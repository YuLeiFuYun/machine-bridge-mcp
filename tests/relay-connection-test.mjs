import { EventEmitter } from "node:events";
import { acknowledgementMismatch, readinessMismatch, RelayConnection, isSupersededClose, reconnectDelay, relayCloseCategory, relayOutageUserAction, welcomeMismatch } from "../src/local/relay-connection.mjs";
import { classifyRelayTransportError, observeTlsLookup } from "../src/local/relay-connection-support.mjs";
import { scheduleRelayReconnect, scheduleRelayReconnectBackoffReset, settleRelayReconnectBackoffOnClose } from "../src/local/relay-reconnect.mjs";
import { classifyRelayTransportErrorReason } from "../src/local/relay-transport-error-state.mjs";
import { RelayTransportConfirmation } from "../src/local/relay-transport-confirmation.mjs";
import { proxyAgentForWebSocket } from "../src/local/network-proxy.mjs";

const TEST_CONNECTION_ID = `connection_${"a".repeat(43)}`;
const lookupStages = [];
observeTlsLookup((stage) => lookupStages.push(stage), Object.assign(new Error("dns unavailable"), { code: "EAI_AGAIN" }));
assert(lookupStages.length === 0, "failed DNS lookup was mislabeled as dns_resolved");
observeTlsLookup((stage) => lookupStages.push(stage), null);
assert(lookupStages.length === 1 && lookupStages[0] === "dns_resolved", "successful DNS lookup lost its milestone");
const aggregateNetworkError = new AggregateError([
  Object.assign(new Error("v6 timeout"), { code: "ETIMEDOUT" }),
  Object.assign(new Error("v4 unreachable"), { code: "ENETUNREACH" }),
]);
assert(classifyRelayTransportError(aggregateNetworkError) === "network_error",
  "Happy Eyeballs aggregate network failure collapsed into generic execution failure");
assert(classifyRelayTransportErrorReason(aggregateNetworkError) === "multi_address_failure",
  "mixed Happy Eyeballs failure leaked or lost its privacy-safe multi-address classification");

{
  const callbacks = [];
  const confirmation = new RelayTransportConfirmation({
    enabled: true, timeoutMs: 15, dispatchTimeoutMs: 30,
    sendConfirmation: (_now, callback) => { callbacks.push(callback); return true; },
  });
  assert(confirmation.begin(1), "first transport confirmation did not start");
  confirmation.reset();
  assert(confirmation.begin(2), "replacement transport confirmation did not start");
  callbacks[0](new Error("stale confirmation send failure"), 3);
  assert(confirmation.dispatchPending(),
    "stale confirmation callback from an old generation cleared the replacement confirmation");
  callbacks[1](null, 4);
  assert(confirmation.responsePending(), "current confirmation dispatch callback did not arm its response deadline");
  confirmation.observe(5);
  assert(!confirmation.pending(), "confirmed transport did not settle the replacement confirmation round");
}

class FakeSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;

  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.readyState = FakeSocket.CONNECTING;
    this.sent = [];
    this.pings = [];
    this.terminated = false;
  }

  open() {
    this.readyState = FakeSocket.OPEN;
    this.emit("open");
  }

  send(value, callback) {
    if (this.readyState !== FakeSocket.OPEN) throw new Error("socket is not open");
    this.sent.push(String(value));
    callback?.();
  }

  ping(value = "", callback) {
    if (this.readyState !== FakeSocket.OPEN) throw new Error("socket is not open");
    if (typeof value === "function") { callback = value; value = ""; }
    this.pings.push(String(value));
    callback?.();
  }

  close(code = 1000, reason = "") {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.emit("close", code, Buffer.from(reason));
  }

  remoteClose(code, reason) {
    this.close(code, reason);
  }

  terminate() {
    this.terminated = true;
    this.close(1006, "");
  }

  fail(error = new Error("socket failure")) {
    this.emit("error", error);
  }
}

class DelayedSendSocket extends FakeSocket {
  constructor(url, options) {
    super(url, options);
    this.pendingSendCallbacks = [];
  }
  send(value, callback) {
    if (this.readyState !== FakeSocket.OPEN) throw new Error("socket is not open");
    this.sent.push(String(value));
    this.pendingSendCallbacks.push(callback);
  }
  flushSend(error = null) {
    const callback = this.pendingSendCallbacks.shift();
    callback?.(error);
  }
}

class FirstPingFailSocket extends FakeSocket {
  static created = 0;
  constructor(url, options) { super(url, options); this.failFirstPing = FirstPingFailSocket.created++ === 0; }
  ping(value = "", callback) {
    if (typeof value === "function") { callback = value; value = ""; }
    if (!this.failFirstPing) return super.ping(value, callback);
    this.pings.push(String(value));
    callback?.(Object.assign(new Error("synthetic ping reset"), { code: "ECONNRESET" }));
  }
}

{
  const connection = new RelayConnection({ workerUrl: "https://relay.example.invalid", WebSocketClass: FakeSocket });
  const oldSocket = new DelayedSendSocket("wss://relay.example.invalid/daemon/ws", {});
  const newSocket = new FakeSocket("wss://relay.example.invalid/daemon/ws", {});
  oldSocket.readyState = FakeSocket.OPEN;
  newSocket.readyState = FakeSocket.OPEN;
  connection.closed = false;
  connection.authenticated = true;
  connection.ready = true;
  connection.socket = oldSocket;
  let observed = 0;
  assert(connection.sendOnSocket(oldSocket, { type: "heartbeat" }, () => { observed += 1; }),
    "stale-send generation fixture could not queue its old-socket send");
  connection.socket = newSocket;
  connection.pendingCloseCategory = "";
  connection.transportError.clear();
  oldSocket.flushSend(Object.assign(new Error("old socket write failed late"), { code: "ECONNRESET" }));
  assert(observed === 0 && connection.pendingCloseCategory === "" && connection.transportError.errorClass === "",
    "late send callback from an old WebSocket generation poisoned the current relay generation");
  connection.stop();
}

class ManualScheduler {
  constructor() {
    this.now = 1;
    this.nextId = 1;
    this.tasks = new Map();
  }

  setTimeout(callback, delay) {
    return this.add(callback, delay, 0);
  }

  clearTimeout(id) {
    this.tasks.delete(id);
  }

  setInterval(callback, delay) {
    return this.add(callback, delay, Math.max(1, delay));
  }

  clearInterval(id) {
    this.tasks.delete(id);
  }

  add(callback, delay, interval) {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.now + Math.max(0, delay), callback, interval });
    return id;
  }

  stall(milliseconds) {
    this.now += milliseconds;
    const due = [...this.tasks.entries()]
      .filter(([, task]) => task.at <= this.now)
      .sort((left, right) => left[1].at - right[1].at || left[0] - right[0]);
    for (const [id, task] of due) {
      if (!this.tasks.has(id)) continue;
      if (task.interval > 0) task.at = this.now + task.interval;
      else this.tasks.delete(id);
      task.callback();
    }
  }

  advance(milliseconds) {
    const target = this.now + milliseconds;
    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!next) break;
      const [id, task] = next;
      this.now = task.at;
      if (task.interval > 0) task.at += task.interval;
      else this.tasks.delete(id);
      task.callback();
    }
    this.now = target;
  }
}

{
  const retryScheduler = new ManualScheduler();
  const socketA = {};
  const state = {
    scheduler: retryScheduler,
    reconnectAttempt: 2,
    reconnectStableReadyMs: 10,
    reconnectStabilityTimer: null,
    reconnectTimer: null,
    closed: false,
    socket: socketA,
    ready: true,
    activeSessionId: "session_a",
    connectTiming: { durationMs: 0 },
    connectTimeoutMs: 100,
    lastReconnectDelayMs: 0,
    nextReconnectAt: 0,
    nextReconnectWallAt: 0,
    outageAttempts: 0,
    lastCloseCategory: "connection_interrupted",
    networkRoute: "direct",
    networkRouteScope: "system",
    reconnectAttempts: [],
    connectCalls: 0,
    clearTimer(name) {
      const id = this[name];
      if (id !== null) retryScheduler.clearTimeout(id);
      this[name] = null;
    },
    recordOutage() {},
    reconnectDelay(attempt) { this.reconnectAttempts.push(attempt); return 5; },
    now: () => retryScheduler.now,
    wallNow: () => retryScheduler.now,
    scheduleOutageWarning() {},
    logger: { debug() {} },
    connect() { this.connectCalls += 1; },
  };
  scheduleRelayReconnectBackoffReset(state, socketA, "session_a");
  state.socket = {};
  retryScheduler.advance(10);
  assert(state.reconnectAttempt === 2,
    "stale reconnect-stability timer reset backoff for a replacement relay generation");
  state.socket = socketA;
  scheduleRelayReconnectBackoffReset(state, socketA, "session_a");
  retryScheduler.advance(10);
  assert(state.reconnectAttempt === 0,
    "current reconnect-stability timer did not reset backoff after minimum uptime");
  scheduleRelayReconnectBackoffReset(state, socketA, "session_a");
  assert(state.reconnectStabilityTimer === null,
    "zero reconnect history scheduled an unnecessary stability timer");

  state.reconnectAttempt = 3;
  settleRelayReconnectBackoffOnClose(state, false, 100);
  settleRelayReconnectBackoffOnClose(state, true, 9);
  assert(state.reconnectAttempt === 3,
    "unstable or non-ready relay close erased reconnect failure history");
  settleRelayReconnectBackoffOnClose(state, true, 10);
  assert(state.reconnectAttempt === 0,
    "stable ready duration did not clear reconnect failure history on close");

  state.reconnectAttempt = 1;
  state.closed = true;
  scheduleRelayReconnect(state, "connection_interrupted");
  assert(state.reconnectAttempts.length === 0,
    "closed relay scheduled another reconnect");
  state.closed = false;
  state.reconnectTimer = 999;
  scheduleRelayReconnect(state, "connection_interrupted");
  assert(state.reconnectAttempts.length === 0,
    "relay scheduled a duplicate reconnect while one was already pending");
  state.reconnectTimer = null;
  scheduleRelayReconnect(state, "connection_interrupted");
  assert(state.reconnectAttempts[0] === 1 && state.reconnectAttempt === 2,
    "reconnect scheduling lost the retained attempt before advancing backoff state");
  retryScheduler.advance(5);
  assert(state.connectCalls === 1 && state.reconnectTimer === null,
    "scheduled reconnect did not release its timer before invoking connect");
}


assert(relayOutageUserAction("connection_interrupted", 5 * 60_000).includes("check internet access"),
  "sustained transport outage lost its network troubleshooting action");
const localRevocationAction = relayOutageUserAction("local_authority_revocation_retry", 5 * 60_000);
assert(localRevocationAction.includes("local authority, process-session, and managed-job state") && !localRevocationAction.includes("internet"),
  "local authority-revocation retry was misdirected to network troubleshooting");
assert(relayOutageUserAction("local_authority_revocation_retry", 5 * 60_000 - 1) === "",
  "brief local authority retry emitted a premature operator action");

const scheduler = new ManualScheduler();
const sockets = [];
const events = [];
const logger = captureLogger(events);
let connection;
connection = new RelayConnection({
  workerUrl: "https://relay.example.invalid",
  secret: "test-daemon-secret-123456",
  logger,
  WebSocketClass: class extends FakeSocket {
    constructor(url, options) {
      super(url, options);
      sockets.push(this);
    }
  },
  scheduler,
  now: () => scheduler.now,
  reconnectDelay: () => 5,
  handshakeTimeoutMs: 20,
  heartbeatIntervalMs: 10,
  heartbeatTimeoutMs: 30,
  outageWarnAfterMs: 15,
  outageWarnRepeatMs: 50,
  helloMessage: () => ({ type: "hello", tools: ["server_info"] }),
  expectedServer: "machine-bridge-mcp",
  expectedVersion: "0.8.1",
});

const started = connection.start();
assert(sockets.length === 1, "relay did not create the initial socket");
assert(sockets[0].options.perMessageDeflate === false,
  "daemon relay silently re-enabled per-message compression and its avoidable sender queueing state");
