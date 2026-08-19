import relayContract from "../shared/relay-contract.json" with { type: "json" };
import { RelayHeartbeatMonitor } from "./relay-heartbeat.mjs";
import { positiveInteger } from "./relay-heartbeat-options.mjs";
import { RelayInboundState } from "./relay-inbound-state.mjs";
import { RelayTransportProbe } from "./relay-transport-probe.mjs";
const SILENT_STALL_LOGGER = Object.freeze({ warn() {} });

export class RelayLiveness {
  constructor(options = {}) {
    this.now = options.now; this.currentSocket = options.currentSocket;
    this.sendApplicationHeartbeat = options.sendApplicationHeartbeat;
    this.isApplicationActive = typeof options.isApplicationActive === "function" ? options.isApplicationActive : options.isActive;
    this.inbound = new RelayInboundState(this.now);
    this.transportProbe = new RelayTransportProbe({
      currentSocket: this.currentSocket,
      fallback: () => this.sendApplicationProbe(this.now()),
      onTransportError: options.onTransportError,
    });
    const active = options.isActive;
    const scheduler = options.scheduler;
    const transportIntervalMs = positiveInteger(options.transportPingIntervalMs ?? options.heartbeatIntervalMs,
      relayContract.transportPingIntervalMs);
    this.transport = new RelayHeartbeatMonitor({
      intervalMs: transportIntervalMs,
      timeoutMs: positiveInteger(options.transportPongTimeoutMs ?? options.heartbeatTimeoutMs,
        relayContract.transportPongTimeoutMs),
      timeoutAfterProbe: true,
      stallThresholdMs: options.heartbeatStallThresholdMs,
      recoveryGraceMs: options.heartbeatRecoveryGraceMs ?? transportIntervalMs,
      scheduler,
      now: this.now,
      wallNow: options.wallNow,
      logger: options.logger,
      isActive: active,
      lastInboundAt: () => this.inbound.lastInboundAt,
      dispatchTimeoutMs: positiveInteger(options.transportPingDispatchTimeoutMs,
        relayContract.transportPingDispatchTimeoutMs),
      confirmationTimeoutMs: positiveInteger(options.transportConfirmationTimeoutMs,
        relayContract.transportApplicationConfirmationTimeoutMs),
      sendHeartbeat: (_now, onDispatched) => this.transportProbe.send(onDispatched),
      sendConfirmation: (now, onDispatched) => this.sendApplicationProbe(now, onDispatched),
      onSuspect: (details) => options.onTransportSuspect?.(details, this.currentSocket?.()),
      onRecovered: (details) => options.onTransportRecovered?.(details, this.currentSocket?.()),
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
      wallNow: options.wallNow,
      logger: SILENT_STALL_LOGGER,
      isActive: this.isApplicationActive,
      lastInboundAt: () => this.inbound.lastApplicationInboundAt,
      sendHeartbeat: (now) => this.sendApplicationProbe(now),
      onTimeout: (details) => options.onApplicationTimeout?.(details, this.currentSocket?.()),
    });
  }

  start() {
    this.inbound.reset();
    this.transport.start();
    this.application.start();
  }

  stop() {
    this.transport.stop();
    this.application.stop();
  }

  observeInbound() {
    this.inbound.observeTransportProof(this.transport);
  }

  observeApplicationInbound() {
    this.inbound.observeApplicationInbound(this.application);
  }

  observeApplicationPong() {
    this.inbound.observeApplicationProof(this.transport, this.application);
  }

  silenceMs(now = this.now()) {
    return this.inbound.silenceMs(now);
  }

  snapshot(now = this.now()) {
    const application = this.application.snapshot(now);
    return {
      ...this.transport.snapshot(now),
      ...this.transportProbe.snapshot(),
      application_heartbeat_interval_ms: application.interval_ms,
      application_heartbeat_timeout_ms: application.timeout_ms,
      application_inbound_silence_ms: this.inbound.applicationSilenceMs(now),
    };
  }

  sendApplicationProbe(now, onDispatched) {
    if (!this.isApplicationActive?.()) return false;
    const socket = this.currentSocket?.();
    return socket ? this.sendApplicationHeartbeat?.(now, socket, onDispatched) !== false : false;
  }
}
