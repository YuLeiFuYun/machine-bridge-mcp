const RELAY_CALL_ID = /^call_[A-Za-z0-9_-]{8,240}$/;

export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function daemonResumeMissingCallIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 32) return null;
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const id of value) {
    if (typeof id !== "string" || !RELAY_CALL_ID.test(id) || seen.has(id)) return null;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function rejectDaemonMessage(ws: WebSocket, error: string, closeCode: number, closeReason: string): void {
  sendWebSocketQuietly(ws, { type: "error", error });
  closeWebSocketQuietly(ws, closeCode, closeReason);
}

export function trySendWebSocket(ws: WebSocket, value: unknown): boolean {
  try {
    ws.send(typeof value === "string" ? value : JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function sendWebSocketQuietly(ws: WebSocket, value: unknown): void {
  // Best-effort protocol cleanup must not replace the primary timeout or rejection.
  trySendWebSocket(ws, value);
}

export function daemonErrorCloseCode(errorCode: string): number {
  return errorCode === "daemon_transport_error" || errorCode === "daemon_liveness_timeout" ? 1012 : 1008;
}

export function closeWebSocketQuietly(ws: WebSocket, code?: number, reason?: string): void {
  try {
    ws.close(code, reason);
  } catch {
    // The socket may already be closed or detached; no recovery remains at this boundary.
  }
}
