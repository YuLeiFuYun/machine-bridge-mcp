export type PendingCallOutcome =
  | { ok: true; value: unknown }
  | { ok: false; error: Error };

export type PendingCallSettlement = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export interface PendingCallRecord {
  id: string;
  socket?: WebSocket;
  daemonInstanceId?: string;
  reconnectTimeout?: ReturnType<typeof setTimeout>;
  reconnectDeadlineAt?: number;
  onReconnectTimeout?: (record: PendingCallRecord) => Error;
  clientRequestKey?: string;
  tool: string;
  startedAt: number;
  timeout?: ReturnType<typeof setTimeout>;
  deadlineAt: number;
  remainingTimeoutMs: number;
  onTimeout: (record: PendingCallRecord) => Error;
  settlement: PendingCallSettlement;
  signal?: AbortSignal;
  abortHandler?: () => void;
}

export interface RegisterPendingCall {
  id: string;
  socket: WebSocket;
  daemonInstanceId?: string;
  clientRequestKey?: string;
  tool: string;
  timeoutMs: number;
  onTimeout: (record: PendingCallRecord) => Error;
  signal?: AbortSignal;
  onAbort?: (record: PendingCallRecord) => Error;
}
