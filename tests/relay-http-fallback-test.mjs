import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createDeviceIdentity, createDeviceSessionIdentity, publicDeviceJwkJson } from "../src/local/device-identity.mjs";
import { createDaemonHttpRelayHeaders } from "../src/local/daemon-http-relay-auth.mjs";
import { DaemonHttpRelayConnection } from "../src/local/daemon-http-relay-connection.mjs";
import { postDaemonHttpRelay } from "../src/local/daemon-http-relay-request.mjs";
import { RelayInboundSequence, RelayOutboundSequence } from "../src/local/daemon-http-relay-sequence.mjs";
import { proxyAgentForRelayHttp } from "../src/local/network-proxy.mjs";
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

async function testDynamicHttpDeviceSessionProvider() {
  const root = createDeviceIdentity();
  let current = createDeviceSessionIdentity(root, ORIGIN, SERVER, VERSION, NOW);
  const scheduler = new ManualScheduler();
  const keys = [];
  const connection = new DaemonHttpRelayConnection({
    workerUrl: ORIGIN, deviceIdentity: current, deviceIdentityProvider: () => current,
    expectedServer: SERVER, expectedVersion: VERSION, instanceId: "instance_session_rotate_1",
    scheduler, now: () => scheduler.now, wallNow: () => NOW + scheduler.now,
    minimumRequestIntervalMs: 1, pollIntervalMs: 1000, standbyRetryIntervalMs: 1,
    descriptor: () => ({ tools: [], policy: {}, relayDiagnostics: {} }), ownedCallIds: () => [],
    postRequest: async ({ headers }) => {
      keys.push(headers["X-Bridge-Device-Key"]);
      return response({ protocol: 1, phase: "standby", ack_daemon_seq: 0, messages: [] });
    },
  });
  connection.start();
  await runNext(scheduler);
  current = createDeviceSessionIdentity(root, ORIGIN, SERVER, VERSION, NOW + 1_000);
  await runNext(scheduler);
  assert.equal(keys.length, 2, "dynamic HTTP session fixture did not issue two authenticated polls");
  assert.notEqual(keys[0], keys[1],
    "HTTPS fallback retained the startup device-session identity after the shared provider rotated");
  connection.stop();
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

async function testDedicatedHttpFallbackProxy() {
  const targetUrl = "http://relay-fallback.example.invalid:47891/daemon/http";
  let resolverCalls = 0;
  const dedicatedProxy = proxyAgentForRelayHttp(
    targetUrl,
    () => { resolverCalls += 1; return ""; },
    {
      MBM_RELAY_PROXY: "http://proxy.example.invalid:8080",
      NO_PROXY: "relay-fallback.example.invalid",
      no_proxy: "relay-fallback.example.invalid",
    },
  );
  assert.equal(dedicatedProxy.mode, "proxy",
    "signed HTTPS fallback did not select the dedicated application proxy route");
  assert(dedicatedProxy.agent, "dedicated relay proxy did not construct an HTTP proxy agent");
  const repeatedDedicatedProxy = proxyAgentForRelayHttp(
    targetUrl,
    () => { resolverCalls += 1; return ""; },
    { MBM_RELAY_PROXY: "http://proxy.example.invalid:8080" },
  );
  assert.equal(repeatedDedicatedProxy.agent, dedicatedProxy.agent,
    "signed HTTPS standby rebuilt its proxy CONNECT agent instead of reusing the warm bounded path");
  assert.equal(dedicatedProxy.agent.keepAlive, true,
    "signed HTTPS standby proxy agent did not enable connection keep-alive");
  assert.equal(resolverCalls, 0,
    "signed HTTPS fallback allowed NO_PROXY resolution to override MBM_RELAY_PROXY");

  let independentResolverCalls = 0;
  const independentFallback = proxyAgentForRelayHttp(
    targetUrl,
    () => { independentResolverCalls += 1; return ""; },
    {
      MBM_RELAY_PROXY: "http://proxy.example.invalid:8080",
      MBM_RELAY_FALLBACK_PROXY: "",
    },
  );
  assert.equal(independentFallback.mode, "direct",
    "explicit empty fallback proxy did not bypass the primary relay proxy");
  assert.equal(independentFallback.agent, null,
    "explicit empty fallback proxy unexpectedly constructed an application proxy agent");
  assert.equal(independentResolverCalls, 1,
    "explicit empty fallback proxy did not restore standard environment-proxy resolution");

  let fallbackProxyResolverCalls = 0;
  const independentFallbackProxy = proxyAgentForRelayHttp(
    targetUrl,
    () => { fallbackProxyResolverCalls += 1; return "http://standard.example.invalid:8081"; },
    {
      MBM_RELAY_PROXY: "http://primary.example.invalid:8080",
      MBM_RELAY_FALLBACK_PROXY: "http://fallback.example.invalid:8082",
    },
  );
  assert.equal(independentFallbackProxy.mode, "proxy");
  assert(independentFallbackProxy.agent,
    "explicit fallback proxy did not construct an independent HTTP proxy agent");
  assert.equal(fallbackProxyResolverCalls, 0,
    "explicit fallback proxy unexpectedly consulted standard environment-proxy resolution");

  const proxyMarker = { kind: "synthetic-relay-proxy" };
  const requests = [];
  const result = await postDaemonHttpRelay({
    url: targetUrl,
    headers: { "Content-Type": "application/json" },
    body: "{}",
    timeoutMs: 2_000,
    maximumResponseBytes: 1024,
    selectProxy: (url) => {
      assert.equal(url, targetUrl);
      return { agent: proxyMarker, mode: "proxy" };
    },
    request: fakeHttpRequest(({ target, options, body }) => {
      requests.push({ target: target.href, options, body });
      return { statusCode: 200, body: "{}" };
    }),
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.networkRoute, "application-http-proxy",
    "signed HTTPS fallback did not report the dedicated application proxy route");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].target, targetUrl);
  assert.equal(requests[0].options.agent, proxyMarker,
    "signed HTTPS fallback did not pass the dedicated proxy agent to the HTTP request");
  assert.equal(requests[0].options.method, "POST");
  assert.equal(requests[0].body, "{}");

  let failedRequests = 0;
  await assert.rejects(
    postDaemonHttpRelay({
      url: targetUrl,
      headers: { "Content-Type": "application/json" },
      body: "{}",
      timeoutMs: 2_000,
      maximumResponseBytes: 1024,
      selectProxy: () => ({ agent: proxyMarker, mode: "proxy" }),
      request: fakeHttpRequest(({ options }) => {
        failedRequests += 1;
        assert.equal(options.agent, proxyMarker);
        throw Object.assign(new Error("synthetic proxy unavailable"), { code: "ECONNREFUSED" });
      }),
    }),
    /synthetic proxy unavailable/,
    "unreachable MBM_RELAY_PROXY fell back to a directly reachable relay target",
  );
  assert.equal(failedRequests, 1,
    "proxy request failure retried the relay through a direct network route");
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
  assert.equal(connection.status().standby, true,
    "successful standby response was not exposed as warm fallback state");
  assert.equal(connection.status().takeover_pending, false,
    "ordinary standby was mislabeled as an exact-generation takeover");
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
  assert.equal(connection.status().takeover_pending, true,
    "exact-generation takeover did not replace standby state before its first request");
  await runNext(scheduler);
  assert.equal(requests.length, 5, "exact-generation takeover did not preempt the longer standby retry timer");
  assert.equal(requests[4].at, 81, "takeover preemption bypassed or exceeded the minimum request interval");
  assert.equal(requests[4].body.takeover_websocket, true);
  assert.equal(requests[4].body.takeover_websocket_connection_id, takeoverConnectionId,
    "preempted fallback request lost its exact WebSocket-generation takeover binding");
  connection.stop();
}