sockets[0].open();
assert(events.every((event) => event.level !== "info"), "transport open was incorrectly reported as authenticated readiness");
assert(sockets[0].sent.length === 0, "relay sent daemon identity before receiving the Worker challenge");
assert(connection.observeWelcome({ type: "welcome", server: "machine-bridge-mcp", version: "0.8.1", connection_id: TEST_CONNECTION_ID }), "valid relay welcome was rejected");
await Promise.resolve();
assert(JSON.parse(sockets[0].sent[0]).type === "hello", "relay did not answer the Worker challenge with daemon hello");
assert(events.every((event) => event.level !== "warn"), "valid relay welcome emitted a warning");
connection.acknowledge({ type: "hello_ack", server: "machine-bridge-mcp", version: "0.8.1" });
assert(connection.status().authenticated === true && connection.status().ready === false, "hello acknowledgement was incorrectly treated as end-to-end readiness");
const authenticatedRelaySession = connection.currentSessionId();
assert(authenticatedRelaySession > 0, "authenticated relay did not establish a session for the readiness probe");
assert(connection.sendForSession({ type: "relay_probe_result", id: "probe_test-ready" }, authenticatedRelaySession).ok === true, "readiness probe result could not use the authenticated session before ready state");
assert(connection.sendForSession({ type: "resume_calls_ack", missing_ids: [] }, authenticatedRelaySession).ok === true,
  "resume reconciliation acknowledgement could not use the authenticated session before ready state");
assert(connection.sendForSession({ type: "authority_revoke_ack", revocation_id: `revoke_${"r".repeat(43)}` }, authenticatedRelaySession).ok === true,
  "authority revocation acknowledgement could not use the authenticated session before ready state");
let startedResolved = false;
void started.then(() => { startedResolved = true; });
await Promise.resolve();
assert(!startedResolved, "relay start resolved before end-to-end result delivery was acknowledged");
let preReadyMessageContext = null;
const preReadyOnMessage = connection.onMessage;
connection.onMessage = (data, context) => {
  preReadyMessageContext = context;
  return preReadyOnMessage?.(data, context);
};
sockets[0].emit("message", Buffer.from(JSON.stringify({ type: "relay_probe", id: "probe_pre_ready" })));
assert(preReadyMessageContext?.sessionId === authenticatedRelaySession, "pre-ready inbound message lost the authenticated session generation");
assert(preReadyMessageContext?.authenticated === true && preReadyMessageContext?.ready === false, "pre-ready inbound context must report authenticated but not ready");
connection.onMessage = preReadyOnMessage;
connection.confirmReady({ type: "ready_ack", server: "machine-bridge-mcp", version: "0.8.1" });
await started;
assert(events.some((event) => event.level === "info" && event.message.includes("end-to-end result delivery verified")), "relay did not report verified readiness");
const ordinarySendCount = sockets[0].sent.length;
assert(connection.send({ type: "test_ready_send" }) === true
  && JSON.parse(sockets[0].sent.at(-1)).type === "test_ready_send"
  && sockets[0].sent.length === ordinarySendCount + 1,
"verified-ready relay did not accept one ordinary business send through the public send path");
const firstRelaySession = connection.currentSessionId();
assert(firstRelaySession > 0, "authenticated relay did not receive a session generation");
let inboundMessageContext = null;
const previousOnMessage = connection.onMessage;
connection.onMessage = (data, context) => {
  inboundMessageContext = context;
  return previousOnMessage?.(data, context);
};
sockets[0].emit("message", Buffer.from(JSON.stringify({ type: "tool_call", id: "session-context-probe", tool: "list_roots", arguments: {} })));
assert(inboundMessageContext?.sessionId === firstRelaySession, "inbound relay message did not include the authenticated session generation");
assert(inboundMessageContext?.authenticated === true && inboundMessageContext?.ready === true, "ready inbound tool_call context must include ready:true after end-to-end readiness");
connection.onMessage = previousOnMessage;
const firstSessionDelivery = connection.sendForSession({ type: "tool_result", id: "first-session" }, firstRelaySession);
assert(firstSessionDelivery.ok === true, "current relay session rejected a bound result");

const warningCountBeforeBriefClose = countLevel(events, "warn");
sockets[0].remoteClose(1006, "");
scheduler.advance(5);
assert(sockets.length === 2, "relay did not schedule a reconnect");
sockets[1].open();
connection.acknowledge({ type: "hello_ack", server: "machine-bridge-mcp", version: "0.8.1" });
completeRelayReadiness(connection, "0.8.1");
const secondRelaySession = connection.currentSessionId();
assert(secondRelaySession > firstRelaySession, "reconnected relay reused the previous session generation");
const secondSocketMessagesBeforeStaleResult = sockets[1].sent.length;
const staleSessionDelivery = connection.sendForSession({ type: "tool_result", id: "stale-session" }, firstRelaySession);
assert(staleSessionDelivery.ok === false && staleSessionDelivery.reason === "session_ended", "stale result was not rejected by relay-session binding");
assert(sockets[1].sent.length === secondSocketMessagesBeforeStaleResult, "stale result was sent over the replacement relay connection");
assert(connection.sendForSession({ type: "tool_result", id: "second-session" }, secondRelaySession).ok === true, "replacement relay session rejected its own result");
assert(countLevel(events, "warn") === warningCountBeforeBriefClose, "brief interruption emitted a warning");
assert(events.some((event) => event.level === "debug" && event.message.includes("brief interruption")), "brief recovery was not available at debug level");
assert(!events.some((event) => event.level !== "debug" && hasRawCloseFields(event.fields)), "raw close fields escaped debug logging");

sockets[1].remoteClose(1006, "");
scheduler.advance(5);
assert(sockets.length === 3, "second reconnect socket was not created");
scheduler.advance(10);
const outageWarning = events.find((event) => event.level === "warn" && event.message.startsWith("remote relay WebSocket unavailable for "));
assert(outageWarning, "sustained outage did not escalate to a warning");
assert(outageWarning.message.includes("reconnecting automatically") && outageWarning.message.includes("connection interrupted"), "sustained outage warning omitted recovery behavior or the meaningful cause");
assert(outageWarning.fields?.event === "relay.outage.active"
  && outageWarning.fields.close_category === "connection_interrupted"
  && outageWarning.fields.close_code === 1006
  && outageWarning.fields.network_route_scope === "application-proxy-selection-only",
"outage warning omitted structured recovery diagnostics");
assert(!Object.hasOwn(outageWarning.fields, "close_reason"), "outage warning exposed the raw WebSocket close reason");
const outageDebug = events.find((event) => event.level === "debug" && event.message === "remote relay WebSocket outage details");
assert(outageDebug?.fields?.cause === "connection interrupted", "debug outage details omitted the classified cause");
assert(!Object.hasOwn(outageDebug?.fields || {}, "close_reason"), "outage diagnostics exposed the raw WebSocket close reason");
sockets[2].open();
connection.acknowledge({ type: "hello_ack", server: "machine-bridge-mcp", version: "0.8.1" });
completeRelayReadiness(connection, "0.8.1");
const restored = events.find((event) => event.level === "warn" && event.message.startsWith("remote relay WebSocket restored after "));
assert(restored?.message.includes("reconnect attempt"), "restored connection summary was incomplete or not user-readable");
assert(restored.fields?.event === "relay.outage.recovered"
  && restored.fields.close_category === "connection_interrupted"
  && restored.fields.network_route_scope === "application-proxy-selection-only",
"recovery summary omitted structured outage diagnostics");
assert(!Object.hasOwn(restored.fields, "close_reason"), "recovery summary exposed the raw WebSocket close reason");
const restoredDebug = events.find((event) => event.level === "debug" && event.message === "remote relay WebSocket outage recovery details");
assert(restoredDebug?.fields?.attempts >= 1 && restoredDebug.fields.outage_seconds >= 1, "debug recovery details were incomplete");

sockets[2].remoteClose(1006, "");
scheduler.advance(5);
assert(sockets.length === 4, "handshake-timeout socket was not created");
sockets[3].open();
scheduler.advance(20);
assert(sockets[3].terminated, "unacknowledged relay transport was not terminated after the handshake timeout");
connection.stop();

const transportWatchdogScheduler = new ManualScheduler();
const transportWatchdogSockets = [];
const transportWatchdogEvents = [];
const transportWatchdogConnection = new RelayConnection({
  workerUrl: "https://relay.example.invalid",
  secret: "test-daemon-secret-123456",
  logger: captureLogger(transportWatchdogEvents),
  WebSocketClass: class extends FakeSocket {
    constructor(url, options) {
      super(url, options);
      transportWatchdogSockets.push(this);
    }
  },
  scheduler: transportWatchdogScheduler,
  now: () => transportWatchdogScheduler.now,
  reconnectDelay: () => 100,
  transportConfirmationTimeoutMs: 15_000,
  outageWarnAfterMs: 100,
});
transportWatchdogConnection.start();
transportWatchdogSockets[0].open();
transportWatchdogConnection.acknowledge({ type: "hello_ack", server: "machine-bridge-mcp", version: "test" });
completeRelayReadiness(transportWatchdogConnection, "test");
transportWatchdogScheduler.advance(5_000);
assert(transportWatchdogSockets[0].pings.length === 1,
  "ready relay did not send the foreground-safe protocol-level transport probe within five seconds");
assert(transportWatchdogSockets[0].sent.every((value) => JSON.parse(value).type !== "heartbeat"),
  "transport probe woke the Worker through the application heartbeat path");
transportWatchdogSockets[0].emit("pong");
for (let index = 0; index < 4; index += 1) {
  transportWatchdogScheduler.advance(5_000);
  assert(!transportWatchdogSockets[0].terminated,
    "fresh protocol-level pong did not preserve a proven-live transport");
  transportWatchdogSockets[0].emit("pong");
}
assert(transportWatchdogSockets[0].sent.some((value) => JSON.parse(value).type === "heartbeat"),
  "fast transport watchdog displaced the low-frequency application heartbeat required for Worker liveness");
transportWatchdogSockets[0].bufferedAmount = 4096;
transportWatchdogScheduler.advance(10_000);
assert(!transportWatchdogSockets[0].terminated,
  "transport watchdog spent the ten-second Pong deadline from prior inbound silence instead of from probe dispatch");
assert(transportWatchdogSockets[0].pings.length === 6,
  "transport watchdog duplicated or lost the outstanding probe before its full response deadline");
transportWatchdogScheduler.advance(5_000);
assert(!transportWatchdogSockets[0].terminated,
  "one missed protocol Pong still hard-terminated a relay before independent application confirmation");
assert(JSON.parse(transportWatchdogSockets[0].sent.at(-1)).type === "heartbeat",
  "first protocol-Pong miss did not request independent application-layer liveness confirmation");
assert(transportWatchdogConnection.status().heartbeat?.transport_confirmation_pending === true
  && transportWatchdogConnection.status().heartbeat?.transport_confirmation_timeout_ms === 15_000,
"transport watchdog did not expose the bounded second-stage confirmation window");
assert(transportWatchdogEvents.some((event) => event.level === "warn"
  && event.fields?.event === "relay.transport.suspect"
  && event.fields?.confirmation_timeout_ms === 15_000),
"transport suspicion did not emit structured evidence before reconnecting");
transportWatchdogScheduler.advance(10_000);
assert(!transportWatchdogSockets[0].terminated,
  "black-holed relay was terminated before the full application-confirmation window elapsed");
transportWatchdogScheduler.advance(5_000);
assert(transportWatchdogSockets[0].terminated,
  "black-holed ready relay survived the bounded protocol-plus-application confirmation window");
const transportWatchdogStatus = transportWatchdogConnection.status();
assert(transportWatchdogStatus.last_close_category === "relay_transport_timeout"
  && transportWatchdogStatus.connect_timeout_ms === 30_000
  && transportWatchdogStatus.last_ready_inbound_silence_ms === 30_000
  && transportWatchdogStatus.heartbeat?.last_probe_buffered_bytes === 4096
  && transportWatchdogStatus.heartbeat?.max_probe_buffered_bytes === 4096
  && transportWatchdogStatus.heartbeat?.probe_outstanding === false
  && transportWatchdogStatus.heartbeat?.last_probe_timeout_age_ms === 10_000
  && transportWatchdogStatus.heartbeat?.transport_confirmation_pending === false
  && transportWatchdogStatus.heartbeat?.last_transport_confirmation_timeout_age_ms === 15_000
  && transportWatchdogStatus.heartbeat?.interval_ms === 5_000
  && transportWatchdogStatus.heartbeat?.timeout_ms === 10_000
  && transportWatchdogStatus.application_heartbeat_interval_ms === 25_000
  && transportWatchdogStatus.application_heartbeat_timeout_ms === 75_000
  && transportWatchdogStatus.heartbeat?.application_heartbeat_timeout_ms === 75_000,
"transport watchdog diagnostics lost the fast half-open contract or the pre-disconnect silence evidence");
assert(transportWatchdogEvents.some((event) => event.level === "warn"
  && event.fields?.event === "relay.transport.confirmation_failed"
  && event.fields?.confirmation_age_ms === 15_000),
"confirmed transport blackhole did not emit structured second-stage failure evidence");
transportWatchdogConnection.stop();

