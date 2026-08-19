import { sendRelayTransportProbe } from "./relay-transport-probe-send.mjs";

export class RelayTransportProbe {
  constructor({ currentSocket, fallback, onTransportError }) {
    this.currentSocket = currentSocket;
    this.fallback = fallback;
    this.onTransportError = onTransportError;
    this.lastBufferedBytes = 0;
    this.maxBufferedBytes = 0;
  }

  send(onDispatched) {
    const socket = this.currentSocket?.();
    const isCurrent = () => this.currentSocket?.() === socket;
    const probe = sendRelayTransportProbe(socket, this.fallback,
      (error, failedSocket) => { if (isCurrent()) this.onTransportError?.(error, failedSocket); },
      () => { if (isCurrent()) onDispatched?.(); });
    this.lastBufferedBytes = probe.bufferedBytes;
    this.maxBufferedBytes = Math.max(this.maxBufferedBytes, probe.bufferedBytes);
    return probe.sent;
  }

  snapshot() {
    return { last_probe_buffered_bytes: this.lastBufferedBytes, max_probe_buffered_bytes: this.maxBufferedBytes };
  }
}