async function testTakeoverTimeoutFitsNewCallRecoveryWindow() {
  const root = createDeviceIdentity();
  const session = createDeviceSessionIdentity(root, ORIGIN, SERVER, VERSION, NOW);
  const scheduler = new ManualScheduler();
  const activation = `activate_${"t".repeat(43)}`;
  const connectionId = `connection_${"u".repeat(43)}`;
  const requestTimeouts = [];
  let requestNumber = 0;
  let readyAt = null;
  let connection;
  connection = new DaemonHttpRelayConnection({
    workerUrl: ORIGIN, deviceIdentity: session, expectedServer: SERVER, expectedVersion: VERSION,
    instanceId: "instance_takeover_budget", scheduler, now: () => scheduler.now, wallNow: () => NOW + scheduler.now,
    minimumRequestIntervalMs: 750, pollIntervalMs: 1000, failureBackoffBaseMs: 1000,
    requestTimeoutMs: 7000, takeoverRequestTimeoutMs: 3000, livenessTimeoutMs: 12000,
    descriptor: () => ({ tools: ["list_dir"], policy: { profile: "full" }, relayDiagnostics: {} }),
    ownedCallIds: () => [],
    postRequest: ({ body, timeoutMs }) => {
      requestNumber += 1;
      requestTimeouts.push(timeoutMs);
      const parsed = JSON.parse(body);
      assert.equal(parsed.takeover_websocket, true,
        "recovery-budget fixture lost exact-generation takeover while retrying");
      assert.equal(parsed.takeover_websocket_connection_id, connectionId,
        "recovery-budget fixture changed takeover generation while retrying");
      if (requestNumber === 1) {
        return new Promise((_resolve, reject) => {
          scheduler.setTimeout(() => reject(Object.assign(new Error("synthetic stale network epoch"), { code: "ETIMEDOUT" })), timeoutMs);
        });
      }
      if (requestNumber === 2) {
        return Promise.resolve(response({
          protocol: 1, phase: "probing", activation_token: activation, ack_daemon_seq: 0,
          messages: [
            { seq: 1, payload: { type: "resume_calls", ids: [] } },
            { seq: 2, payload: { type: "ready_ack", server: SERVER, version: VERSION } },
          ],
        }));
      }
      return Promise.resolve(response({
        protocol: 1, phase: "ready", activation_token: activation, ack_daemon_seq: 2, messages: [],
      }));
    },
    onMessage: (raw, context) => {
      const message = JSON.parse(raw);
      if (message.type !== "ready_ack") return;
      assert.equal(connection.confirmReady(message), true,
        "takeover recovery-budget fixture rejected Worker readiness acknowledgement");
      assert.equal(connection.sendForSession({ type: "resume_calls_ack", missing_ids: [] }, context.sessionId).ok, true,
        "takeover recovery-budget fixture could not queue resume acknowledgement");
    },
    onReady: () => { readyAt = scheduler.now; },
  });

  connection.start({ takeoverWebSocket: true, takeoverWebSocketConnectionId: connectionId });
  await runNext(scheduler); // dispatch first takeover request; it remains stuck on the stale network epoch
  await runNext(scheduler); // bounded takeover deadline rejects the stale request
  await runNext(scheduler); // first failure backoff expires; replacement probing request succeeds
  await runNext(scheduler); // verified-ready proof completes after the hard request-start interval
  assert.deepEqual(requestTimeouts, [3000, 3000, 3000],
    "takeover handshake used the ordinary seven-second request budget instead of the recovery-bounded deadline");
  assert(readyAt !== null && readyAt < 15000,
    `takeover did not recover inside the new-call recovery window: ready_at_ms=${readyAt}`);
  connection.stop();
}

