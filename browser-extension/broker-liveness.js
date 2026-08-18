globalThis.__machineBridgeBrokerLiveness = (() => {
  const PONG_TIMEOUT_MS = 10000;
  function initialize(socket) {
    socket.pongTimer = null;
    socket.pongWatchdog = false;
    socket.pingSequence = 0;
  }
  function clear(socket) {
    clearTimeout(socket?.pongTimer);
    if (socket) socket.pongTimer = null;
  }
  function negotiate(socket, enabled) { socket.pongWatchdog = enabled === true; }
  function keepalive(socket, current, send, close) {
    if (!current || !socket.bridgeReady || socket.readyState !== WebSocket.OPEN) return;
    const seq = socket.pongWatchdog ? ++socket.pingSequence : 0;
    if (!send(socket, JSON.stringify({ type: "ping", ...(seq ? { seq } : {}) }))) {
      close(socket, 1011, "browser extension keepalive failed");
      return;
    }
    if (!seq) return;
    clear(socket);
    socket.pongTimer = setTimeout(() => {
      if (socket.bridgeReady && socket.pingSequence === seq) close(socket, 1012, "browser broker pong timed out");
    }, PONG_TIMEOUT_MS);
  }
  function handlePong(socket, message, close) {
    if (!socket.pongWatchdog) return;
    if (!Number.isSafeInteger(message.seq) || message.seq !== socket.pingSequence) {
      close(socket, 1002, "invalid browser broker pong");
      return;
    }
    clear(socket);
  }
  return Object.freeze({ initialize, clear, negotiate, keepalive, handlePong });
})();
