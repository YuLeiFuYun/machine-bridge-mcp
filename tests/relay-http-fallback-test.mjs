import assert from "node:assert/strict";
import { createDeviceIdentity, createDeviceSessionIdentity, publicDeviceJwkJson } from "../src/local/device-identity.mjs";
import { createDaemonHttpRelayHeaders } from "../src/local/daemon-http-relay-auth.mjs";
import { DaemonHttpRelayConnection } from "../src/local/daemon-http-relay-connection.mjs";
import { RelayInboundSequence, RelayOutboundSequence } from "../src/local/daemon-http-relay-sequence.mjs";
import { ResilientRelayConnection } from "../src/local/resilient-relay-connection.mjs";
import { verifyDaemonHttpRelayRequest } from "../src/worker/daemon-http-auth.ts";
import { DaemonHttpChannel } from "../src/worker/daemon-http-channel.ts";

const ORIGIN = "https://relay.example.invalid";
const SERVER = "machine-bridge-mcp";
const VERSION = "3.0.0-beta.102";
const NOW = Date.UTC(2026, 7, 18, 4, 0, 0);

async function testSignedHttpRelayAuthentication() {
  const root = createDeviceIdentity();
  const session = createDeviceSessionIdentity(root, ORIGIN, SERVER, VERSION, NOW);
  const publicKeyJson = publicDeviceJwkJson(root);
  const body = Buffer.from(JSON.stringify({ protocol: 1, value: "bounded" }));
  const storage = new MemoryStorage();
  const headers = new Headers(createDaemonHttpRelayHeaders(session, ORIGIN, SERVER, VERSION, body, NOW));
  assert.equal(await verifyDaemonHttpRelayRequest({
    storage, publicKeyJson, headers, body, workerOrigin: ORIGIN, server: SERVER, version: VERSION,
    now: Math.floor(NOW / 1000),
  }), true, "valid signed daemon HTTP exchange was rejected");
  assert.equal(await verifyDaemonHttpRelayRequest({
    storage, publicKeyJson, headers, body, workerOrigin: ORIGIN, server: SERVER, version: VERSION,
    now: Math.floor(NOW / 1000),
  }), false, "daemon HTTP exchange nonce replay was accepted");

  const tamperedHeaders = new Headers(createDaemonHttpRelayHeaders(session, ORIGIN, SERVER, VERSION, body, NOW));
  assert.equal(await verifyDaemonHttpRelayRequest({
    storage: new MemoryStorage(), publicKeyJson, headers: tamperedHeaders,
    body: Buffer.from(JSON.stringify({ protocol: 1, value: "changed" })), workerOrigin: ORIGIN,
    server: SERVER, version: VERSION, now: Math.floor(NOW / 1000),
  }), false, "daemon HTTP body tampering was not rejected");

  const expiredHeaders = new Headers(createDaemonHttpRelayHeaders(session, ORIGIN, SERVER, VERSION, body, NOW - 31_000));
  assert.equal(await verifyDaemonHttpRelayRequest({
    storage: new MemoryStorage(), publicKeyJson, headers: expiredHeaders, body,
    workerOrigin: ORIGIN, server: SERVER, version: VERSION, now: Math.floor(NOW / 1000),
  }), false, "expired daemon HTTP request replay window was accepted");
}