async function testPrimaryFallbackHandover() {
  const scheduler = new ManualScheduler();
  const ready = [];
  const disconnected = [];
  FakeWebSocketRelay.instances.length = 0;
  FakeHttpRelay.instances.length = 0;
  const relay = new ResilientRelayConnection({
    scheduler, fallbackDelayMs: 1500, standbyDelayMs: 5000,
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
  scheduler.advance(0);
  assert.equal(http.started, true, "verified WSS readiness did not immediately establish HTTPS standby prewarm");
  assert.equal(http.startOptions?.takeoverWebSocket, false,
    "healthy WSS standby prewarm incorrectly requested takeover authority");
  assert.equal(relay.status().https_fallback_warming, true,
    "new HTTPS standby was not visible while its first standby exchange was pending");
  http.markStandby();
  assert.equal(relay.status().https_fallback_standby, true,
    "verified standby state was not distinguishable from fallback warming");
  assert.equal(relay.status().https_fallback_warming, false,
    "verified standby state remained mislabeled as warming");
  assert.equal(relay.send({ type: "one" }), true);
  assert.equal(ws.sent.length, 1, "ready WSS was not the preferred send path");

  ws.emitDegraded();
  scheduler.advance(0);
  assert.equal(http.startOptions?.takeoverWebSocket, false,
    "WSS liveness suspicion prematurely took ownership away from a WSS still under confirmation");
  ws.emitRecovered();
  assert.equal(http.stopped, false, "recovered WSS tore down the bounded HTTPS standby path");
  assert.equal(relay.status().https_fallback_standby, true,
    "recovered WSS lost the verified HTTPS standby state");

  ws.emitDisconnect();
  scheduler.advance(0);
  assert.equal(http.started, true, "HTTPS standby object was not retained after WSS loss");
  assert.equal(http.startOptions?.takeoverWebSocket, true,
    "established WSS loss did not promote standby into exact-generation HTTPS takeover");
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
  assert.equal(http.stopped, true, "WSS reclaim did not retire the takeover session before returning it to standby");
  scheduler.advance(0);
  assert.equal(http.stopped, false, "WSS reclaim failed to rebuild bounded HTTPS standby immediately");
  assert.equal(http.startOptions?.takeoverWebSocket, false,
    "post-reclaim HTTPS standby retained stale takeover authority");
  assert.deepEqual(disconnected, ["websocket"], "transport handover generated a false second runtime disconnect");
  assert.deepEqual(ready, ["websocket", "https"],
    "preferred WSS reclaim emitted a duplicate global bridge-ready notification");
  relay.stop();
}


async function testPrimaryFallbackHandoverStress() {
  const cycles = 128;
  const scheduler = new ManualScheduler();
  const ready = [];
  const disconnected = [];
  FakeWebSocketRelay.instances.length = 0;
  FakeHttpRelay.instances.length = 0;
  const relay = new ResilientRelayConnection({
    scheduler, fallbackDelayMs: 1500, standbyDelayMs: 5000,
    WebSocketRelayClass: FakeWebSocketRelay,
    HttpRelayClass: FakeHttpRelay,
    websocket: {}, http: {},
    onReady: (event) => ready.push(event.transport),
    onDisconnect: (event) => disconnected.push(event.transport),
  });
  const started = relay.start();
  const ws = FakeWebSocketRelay.instances[0];
  const http = FakeHttpRelay.instances[0];
  ws.emitReady();
  assert.equal(await started, true);
  scheduler.advance(0);
  http.markStandby();

  for (let index = 0; index < cycles; index += 1) {
    const generation = `connection_${String.fromCharCode(65 + (index % 26)).repeat(43)}`;
    ws.takeoverConnectionId = () => generation;
    assert.equal(relay.status().transport, "websocket",
      `stress cycle ${index} did not begin with WSS ownership`);
    assert.equal(relay.status().https_fallback_standby, true,
      `stress cycle ${index} did not begin with a warm HTTPS standby`);

    ws.emitDisconnect();
    scheduler.advance(0);
    assert.equal(http.startOptions?.takeoverWebSocket, true,
      `stress cycle ${index} did not promote standby after WSS loss`);
    assert.equal(http.startOptions?.takeoverWebSocketConnectionId, generation,
      `stress cycle ${index} lost exact disconnected-generation binding`);

    ws.outageDurationMs = index + 1;
    http.emitReady();
    assert.equal(relay.status().transport, "https",
      `stress cycle ${index} did not converge to HTTPS ownership`);
    assert.equal(relay.send({ type: "stress_https", index }), true,
      `stress cycle ${index} could not send through HTTPS takeover`);

    ws.emitReady();
    assert.equal(relay.status().transport, "websocket",
      `stress cycle ${index} did not return ownership to WSS`);
    scheduler.advance(0);
    assert.equal(http.startOptions?.takeoverWebSocket, false,
      `stress cycle ${index} retained stale takeover authority after WSS reclaim`);
    http.markStandby();
    assert.equal(relay.status().https_fallback_standby, true,
      `stress cycle ${index} failed to re-establish HTTPS standby`);
    assert.equal(relay.send({ type: "stress_websocket", index }), true,
      `stress cycle ${index} could not send through reclaimed WSS`);
  }

  assert.equal(disconnected.length, cycles,
    "stress handovers produced a missing or duplicate global disconnect notification");
  assert(disconnected.every((transport) => transport === "websocket"),
    "stress handovers reported a false HTTPS global disconnect");
  assert.equal(ready.filter((transport) => transport === "websocket").length, 1,
    "stress WSS reclaims emitted duplicate global ready notifications");
  assert.equal(ready.filter((transport) => transport === "https").length, cycles,
    "stress HTTPS takeovers produced a missing or duplicate global ready notification");
  relay.stop();
}

function testAuthenticationRefreshInterruptsBothTransports() {
  FakeWebSocketRelay.instances.length = 0;
  FakeHttpRelay.instances.length = 0;
  const relay = new ResilientRelayConnection({
    scheduler: new ManualScheduler(), WebSocketRelayClass: FakeWebSocketRelay, HttpRelayClass: FakeHttpRelay,
    websocket: {}, http: {},
  });
  const ws = FakeWebSocketRelay.instances[0];
  const http = FakeHttpRelay.instances[0];
  const categories = [];
  ws.interrupt = (category) => { categories.push(["websocket", category]); return true; };
  http.interrupt = (category) => { categories.push(["https", category]); return true; };
  assert.equal(relay.refreshAuthentication(), true,
    "session rotation did not request transport authentication refresh");
  assert.deepEqual(categories, [
    ["websocket", "relay_session_rotated"], ["https", "relay_session_rotated"],
  ], "session rotation refreshed only one relay transport or used an unstable close category");
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

function fakeHttpRequest(handler) {
  return (target, options, onResponse) => {
    const request = new EventEmitter();
    request.destroy = (error) => { if (error) queueMicrotask(() => request.emit("error", error)); };
    request.end = (body) => {
      queueMicrotask(() => {
        let scripted;
        try { scripted = handler({ target, options, body }); }
        catch (error) { request.emit("error", error); return; }
        const response = new EventEmitter();
        response.statusCode = scripted.statusCode ?? 200;
        response.headers = scripted.headers ?? {};
        response.destroy = () => {};
        onResponse(response);
        const payload = Buffer.from(scripted.body ?? "");
        if (payload.length > 0) response.emit("data", payload);
        response.emit("end");
      });
    };
    return request;
  };
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
    this.startOptions = undefined; this.standby = false;
    this.lastErrorClass = null; this.lastErrorReason = "unknown"; this.lastErrorReady = false; this.lastErrorAuthenticated = false;
  }
  start(options = {}) { this.started = true; this.stopped = false; this.startOptions = options; if (options.takeoverWebSocket === true) this.standby = false; return new Promise(() => {}); }
  stop() { this.stopped = true; this.ready = false; this.standby = false; }
  status() { return {
    ready: this.ready, closed: !this.started || this.stopped, transport: this.kind, standby: this.standby,
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
  emitReady() { this.ready = true; this.standby = false; this.stopped = false; this.options.onReady?.({ sessionId: this.sessionId }); }
  markStandby() { this.ready = false; this.standby = true; this.stopped = false; }
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
await testDynamicHttpDeviceSessionProvider();
testTransportSequences();
await testDedicatedHttpFallbackProxy();
await testHttpFallbackFailureClassification();
await testLocalLostResponseDoesNotReplayToolCall();
await testSessionResetDoesNotCommitPriorInboundSequence();
await testTakeoverPreemptsStandbyRequest();
await testStandbyAndFailureBackoff();
await testTakeoverTimeoutFitsNewCallRecoveryWindow();
testAuthenticationRefreshInterruptsBothTransports();
await testPrimaryFallbackHandover();
await testPrimaryFallbackHandoverStress();
console.log("relay HTTP fallback reliability test ok");
