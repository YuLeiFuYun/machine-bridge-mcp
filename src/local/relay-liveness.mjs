import relayContract from "../shared/relay-contract.json" with { type: "json" };
import { RelayHeartbeatMonitor } from "./relay-heartbeat.mjs";

const SILENT_STALL_LOGGER = Object.freeze({ warn() {} });

export class RelayLiveness {
  constructor(options = {}) {
    this.now = options.now;
    this.currentSocket = options.currentSocket;
    this.sendApplicationHeartbeat = options.sendApplicationHeartbeat;
    this.lastInboundAt = 0;
    this.lastApplicationInboundAt = 0;
    const active = options.isActive;
    const scheduler = options.scheduler;
    const transportIntervalMs = positiveInteger(options.transportPingIntervalMs ?? options.heartbeatIntervalMs,
      relayContract.transportPingIntervalMs);
    this.transport = new RelayHeartbeatMonitor({
      intervalMs: transportIntervalMs,
      timeoutMs: positiveInteger(options.transportPongTimeoutMs ?? options.heartbeatTimeoutMs,
        relayContract.transportPongTimeoutMs),
      stallThresholdMs: options.heartbeatStallThresholdMs,
      recoveryGraceMs: options.heartbeatRecoveryGraceMs ?? transportIntervalMs,
      scheduler,
      now: this.now,
      logger: options.logger,
      isActive: active,
      lastInboundAt: () => this.lastInboundAt,
      sendHeartbeat: () => this.probeTransport(options.onTransportError),
      onTimeout: (details) => options.onTransportTimeout?.(details, this.currentSocket?.()),
    });
    this.application = new RelayHeartbeatMonitor({
      intervalMs: positiveInteger(options.applicationHeartbeatIntervalMs,
        relayContract.daemonApplicationHeartbeatIntervalMs),
      timeoutMs: positiveInteger(options.applicationHeartbeatTimeoutMs,
        relayContract.daemonApplicationHeartbeatTimeoutMs),
      stallThresholdMs: options.heartbeatStallThresholdMs,
      recoveryGraceMs: options.heartbeatRecoveryGraceMs,
      scheduler,
      now: this.now,
      logger: SILENT_STALL_LOGGER,
      isActive: active,
      lastInboundAt: () => this.lastApplicationInboundAt,
      sendHeartbeat: (now) => this.sendApplicationProbe(now),
      onTimeout: (details) => options.onApplicationTimeout?.(details, this.currentSocket?.()),
    });
  }

  start() {
    const now = this.now();
    this.lastInboundAt = now;
    this.lastApplicationInboundAt = now;
    this.transport.start();
    this.application.start();
  }

  stop() {
    this.transport.stop();
    this.application.stop();
  }

  observeInbound() {
    this.lastInboundAt = this.now();
    this.transport.observeInbound();
  }

  observeApplicationInbound() {
    const now = this.now();
    this.lastInboundAt = now;
    this.lastApplicationInboundAt = now;
    this.transport.observeInbound();
    this.application.observeInbound();
  }

  silenceMs(now = this.now()) {
    return this.lastInboundAt > 0 ? Math.max(0, Number(now) - this.lastInboundAt) : 0;
  }

  snapshot(now = this.now()) {
    const application = this.application.snapshot(now);
    return {
      ...this.transport.snapshot(now),
      application_heartbeat_interval_ms: application.interval_ms,
      application_heartbeat_timeout_ms: application.timeout_ms,
      application_inbound_silence_ms: Math.max(0, Number(now) - this.lastApplicationInboundAt),
    };
  }

  probeTransport(onTransportError) {
    const socket = this.currentSocket?.();
    if (!socket) return false;
    if (typeof socket.ping !== "function") return this.sendApplicationProbe(this.now());
    try {
      socket.ping();
      return true;
    } catch (error) {
      onTransportError?.(error, socket);
      return false;
    }
  }

  sendApplicationProbe(now) {
    const socket = this.currentSocket?.();
    return socket ? this.sendApplicationHeartbeat?.(now, socket) !== false : false;
  }
}
function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}