function testTransportSequences() {
  const outbound = new RelayOutboundSequence();
  outbound.enqueue({ type: "tool_result", id: "call_12345678", ok: true });
  const first = outbound.snapshot();
  const retry = outbound.snapshot();
  assert.deepEqual(retry, first, "unacknowledged daemon HTTP payload changed identity across retry");
  assert.equal(first[0].seq, 1, "daemon HTTP outbound sequence did not start at one");
  assert.equal(outbound.acknowledge(1), true, "daemon HTTP outbound acknowledgement was rejected");
  assert.deepEqual(outbound.snapshot(), [], "acknowledged daemon HTTP payload remained queued");

  const inbound = new RelayInboundSequence();
  assert.equal(inbound.classify(1), "new");
  inbound.commit(1);
  assert.equal(inbound.classify(1), "duplicate", "duplicate transport sequence was not recognized");
  assert.equal(inbound.classify(3), "gap", "transport sequence gap was not rejected");

  const channel = new DaemonHttpChannel({
    sessionId: `relay_http_${"a".repeat(43)}`,
    activationToken: `activate_${"b".repeat(43)}`,
    attachment: { role: "candidate", connectedAt: new Date(NOW).toISOString() },
    now: NOW,
  });
  channel.activate(NOW);
  assert.equal(channel.readyState, 0, "activated HTTPS fallback became schedulable before verified-ready proof");
  channel.send(JSON.stringify({ type: "tool_call", id: "call_abcdefgh" }));
  assert.deepEqual(channel.outboundMessages(), channel.outboundMessages(),
    "Worker HTTP channel changed an unacknowledged payload across retry");
  assert.equal(channel.acknowledgeWorker(1), true);
  assert.deepEqual(channel.outboundMessages(), []);
  channel.verifyReady(NOW + 1);
  assert.equal(channel.readyState, 1, "verified HTTPS fallback did not become schedulable");
  assert.throws(() => channel.send(JSON.stringify({ payload: "x".repeat(8_500_000) })), /capacity exceeded/,
    "single unsendable Worker fallback payload exceeded envelope limit without rejection");
}

async function testHttpFallbackFailureClassification() {
  const connection = new DaemonHttpRelayConnection({ workerUrl: ORIGIN });
  connection.handleFailure(Object.assign(new Error("timeout"), { code: "daemon_http_timeout" }));
  assert.equal(connection.status().last_transport_error_class, "timeout",
    "HTTPS fallback request timeout collapsed into a generic execution failure");
  assert.equal(connection.status().last_transport_error_reason, "connection_timeout",
    "HTTPS fallback timeout lost the privacy-safe transport reason");
  await connection.handleResponse(200, JSON.stringify({ protocol: 1, phase: "standby", ack_daemon_seq: 0, messages: [] }));
  assert.equal(connection.status().last_ready_at, null,
    "successful standby probe was mislabeled as a verified HTTPS-fallback ready transition");
  assert.equal(typeof connection.status().last_success_at, "string",
    "successful HTTPS fallback response did not expose its distinct request-success timestamp");
  assert.equal(connection.status().last_transport_error_class, "timeout");
  assert.equal(connection.status().last_transport_error_reason, "connection_timeout");
  assert.equal(connection.status().http_poll_failures, 0,
    "successful HTTPS fallback response did not reset current failure count while retaining historical error evidence");
  connection.handleFailure(Object.assign(new Error("unsupported"), { code: "daemon_http_unsupported" }));
  assert.equal(connection.status().last_transport_error_class, "unavailable",
    "unsupported HTTPS fallback collapsed into a generic execution failure");
  connection.handleFailure(new AggregateError([
    Object.assign(new Error("v6 timeout"), { code: "ETIMEDOUT" }),
    Object.assign(new Error("v4 unreachable"), { code: "ENETUNREACH" }),
  ]));
  assert.equal(connection.status().last_transport_error_class, "network_error");
  assert.equal(connection.status().last_transport_error_reason, "multi_address_failure",
    "HTTPS fallback lost Happy Eyeballs aggregate network evidence");

  const protocolFailure = new DaemonHttpRelayConnection({
    workerUrl: ORIGIN, failureBackoffBaseMs: 10, failureBackoffMaximumMs: 40,
  });
  await protocolFailure.handleResponse(409, "");
  assert.equal(protocolFailure.status().last_transport_error_class, "conflict",
    "HTTPS fallback session conflict was not retained as bounded diagnostic evidence");
  assert.equal(protocolFailure.status().http_poll_failures, 1);
  assert.equal(protocolFailure.nextPollDelay(), 10,
    "HTTPS fallback session conflict bypassed the first bounded retry backoff");
  await protocolFailure.handleResponse(200, "not-json");
  assert.equal(protocolFailure.status().last_transport_error_class, "protocol_error",
    "malformed HTTPS fallback response was not classified as a protocol failure");
  assert.equal(protocolFailure.status().http_poll_failures, 2);
  assert.equal(protocolFailure.nextPollDelay(), 20,
    "repeated fallback protocol/session failures bypassed exponential retry backoff");
}

