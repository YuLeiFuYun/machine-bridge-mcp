import { recordMatchesAuthorityRevocation, type AuthorityRevocation } from "../../shared/authority-revocation.mjs";
import relayContract from "../../shared/relay-contract.json" with { type: "json" };

type OpenSubscriptionInput = Readonly<{
  authority: Readonly<{
    accountId: string;
    accountVersion: number;
    clientId: string;
    familyId: string;
  }>;
  requestKey?: string;
  requestSignal: AbortSignal;
  acknowledged: Record<string, unknown>;
  initialMessages: readonly Record<string, unknown>[];
}>;

type ActiveSubscription = Readonly<{
  owner_kind: "account";
  owner_account_id: string;
  owner_account_version: number;
  owner_client_id: string;
  owner_family_id: string;
  cancel: () => void;
}>;

export class McpSubscriptionRegistry {
  private readonly capacity = new McpSubscriptionCapacity();
  private readonly cancelByRequestKey = new Map<string, () => void>();
  private readonly active = new Set<ActiveSubscription>();
  private readonly leaseMs: number;

  constructor(options: Readonly<{ leaseMs?: number }> = {}) {
    this.leaseMs = Number.isSafeInteger(options.leaseMs) && Number(options.leaseMs) > 0
      ? Number(options.leaseMs) : MCP_TOOL_LIST_SUBSCRIPTION_LEASE_MS;
  }

  snapshot(accountId: string) {
    return this.capacity.snapshot(accountId);
  }

  cancelRequest(requestKey?: string): boolean {
    if (!requestKey) return false;
    const cancel = this.cancelByRequestKey.get(requestKey);
    if (!cancel) return false;
    cancel();
    return true;
  }

  cancelAuthority(revocation: AuthorityRevocation): number {
    const matching = [...this.active].filter((record) => recordMatchesAuthorityRevocation(record, revocation));
    for (const record of matching) record.cancel();
    return matching.length;
  }

  open(input: OpenSubscriptionInput): Response | null {
    const releaseCapacity = this.capacity.reserve(input.authority.accountId);
    if (!releaseCapacity) return null;

    const controller = new AbortController();
    const cancelWithReason = (reason: string) => { if (!controller.signal.aborted) controller.abort(reason); };
    const cancel = () => cancelWithReason("subscription cancelled");
    const active: ActiveSubscription = {
      owner_kind: "account",
      owner_account_id: input.authority.accountId,
      owner_account_version: input.authority.accountVersion,
      owner_client_id: input.authority.clientId,
      owner_family_id: input.authority.familyId,
      cancel,
    };
    if (input.requestKey) {
      if (this.cancelByRequestKey.has(input.requestKey)) {
        releaseCapacity();
        throw new Error("duplicate subscription request identity");
      }
      this.cancelByRequestKey.set(input.requestKey, cancel);
    }

    const requestAbort = () => {
      if (!controller.signal.aborted) {
        controller.abort(input.requestSignal.reason ?? "client request aborted");
      }
    };
    input.requestSignal.addEventListener("abort", requestAbort, { once: true });
    let released = false;
    let leaseTimer: ReturnType<typeof setTimeout> | undefined;
    const release = () => {
      if (released) return;
      released = true;
      if (leaseTimer) clearTimeout(leaseTimer);
      input.requestSignal.removeEventListener("abort", requestAbort);
      if (input.requestKey && this.cancelByRequestKey.get(input.requestKey) === cancel) {
        this.cancelByRequestKey.delete(input.requestKey);
      }
      this.active.delete(active);
      releaseCapacity();
    };

    try {
      if (input.requestSignal.aborted) requestAbort();
      this.active.add(active);
      const response = openSubscriptionResponse(
        input.acknowledged,
        input.initialMessages,
        controller.signal,
        release,
      );
      if (!released) {
        leaseTimer = setTimeout(() => cancelWithReason("subscription lease expired"), this.leaseMs);
      }
      // This records only that the server successfully constructed an open
      // subscription response. It cannot prove that an external client read
      // the acknowledgement or any notification from the response body.
      this.capacity.markOpened(input.authority.accountId);
      return response;
    } catch (error) {
      release();
      throw error;
    }
  }
}
export const MAX_ACTIVE_MCP_SUBSCRIPTIONS = 32;

