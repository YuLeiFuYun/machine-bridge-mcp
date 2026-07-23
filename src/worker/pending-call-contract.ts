export interface PendingCallRecord {
  id: string;
  socket?: WebSocket;
  daemonInstanceId?: string;
  reconnectTimeout?: ReturnType<typeof setTimeout>;
  clientRequestKey?: string;
  tool: string;
  startedAt: number;
  timeout?: ReturnType<typeof setTimeout>;
  deadlineAt: number;
  remainingTimeoutMs: number;
  onTimeout: (record: PendingCallRecord) => Error;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
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
