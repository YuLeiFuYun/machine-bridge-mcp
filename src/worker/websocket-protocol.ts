export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

export function closeWebSocketQuietly(ws: WebSocket, code?: number, reason?: string): void {
  try {
    ws.close(code, reason);
  } catch {
    // The socket may already be closed or detached; no recovery remains at this boundary.
  }
}