{
  const scheduler = new ManualScheduler();
  const sockets = [];
  const recoveryEvents = [];
  let connection;
  connection = new RelayConnection({
    workerUrl: "https://relay.example.invalid", logger: captureLogger(recoveryEvents),
    WebSocketClass: class extends FakeSocket { constructor(url, options) { super(url, options); sockets.push(this); } },
    scheduler, now: () => scheduler.now, reconnectDelay: () => 100,
    transportPingIntervalMs: 5, transportPongTimeoutMs: 10, transportConfirmationTimeoutMs: 15,
    applicationHeartbeatIntervalMs: 100, applicationHeartbeatTimeoutMs: 300,
    onMessage: (raw, context) => {
      const message = JSON.parse(Buffer.from(raw).toString("utf8"));
      if (message.type === "pong") connection.observeApplicationPong(context);
    },
  });
  connection.start(); sockets[0].open();
  connection.acknowledge({ type: "hello_ack", server: "machine-bridge-mcp", version: "test" });
  completeRelayReadiness(connection, "test");
  scheduler.advance(5);
  scheduler.advance(10);
  assert(!sockets[0].terminated && connection.status().heartbeat?.transport_confirmation_pending === true,
    "transient transport silence did not enter second-stage confirmation");
  sockets[0].emit("message", Buffer.from(JSON.stringify({ type: "tool_call", id: "call_inbound_only" })));
  assert(connection.status().heartbeat?.transport_confirmation_pending === true,
    "unrelated inbound application traffic falsely proved the daemon-to-Worker transport direction");
  sockets[0].emit("message", Buffer.from(JSON.stringify({ type: "pong", ts: scheduler.now })));
  assert(connection.status().heartbeat?.transport_confirmation_pending === false,
    "application pong did not clear transport suspicion immediately");
  assert(recoveryEvents.some((event) => event.level === "warn"
    && event.fields?.event === "relay.transport.recovered"
    && event.fields?.transport_confirmed === true),
  "application confirmation recovery did not emit structured transport evidence");
  scheduler.advance(5); sockets[0].emit("pong");
  scheduler.advance(10); sockets[0].emit("pong");
  assert(!sockets[0].terminated,
    "relay was terminated after independent application traffic had disproved the transport timeout");
  assert(connection.status().recent_outages.length === 0,
    "transport suspicion recovered without reconnect was incorrectly recorded as a completed outage");
  connection.stop();
}

{
  class DelayedConfirmationSocket extends FakeSocket {
    send(value, callback) {
      const text = String(value);
      if (typeof callback === "function" && JSON.parse(text).type === "heartbeat") {
        if (this.readyState !== FakeSocket.OPEN) throw new Error("socket is not open");
        this.sent.push(text); this.confirmationCallback = callback; return;
      }
      super.send(text, callback);
    }
    flushConfirmation(error = null) {
      const callback = this.confirmationCallback; this.confirmationCallback = null; callback?.(error);
    }
  }
  const scheduler = new ManualScheduler(); const sockets = [];
  const connection = new RelayConnection({
    workerUrl: "https://relay.example.invalid", logger: captureLogger([]),
    WebSocketClass: class extends DelayedConfirmationSocket { constructor(url, options) { super(url, options); sockets.push(this); } },
    scheduler, now: () => scheduler.now, reconnectDelay: () => 100,
    transportPingIntervalMs: 5, transportPongTimeoutMs: 10, transportConfirmationTimeoutMs: 15,
    transportPingDispatchTimeoutMs: 30, applicationHeartbeatIntervalMs: 100, applicationHeartbeatTimeoutMs: 300,
  });
  connection.start(); sockets[0].open();
  connection.acknowledge({ type: "hello_ack", server: "machine-bridge-mcp", version: "test" });
  completeRelayReadiness(connection, "test");
  scheduler.advance(15);
  assert(connection.status().heartbeat?.transport_confirmation_dispatch_pending === true,
    "second-stage confirmation treated queued application heartbeat as already dispatched");
  scheduler.advance(25);
  assert(!sockets[0].terminated,
    "second-stage response deadline was spent while its application heartbeat was still queued locally");
  sockets[0].flushConfirmation();
  assert(connection.status().heartbeat?.transport_confirmation_dispatch_pending === false
    && connection.status().heartbeat?.transport_confirmation_age_ms === 0
    && connection.status().heartbeat?.last_transport_confirmation_dispatch_ms === 25,
  "second-stage confirmation did not start its response clock from actual sender completion");
  scheduler.advance(10);
  assert(!sockets[0].terminated, "dispatched confirmation lost part of its full response deadline");
  scheduler.advance(5);
  assert(sockets[0].terminated, "dispatched confirmation survived beyond its full response deadline");
  connection.stop();
}

{
  class StalledConfirmationSocket extends FakeSocket {
    send(value, callback) {
      const text = String(value);
      if (typeof callback === "function" && JSON.parse(text).type === "heartbeat") {
        if (this.readyState !== FakeSocket.OPEN) throw new Error("socket is not open");
        this.sent.push(text); return;
      }
      super.send(text, callback);
    }
  }
  const scheduler = new ManualScheduler(); const sockets = []; const events = [];
  const connection = new RelayConnection({
    workerUrl: "https://relay.example.invalid", logger: captureLogger(events),
    WebSocketClass: class extends StalledConfirmationSocket { constructor(url, options) { super(url, options); sockets.push(this); } },
    scheduler, now: () => scheduler.now, reconnectDelay: () => 100,
    transportPingIntervalMs: 5, transportPongTimeoutMs: 10, transportConfirmationTimeoutMs: 15,
    transportPingDispatchTimeoutMs: 30, applicationHeartbeatIntervalMs: 100, applicationHeartbeatTimeoutMs: 300,
  });
  connection.start(); sockets[0].open();
  connection.acknowledge({ type: "hello_ack", server: "machine-bridge-mcp", version: "test" });
  completeRelayReadiness(connection, "test"); scheduler.advance(45);
  assert(sockets[0].terminated && connection.status().last_close_category === "relay_transport_send_timeout",
    "stalled second-stage confirmation send was misclassified as remote response loss");
  assert(connection.status().heartbeat?.last_transport_confirmation_dispatch_timeout_age_ms === 30,
    "stalled confirmation send lost its bounded dispatch-timeout evidence");
  assert(events.some((event) => event.fields?.event === "relay.transport.confirmation_send_timeout"),
    "stalled confirmation send did not emit its distinct structured event");
  connection.stop();
}

const delayedPingScheduler = new ManualScheduler();
const delayedPingSockets = [];
class DelayedPingSocket extends FakeSocket {
  constructor(url, options) {
    super(url, options);
    this.pendingPingCallbacks = [];
  }
  ping(value = "", callback) {
    if (this.readyState !== FakeSocket.OPEN) throw new Error("socket is not open");
    if (typeof value === "function") { callback = value; value = ""; }
    this.pings.push(String(value));
    this.pendingPingCallbacks.push(callback);
  }
  flushPing(error = null) {
    const callback = this.pendingPingCallbacks.shift();
    callback?.(error);
  }
}
const delayedPingConnection = new RelayConnection({
  workerUrl: "https://relay.example.invalid",
  logger: captureLogger([]),
  WebSocketClass: class extends DelayedPingSocket {
    constructor(url, options) { super(url, options); delayedPingSockets.push(this); }
  },
  scheduler: delayedPingScheduler,
  now: () => delayedPingScheduler.now,
  reconnectDelay: () => 100,
  transportPingIntervalMs: 5,
  transportPongTimeoutMs: 10,
  transportConfirmationTimeoutMs: 15,
  transportPingDispatchTimeoutMs: 30,
  applicationHeartbeatIntervalMs: 100,
  applicationHeartbeatTimeoutMs: 300,
});
delayedPingConnection.start();
delayedPingSockets[0].open();
delayedPingConnection.acknowledge({ type: "hello_ack", server: "machine-bridge-mcp", version: "test" });
completeRelayReadiness(delayedPingConnection, "test");
delayedPingScheduler.advance(5);
assert(delayedPingSockets[0].pings.length === 1, "delayed-ping fixture did not queue the transport probe");
delayedPingScheduler.advance(10);
assert(!delayedPingSockets[0].terminated,
  "transport Pong deadline started before the queued ping was actually dispatched");
delayedPingSockets[0].flushPing();
assert(delayedPingConnection.status().heartbeat?.last_probe_dispatch_ms === 10,
  "transport probe did not record its local dispatch delay");
delayedPingScheduler.advance(5);
assert(!delayedPingSockets[0].terminated,
  "transport probe timed out before the full Pong deadline elapsed from actual dispatch");
delayedPingScheduler.advance(5);
assert(!delayedPingSockets[0].terminated
  && delayedPingConnection.status().heartbeat?.transport_confirmation_pending === true,
"transport probe did not enter independent confirmation after the Pong deadline from actual dispatch");
delayedPingScheduler.advance(15);
assert(delayedPingSockets[0].terminated && delayedPingConnection.status().last_close_category === "relay_transport_timeout",
  "transport probe did not enforce the second-stage confirmation deadline after actual dispatch");
delayedPingConnection.stop();

{
  const scheduler = new ManualScheduler();
  const sockets = [];
  const connection = new RelayConnection({
    workerUrl: "https://relay.example.invalid", logger: captureLogger([]),
    WebSocketClass: class extends DelayedPingSocket { constructor(url, options) { super(url, options); sockets.push(this); } },
    scheduler, now: () => scheduler.now, reconnectDelay: () => 100,
    transportPingIntervalMs: 5, transportPongTimeoutMs: 10, transportPingDispatchTimeoutMs: 30,
    applicationHeartbeatIntervalMs: 100, applicationHeartbeatTimeoutMs: 300,
  });
  connection.start(); sockets[0].open();
  connection.acknowledge({ type: "hello_ack", server: "machine-bridge-mcp", version: "test" });
  completeRelayReadiness(connection, "test");
  scheduler.advance(5);
  sockets[0].flushPing(Object.assign(new Error("reset during Ping write"), { code: "ECONNRESET" }));
  const failedPing = connection.status();
  assert(sockets[0].terminated
    && failedPing.last_close_category === "relay_transport_error"
    && failedPing.last_transport_error_class === "network_error"
    && failedPing.last_transport_error_reason === "connection_reset",
  "Ping sender callback error did not enter the transport-error reconnect path with bounded cause evidence");
  connection.stop();
}

{
  const scheduler = new ManualScheduler();
  const sockets = [];
  const connection = new RelayConnection({
    workerUrl: "https://relay.example.invalid", logger: captureLogger([]),
    WebSocketClass: class extends DelayedPingSocket { constructor(url, options) { super(url, options); sockets.push(this); } },
    scheduler, now: () => scheduler.now, reconnectDelay: () => 100,
    transportPingIntervalMs: 5, transportPongTimeoutMs: 10, transportPingDispatchTimeoutMs: 30,
    applicationHeartbeatIntervalMs: 100, applicationHeartbeatTimeoutMs: 300,
  });
  connection.start(); sockets[0].open();
  connection.acknowledge({ type: "hello_ack", server: "machine-bridge-mcp", version: "test" });
  completeRelayReadiness(connection, "test");
  scheduler.advance(5);
  sockets[0].emit("pong");
  assert(connection.status().heartbeat?.probe_dispatch_pending === true,
    "fresh inbound transport proof forgot a Ping that was already queued in the WebSocket sender");
  scheduler.advance(29);
  assert(!sockets[0].terminated && connection.status().heartbeat?.probe_dispatch_pending === true,
    "fresh inbound proof incorrectly cancelled a still-queued Ping before its bounded dispatch deadline");
  sockets[0].flushPing();
  assert(!sockets[0].terminated && connection.status().heartbeat?.probe_dispatch_pending === false,
    "a queued Ping that completed inside its dispatch budget was treated as a transport send failure");
  assert(sockets[0].pings.length === 1,
    "fresh inbound transport proof caused a duplicate Ping while the earlier control frame was still queued");
  const afterInboundRace = connection.status().heartbeat;
  assert(afterInboundRace?.probe_dispatch_pending === false && afterInboundRace?.probe_outstanding === false,
    "inbound liveness during local probe dispatch was turned into a stale future Pong deadline");
  connection.stop();
}

