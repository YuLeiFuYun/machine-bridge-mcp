const MAX_BUFFERED_DIAGNOSTIC_BYTES = 64 * 1024 * 1024;

export function sendRelayTransportProbe(socket, fallback, onTransportError, onDispatched) {
  if (!socket) return { sent: false, bufferedBytes: 0 };
  const bufferedBytes = boundedBufferedAmount(socket.bufferedAmount);
  if (typeof socket.ping !== "function") {
    const sent = fallback?.() !== false;
    if (sent) onDispatched?.();
    return { sent, bufferedBytes };
  }
  try {
    socket.ping((error) => {
      if (error) onTransportError?.(error, socket);
      else onDispatched?.();
    });
    return { sent: true, bufferedBytes };
  } catch (error) {
    onTransportError?.(error, socket);
    return { sent: false, bufferedBytes };
  }
}

function boundedBufferedAmount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0
    ? Math.min(MAX_BUFFERED_DIAGNOSTIC_BYTES, Math.round(number)) : 0;
}