async function testLocalLostResponseDoesNotReplayToolCall() {
  const root = createDeviceIdentity();
  const session = createDeviceSessionIdentity(root, ORIGIN, SERVER, VERSION, NOW);
  const scheduler = new ManualScheduler();
  const requests = [];
  let requestNumber = 0;
  let toolCallExecutions = 0;
  let readyEvents = 0;
  let resumeSeen = false;
  let connection;
  const activation = `activate_${"c".repeat(43)}`;

  const postRequest = async ({ body }) => {
    requestNumber += 1;
    const parsed = JSON.parse(body);
    requests.push({ at: scheduler.now, body: parsed });
    if (requestNumber === 1) return response({
      protocol: 1, phase: "probing", activation_token: activation, ack_daemon_seq: 0,
      messages: [
        { seq: 1, payload: { type: "resume_calls", ids: [] } },
        { seq: 2, payload: { type: "ready_ack", server: SERVER, version: VERSION } },
      ],
    });
    if (requestNumber === 2) {
      assert.deepEqual(parsed.messages.map((message) => [message.seq, message.payload?.type]),
        [[1, "https_ready"], [2, "resume_calls_ack"]],
      "fallback probing proof did not establish local readiness before missing-call acknowledgement");
      throw Object.assign(new Error("simulated response loss"), { code: "ECONNRESET" });
    }
    if (requestNumber === 3) {
      assert.deepEqual(parsed.messages.map((message) => [message.seq, message.payload?.type]),
        [[1, "https_ready"], [2, "resume_calls_ack"]],
      "response loss changed probing proof sequences instead of retrying the same envelope");
      return response({
        protocol: 1, phase: "ready", activation_token: activation, ack_daemon_seq: 2,
        messages: [{ seq: 3, payload: toolCallEnvelope() }],
      });
    }
    if (requestNumber === 4) {
      assert.equal(parsed.ack_worker_seq, 3, "tool-call transport sequence was not acknowledged after handoff");
      return response({
        protocol: 1, phase: "ready", activation_token: activation, ack_daemon_seq: 2,
        messages: [{ seq: 3, payload: toolCallEnvelope() }],
      });
    }
    return response({ protocol: 1, phase: "ready", activation_token: activation, ack_daemon_seq: 2, messages: [] });
  };

  connection = new DaemonHttpRelayConnection({
    workerUrl: ORIGIN, deviceIdentity: session, expectedServer: SERVER, expectedVersion: VERSION,
    instanceId: "instance_abcdefgh12345678", scheduler, now: () => scheduler.now, wallNow: () => NOW + scheduler.now,
    minimumRequestIntervalMs: 750, pollIntervalMs: 1000, requestTimeoutMs: 8000, livenessTimeoutMs: 12000,
    descriptor: () => ({ tools: ["list_dir"], policy: { profile: "full" }, relayDiagnostics: {} }),
    ownedCallIds: () => [], postRequest,
    onReady: () => { readyEvents += 1; },
    onMessage: (raw, context) => {
      const message = JSON.parse(raw);
      if (message.type === "resume_calls") {
        resumeSeen = true;
      } else if (message.type === "ready_ack") {
        assert.equal(resumeSeen, true, "fallback ready acknowledgement arrived before resume reconciliation");
        assert.equal(connection.confirmReady(message), true, "fallback ready acknowledgement was rejected");
        const outcome = connection.sendForSession({ type: "resume_calls_ack", missing_ids: [] }, context.sessionId);
        assert.equal(outcome.ok, true, "fallback resume acknowledgement could not be queued after local readiness");
      } else if (message.type === "tool_call") {
        toolCallExecutions += 1;
        return new Promise(() => {});
      }
    },
  });
  connection.start();
  await runNext(scheduler); // signed probing response with resume/ready controls
  assert.equal(readyEvents, 0, "HTTPS fallback reported ready before Worker verified the local ready proof");
  await runNext(scheduler); // response loss carrying resume ack + https_ready
  assert.equal(readyEvents, 0, "lost verified-ready response falsely completed local readiness");
  await runNext(scheduler); // retry same proof, Worker phase ready, receive tool_call seq 3
  assert.equal(readyEvents, 1, "HTTPS fallback did not reach ready after bidirectional verified-ready proof");
  assert.equal(typeof connection.status().last_ready_at, "string",
    "verified HTTPS fallback readiness did not publish its distinct ready timestamp");
  assert.equal(typeof connection.status().last_success_at, "string",
    "verified HTTPS fallback readiness lost the general successful-exchange timestamp");
  await runNext(scheduler); // duplicate tool_call seq 3
  assert.equal(toolCallExecutions, 1, "duplicate HTTP transport delivery replayed a tool_call side effect");
  for (let index = 1; index < requests.length; index += 1) {
    assert(requests[index].at - requests[index - 1].at >= 750,
      "daemon HTTP fallback exceeded its bounded request-rate interval");
  }
  connection.stop();
}