{
  const scheduler = new ManualScheduler();
  const sockets = [];
  const connection = new RelayConnection({
    workerUrl: "https://relay.example.invalid", logger: captureLogger([]),
    WebSocketClass: class extends DelayedPingSocket { constructor(url, options) { super(url, options); sockets.push(this); } },
    scheduler, now: () => scheduler.now, reconnectDelay: () => 100,
    transportPingIntervalMs: 5, transportPongTimeoutMs: 10, transportPingDispatchTimeoutMs: 30,
    applicationHeartbeatIntervalMs: 100, applicationHeartbeatTimeoutMs: 300,
  });
  connection.start(); sockets[0].open();
  connection.acknowledge({ type: "hello_ack", server: "machine-bridge-mcp", version: "test" });
  completeRelayReadiness(connection, "test");
  scheduler.advance(5);
  sockets[0].emit("pong");
  scheduler.advance(30);
  assert(sockets[0].terminated
    && connection.status().last_close_category === "relay_transport_send_timeout"
    && connection.status().heartbeat?.last_probe_dispatch_timeout_age_ms === 30,
  "fresh inbound traffic incorrectly masked a thirty-second local WebSocket send-queue stall");
  connection.stop();
}

{
  const scheduler = new ManualScheduler();
  const sockets = [];
  const connection = new RelayConnection({
    workerUrl: "https://relay.example.invalid", logger: captureLogger([]),
    WebSocketClass: class extends DelayedPingSocket { constructor(url, options) { super(url, options); sockets.push(this); } },
    scheduler, now: () => scheduler.now, reconnectDelay: () => 100,
    transportPingIntervalMs: 5, transportPongTimeoutMs: 10, transportPingDispatchTimeoutMs: 5,
    applicationHeartbeatIntervalMs: 100, applicationHeartbeatTimeoutMs: 300,
  });
  connection.start(); sockets[0].open();
  connection.acknowledge({ type: "hello_ack", server: "machine-bridge-mcp", version: "test" });
  completeRelayReadiness(connection, "test");
  scheduler.advance(5);
  scheduler.advance(5);
  const dispatchTimeout = connection.status();
  assert(sockets[0].terminated && dispatchTimeout.last_close_category === "relay_transport_send_timeout"
    && dispatchTimeout.heartbeat?.last_probe_dispatch_timeout_age_ms === 5
    && dispatchTimeout.heartbeat?.probe_dispatch_pending === false,
  "locally stalled WebSocket Ping dispatch did not enter the bounded transport-recovery path");
  connection.stop();
}

const applicationLivenessScheduler = new ManualScheduler();
const applicationLivenessSockets = [];
const applicationLivenessConnection = new RelayConnection({
  workerUrl: "https://relay.example.invalid",
  secret: "test-daemon-secret-123456",
  logger: captureLogger([]),
  WebSocketClass: class extends FakeSocket {
    constructor(url, options) {
      super(url, options);
      applicationLivenessSockets.push(this);
    }
  },
  scheduler: applicationLivenessScheduler,
  now: () => applicationLivenessScheduler.now,
  reconnectDelay: () => 100,
  transportPingIntervalMs: 5,
  transportPongTimeoutMs: 15,
  applicationHeartbeatIntervalMs: 5,
  applicationHeartbeatTimeoutMs: 15,
  outageWarnAfterMs: 100,
});
applicationLivenessConnection.start();
applicationLivenessSockets[0].open();
applicationLivenessConnection.acknowledge({ type: "hello_ack", server: "machine-bridge-mcp", version: "test" });
completeRelayReadiness(applicationLivenessConnection, "test");
for (let index = 0; index < 2; index += 1) {
  applicationLivenessScheduler.advance(5);
  applicationLivenessSockets[0].emit("pong");
  assert(!applicationLivenessSockets[0].terminated,
    "healthy protocol-level Pong was incorrectly treated as application-heartbeat failure before its deadline");
}
applicationLivenessScheduler.advance(5);
assert(applicationLivenessSockets[0].terminated
  && applicationLivenessConnection.status().last_close_category === "relay_heartbeat_timeout",
"protocol-level Pong incorrectly masked a silent Worker application path");
applicationLivenessConnection.stop();

const heartbeatScheduler = new ManualScheduler();
const heartbeatSockets = [];
let heartbeatConnection;
heartbeatConnection = new RelayConnection({
  workerUrl: "https://relay.example.invalid",
  secret: "test-daemon-secret-123456",
  logger: captureLogger([]),
  WebSocketClass: class extends FakeSocket {
    constructor(url, options) {
      super(url, options);
      heartbeatSockets.push(this);
    }
  },
  scheduler: heartbeatScheduler,
  now: () => heartbeatScheduler.now,
  reconnectDelay: () => 100,
  handshakeTimeoutMs: 20,
  heartbeatIntervalMs: 5,
  heartbeatTimeoutMs: 10,
  transportConfirmationTimeoutMs: 10,
  outageWarnAfterMs: 100,
});
heartbeatConnection.start();
heartbeatSockets[0].open();
heartbeatConnection.acknowledge({ type: "hello_ack", server: "machine-bridge-mcp", version: "test" });
completeRelayReadiness(heartbeatConnection, "test");
heartbeatScheduler.advance(10);
assert(!heartbeatSockets[0].terminated,
  "legacy heartbeat options spent the transport response timeout before the probe was dispatched");
heartbeatScheduler.advance(5);
assert(!heartbeatSockets[0].terminated && heartbeatConnection.status().heartbeat?.transport_confirmation_pending === true,
  "legacy heartbeat aliases bypassed second-stage application confirmation after the transport response timeout");
heartbeatScheduler.advance(10);
assert(heartbeatSockets[0].terminated,
  "silent relay connection survived the legacy probe deadline plus bounded application confirmation");
heartbeatConnection.stop();

const stalledHeartbeatScheduler = new ManualScheduler();
const stalledHeartbeatSockets = [];
const stalledHeartbeatEvents = [];
const stalledHeartbeatWallBase = Date.UTC(2026, 7, 19, 5, 0, 0);
const stalledHeartbeatConnection = new RelayConnection({
  workerUrl: "https://relay.example.invalid",
  logger: captureLogger(stalledHeartbeatEvents),
  WebSocketClass: class extends FakeSocket {
    constructor(url, options) {
      super(url, options);
      stalledHeartbeatSockets.push(this);
    }
  },
  scheduler: stalledHeartbeatScheduler,
  now: () => stalledHeartbeatScheduler.now,
  wallNow: () => stalledHeartbeatWallBase + stalledHeartbeatScheduler.now,
  reconnectDelay: () => 100,
  heartbeatIntervalMs: 5,
  heartbeatTimeoutMs: 10,
  applicationHeartbeatIntervalMs: 5,
  applicationHeartbeatTimeoutMs: 10,
  heartbeatStallThresholdMs: 5,
  heartbeatRecoveryGraceMs: 10,
  handshakeTimeoutMs: 20,
  outageWarnAfterMs: 100,
});
stalledHeartbeatConnection.start();
stalledHeartbeatSockets[0].open();
stalledHeartbeatConnection.acknowledge({ type: "hello_ack", server: "machine-bridge-mcp", version: "test" });
completeRelayReadiness(stalledHeartbeatConnection, "test");
stalledHeartbeatScheduler.stall(20);
assert(!stalledHeartbeatSockets[0].terminated, "local event-loop stall was misclassified as remote relay failure");
assert(stalledHeartbeatConnection.status().heartbeat.event_loop_stall_count === 1
  && stalledHeartbeatConnection.status().heartbeat.recovery_active
  && stalledHeartbeatConnection.status().heartbeat.last_event_loop_stall_at
    === new Date(stalledHeartbeatWallBase + stalledHeartbeatScheduler.now).toISOString(),
"local event-loop stall was not exposed through relay diagnostics");
assert(stalledHeartbeatEvents.some((event) => event.level === "warn"
  && event.fields?.event === "runtime.event_loop.stall"
  && event.fields?.relay_disconnect_deferred === true),
"local event-loop stall did not emit a structured recovery warning");
stalledHeartbeatSockets[0].emit("message", Buffer.from(JSON.stringify({ type: "pong" })));
stalledHeartbeatScheduler.advance(5);
assert(!stalledHeartbeatSockets[0].terminated, "fresh inbound traffic did not clear heartbeat recovery grace");
stalledHeartbeatConnection.stop();

const resumedAfterLongPauseScheduler = new ManualScheduler();
const resumedAfterLongPauseSockets = [];
const resumedAfterLongPauseEvents = [];
const resumedAfterLongPauseConnection = new RelayConnection({
  workerUrl: "https://relay.example.invalid",
  logger: captureLogger(resumedAfterLongPauseEvents),
  WebSocketClass: class extends FakeSocket {
    constructor(url, options) {
      super(url, options);
      resumedAfterLongPauseSockets.push(this);
    }
  },
  scheduler: resumedAfterLongPauseScheduler,
  now: () => resumedAfterLongPauseScheduler.now,
  reconnectDelay: () => 5,
  heartbeatIntervalMs: 5,
  heartbeatTimeoutMs: 10,
  heartbeatStallThresholdMs: 5,
  heartbeatRecoveryGraceMs: 10,
  handshakeTimeoutMs: 20,
  outageWarnAfterMs: 100,
});
resumedAfterLongPauseConnection.start();
resumedAfterLongPauseSockets[0].open();
resumedAfterLongPauseConnection.acknowledge({ type: "hello_ack", server: "machine-bridge-mcp", version: "test" });
completeRelayReadiness(resumedAfterLongPauseConnection, "test");
resumedAfterLongPauseScheduler.now += 26;
resumedAfterLongPauseSockets[0].emit("message", "fresh-after-pause");
resumedAfterLongPauseScheduler.stall(0);
assert(!resumedAfterLongPauseSockets[0].terminated,
  "fresh inbound relay traffic after a long local pause did not preserve a proven-live socket");
resumedAfterLongPauseScheduler.stall(26);
assert(resumedAfterLongPauseSockets[0].terminated,
  "relay retained a stale socket after a local pause exceeded both heartbeat timeout and recovery grace");
assert(resumedAfterLongPauseEvents.some((event) => event.level === "warn"
  && event.fields?.event === "runtime.event_loop.stall"
  && event.fields?.relay_disconnect_deferred === false),
"long local pause did not expose immediate relay recovery through structured diagnostics");
resumedAfterLongPauseScheduler.advance(5);
assert(resumedAfterLongPauseSockets.length === 2, "long local pause did not enter reconnect immediately");
resumedAfterLongPauseConnection.stop();

{
  const scheduler = new ManualScheduler();
  const sockets = [];
  const connection = new RelayConnection({
    workerUrl: "https://relay.example.invalid", logger: captureLogger([]),
    WebSocketClass: class extends FakeSocket { constructor(url, options) { super(url, options); sockets.push(this); } },
    scheduler, now: () => scheduler.now, reconnectDelay: () => 5,
    transportPingIntervalMs: 5, transportPongTimeoutMs: 10,
    applicationHeartbeatIntervalMs: 5, applicationHeartbeatTimeoutMs: 20,
    readinessTimeoutMs: 30,
  });
  connection.start(); sockets[0].open();
  connection.acknowledge({ type: "hello_ack", server: "machine-bridge-mcp", version: "test" });
  scheduler.advance(5); sockets[0].emit("pong");
  scheduler.advance(5); sockets[0].emit("pong");
  assert(sockets[0].sent.every((value) => JSON.parse(value).type !== "heartbeat"),
    "authenticated-but-probing relay sent application heartbeat before Worker readiness");
  completeRelayReadiness(connection, "test");
  scheduler.advance(5); sockets[0].emit("pong");
  assert(sockets[0].sent.some((value) => JSON.parse(value).type === "heartbeat"),
    "application heartbeat did not begin after verified relay readiness");
  connection.stop();
}

const readinessScheduler = new ManualScheduler();
const readinessSockets = [];
const readinessConnection = new RelayConnection({
  workerUrl: "https://relay.example.invalid",
  secret: "test-daemon-secret-123456",
  logger: captureLogger([]),
  WebSocketClass: class extends FakeSocket {
    constructor(url, options) {
      super(url, options);
      readinessSockets.push(this);
    }
  },
  scheduler: readinessScheduler,
  now: () => readinessScheduler.now,
  reconnectDelay: () => 5,
  handshakeTimeoutMs: 20,
  readinessTimeoutMs: 15,
  outageWarnAfterMs: 100,
});
readinessConnection.start();
readinessSockets[0].open();
readinessConnection.acknowledge({ type: "hello_ack", server: "machine-bridge-mcp", version: "test" });
assert(readinessConnection.status().authenticated && !readinessConnection.status().ready, "readiness timeout fixture did not enter probing state");
readinessScheduler.advance(15);
assert(readinessSockets[0].terminated, "relay with no end-to-end readiness acknowledgement was not terminated");
readinessScheduler.advance(5);
assert(readinessSockets.length === 2, "readiness timeout did not enter reconnect backoff");
readinessConnection.stop();

