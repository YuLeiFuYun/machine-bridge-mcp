import relayContract from "../shared/relay-contract.json" with { type: "json" };
import { DAEMON_CHANNEL_OPEN, type DaemonChannel } from "./daemon-channel.ts";
import type { DaemonAttachment } from "./daemon-socket-attachment.ts";
import { relayDiagnosticsAfterReady } from "./daemon-relay-diagnostics.ts";

type SequencedMessage = Readonly<{ seq: number; payload: unknown; bytes: number }>;

export class DaemonHttpChannel implements DaemonChannel {
  readonly daemonTransport = "https" as const;
  readonly sessionId: string;
  readonly activationToken: string;
  readonly attachment: DaemonAttachment;
  private activatedAtMs = 0;
  private verifiedReadyAtMs = 0;
  private lastSeenAtMs: number;
  private nextWorkerSeq = 1;
  private acknowledgedWorkerSeq = 0;
  private acknowledgedDaemonSeq = 0;
  private queuedBytes = 0;
  private readonly outbound: SequencedMessage[] = [];
  private closed = false;

  constructor(input: {
    sessionId: string;
    activationToken: string;
    attachment: DaemonAttachment;
    now?: number;
  }) {
    this.sessionId = input.sessionId;
    this.activationToken = input.activationToken;
    this.attachment = input.attachment;
    this.lastSeenAtMs = input.now ?? Date.now();
  }

  get readyState(): number { return !this.closed && this.verifiedReadyAtMs > 0 ? DAEMON_CHANNEL_OPEN : 0; }
  get lastSeenMs(): number { return this.lastSeenAtMs; }
  get activatedMs(): number { return this.activatedAtMs; }
  get isActivated(): boolean { return !this.closed && this.activatedAtMs > 0; }
  get daemonSequence(): number { return this.acknowledgedDaemonSeq; }

  activate(now = Date.now()): void {
    if (this.closed) throw new Error("HTTP daemon channel is closed");
    this.activatedAtMs = now;
    this.touch(now);
    this.attachment.role = "probing";
  }

  verifyReady(now = Date.now()): void {
    if (!this.isActivated) throw new Error("HTTP daemon channel was not activated");
    this.verifiedReadyAtMs = now;
    this.touch(now);
    this.attachment.role = "daemon";
    this.attachment.connectedAt = new Date(now).toISOString();
    this.attachment.lastSeenAt = this.attachment.connectedAt;
    this.attachment.relayDiagnostics = relayDiagnosticsAfterReady(
      this.attachment.relayDiagnostics,
      this.attachment.connectedAt,
    );
  }

  touch(now = Date.now()): void {
    this.lastSeenAtMs = now;
    this.attachment.lastSeenAt = new Date(now).toISOString();
  }

  send(data: string): void {
    if (!this.isActivated) throw new Error("HTTP daemon channel is not activated");
    const bytes = new TextEncoder().encode(data).byteLength;
    if (bytes > relayContract.httpFallbackMaximumMessageBytes
        || this.outbound.length >= relayContract.httpFallbackMaximumQueuedMessages
        || this.queuedBytes + bytes > relayContract.httpFallbackMaximumQueuedBytes) {
      throw new Error("HTTP daemon relay queue capacity exceeded");
    }
    let payload: unknown;
    try { payload = JSON.parse(data); } catch { throw new Error("HTTP daemon relay message is not JSON"); }
    this.outbound.push(Object.freeze({ seq: this.nextWorkerSeq++, payload, bytes }));
    this.queuedBytes += bytes;
  }

  acknowledgeWorker(sequence: number): boolean {
    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence >= this.nextWorkerSeq) return false;
    if (sequence <= this.acknowledgedWorkerSeq) return true;
    this.acknowledgedWorkerSeq = sequence;
    while (this.outbound[0]?.seq <= sequence) {
      const removed = this.outbound.shift();
      if (removed) this.queuedBytes = Math.max(0, this.queuedBytes - removed.bytes);
    }
    return true;
  }

  outboundMessages(): Array<{ seq: number; payload: unknown }> {
    const selected: Array<{ seq: number; payload: unknown }> = [];
    let bytes = 0;
    for (const message of this.outbound) {
      if (selected.length >= relayContract.httpFallbackMaximumQueuedMessages) break;
      if (selected.length > 0 && bytes + message.bytes > relayContract.httpFallbackMaximumEnvelopeBytes) break;
      selected.push({ seq: message.seq, payload: message.payload });
      bytes += message.bytes;
    }
    return selected;
  }

  acceptDaemonSequence(sequence: number): "new" | "duplicate" | "gap" {
    if (!Number.isSafeInteger(sequence) || sequence <= 0) return "gap";
    if (sequence <= this.acknowledgedDaemonSeq) return "duplicate";
    if (sequence !== this.acknowledgedDaemonSeq + 1) return "gap";
    return "new";
  }

  commitDaemonSequence(sequence: number): void {
    if (sequence !== this.acknowledgedDaemonSeq + 1) throw new Error("HTTP daemon sequence commit is not contiguous");
    this.acknowledgedDaemonSeq = sequence;
  }

  close(): void {
    this.closed = true;
    this.outbound.length = 0;
    this.queuedBytes = 0;
  }
}