async function testSessionResetDoesNotCommitPriorInboundSequence() {
  const root = createDeviceIdentity();
  const session = createDeviceSessionIdentity(root, ORIGIN, SERVER, VERSION, NOW);
  const scheduler = new ManualScheduler();
  const activation = `activate_${"r".repeat(43)}`;
  let connection;
  let messages = 0;
  connection = new DaemonHttpRelayConnection({
    workerUrl: ORIGIN, deviceIdentity: session, expectedServer: SERVER, expectedVersion: VERSION,
    instanceId: "instance_reset12345678", scheduler, now: () => scheduler.now, wallNow: () => NOW + scheduler.now,
    minimumRequestIntervalMs: 750, pollIntervalMs: 1000, requestTimeoutMs: 8000, livenessTimeoutMs: 12000,
    descriptor: () => ({ tools: ["list_dir"], policy: { profile: "full" }, relayDiagnostics: {} }),
    ownedCallIds: () => [],
    postRequest: async () => response({
      protocol: 1, phase: "probing", activation_token: activation, ack_daemon_seq: 0,
      messages: [{ seq: 1, payload: { type: "resume_calls", ids: [] } }],
    }),
    onMessage: () => {
      messages += 1;
      connection.interrupt("synthetic_protocol_reset");
    },
  });
  connection.start();
  await runNext(scheduler);
  assert.equal(messages, 1, "session-reset fixture did not enter the inbound handler");
  assert.equal(connection.inbound.acknowledged, 0,
    "an old HTTP response committed its sequence after the handler reset the transport session");
  assert.equal(connection.inbound.classify(1), "new",
    "fresh HTTP session could not accept sequence one after an old handler-triggered reset");
  connection.stop();
}

async function testTakeoverPreemptsStandbyRequest() {
  const root = createDeviceIdentity();
  const session = createDeviceSessionIdentity(root, ORIGIN, SERVER, VERSION, NOW);
  const scheduler = new ManualScheduler();
  const requests = [];
  let firstAborted = false;
  const connectionId = `connection_${"q".repeat(43)}`;
  const connection = new DaemonHttpRelayConnection({
    workerUrl: ORIGIN, deviceIdentity: session, expectedServer: SERVER, expectedVersion: VERSION,
    instanceId: "instance_takeover123456", scheduler, now: () => scheduler.now, wallNow: () => NOW + scheduler.now,
    minimumRequestIntervalMs: 1, pollIntervalMs: 1000, requestTimeoutMs: 8000, livenessTimeoutMs: 12000,
    descriptor: () => ({ tools: ["list_dir"], policy: { profile: "full" }, relayDiagnostics: {} }),
    ownedCallIds: () => [],
    postRequest: ({ body, signal }) => {
      requests.push(JSON.parse(body));
      if (requests.length > 1) return Promise.resolve(response({ protocol: 1, phase: "standby", ack_daemon_seq: 0, messages: [] }));
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          firstAborted = true;
          reject(Object.assign(new Error("standby request superseded"), { code: "ECONNABORTED" }));
        }, { once: true });
      });
    },
  });
  connection.start();
  await runNext(scheduler);
  assert.equal(requests.length, 1, "fallback prewarm fixture did not start its standby request");
  connection.start({ takeoverWebSocket: true, takeoverWebSocketConnectionId: connectionId });
  assert.equal(firstAborted, true, "takeover left an obsolete standby HTTP request occupying the fallback channel");
  await runNext(scheduler);
  assert.equal(requests.length, 2, "takeover did not dispatch immediately after aborting standby prewarm");
  assert.equal(requests[1].takeover_websocket, true);
  assert.equal(requests[1].takeover_websocket_connection_id, connectionId,
    "takeover replacement request lost its exact WebSocket-generation binding");
  connection.stop();
}

