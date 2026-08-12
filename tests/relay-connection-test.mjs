import { EventEmitter } from "node:events";
import { acknowledgementMismatch, readinessMismatch, RelayConnection, isSupersededClose, reconnectDelay, relayCloseCategory, relayOutageUserAction, welcomeMismatch } from "../src/local/relay-connection.mjs";
import { proxyAgentForWebSocket } from "../src/local/network-proxy.mjs";

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
    this.terminated = false;
  }

  open() {
    this.readyState = FakeSocket.OPEN;
    this.emit("open");
  }

  send(value) {
    if (this.readyState !== FakeSocket.OPEN) throw new Error("socket is not open");
    this.sent.push(String(value));
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
sockets[0].open();
assert(events.every((event) => event.level !== "info"), "transport open was incorrectly reported as authenticated readiness");
assert(sockets[0].sent.length === 0, "relay sent daemon identity before receiving the Worker challenge");
assert(connection.observeWelcome({ type: "welcome", server: "machine-bridge-mcp", version: "0.8.1" }), "valid relay welcome was rejected");
await Promise.resolve();
assert(JSON.parse(sockets[0].sent[0]).type === "hello", "relay did not answer the Worker challenge with daemon hello");
assert(events.every((event) => event.level !== "warn"), "valid relay welcome emitted a warning");
connection.acknowledge({ type: "hello_ack", server: "machine-bridge-mcp", version: "0.8.1" });
assert(connection.status().authenticated === true && connection.status().ready === false, "hello acknowledgement was incorrectly treated as end-to-end readiness");
const authenticatedRelaySession = connection.currentSessionId();
assert(authenticatedRelaySession > 0, "authenticated relay did not establish a session for the readiness probe");
assert(connection.sendForSession({ type: "relay_probe_result", id: "probe_test-ready" }, authenticatedRelaySession).ok === true, "readiness probe result could not use the authenticated session before ready state");
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
const outageWarning = events.find((event) => event.level === "warn" && event.message.startsWith("remote relay unavailable for "));
assert(outageWarning, "sustained outage did not escalate to a warning");
assert(outageWarning.message.includes("reconnecting automatically") && outageWarning.message.includes("connection interrupted"), "sustained outage warning omitted recovery behavior or the meaningful cause");
assert(outageWarning.fields?.event === "relay.outage.active"
  && outageWarning.fields.close_category === "connection_interrupted"
  && outageWarning.fields.close_code === 1006
  && outageWarning.fields.network_route_scope === "application-proxy-selection-only",
"outage warning omitted structured recovery diagnostics");
assert(!Object.hasOwn(outageWarning.fields, "close_reason"), "outage warning exposed the raw WebSocket close reason");
const outageDebug = events.find((event) => event.level === "debug" && event.message === "remote relay outage details");
assert(outageDebug?.fields?.cause === "connection interrupted", "debug outage details omitted the classified cause");
assert(!Object.hasOwn(outageDebug?.fields || {}, "close_reason"), "outage diagnostics exposed the raw WebSocket close reason");
sockets[2].open();
connection.acknowledge({ type: "hello_ack", server: "machine-bridge-mcp", version: "0.8.1" });
completeRelayReadiness(connection, "0.8.1");
const restored = events.find((event) => event.level === "warn" && event.message.startsWith("remote relay connection restored after "));
assert(restored?.message.includes("reconnect attempt"), "restored connection summary was incomplete or not user-readable");
assert(restored.fields?.event === "relay.outage.recovered"
  && restored.fields.close_category === "connection_interrupted"
  && restored.fields.network_route_scope === "application-proxy-selection-only",
"recovery summary omitted structured outage diagnostics");
assert(!Object.hasOwn(restored.fields, "close_reason"), "recovery summary exposed the raw WebSocket close reason");
const restoredDebug = events.find((event) => event.level === "debug" && event.message === "remote relay outage recovery details");
assert(restoredDebug?.fields?.attempts >= 1 && restoredDebug.fields.outage_seconds >= 1, "debug recovery details were incomplete");

sockets[2].remoteClose(1006, "");
scheduler.advance(5);
assert(sockets.length === 4, "handshake-timeout socket was not created");
sockets[3].open();
scheduler.advance(20);
assert(sockets[3].terminated, "unacknowledged relay transport was not terminated after the handshake timeout");
connection.stop();

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
  outageWarnAfterMs: 100,
});
heartbeatConnection.start();
heartbeatSockets[0].open();
heartbeatConnection.acknowledge({ type: "hello_ack", server: "machine-bridge-mcp", version: "test" });
completeRelayReadiness(heartbeatConnection, "test");
heartbeatScheduler.advance(10);
assert(heartbeatSockets[0].terminated, "silent relay connection was not terminated after heartbeat timeout");
heartbeatConnection.stop();

