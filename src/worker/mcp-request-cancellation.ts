import relayContract from "../shared/relay-contract.json" with { type: "json" };

const DEFAULT_TOMBSTONE_TTL_MS = Number(relayContract.maximumRelayToolTimeoutMs)
  + Number(relayContract.reconnectGraceMs);
const DEFAULT_MAX_TOMBSTONES = 512;

export type McpRequestCancellationLease = Readonly<{
  signal: AbortSignal;
  cancel: (reason?: unknown) => void;
  release: () => void;
}>;

export class McpRequestCancellationRegistry {
  private readonly active = new Map<string, AbortController>();
  private readonly cancelledBeforeOpen = new Map<string, number>();
  private readonly now: () => number;
  private readonly tombstoneTtlMs: number;
  private readonly maximumTombstones: number;
  private readonly onFailClosed: () => void;
  private failClosedUntil = 0;

  constructor(options: Readonly<{
    now?: () => number;
    tombstoneTtlMs?: number;
    maximumTombstones?: number;
    onFailClosed?: () => void;
  }> = {}) {
    this.now = options.now ?? Date.now;
    this.tombstoneTtlMs = positiveInteger(options.tombstoneTtlMs, DEFAULT_TOMBSTONE_TTL_MS);
    this.maximumTombstones = positiveInteger(options.maximumTombstones, DEFAULT_MAX_TOMBSTONES);
    this.onFailClosed = options.onFailClosed ?? (() => {});
  }

  cancel(requestKey?: string, reason: unknown = "client request cancelled"): boolean {
    if (!requestKey) return false;
    this.prune();
    const active = this.active.get(requestKey);
    if (active) {
      if (!active.signal.aborted) active.abort(reason);
      return true;
    }
    const expiresAt = this.now() + this.tombstoneTtlMs;
    if (this.cancelledBeforeOpen.has(requestKey) || this.cancelledBeforeOpen.size < this.maximumTombstones) {
      this.cancelledBeforeOpen.set(requestKey, expiresAt);
    } else {
      // Fail closed rather than evicting a cancellation marker and later
      // dispatching a delayed side effect whose public response already died.
      const enteringFailClosed = this.now() >= this.failClosedUntil;
      this.failClosedUntil = Math.max(this.failClosedUntil, expiresAt);
      if (enteringFailClosed) {
        try { this.onFailClosed(); } catch { /* observability must not change cancellation */ }
      }
    }
    return true;
  }

  open(requestKey: string | undefined, requestSignal: AbortSignal): McpRequestCancellationLease {
    this.prune();
    if (requestKey && this.active.has(requestKey)) throw new Error("duplicate MCP response stream identity");
    const controller = new AbortController();
    const requestAbort = () => {
      if (!controller.signal.aborted) controller.abort(requestSignal.reason ?? "client request aborted");
    };
    requestSignal.addEventListener("abort", requestAbort, { once: true });
    if (requestSignal.aborted) requestAbort();
    if (requestKey) {
      const cancelledBeforeOpen = this.cancelledBeforeOpen.delete(requestKey);
      if ((cancelledBeforeOpen || this.now() < this.failClosedUntil) && !controller.signal.aborted) {
        controller.abort("client request cancelled before dispatch ownership opened");
      }
      this.active.set(requestKey, controller);
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      requestSignal.removeEventListener("abort", requestAbort);
      if (requestKey && this.active.get(requestKey) === controller) this.active.delete(requestKey);
    };
    return Object.freeze({
      signal: controller.signal,
      cancel: (reason: unknown = "client response stream closed") => {
        if (!controller.signal.aborted) controller.abort(reason);
      },
      release,
    });
  }

  snapshot() {
    this.prune();
    return Object.freeze({
      active: this.active.size,
      cancelled_before_open: this.cancelledBeforeOpen.size,
      fail_closed: this.now() < this.failClosedUntil,
      maximum_tombstones: this.maximumTombstones,
      tombstone_ttl_ms: this.tombstoneTtlMs,
    });
  }

  private prune(): void {
    const now = this.now();
    for (const [key, expiresAt] of this.cancelledBeforeOpen) {
      if (expiresAt <= now) this.cancelledBeforeOpen.delete(key);
    }
    if (this.failClosedUntil <= now) this.failClosedUntil = 0;
  }
}

function positiveInteger(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}
