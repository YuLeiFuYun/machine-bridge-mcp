import type { AuthorityRevocation } from "../shared/authority-revocation.mjs";
import type { DaemonChannel } from "./daemon-channel.ts";

export type PendingCallOutcome =
  | { ok: true; value: unknown }
  | { ok: false; error: Error };

export type PendingCallSettlement = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export class PendingCallRegistrationError extends Error {
  readonly code: "conflict" | "limit_exceeded";
  readonly retryable: boolean;
  constructor(code: "conflict" | "limit_exceeded", message: string, retryable = false) {
    super(message);
    this.name = "PendingCallRegistrationError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface PendingCallRecord {
  id: string;
  socket?: DaemonChannel;
  daemonInstanceId?: string;
  reconnectTimeout?: ReturnType<typeof setTimeout>;
  reconnectDeadlineAt?: number;
  onReconnectTimeout?: (record: PendingCallRecord) => Error;
  clientRequestKey?: string;
  owner_kind?: "account";
  owner_account_id?: string;
  owner_account_version?: number;
  owner_client_id?: string;
  owner_family_id?: string;
  tool: string;
  recovery?: Record<string, unknown>;
  startedAt: number;
  timeout?: ReturnType<typeof setTimeout>;
  deadlineAt: number;
  remainingTimeoutMs: number;
  onTimeout: (record: PendingCallRecord) => Error;
  redeliverAfterProvenMissing?: (record: PendingCallRecord, channel: DaemonChannel) => boolean;
  settlement: PendingCallSettlement;
  signal?: AbortSignal;
  abortHandler?: () => void;
}

export interface RegisterPendingCall {
  id: string;
  socket: DaemonChannel;
  daemonInstanceId?: string;
  clientRequestKey?: string;
  authority?: AuthorityRevocation;
  tool: string;
  recovery?: Record<string, unknown>;
  timeoutMs: number;
  onTimeout: (record: PendingCallRecord) => Error;
  redeliverAfterProvenMissing?: (record: PendingCallRecord, channel: DaemonChannel) => boolean;
  signal?: AbortSignal;
  onAbort?: (record: PendingCallRecord) => Error;
}