async function testStandbyAndFailureBackoff() {
  const root = createDeviceIdentity();
  const session = createDeviceSessionIdentity(root, ORIGIN, SERVER, VERSION, NOW);
  const scheduler = new ManualScheduler();
  const requests = [];
  const takeoverConnectionId = `connection_${"b".repeat(43)}`;
  const connection = new DaemonHttpRelayConnection({
    workerUrl: ORIGIN, deviceIdentity: session, expectedServer: SERVER, expectedVersion: VERSION,
    instanceId: "instance_backoff123456", scheduler, now: () => scheduler.now, wallNow: () => NOW + scheduler.now,
    minimumRequestIntervalMs: 1, pollIntervalMs: 1000, standbyRetryIntervalMs: 50,
    failureBackoffBaseMs: 10, failureBackoffMaximumMs: 40,
    requestTimeoutMs: 8000, livenessTimeoutMs: 12000,
    descriptor: () => ({ tools: ["list_dir"], policy: { profile: "full" }, relayDiagnostics: {} }),
    ownedCallIds: () => [],
    postRequest: async ({ body }) => {
      requests.push({ at: scheduler.now, body: JSON.parse(body) });
      if (requests.length === 1 || requests.length === 4 || requests.length >= 5) {
        return response({ protocol: 1, phase: "standby", ack_daemon_seq: 0, messages: [] });
      }
      throw Object.assign(new Error("synthetic fast network failure"), { code: "ECONNRESET" });
    },
  });
  connection.start();
  await runNext(scheduler);
  scheduler.advance(49); await flushAsync();
  assert.equal(requests.length, 1, "successful standby prewarm still retried at the old sub-second cadence");
  scheduler.advance(1); await flushAsync();
  assert.equal(requests.length, 2);
  scheduler.advance(9); await flushAsync();
  assert.equal(requests.length, 2, "first fast fallback failure ignored its retry backoff");
  scheduler.advance(1); await flushAsync();
  assert.equal(requests.length, 3);
  scheduler.advance(19); await flushAsync();
  assert.equal(requests.length, 3, "second fast fallback failure ignored exponential retry backoff");
  scheduler.advance(1); await flushAsync();
  assert.equal(requests.length, 4);
  assert.deepEqual(requests.map((request) => request.at), [0, 50, 60, 80],
    "fallback standby/failure retries did not follow the bounded 50/10/20 millisecond fixture cadence");

  connection.start({ takeoverWebSocket: true, takeoverWebSocketConnectionId: takeoverConnectionId });
  await runNext(scheduler);
  assert.equal(requests.length, 5, "exact-generation takeover did not preempt the longer standby retry timer");
  assert.equal(requests[4].at, 81, "takeover preemption bypassed or exceeded the minimum request interval");
  assert.equal(requests[4].body.takeover_websocket, true);
  assert.equal(requests[4].body.takeover_websocket_connection_id, takeoverConnectionId,
    "preempted fallback request lost its exact WebSocket-generation takeover binding");
  connection.stop();
}