const prematureReadySockets = [];
const prematureReadyConnection = new RelayConnection({
  workerUrl: "https://relay.example.invalid",
  secret: "test-daemon-secret-123456",
  logger: captureLogger([]),
  WebSocketClass: class extends FakeSocket {
    constructor(url, options) {
      super(url, options);
      prematureReadySockets.push(this);
    }
  },
  expectedServer: "machine-bridge-mcp",
  expectedVersion: "test",
});
const prematureReadyStarted = prematureReadyConnection.start();
prematureReadySockets[0].open();
prematureReadyConnection.acknowledge({ type: "hello_ack", server: "machine-bridge-mcp", version: "test" });
assert(prematureReadyConnection.confirmReady({ type: "ready_ack", server: "machine-bridge-mcp", version: "test" }) === false, "relay accepted ready_ack before delivering its readiness probe result");
const prematureReadyError = await prematureReadyStarted.then(() => null, (error) => error);
assert(prematureReadyError?.code === "relay_protocol_mismatch" && prematureReadySockets[0].terminated, "premature ready_ack did not fail closed");

const errorScheduler = new ManualScheduler();
const errorSockets = [];
const errorConnection = new RelayConnection({
  workerUrl: "https://relay.example.invalid",
  secret: "test-daemon-secret-123456",
  logger: captureLogger([]),
  WebSocketClass: class extends FakeSocket {
    constructor(url, options) {
      super(url, options);
      errorSockets.push(this);
    }
  },
  scheduler: errorScheduler,
  now: () => errorScheduler.now,
  reconnectDelay: () => 5,
  outageWarnAfterMs: 100,
});
errorConnection.start();
errorSockets[0].open();
errorConnection.acknowledge({ type: "hello_ack", server: "machine-bridge-mcp", version: "test" });
completeRelayReadiness(errorConnection, "test");
errorSockets[0].fail(Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" }));
assert(errorSockets[0].terminated, "relay transport error did not force the close/reconnect path");
assert(errorConnection.status().last_transport_error_class === "network_error"
  && errorConnection.status().last_transport_error_reason === "connection_reset"
  && errorConnection.status().last_transport_error_ready === true
  && errorConnection.status().last_transport_error_authenticated === true,
"ready-transport network failure lost its authenticated/ready context");
errorScheduler.advance(5);
assert(errorSockets.length === 2, "relay transport error did not schedule a reconnect");
errorConnection.stop();

{
  const classifiedScheduler = new ManualScheduler();
  const classifiedSockets = [];
  const classifiedConnection = new RelayConnection({
    workerUrl: "https://relay.example.invalid",
    logger: captureLogger([]),
    WebSocketClass: class extends FakeSocket {
      constructor(url, options) {
        super(url, options);
        classifiedSockets.push(this);
      }
      terminate() { this.terminated = true; }
    },
    scheduler: classifiedScheduler,
    now: () => classifiedScheduler.now,
    reconnectDelay: () => 5,
  });
  const classifiedReady = classifiedConnection.start();
  classifiedSockets[0].open();
  classifiedConnection.acknowledge({ type: "hello_ack", server: "machine-bridge-mcp", version: "test" });
  completeRelayReadiness(classifiedConnection, "test");
  await classifiedReady;
  const classifiedSession = classifiedConnection.currentSessionId();
  assert(classifiedConnection.interrupt("relay_readiness_timeout"), "classified interruption was not initiated");
  classifiedConnection.handleServerError({ type: "error", error: "daemon_liveness_timeout" });
  classifiedSockets[0].send = () => { throw new Error("late send failure"); };
  assert(classifiedConnection.sendForSession({ type: "tool_result", id: "late-send" }, classifiedSession).reason === "send_failed",
    "late send failure did not enter the bounded send-failure path");
  classifiedSockets[0].fail(Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" }));
  classifiedSockets[0].remoteClose(1006, "");
  assert(classifiedConnection.status().last_close_category === "relay_readiness_timeout",
    "a later close signal overwrote the first specific relay close category");
  classifiedConnection.stop();
}

{
  const durationScheduler = new ManualScheduler();
  const durationSockets = [];
  const durationConnection = new RelayConnection({
    workerUrl: "https://relay.example.invalid",
    logger: captureLogger([]),
    WebSocketClass: class extends FakeSocket {
      constructor(url, options) { super(url, options); durationSockets.push(this); }
    },
    scheduler: durationScheduler,
    now: () => durationScheduler.now,
    reconnectDelay: () => 5,
    handshakeTimeoutMs: 10,
  });
  const durationReady = durationConnection.start();
  durationSockets[0].open();
  durationConnection.acknowledge({ type: "hello_ack", server: "machine-bridge-mcp", version: "test" });
  completeRelayReadiness(durationConnection, "test");
  await durationReady;
  durationScheduler.advance(100);
  durationSockets[0].remoteClose(1006, "");
  const healthyDuration = durationConnection.status().last_ready_duration_ms;
  durationScheduler.advance(5);
  durationSockets[1].open();
  durationScheduler.advance(10);
  assert(durationConnection.status().last_ready_duration_ms === healthyDuration && healthyDuration === 100,
    "failed reconnect attempt erased the previous healthy ready duration");
  durationConnection.stop();
}

const deliveryScheduler = new ManualScheduler();
const deliverySockets = [];
const deliveryConnection = new RelayConnection({
  workerUrl: "https://relay.example.invalid",
  secret: "test-daemon-secret-123456",
  logger: captureLogger([]),
  WebSocketClass: class extends FakeSocket {
    constructor(url, options) {
      super(url, options);
      deliverySockets.push(this);
    }
  },
  scheduler: deliveryScheduler,
  now: () => deliveryScheduler.now,
  reconnectDelay: () => 5,
  outageWarnAfterMs: 100,
});
deliveryConnection.start();
deliverySockets[0].open();
deliveryConnection.acknowledge({ type: "hello_ack", server: "machine-bridge-mcp", version: "test" });
completeRelayReadiness(deliveryConnection, "test");
assert(deliveryConnection.interrupt("relay_transport_error"), "terminal-delivery failure could not interrupt the active relay");
assert(deliverySockets[0].terminated, "terminal-delivery failure left the ambiguous relay socket open");
deliveryScheduler.advance(5);
assert(deliverySockets.length === 2, "terminal-delivery failure did not enter reconnect backoff");
deliveryConnection.stop();

const constructorScheduler = new ManualScheduler();
let constructorAttempts = 0;
const constructorSockets = [];
const constructorConnection = new RelayConnection({
  workerUrl: "https://relay.example.invalid",
  secret: "test-daemon-secret-123456",
  logger: captureLogger([]),
  WebSocketClass: class extends FakeSocket {
    constructor(url, options) {
      constructorAttempts += 1;
      if (constructorAttempts === 1) throw Object.assign(new Error("network unavailable"), { code: "ENETUNREACH" });
      super(url, options);
      constructorSockets.push(this);
    }
  },
  scheduler: constructorScheduler,
  now: () => constructorScheduler.now,
  reconnectDelay: () => 5,
  outageWarnAfterMs: 100,
});
constructorConnection.start();
assert(constructorConnection.status().last_transport_error_reason === "network_unreachable"
  && constructorConnection.status().last_failed_connect_stage === "tcp_connecting",
"pre-WebSocket network failure lost its privacy-safe errno class or last-entered connect phase");
constructorScheduler.advance(5);
assert(constructorAttempts === 2 && constructorSockets.length === 1, "synchronous WebSocket construction failure did not use reconnect backoff");
constructorConnection.stop();

const expiredSessionScheduler = new ManualScheduler();
const expiredSessionSockets = [];
let sessionExpired = false;
let expiredSessionFatal = null;
const expiredSessionConnection = new RelayConnection({
  workerUrl: "https://relay.example.invalid",
  logger: captureLogger([]),
  connectionHeaders: () => {
    if (sessionExpired) throw Object.assign(new Error("device session certificate expired"), { code: "device_session_expired" });
    return {};
  },
  WebSocketClass: class extends FakeSocket {
    constructor(url, options) { super(url, options); expiredSessionSockets.push(this); }
  },
  scheduler: expiredSessionScheduler,
  now: () => expiredSessionScheduler.now,
  reconnectDelay: () => 1,
  onFatal: (error) => { expiredSessionFatal = error; },
});
expiredSessionConnection.start();
expiredSessionSockets[0].open();
expiredSessionConnection.acknowledge({ type: "hello_ack", server: "machine-bridge-mcp", version: "test" });
completeRelayReadiness(expiredSessionConnection, "test");
sessionExpired = true;
expiredSessionSockets[0].remoteClose(1006, "");
expiredSessionScheduler.advance(1);
await Promise.resolve();
assert(expiredSessionConnection.status().closed === true
  && expiredSessionFatal?.code === "relay_device_session_expired"
  && expiredSessionSockets.length === 1,
"expired daemon session entered an unrecoverable reconnect loop instead of requesting supervised restart");

const expiredProofScheduler = new ManualScheduler();
const expiredProofSockets = [];
let expiredProofFatal = null;
let expireProof = false;
const expiredProofConnection = new RelayConnection({
  workerUrl: "https://relay.example.invalid", logger: captureLogger([]),
  expectedServer: "machine-bridge-mcp", expectedVersion: "test",
  helloMessage: async () => {
    if (expireProof) throw Object.assign(new Error("device session certificate expired"), { code: "device_session_expired" });
    return { type: "hello" };
  },
  WebSocketClass: class extends FakeSocket {
    constructor(url, options) { super(url, options); expiredProofSockets.push(this); }
  },
  scheduler: expiredProofScheduler, now: () => expiredProofScheduler.now,
  reconnectDelay: () => 1,
  onFatal: (error) => { expiredProofFatal = error; },
});
expiredProofConnection.start();
expiredProofSockets[0].open();
expiredProofConnection.acknowledge({ type: "hello_ack", server: "machine-bridge-mcp", version: "test" });
completeRelayReadiness(expiredProofConnection, "test");
expireProof = true;
expiredProofSockets[0].remoteClose(1006, "");
expiredProofScheduler.advance(1);
expiredProofSockets[1].open();
assert(expiredProofConnection.observeWelcome({
  type: "welcome", server: "machine-bridge-mcp", version: "test", connection_id: TEST_CONNECTION_ID,
}), "valid welcome was rejected before the expiry-race authentication proof");
await new Promise((resolve) => { setImmediate(resolve); });
assert(expiredProofConnection.status().closed === true && expiredProofFatal?.code === "relay_device_session_expired",
  "session expiry between preflight and challenge proof was misclassified as credential rejection");

const connectingScheduler = new ManualScheduler();
const connectingSockets = [];
const connectingEvents = [];
const connectingConnection = new RelayConnection({
  workerUrl: "https://relay.example.invalid",
  secret: "test-daemon-secret-123456",
  logger: captureLogger(connectingEvents),
  WebSocketClass: class extends FakeSocket {
    constructor(url, options) {
      super(url, options);
      connectingSockets.push(this);
    }
  },
  scheduler: connectingScheduler,
  now: () => connectingScheduler.now,
  reconnectDelay: () => 5,
  connectTimeoutMs: 10,
  outageWarnAfterMs: 100,
});
connectingConnection.start();
connectingScheduler.advance(10);
assert(connectingSockets[0].terminated, "a WebSocket stuck in CONNECTING was not terminated at the connection deadline");
connectingScheduler.advance(5);
assert(connectingSockets.length === 2, "a timed-out CONNECTING socket did not enter reconnect backoff");
assert(connectingEvents.some((event) => event.level === "debug" && event.message === "remote relay transport connection timed out"), "connection-attempt timeout was not diagnosable at debug level");
connectingConnection.stop();

const stoppedStartScheduler = new ManualScheduler();
const stoppedStartSockets = [];
const stoppedStartConnection = new RelayConnection({
  workerUrl: "https://relay.example.invalid",
  secret: "test-daemon-secret-123456",
  logger: captureLogger([]),
  WebSocketClass: class extends FakeSocket {
    constructor(url, options) {
      super(url, options);
      stoppedStartSockets.push(this);
    }
  },
  scheduler: stoppedStartScheduler,
  now: () => stoppedStartScheduler.now,
  reconnectDelay: () => 5,
});
const stoppedStart = stoppedStartConnection.start();
assert(stoppedStartSockets.length === 1, "stop-before-ready fixture did not begin relay startup");
stoppedStartConnection.stop();
assert(await stoppedStart === false, "relay stop left the first-start readiness promise unsettled");
assert(stoppedStartScheduler.tasks.size === 0, "relay stop left startup timers armed after settling the pending start");

const repeatScheduler = new ManualScheduler();
const repeatSockets = [];
const repeatEvents = [];
const repeatConnection = new RelayConnection({
  workerUrl: "https://relay.example.invalid",
  secret: "test-daemon-secret-123456",
  logger: captureLogger(repeatEvents),
  WebSocketClass: class extends FakeSocket {
    constructor(url, options) {
      super(url, options);
      repeatSockets.push(this);
    }
  },
  scheduler: repeatScheduler,
  now: () => repeatScheduler.now,
  reconnectDelay: () => 1_000,
  connectTimeoutMs: 1_000,
  outageWarnAfterMs: 10,
  outageWarnRepeatMs: 20,
  outageWarnMaxRepeatMs: 40,
});
repeatConnection.start();
repeatSockets[0].open();
repeatConnection.acknowledge({ type: "hello_ack", server: "machine-bridge-mcp", version: "test" });
completeRelayReadiness(repeatConnection, "test");
repeatSockets[0].remoteClose(1006, "");
repeatScheduler.advance(10);
assert(countLevel(repeatEvents, "warn") === 1, "first sustained-outage warning did not fire on its own timer");
repeatScheduler.advance(20);
assert(countLevel(repeatEvents, "warn") === 2, "repeated outage warning depended on a new reconnect event");
repeatScheduler.advance(39);
assert(countLevel(repeatEvents, "warn") === 2, "outage warning backoff fired too early");
repeatScheduler.advance(1);
assert(countLevel(repeatEvents, "warn") === 3, "outage warning backoff did not double to the configured cap");
repeatConnection.stop();

const handshakeErrorScheduler = new ManualScheduler();
const handshakeErrorSockets = [];
let handshakeErrorFatal = false;
const handshakeErrorConnection = new RelayConnection({
  workerUrl: "https://relay.example.invalid",
  secret: "test-daemon-secret-123456",
  logger: captureLogger([]),
  WebSocketClass: class extends FakeSocket {
    constructor(url, options) {
      super(url, options);
      handshakeErrorSockets.push(this);
    }
  },
  scheduler: handshakeErrorScheduler,
  now: () => handshakeErrorScheduler.now,
  reconnectDelay: () => 5,
  connectTimeoutMs: 100,
  handshakeTimeoutMs: 100,
  outageWarnAfterMs: 100,
  onFatal: () => { handshakeErrorFatal = true; },
});
handshakeErrorConnection.start();
handshakeErrorSockets[0].open();
handshakeErrorConnection.handleServerError({ type: "error", error: "daemon_hello_timeout" });
assert(handshakeErrorSockets[0].terminated, "relay handshake-timeout error did not terminate the stale candidate");
handshakeErrorScheduler.advance(5);
assert(handshakeErrorSockets.length === 2 && !handshakeErrorFatal, "relay handshake-timeout error was misclassified as a fatal policy rejection");
handshakeErrorConnection.stop();

const mismatchScheduler = new ManualScheduler();
const mismatchSockets = [];
const mismatchEvents = [];
const mismatchConnection = new RelayConnection({
  workerUrl: "https://relay.example.invalid",
  secret: "test-daemon-secret-123456",
  logger: captureLogger(mismatchEvents),
  WebSocketClass: class extends FakeSocket {
    constructor(url, options) {
      super(url, options);
      mismatchSockets.push(this);
    }
  },
  scheduler: mismatchScheduler,
  now: () => mismatchScheduler.now,
  reconnectDelay: () => 5,
  expectedServer: "machine-bridge-mcp",
  expectedVersion: "0.8.1",
  outageWarnAfterMs: 10,
});
const mismatchStart = mismatchConnection.start();
mismatchSockets[0].open();
assert(!mismatchConnection.acknowledge({ type: "hello_ack", server: "machine-bridge-mcp", version: "0.7.1" }), "mismatched relay version was accepted");
assert(mismatchSockets[0].terminated, "mismatched relay acknowledgement did not terminate the candidate");
const mismatchError = await mismatchStart.then(() => null, (error) => error);
assert(mismatchError?.code === "relay_protocol_mismatch", "mismatched relay acknowledgement did not reject initial readiness");
mismatchScheduler.advance(100);
assert(mismatchSockets.length === 1, "non-transient relay mismatch entered the reconnect loop");
assert(!mismatchEvents.some((event) => event.level === "error"), "initial relay mismatch logged before the CLI handled the rejected start");
assert(mismatchError.message.includes("upgrade and redeploy"), "relay mismatch rejection did not provide corrective action");
mismatchConnection.stop();
assert(welcomeMismatch({ type: "welcome", server: "machine-bridge-mcp", version: "0.8.1", connection_id: TEST_CONNECTION_ID }, "machine-bridge-mcp", "0.8.1") === "", "valid relay welcome metadata was rejected");
assert(welcomeMismatch({ type: "welcome", server: "machine-bridge-mcp", version: "0.7.1", connection_id: TEST_CONNECTION_ID }, "machine-bridge-mcp", "0.8.1") === "server_version_mismatch", "relay welcome version mismatch was not classified");
assert(welcomeMismatch({ type: "welcome", server: "machine-bridge-mcp", version: "0.8.1" }, "machine-bridge-mcp", "0.8.1") === "invalid_connection_identity", "relay welcome accepted a missing takeover-generation identity");
assert(acknowledgementMismatch({ type: "hello_ack", server: "machine-bridge-mcp", version: "0.8.1" }, "machine-bridge-mcp", "0.8.1") === "", "valid relay acknowledgement was rejected");
assert(acknowledgementMismatch({ type: "hello_ack", server: "machine-bridge-mcp", version: "0.7.1" }, "machine-bridge-mcp", "0.8.1") === "server_version_mismatch", "relay version mismatch was not classified");
assert(readinessMismatch({ type: "ready_ack", server: "machine-bridge-mcp", version: "0.8.1" }, "machine-bridge-mcp", "0.8.1") === "", "valid relay readiness acknowledgement was rejected");
assert(readinessMismatch({ type: "ready_ack", server: "machine-bridge-mcp", version: "0.7.1" }, "machine-bridge-mcp", "0.8.1") === "server_version_mismatch", "relay readiness version mismatch was not classified");

let fatalCallback = false;
const fatalScheduler = new ManualScheduler();
const fatalSockets = [];
const fatalEvents = [];
const fatalConnection = new RelayConnection({
  workerUrl: "https://relay.example.invalid",
  secret: "test-daemon-secret-123456",
  logger: captureLogger(fatalEvents),
  WebSocketClass: class extends FakeSocket {
    constructor(url, options) {
      super(url, options);
      fatalSockets.push(this);
    }
  },
  scheduler: fatalScheduler,
  now: () => fatalScheduler.now,
  onFatal: () => { fatalCallback = true; },
});
await (async () => {
  const ready = fatalConnection.start();
  fatalSockets[0].open();
  fatalConnection.acknowledge({ type: "hello_ack", server: "machine-bridge-mcp", version: "test" });
  completeRelayReadiness(fatalConnection, "test");
  await ready;
})();
fatalSockets[0].fail(new Error("Unexpected server response: 401"));
await Promise.resolve();
assert(fatalCallback, "fatal relay authentication failure did not invoke the daemon exit callback");
assert(fatalEvents.some((event) => event.level === "error" && event.message.includes("verify credentials")), "fatal relay authentication error was not actionable");
fatalScheduler.advance(100_000);
assert(fatalSockets.length === 1, "fatal relay authentication failure entered the reconnect loop");
fatalConnection.stop();

let policyFatalCallback = false;
let policyDisconnectCount = 0;
const policyScheduler = new ManualScheduler();
const policySockets = [];
const policyConnection = new RelayConnection({
  workerUrl: "https://relay.example.invalid",
  secret: "test-daemon-secret-123456",
  logger: captureLogger([]),
  WebSocketClass: class extends FakeSocket {
    constructor(url, options) {
      super(url, options);
      policySockets.push(this);
    }
  },
  scheduler: policyScheduler,
  now: () => policyScheduler.now,
  onDisconnect: () => { policyDisconnectCount += 1; },
  onFatal: () => { policyFatalCallback = true; },
});
const policyReady = policyConnection.start();
policySockets[0].open();
policyConnection.acknowledge({ type: "hello_ack", server: "machine-bridge-mcp", version: "test" });
completeRelayReadiness(policyConnection, "test");
await policyReady;
policySockets[0].remoteClose(1008, "policy rejected");
await Promise.resolve();
assert(policyFatalCallback, "policy close did not invoke fatal callback");
assert(policyDisconnectCount === 1, `policy close invoked disconnect cleanup ${policyDisconnectCount} times`);
policyScheduler.advance(100_000);
assert(policySockets.length === 1, "policy close entered the reconnect loop");
policyConnection.stop();

{
  const staleProofScheduler = new ManualScheduler();
  const staleProofSockets = [];
  let rejectStaleProof;
  let staleProofFatal = false;
  const staleProof = new Promise((_resolve, reject) => { rejectStaleProof = reject; });
  const staleProofConnection = new RelayConnection({
    workerUrl: "https://relay.example.invalid",
    logger: captureLogger([]),
    WebSocketClass: class extends FakeSocket {
      constructor(url, options) {
        super(url, options);
        staleProofSockets.push(this);
      }
    },
    scheduler: staleProofScheduler,
    now: () => staleProofScheduler.now,
    reconnectDelay: () => 5,
    helloMessage: () => staleProof,
    onFatal: () => { staleProofFatal = true; },
  });
  void staleProofConnection.start().catch(() => {});
  staleProofSockets[0].open();
  staleProofConnection.observeWelcome({ type: "welcome", server: "machine-bridge-mcp", version: "test", connection_id: TEST_CONNECTION_ID });
  staleProofSockets[0].remoteClose(1006, "");
  staleProofScheduler.advance(5);
  assert(staleProofSockets.length === 2, "stale authentication proof setup did not reconnect");
  staleProofSockets[1].open();
  rejectStaleProof(new Error("old proof failed after reconnect"));
  await Promise.resolve();
  await Promise.resolve();
  assert(!staleProofFatal && staleProofConnection.status().closed === false && !staleProofSockets[1].terminated,
    "an old socket authentication failure terminated the replacement connection");
  staleProofConnection.stop();
}

{
  const helloSendScheduler = new ManualScheduler();
  const helloSendSockets = [];
  let helloSendFatal = false;
  const helloSendConnection = new RelayConnection({
    workerUrl: "https://relay.example.invalid",
    secret: "test-daemon-secret-123456",
    logger: captureLogger([]),
    WebSocketClass: class extends FakeSocket {
      constructor(url, options) {
        super(url, options);
        helloSendSockets.push(this);
      }
      send() { throw new Error("synthetic hello transport failure"); }
    },
    scheduler: helloSendScheduler,
    now: () => helloSendScheduler.now,
    reconnectDelay: () => 5,
    helloMessage: () => ({ type: "hello", tools: ["server_info"] }),
    onFatal: () => { helloSendFatal = true; },
  });
  void helloSendConnection.start().catch(() => {});
  helloSendSockets[0].open();
  helloSendConnection.observeWelcome({ type: "welcome", server: "machine-bridge-mcp", version: "test", connection_id: TEST_CONNECTION_ID });
  await Promise.resolve();
  await Promise.resolve();
  assert(!helloSendFatal, "hello send transport failure was misclassified as authentication failure");
  assert(helloSendConnection.status().last_close_category === "relay_transport_error",
    "hello send transport failure lost its retryable category");
  helloSendScheduler.advance(5);
  assert(helloSendSockets.length === 2, "hello send transport failure did not reconnect");
  helloSendConnection.stop();
}

for (const [errorCode, expectedCategory] of [
  ["daemon_transport_error", "relay_transport_error"],
  ["daemon_liveness_timeout", "relay_heartbeat_timeout"],
]) {
  const transientScheduler = new ManualScheduler();
  const transientSockets = [];
  const transientEvents = [];
  let transientFatal = false;
  let transientDisconnects = 0;
  const transientConnection = new RelayConnection({
    workerUrl: "https://relay.example.invalid",
    secret: "test-daemon-secret-123456",
    logger: captureLogger(transientEvents),
    WebSocketClass: class extends FakeSocket {
      constructor(url, options) {
        super(url, options);
        transientSockets.push(this);
      }
    },
    scheduler: transientScheduler,
    now: () => transientScheduler.now,
    reconnectDelay: () => 5,
    onFatal: () => { transientFatal = true; },
    onDisconnect: () => { transientDisconnects += 1; },
  });
  const transientReady = transientConnection.start();
  transientSockets[0].open();
  transientConnection.acknowledge({ type: "hello_ack", server: "machine-bridge-mcp", version: "test" });
  completeRelayReadiness(transientConnection, "test");
  await transientReady;
  transientConnection.handleServerError({ type: "error", error: errorCode });
  await Promise.resolve();
  assert(transientSockets[0].terminated, `${errorCode} did not terminate the stale relay socket`);
  assert(!transientFatal, `${errorCode} was misclassified as a permanent protocol failure`);
  assert(transientDisconnects === 1, `${errorCode} did not preserve normal disconnect cleanup`);
  assert(transientConnection.status().last_close_category === expectedCategory,
    `${errorCode} did not preserve its retryable outage category`);
  transientScheduler.advance(5);
  assert(transientSockets.length === 2, `${errorCode} did not enter the reconnect loop`);
  assert(!transientEvents.some((event) => event.level === "error" && event.message.includes("upgrade and redeploy")),
    `${errorCode} emitted a false protocol-upgrade instruction`);
  transientConnection.stop();
}

for (const [closeCode, closeReason, expectedCategory] of [
  [1008, "daemon pong failed", "relay_transport_error"],
  [1012, "daemon pong failed", "relay_transport_error"],
  [1008, "daemon send failed", "relay_transport_error"],
  [1012, "daemon send failed", "relay_transport_error"],
  [1008, "daemon liveness timeout", "relay_heartbeat_timeout"],
  [1012, "daemon liveness timeout", "relay_heartbeat_timeout"],
]) {
  const closeScheduler = new ManualScheduler();
  const closeSockets = [];
  let closeFatal = false;
  const closeConnection = new RelayConnection({
    workerUrl: "https://relay.example.invalid",
    secret: "test-daemon-secret-123456",
    logger: captureLogger([]),
    WebSocketClass: class extends FakeSocket {
      constructor(url, options) {
        super(url, options);
        closeSockets.push(this);
      }
    },
    scheduler: closeScheduler,
    now: () => closeScheduler.now,
    reconnectDelay: () => 5,
    onFatal: () => { closeFatal = true; },
  });
  const closeReady = closeConnection.start();
  closeSockets[0].open();
  closeConnection.acknowledge({ type: "hello_ack", server: "machine-bridge-mcp", version: "test" });
  completeRelayReadiness(closeConnection, "test");
  await closeReady;
  closeSockets[0].remoteClose(closeCode, closeReason);
  await Promise.resolve();
  assert(!closeFatal, `${closeReason} close was misclassified as a permanent policy rejection`);
  assert(closeConnection.status().last_close_category === expectedCategory,
    `${closeReason} close lost its retryable outage category`);
  closeScheduler.advance(5);
  assert(closeSockets.length === 2, `${closeReason} close did not enter the reconnect loop`);
  closeConnection.stop();
}

let protocolFatalCallback = false;
const protocolScheduler = new ManualScheduler();
const protocolSockets = [];
const protocolEvents = [];
const protocolConnection = new RelayConnection({
  workerUrl: "https://relay.example.invalid",
  secret: "test-daemon-secret-123456",
  logger: captureLogger(protocolEvents),
  WebSocketClass: class extends FakeSocket {
    constructor(url, options) {
      super(url, options);
      protocolSockets.push(this);
    }
  },
  scheduler: protocolScheduler,
  now: () => protocolScheduler.now,
  onFatal: () => { protocolFatalCallback = true; },
});
const protocolReady = protocolConnection.start();
protocolSockets[0].open();
protocolConnection.acknowledge({ type: "hello_ack", server: "machine-bridge-mcp", version: "test" });
completeRelayReadiness(protocolConnection, "test");
await protocolReady;
protocolConnection.handleServerError({ type: "error", error: "unknown_message_type" });
await Promise.resolve();
assert(protocolFatalCallback, "server protocol error did not invoke the fatal callback");
assert(protocolSockets[0].terminated, "server protocol error did not terminate the connection");
assert(protocolEvents.some((event) => event.level === "error" && event.message.includes("upgrade and redeploy")), "server protocol error was not actionable");
protocolScheduler.advance(100_000);
assert(protocolSockets.length === 1, "server protocol error incorrectly entered the reconnect loop");
protocolConnection.stop();

let superseded = false;
const supersededScheduler = new ManualScheduler();
const supersededSockets = [];
const supersededEvents = [];
const supersededConnection = new RelayConnection({
  workerUrl: "https://relay.example.invalid",
  secret: "test-daemon-secret-123456",
  logger: captureLogger(supersededEvents),
  WebSocketClass: class extends FakeSocket {
    constructor(url, options) {
      super(url, options);
      supersededSockets.push(this);
    }
  },
  scheduler: supersededScheduler,
  now: () => supersededScheduler.now,
  onSuperseded: () => { superseded = true; },
});
supersededConnection.start();
supersededSockets[0].open();
supersededConnection.acknowledge({ type: "hello_ack", server: "machine-bridge-mcp", version: "test" });
completeRelayReadiness(supersededConnection, "test");
supersededSockets[0].remoteClose(1012, "replaced by verified daemon");
await Promise.resolve();
assert(superseded, "verified replacement callback was not invoked");
assert(supersededEvents.some((event) => event.level === "warn" && event.message.includes("replaced by a newer verified instance")), "replacement warning was not actionable");
assert(isSupersededClose(1012, "replaced by verified daemon"), "replacement close classification failed");
assert(relayCloseCategory(1006, "") === "connection_interrupted", "1006 close classification was not meaningful");
assert(relayCloseCategory(1002, "protocol error") === "relay_protocol_error", "1002 close classification failed");
assert(relayCloseCategory(1008, "daemon hello timeout") === "relay_handshake_timeout", "daemon hello timeout was misclassified as an authentication failure");
assert(relayCloseCategory(1008, "daemon ready timeout") === "relay_readiness_timeout", "daemon ready timeout was misclassified");
assert(relayCloseCategory(1011, "") === "relay_internal_error", "1011 close classification failed");
assert(reconnectDelay(0, () => 0) === 1000 && reconnectDelay(99, () => 0) === 15_000, "reconnect backoff bounds changed");
assert(reconnectDelay(4, () => 0, 15_000, 15_000) === 250,
  "a connection attempt that already consumed its full deadline was followed by another full idle backoff");
assert(reconnectDelay(4, () => 0, 100, 15_000) === 15_000,
  "fast connection failures no longer retain exponential reconnect backoff");

{
  const flapScheduler = new ManualScheduler();
  const flapSockets = [];
  const reconnectAttempts = [];
  const flapConnection = new RelayConnection({
    workerUrl: "https://relay.example.invalid",
    logger: captureLogger([]),
    WebSocketClass: class extends FakeSocket {
      constructor(url, options) { super(url, options); flapSockets.push(this); }
    },
    scheduler: flapScheduler,
    now: () => flapScheduler.now,
    reconnectStableReadyMs: 5_000,
    reconnectDelay: (attempt) => { reconnectAttempts.push(attempt); return 10; },
  });
  const firstReady = flapConnection.start();
  flapSockets[0].open();
  flapConnection.acknowledge({ type: "hello_ack", server: "machine-bridge-mcp", version: "test" });
  completeRelayReadiness(flapConnection, "test");
  await firstReady;
  flapSockets[0].remoteClose(1006, "");
  assert(JSON.stringify(reconnectAttempts) === JSON.stringify([0]),
    "first relay interruption did not start from the initial reconnect backoff");
  flapScheduler.advance(10);
  flapSockets[1].open();
  flapConnection.acknowledge({ type: "hello_ack", server: "machine-bridge-mcp", version: "test" });
  completeRelayReadiness(flapConnection, "test");
  flapScheduler.advance(4_999);
  flapSockets[1].remoteClose(1006, "");
  assert(JSON.stringify(reconnectAttempts) === JSON.stringify([0, 1]),
    "a short verified-ready relay flap erased reconnect failure history before minimum uptime");
  flapScheduler.advance(10);
  flapSockets[2].open();
  flapConnection.acknowledge({ type: "hello_ack", server: "machine-bridge-mcp", version: "test" });
  completeRelayReadiness(flapConnection, "test");
  flapScheduler.advance(5_000);
  assert(flapConnection.status().reconnect_attempt === 0,
    "stable verified-ready uptime did not clear reconnect failure history");
  flapSockets[2].remoteClose(1006, "");
  assert(JSON.stringify(reconnectAttempts) === JSON.stringify([0, 1, 0]),
    "a stable verified-ready relay did not restart later reconnect backoff from its initial attempt");
  flapConnection.stop();
}

{
  const monotonicScheduler = new ManualScheduler();
  const monotonicSockets = [];
  let wallNow = Date.UTC(2026, 7, 18, 4, 0, 0);
  const monotonicConnection = new RelayConnection({
    workerUrl: "https://relay.example.invalid",
    logger: captureLogger([]),
    WebSocketClass: class extends FakeSocket {
      constructor(url, options) { super(url, options); monotonicSockets.push(this); }
    },
    scheduler: monotonicScheduler,
    now: () => monotonicScheduler.now,
    wallNow: () => wallNow,
    reconnectDelay: () => 100,
  });
  const monotonicReady = monotonicConnection.start();
  monotonicSockets[0].open();
  monotonicConnection.acknowledge({ type: "hello_ack", server: "machine-bridge-mcp", version: "test" });
  completeRelayReadiness(monotonicConnection, "test");
  await monotonicReady;
  monotonicScheduler.advance(100);
  wallNow += 7 * 24 * 60 * 60_000;
  monotonicSockets[0].remoteClose(1006, "");
  const jumpedForward = monotonicConnection.status();
  assert(jumpedForward.last_ready_duration_ms === 100 && jumpedForward.outage_duration_ms === 0,
    "wall-clock jump changed relay elapsed-duration accounting");
  assert(jumpedForward.last_disconnected_at === new Date(wallNow).toISOString()
    && jumpedForward.outage_started_at === new Date(wallNow).toISOString(),
  "operator timestamps stopped using wall clock after monotonic deadline migration");
  wallNow -= 14 * 24 * 60 * 60_000;
  monotonicScheduler.advance(50);
  assert(monotonicConnection.status().outage_duration_ms === 50,
    "backward wall-clock jump changed relay outage duration");
  monotonicConnection.stop();
}

{
  const stageScheduler = new ManualScheduler();
  const stageSockets = [];
  const stageConnection = new RelayConnection({
    workerUrl: "https://relay.example.invalid",
    logger: captureLogger([]),
    WebSocketClass: class extends FakeSocket {
      constructor(url, options) { super(url, options); stageSockets.push(this); }
    },
    scheduler: stageScheduler,
    now: () => stageScheduler.now,
    reconnectDelay: () => 100,
  });
  void stageConnection.start().catch(() => {});
  stageScheduler.advance(2);
  stageConnection.connectTiming.observe("dns_resolved");
  stageScheduler.advance(2);
  stageConnection.connectTiming.observe("tcp_connected");
  stageScheduler.advance(2);
  stageConnection.connectTiming.observe("tls_established");
  stageScheduler.advance(1);
  stageSockets[0].fail(new Error("Unexpected server response: 503"));
  const failedStage = stageConnection.status();
  assert(failedStage.last_connect_stage === "http_rejected"
    && failedStage.last_connect_http_status === 503
    && failedStage.last_connect_duration_ms === 7
    && failedStage.last_connect_milestones_ms.socket_constructing === 0
    && failedStage.last_connect_milestones_ms.dns_resolved === 2
    && failedStage.last_connect_milestones_ms.tcp_connected === 4
    && failedStage.last_connect_milestones_ms.tls_established === 6
    && failedStage.last_connect_milestones_ms.http_rejected === 7
    && failedStage.last_failed_connect_stage === "http_rejected"
    && failedStage.last_failed_connect_duration_ms === 7
    && failedStage.last_failed_connect_milestones_ms.tls_established === 6
    && failedStage.last_failed_connect_milestones_ms.http_rejected === 7
    && failedStage.last_failed_connect_http_status === 503
    && failedStage.last_transport_error_reason === "unknown"
    && failedStage.last_transport_error_ready === false
    && failedStage.last_transport_error_authenticated === false,
  "relay connection failure did not preserve bounded current/failed phase and transport-context diagnostics");
  stageConnection.stop();
}

const directProxy = proxyAgentForWebSocket("wss://relay.example.invalid/daemon/ws", () => "");
assert(directProxy.agent === null && directProxy.mode === "direct", "NO_PROXY/direct relay routing did not bypass proxy construction");
const dedicatedProxy = proxyAgentForWebSocket(
  "wss://relay.example.invalid/daemon/ws",
  () => { throw new Error("standard proxy resolution must not run when MBM_RELAY_PROXY is configured"); },
  { MBM_RELAY_PROXY: "http://proxy.example.invalid:8080", NO_PROXY: "relay.example.invalid" },
);
assert(dedicatedProxy.agent && dedicatedProxy.mode === "proxy",
  "dedicated relay proxy did not override standard proxy/NO_PROXY resolution");
const clearedDedicatedProxy = proxyAgentForWebSocket(
  "wss://relay.example.invalid/daemon/ws",
  () => "http://proxy.example.invalid:8081",
  { MBM_RELAY_PROXY: "" },
);
assert(clearedDedicatedProxy.agent && clearedDedicatedProxy.mode === "proxy",
  "empty MBM_RELAY_PROXY did not fall back to standard environment-proxy resolution");
let unsupportedProxyRejected = false;
try { proxyAgentForWebSocket("wss://relay.example.invalid/daemon/ws", () => "socks5://proxy.example.invalid:1080"); } catch (error) {
  unsupportedProxyRejected = String(error?.message || error).includes("HTTP or HTTPS");
}
assert(unsupportedProxyRejected, "unsupported relay proxy protocol was accepted");
let unsupportedDedicatedProxyRejected = false;
try {
  proxyAgentForWebSocket("wss://relay.example.invalid/daemon/ws", () => "", { MBM_RELAY_PROXY: "socks5://proxy.example.invalid:1080" });
} catch (error) {
  unsupportedDedicatedProxyRejected = error?.code === "relay_proxy_configuration"
    && String(error?.message || error).includes("HTTP or HTTPS");
}
assert(unsupportedDedicatedProxyRejected, "unsupported dedicated relay proxy protocol was accepted");

const proxyMarker = { proxy: true };
const proxySockets = [];
const proxyConnection = new RelayConnection({
  workerUrl: "https://relay.example.invalid",
  secret: "test-daemon-secret-123456",
  logger: captureLogger([]),
  WebSocketClass: class extends FakeSocket {
    constructor(url, options) {
      super(url, options);
      proxySockets.push(this);
    }
  },
  proxyAgentForUrl: () => ({ agent: proxyMarker, mode: "proxy" }),
});
proxyConnection.start();
assert(proxySockets[0].options.agent === proxyMarker && proxyConnection.status().network_route === "application-http-proxy", "relay WebSocket did not receive the selected proxy agent");
proxyConnection.stop();

{
  const previousRelayProxy = process.env.MBM_RELAY_PROXY;
  const previousNoProxy = process.env.NO_PROXY;
  const previousNoProxyLower = process.env.no_proxy;
  try {
    process.env.MBM_RELAY_PROXY = "http://proxy.example.invalid:8080";
    process.env.NO_PROXY = "relay.example.invalid";
    process.env.no_proxy = "relay.example.invalid";
    const dedicatedSockets = [];
    const dedicatedConnection = new RelayConnection({
      workerUrl: "https://relay.example.invalid",
      secret: "test-daemon-secret-123456",
      logger: captureLogger([]),
      WebSocketClass: class extends FakeSocket {
        constructor(url, options) {
          super(url, options);
          dedicatedSockets.push(this);
        }
      },
    });
    dedicatedConnection.start();
    assert(dedicatedSockets[0].options.agent && dedicatedConnection.status().network_route === "application-http-proxy",
      "default relay construction allowed NO_PROXY to bypass MBM_RELAY_PROXY");
    dedicatedConnection.stop();
  } finally {
    if (previousRelayProxy === undefined) delete process.env.MBM_RELAY_PROXY;
    else process.env.MBM_RELAY_PROXY = previousRelayProxy;
    if (previousNoProxy === undefined) delete process.env.NO_PROXY;
    else process.env.NO_PROXY = previousNoProxy;
    if (previousNoProxyLower === undefined) delete process.env.no_proxy;
    else process.env.no_proxy = previousNoProxyLower;
  }
}

const invalidProxyConnection = new RelayConnection({
  workerUrl: "https://relay.example.invalid",
  secret: "test-daemon-secret-123456",
  logger: captureLogger([]),
  WebSocketClass: FakeSocket,
  proxyAgentForUrl: () => { const error = new Error("relay proxy configuration is invalid"); error.code = "relay_proxy_configuration"; throw error; },
});
const invalidProxyError = await invalidProxyConnection.start().then(() => null, (error) => error);
assert(invalidProxyError?.code === "relay_proxy_configuration"
  && invalidProxyError.message.includes("MBM_RELAY_PROXY")
  && invalidProxyError.message.includes("HTTP_PROXY"),
"invalid proxy configuration did not fail fast with corrective guidance");
assert(invalidProxyConnection.status().network_route === "invalid-application-proxy-configuration", "invalid proxy route was not observable");

const outageHistoryScheduler = new ManualScheduler();
const outageHistorySockets = [];
const outageHistoryWallBase = Date.UTC(2026, 7, 27, 14, 0, 0);
const outageHistoryConnection = new RelayConnection({
  workerUrl: "https://relay.example.invalid",
  secret: "test-daemon-secret-123456",
  logger: captureLogger([]),
  WebSocketClass: class extends FakeSocket {
    constructor(url, options) {
      super(url, options);
      outageHistorySockets.push(this);
    }
  },
  scheduler: outageHistoryScheduler,
  now: () => outageHistoryScheduler.now,
  wallNow: () => outageHistoryWallBase + outageHistoryScheduler.now,
  reconnectDelay: () => 5,
});
outageHistoryConnection.start();
outageHistorySockets[0].open();
outageHistoryConnection.acknowledge({ type: "hello_ack", server: "machine-bridge-mcp", version: "test" });
completeRelayReadiness(outageHistoryConnection, "test");
for (let outageNumber = 1; outageNumber <= 10; outageNumber += 1) {
  outageHistoryScheduler.advance(7);
  outageHistorySockets.at(-1).remoteClose(1006, "");
  outageHistoryScheduler.advance(5);
  outageHistorySockets.at(-1).open();
  outageHistoryConnection.acknowledge({ type: "hello_ack", server: "machine-bridge-mcp", version: "test" });
  completeRelayReadiness(outageHistoryConnection, "test");
}
const outageHistory = outageHistoryConnection.status();
assert(outageHistory.outage_count === 10 && outageHistory.recent_outages.length === 8,
  "relay diagnostics did not retain the bounded completed-outage history");
assert(outageHistory.recent_outages[0].outage_number === 10
  && outageHistory.recent_outages.at(-1).outage_number === 3,
"relay completed-outage history was not newest-first or did not evict the oldest entries");
assert(outageHistory.recent_outages.every((entry) => entry.ready_at && entry.disconnected_at
    && entry.last_disconnect_at === entry.disconnected_at
    && entry.duration_ms === 5 && entry.previous_ready_duration_ms >= 7),
"relay completed-outage history lost bounded timing evidence");
outageHistoryConnection.stop();

const multiAttemptScheduler = new ManualScheduler();
const multiAttemptSockets = [];
const multiAttemptWallBase = Date.UTC(2026, 7, 27, 16, 0, 0);
const multiAttemptConnection = new RelayConnection({
  workerUrl: "https://relay.example.invalid", secret: "test-daemon-secret-123456", logger: captureLogger([]),
  WebSocketClass: class extends FakeSocket { constructor(url, options) { super(url, options); multiAttemptSockets.push(this); } },
  scheduler: multiAttemptScheduler, now: () => multiAttemptScheduler.now,
  wallNow: () => multiAttemptWallBase + multiAttemptScheduler.now, reconnectDelay: () => 5,
});
multiAttemptConnection.start(); multiAttemptSockets[0].open();
multiAttemptConnection.acknowledge({ type: "hello_ack", server: "machine-bridge-mcp", version: "test" });
completeRelayReadiness(multiAttemptConnection, "test");
multiAttemptScheduler.advance(100); multiAttemptSockets.at(-1).remoteClose(1006, "");
multiAttemptScheduler.advance(5); multiAttemptSockets.at(-1).open(); multiAttemptSockets.at(-1).remoteClose(1006, "");
multiAttemptScheduler.advance(5); multiAttemptSockets.at(-1).open(); multiAttemptSockets.at(-1).remoteClose(1006, "");
multiAttemptScheduler.advance(5); multiAttemptSockets.at(-1).open();
multiAttemptConnection.acknowledge({ type: "hello_ack", server: "machine-bridge-mcp", version: "test" });
completeRelayReadiness(multiAttemptConnection, "test");
const multiAttemptOutage = multiAttemptConnection.status().recent_outages[0];
const multiAttemptStartedAt = Date.parse(multiAttemptOutage.disconnected_at);
const multiAttemptLastDisconnectAt = Date.parse(multiAttemptOutage.last_disconnect_at);
const multiAttemptReadyAt = Date.parse(multiAttemptOutage.ready_at);
assert(multiAttemptLastDisconnectAt - multiAttemptStartedAt === 10
  && multiAttemptReadyAt - multiAttemptStartedAt === multiAttemptOutage.duration_ms
  && multiAttemptOutage.duration_ms === 15 && multiAttemptOutage.attempts === 3,
"multi-attempt relay outage mixed its first outage start with the final reconnect failure timestamp");
multiAttemptConnection.stop();

FirstPingFailSocket.created = 0;
const pingFailureScheduler = new ManualScheduler();
const pingFailureSockets = [];
const pingFailureConnection = new RelayConnection({
  workerUrl: "https://relay.example.invalid", secret: "test-daemon-secret-123456", logger: captureLogger([]),
  WebSocketClass: class extends FirstPingFailSocket {
    constructor(url, options) { super(url, options); pingFailureSockets.push(this); }
  },
  scheduler: pingFailureScheduler, now: () => pingFailureScheduler.now,
  wallNow: () => Date.UTC(2026, 7, 27, 17, 0, 0) + pingFailureScheduler.now,
  transportPingIntervalMs: 5, transportPongTimeoutMs: 10, reconnectDelay: () => 5,
});
pingFailureConnection.start(); pingFailureSockets[0].open();
pingFailureConnection.acknowledge({ type: "hello_ack", server: "machine-bridge-mcp", version: "test" });
completeRelayReadiness(pingFailureConnection, "test");
pingFailureScheduler.advance(5);
assert(pingFailureSockets[0].terminated === true, "synthetic protocol Ping failure did not terminate the affected relay socket");
pingFailureScheduler.advance(5); pingFailureSockets.at(-1).open();
pingFailureConnection.acknowledge({ type: "hello_ack", server: "machine-bridge-mcp", version: "test" });
completeRelayReadiness(pingFailureConnection, "test");
const pingFailureOutage = pingFailureConnection.status().recent_outages[0];
assert(pingFailureOutage.probe_dispatch_pending_at_start === true
  && pingFailureOutage.probe_outstanding_at_start === false
  && pingFailureOutage.transport_confirmation_pending_at_start === false,
"relay outage history did not freeze the pre-close liveness phase for a protocol Ping dispatch failure");
pingFailureConnection.stop();

console.log("relay connection lifecycle/logging test ok");

function completeRelayReadiness(connection, version) {
  const sessionId = connection.currentSessionId();
  assert(sessionId > 0, "readiness completion requires an authenticated relay session");
  assert(connection.sendForSession({ type: "relay_probe_result", id: "probe_test-ready" }, sessionId).ok === true, "readiness probe result could not be delivered");
  assert(connection.confirmReady({ type: "ready_ack", server: "machine-bridge-mcp", version }) === true, "valid readiness acknowledgement was rejected");
}

function captureLogger(events) {
  return Object.fromEntries(["debug", "info", "warn", "error"].map((level) => [level, (message, fields) => events.push({ level, message, fields })]));
}

function countLevel(events, level) {
  return events.filter((event) => event.level === level).length;
}

function hasRawCloseFields(fields) {
  return Boolean(fields && (Object.hasOwn(fields, "code") || Object.hasOwn(fields, "reason") || Object.hasOwn(fields, "close_code") || Object.hasOwn(fields, "close_reason")));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