const stalledHeartbeatScheduler = new ManualScheduler();
const stalledHeartbeatSockets = [];
const stalledHeartbeatEvents = [];
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
  reconnectDelay: () => 100,
  heartbeatIntervalMs: 5,
  heartbeatTimeoutMs: 10,
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
  && stalledHeartbeatConnection.status().heartbeat.recovery_active,
"local event-loop stall was not exposed through relay diagnostics");
assert(stalledHeartbeatEvents.some((event) => event.level === "warn"
  && event.fields?.event === "runtime.event_loop.stall"
  && event.fields?.relay_disconnect_deferred === true),
"local event-loop stall did not emit a structured recovery warning");
stalledHeartbeatSockets[0].emit("message", Buffer.from(JSON.stringify({ type: "pong" })));
stalledHeartbeatScheduler.advance(5);
assert(!stalledHeartbeatSockets[0].terminated, "fresh inbound traffic did not clear heartbeat recovery grace");
stalledHeartbeatConnection.stop();

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
constructorScheduler.advance(5);
assert(constructorAttempts === 2 && constructorSockets.length === 1, "synchronous WebSocket construction failure did not use reconnect backoff");
constructorConnection.stop();

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
assert(welcomeMismatch({ type: "welcome", server: "machine-bridge-mcp", version: "0.8.1" }, "machine-bridge-mcp", "0.8.1") === "", "valid relay welcome metadata was rejected");
assert(welcomeMismatch({ type: "welcome", server: "machine-bridge-mcp", version: "0.7.1" }, "machine-bridge-mcp", "0.8.1") === "server_version_mismatch", "relay welcome version mismatch was not classified");
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
  staleProofConnection.observeWelcome({ type: "welcome", server: "machine-bridge-mcp", version: "test" });
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
  helloSendConnection.observeWelcome({ type: "welcome", server: "machine-bridge-mcp", version: "test" });
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

const directProxy = proxyAgentForWebSocket("wss://relay.example.invalid/daemon/ws", () => "");
assert(directProxy.agent === null && directProxy.mode === "direct", "NO_PROXY/direct relay routing did not bypass proxy construction");
let unsupportedProxyRejected = false;
try { proxyAgentForWebSocket("wss://relay.example.invalid/daemon/ws", () => "socks5://proxy.example.invalid:1080"); } catch (error) {
  unsupportedProxyRejected = String(error?.message || error).includes("HTTP or HTTPS");
}
assert(unsupportedProxyRejected, "unsupported relay proxy protocol was accepted");

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

const invalidProxyConnection = new RelayConnection({
  workerUrl: "https://relay.example.invalid",
  secret: "test-daemon-secret-123456",
  logger: captureLogger([]),
  WebSocketClass: FakeSocket,
  proxyAgentForUrl: () => { const error = new Error("relay proxy configuration is invalid"); error.code = "relay_proxy_configuration"; throw error; },
});
const invalidProxyError = await invalidProxyConnection.start().then(() => null, (error) => error);
assert(invalidProxyError?.code === "relay_proxy_configuration" && invalidProxyError.message.includes("HTTP_PROXY"), "invalid proxy configuration did not fail fast with corrective guidance");
assert(invalidProxyConnection.status().network_route === "invalid-application-proxy-configuration", "invalid proxy route was not observable");

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