async function testPrimaryFallbackHandover() {
  const scheduler = new ManualScheduler();
  const ready = [];
  const disconnected = [];
  FakeWebSocketRelay.instances.length = 0;
  FakeHttpRelay.instances.length = 0;
  const relay = new ResilientRelayConnection({
    scheduler, fallbackDelayMs: 1500,
    WebSocketRelayClass: FakeWebSocketRelay,
    HttpRelayClass: FakeHttpRelay,
    websocket: {}, http: {},
    onReady: (event) => ready.push(event.transport),
    onDisconnect: (event) => disconnected.push(event.transport),
  });
  const started = relay.start();
  const ws = FakeWebSocketRelay.instances[0];
  const http = FakeHttpRelay.instances[0];
  assert.equal(ws.started, true);
  scheduler.advance(1499);
  assert.equal(http.started, false, "HTTPS fallback started before primary WSS activation grace elapsed");
  ws.emitReady();
  assert.equal(await started, true);
  scheduler.advance(10);
  assert.equal(http.started, false, "HTTPS fallback started despite verified WSS readiness");
  assert.equal(relay.send({ type: "one" }), true);
  assert.equal(ws.sent.length, 1, "ready WSS was not the preferred send path");

  ws.emitDegraded();
  scheduler.advance(0);
  assert.equal(http.started, true, "WSS liveness suspicion did not prewarm the HTTPS fallback path");
  assert.equal(relay.status().https_fallback_warming, true,
    "fallback prewarm was not distinguishable from an inactive or ready fallback in diagnostics");
  assert.equal(http.startOptions?.takeoverWebSocket, false,
    "fallback prewarm prematurely took ownership away from a WSS still under confirmation");
  ws.emitRecovered();
  assert.equal(http.stopped, true, "recovered WSS left a standby HTTPS fallback polling indefinitely");
  assert.equal(relay.status().https_fallback_warming, false,
    "recovered WSS left stale fallback-warming diagnostics behind");

  ws.emitDisconnect();
  scheduler.advance(0);
  assert.equal(http.started, true, "HTTPS fallback did not start immediately after WSS loss");
  assert.equal(http.startOptions?.takeoverWebSocket, true,
    "established WSS loss did not authorize same-instance HTTPS takeover of a Worker-side zombie socket");
  assert.equal(http.startOptions?.takeoverWebSocketConnectionId, `connection_${"a".repeat(43)}`,
    "HTTPS fallback takeover was not bound to the disconnected WebSocket generation");
  ws.lastErrorClass = "network_error"; ws.lastErrorReason = "network_unreachable";
  ws.lastErrorReady = true; ws.lastErrorAuthenticated = true;
  http.lastErrorClass = "timeout"; http.lastErrorReason = "connection_timeout";
  http.lastErrorReady = false; http.lastErrorAuthenticated = true;
  ws.outageDurationMs = 1350;
  http.emitReady();
  assert.equal(relay.status().transport, "https");
  assert.equal(relay.status().last_transport_error_class, "timeout");
  assert.equal(relay.status().last_transport_error_reason, "connection_timeout");
  assert.equal(relay.status().last_transport_error_ready, false);
  assert.equal(relay.status().last_transport_error_authenticated, true,
    "active HTTPS projection mixed WSS error context with fallback error classification");
  assert.equal(relay.status().outage_active, false,
    "ready HTTPS fallback still reported the bridge as globally unavailable");
  assert.equal(relay.status().https_fallback_last_takeover_ms, 1350,
    "verified HTTPS takeover did not retain the bounded bridge-continuity gap");
  assert.equal(relay.send({ type: "two" }), true);
  assert.equal(http.sent.length, 1, "ready HTTPS fallback did not carry relay traffic");
  ws.emitReady();
  assert.equal(relay.status().transport, "websocket", "verified WSS did not reclaim primary transport ownership");
  assert.equal(relay.status().https_fallback_last_takeover_ms, 1350,
    "WSS recovery erased the preceding HTTPS continuity evidence");
  assert.equal(http.stopped, true, "HTTPS fallback remained active after WSS handover");
  assert.deepEqual(disconnected, ["websocket"], "transport handover generated a false second runtime disconnect");
  assert.deepEqual(ready, ["websocket", "https", "websocket"]);
  relay.stop();
}

function toolCallEnvelope() {
  return {
    type: "tool_call", id: "call_abcdefgh", tool: "list_dir", arguments: {}, timeout_ms: 20000,
    authorization: {
      account_id: "acct_abcdefghijklmnopqrst", account_version: 1,
      client_id: `mcp_client_${"d".repeat(43)}`, family_id: `mcp_family_${"e".repeat(43)}`, role: "owner",
    },
  };
}