export const MAX_ACTIVE_MCP_SUBSCRIPTIONS_PER_ACCOUNT = 8;

export const MAX_OPENED_MCP_SUBSCRIPTION_ACCOUNTS = 64;

export class McpSubscriptionCapacity {
  private active = 0;
  private readonly byAccount = new Map<string, number>();
  private readonly openedAccounts = new Set<string>();

  reserve(accountId: string): (() => void) | null {
    const key = typeof accountId === "string" ? accountId : "";
    const accountActive = this.byAccount.get(key) ?? 0;
    if (!key || this.active >= MAX_ACTIVE_MCP_SUBSCRIPTIONS
        || accountActive >= MAX_ACTIVE_MCP_SUBSCRIPTIONS_PER_ACCOUNT) return null;
    this.active += 1;
    this.byAccount.set(key, accountActive + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      const remaining = Math.max(0, (this.byAccount.get(key) ?? 1) - 1);
      if (remaining) this.byAccount.set(key, remaining);
      else this.byAccount.delete(key);
    };
  }

  markOpened(accountId: string): void {
    const key = typeof accountId === "string" ? accountId : "";
    if (!key || (this.byAccount.get(key) ?? 0) <= 0) return;
    this.openedAccounts.delete(key);
    while (this.openedAccounts.size >= MAX_OPENED_MCP_SUBSCRIPTION_ACCOUNTS) {
      const oldest = this.openedAccounts.values().next().value;
      if (typeof oldest !== "string") break;
      this.openedAccounts.delete(oldest);
    }
    this.openedAccounts.add(key);
  }

  snapshot(accountId: string): Readonly<{ activeForAccount: number; openedForAccount: boolean }> {
    const key = typeof accountId === "string" ? accountId : "";
    return Object.freeze({
      activeForAccount: key ? this.byAccount.get(key) ?? 0 : 0,
      openedForAccount: Boolean(key && this.openedAccounts.has(key)),
    });
  }
}
// Tool definitions are immutable for one Worker deployment. The initial level-trigger
// gives the client the only freshness edge available within that deployment; this
// bounded lease prevents an unobservable HTTP disconnect from pinning stream capacity.
export const MCP_TOOL_LIST_SUBSCRIPTION_LEASE_MS = Math.max(1_000, Number(relayContract.streamHeartbeatMs) * 2);
export function closedSubscriptionResponse(
  acknowledged: Record<string, unknown>,
  completed: Record<string, unknown>,
): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(sseMessage(acknowledged)));
      controller.enqueue(encoder.encode(sseMessage(completed)));
      controller.close();
    },
  });
  return eventStreamResponse(body);
}

export function openSubscriptionResponse(
  acknowledged: Record<string, unknown>,
  initialMessages: readonly Record<string, unknown>[],
  signal: AbortSignal,
  onClose: () => void = () => {},
): Response {
  const encoder = new TextEncoder();
  let writable = true;
  let finalized = false;
  let removeAbort = () => {};
  const finalize = () => {
    if (finalized) return;
    finalized = true;
    try { onClose(); } catch { /* Subscription accounting cleanup must not corrupt stream settlement. */ }
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(sseMessage(acknowledged)));
      for (const message of initialMessages) controller.enqueue(encoder.encode(sseMessage(message)));
      const abort = () => {
        if (!writable) return;
        writable = false;
        try { controller.close(); } catch { /* The client already closed the subscription stream. */ }
        finalize();
      };
      signal.addEventListener("abort", abort, { once: true });
      removeAbort = () => signal.removeEventListener("abort", abort);
      if (signal.aborted) abort();
    },
    cancel() {
      if (!writable) return;
      writable = false;
      removeAbort();
      finalize();
    },
  });
  return eventStreamResponse(body);
}

function eventStreamResponse(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    },
  });
}

function sseMessage(message: unknown): string {
  return `event: message\ndata: ${JSON.stringify(message)}\n\n`;
}