function response(body) { return { statusCode: 200, body: JSON.stringify(body), networkRoute: "system-network-stack" }; }

async function runNext(scheduler) {
  scheduler.runNext();
  await flushAsync();
}

async function flushAsync() {
  await new Promise((resolve) => { setImmediate(resolve); });
}

class MemoryStorage {
  constructor() { this.values = new Map(); }
  async get(key) { return this.values.get(key); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async transaction(callback) { return callback(this); }
}

class ManualScheduler {
  constructor() { this.now = 0; this.nextId = 1; this.tasks = new Map(); }
  setTimeout(callback, delay) {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.now + Math.max(0, Number(delay) || 0), callback });
    return { id, unref() {} };
  }
  clearTimeout(handle) { if (handle?.id) this.tasks.delete(handle.id); }
  advance(milliseconds) { this.now += milliseconds; this.runDue(); }
  runNext() {
    const next = [...this.tasks.entries()].sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
    assert(next, "manual scheduler had no pending task");
    this.now = Math.max(this.now, next[1].at);
    this.tasks.delete(next[0]);
    next[1].callback();
  }
  runDue() {
    for (;;) {
      const next = [...this.tasks.entries()].filter(([, task]) => task.at <= this.now)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!next) return;
      this.tasks.delete(next[0]); next[1].callback();
    }
  }
}

class FakeRelayBase {
  constructor(options) {
    this.options = options; this.started = false; this.stopped = false; this.ready = false; this.sent = []; this.sessionId = 7;
    this.startOptions = undefined;
    this.lastErrorClass = null; this.lastErrorReason = "unknown"; this.lastErrorReady = false; this.lastErrorAuthenticated = false;
  }
  start(options = {}) { this.started = true; this.stopped = false; this.startOptions = options; return new Promise(() => {}); }
  stop() { this.stopped = true; this.ready = false; }
  status() { return {
    ready: this.ready, closed: !this.started || this.stopped, transport: this.kind,
    outage_duration_ms: this.outageDurationMs || 0,
    last_transport_error_class: this.lastErrorClass,
    last_transport_error_reason: this.lastErrorReason,
    last_transport_error_ready: this.lastErrorReady,
    last_transport_error_authenticated: this.lastErrorAuthenticated,
  }; }
  currentSessionId() { return this.ready ? this.sessionId : 0; }
  send(value) { if (!this.ready) return false; this.sent.push(value); return true; }
  sendForSession(value, sessionId) { return this.ready && sessionId === this.sessionId && this.send(value)
    ? { ok: true, reason: "sent" } : { ok: false, reason: "transport_unavailable" }; }
  interrupt() { this.emitDisconnect(); return true; }
  confirmReady() { return true; }
  handleServerError() { return false; }
  observeWelcome() { return false; }
  acknowledge() { return false; }
  emitReady() { this.ready = true; this.stopped = false; this.options.onReady?.({ sessionId: this.sessionId }); }
  emitDisconnect() { const wasReady = this.ready; this.ready = false; if (wasReady) this.options.onDisconnect?.(); }
}

class FakeWebSocketRelay extends FakeRelayBase {
  static instances = [];
  constructor(options) { super(options); this.kind = "websocket"; FakeWebSocketRelay.instances.push(this); }
  takeoverConnectionId() { return `connection_${"a".repeat(43)}`; }
  emitDegraded() { this.options.onDegraded?.({ category: "relay_transport_timeout" }); }
  emitRecovered() { this.options.onRecovered?.({ category: "relay_transport_timeout" }); }
}
class FakeHttpRelay extends FakeRelayBase {
  static instances = [];
  constructor(options) { super(options); this.kind = "https"; FakeHttpRelay.instances.push(this); }
}

await testSignedHttpRelayAuthentication();
testTransportSequences();
await testHttpFallbackFailureClassification();
await testLocalLostResponseDoesNotReplayToolCall();
await testSessionResetDoesNotCommitPriorInboundSequence();
await testTakeoverPreemptsStandbyRequest();
await testStandbyAndFailureBackoff();
await testPrimaryFallbackHandover();
console.log("relay HTTP fallback reliability test ok");
