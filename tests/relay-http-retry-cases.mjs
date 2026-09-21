import assert from "node:assert/strict";
import { DaemonHttpRelayConnection } from "../src/local/daemon-http-relay-connection.mjs";
import { postDaemonHttpRelay } from "../src/local/daemon-http-relay-request.mjs";
import { relayRetryAfterMs } from "../src/local/daemon-http-retry-policy.mjs";
import relayContract from "../src/shared/relay-contract.json" with { type: "json" };
import { createDaemonPreflightHeaders, createDeviceIdentity, createDeviceSessionIdentity, publicDeviceJwkJson } from "../src/local/device-identity.mjs";
import { createDaemonHttpRelayHeaders } from "../src/local/daemon-http-relay-auth.mjs";
import { verifyDaemonHttpRelayRequest } from "../src/worker/daemon-http-auth.ts";
import { consumeDaemonPreflightNonce, verifyDaemonPreflight } from "../src/worker/daemon-auth.ts";
import { DAEMON_HTTP_RELAY_TTL_SECONDS, DAEMON_PREFLIGHT_TTL_SECONDS } from "../src/shared/daemon-auth.mjs";

export async function testRelayRetryPolicy(fixture) {
  const { NOW, ORIGIN, SERVER, VERSION, fakeHttpRequest, ManualScheduler, runNext } = fixture;
  assert.equal(relayRetryAfterMs(429, "60", NOW), 60_000);
  assert.equal(relayRetryAfterMs(503, new Date(NOW + 120_000).toUTCString(), NOW), 120_000);
  assert.equal(relayRetryAfterMs(503, "999999999999", NOW), relayContract.httpFallbackMaximumRetryAfterMs);
  for (const value of ["-1", "0", "1.5", "NaN", "Infinity", "tomorrow", "9".repeat(129), [], null,
    new Date(NOW - 1000).toUTCString()]) assert.equal(relayRetryAfterMs(429, value, NOW), 0);
  assert.equal(relayRetryAfterMs(200, "60", NOW), 0);
  assert.equal(relayRetryAfterMs(500, "60", NOW), 0);
  const wire = await postDaemonHttpRelay({
    url: ORIGIN, headers: {}, body: "{}", timeoutMs: 1000, maximumResponseBytes: 1024,
    selectProxy: () => ({}),
    request: fakeHttpRequest(() => ({ statusCode: 503, headers: { "retry-after": "60" }, body: "" })),
  });
  assert.equal(wire.retryAfterMs, 60_000, "request adapter discarded Retry-After");
  assert.equal(Object.hasOwn(wire, "headers"), false, "raw response headers escaped the request adapter");

  const root = createDeviceIdentity();
  const identity = createDeviceSessionIdentity(root, ORIGIN, SERVER, VERSION, NOW);
  for (const statusCode of [429, 503]) {
    const scheduler = new ManualScheduler(); scheduler.now = 1000;
    let attempts = 0; let wall = NOW; let disconnects = 0;
    const connection = new DaemonHttpRelayConnection({
      workerUrl: ORIGIN, expectedServer: SERVER, expectedVersion: VERSION, deviceIdentity: identity,
      scheduler, now: () => scheduler.now, wallNow: () => wall,
      onDisconnect: () => { disconnects += 1; },
      postRequest: async () => {
        attempts += 1;
        return attempts === 1 ? { statusCode, body: "", retryAfterMs: 60_000 }
          : { statusCode: 200, body: JSON.stringify({ protocol: 1, phase: "standby", ack_daemon_seq: 0, messages: [] }) };
      },
    });
    connection.start(); connection.ready = true; connection.authenticated = true;
    connection.activeSessionId = 1; connection.lastSuccessAt = scheduler.now;
    await runNext(scheduler);
    assert.equal(disconnects, 1, "long server backoff retained false-ready transport state");
    assert.equal(connection.ready, false);
    const deadline = 61_000;
    assert.equal(connection.pollTimerDueAt, deadline);
    assert.equal(connection.status().http_retry_delay_ms, 60_000);
    assert.equal(connection.status().http_retry_status_code, statusCode);
    for (const action of [
      () => connection.start(),
      () => connection.start({ takeoverWebSocket: true, takeoverWebSocketConnectionId: "connection_" + "a".repeat(43) }),
      () => connection.interrupt(),
      () => { connection.stop(); connection.start(); },
    ]) {
      action(); await connection.poll();
      assert.equal(attempts, 1, "lifecycle entry bypassed the server retry deadline");
      assert.equal(connection.pollTimerDueAt, deadline);
    }
    wall += 24 * 60 * 60 * 1000;
    scheduler.advance(59_999); await connection.poll();
    assert.equal(connection.status().http_retry_delay_ms, 1, "cooldown diagnostics did not track monotonic time");
    assert.equal(attempts, 1, "wall-clock change or direct poll bypassed monotonic backoff");
    wall = NOW + 60_000;
    await runNext(scheduler);
    assert.equal(attempts, 2);
    assert.equal(connection.consecutiveFailures, 0);
    assert.equal(connection.retryNotBeforeAt, 0, "success retained the old retry deadline");
    assert.equal(connection.status().http_retry_delay_ms, 0);
    assert.equal(connection.status().http_retry_status_code, null);
    connection.stop();
  }

  const scheduler = new ManualScheduler(); scheduler.now = 1000;
  let attempts = 0; const envelopes = [];
  const connection = new DaemonHttpRelayConnection({
    workerUrl: ORIGIN, expectedServer: SERVER, expectedVersion: VERSION, deviceIdentity: identity,
    scheduler, now: () => scheduler.now, wallNow: () => NOW + scheduler.now,
    postRequest: async ({ body }) => { attempts += 1; envelopes.push(JSON.parse(body)); throw new Error("synthetic transport failure"); },
  });
  connection.start(); connection.ready = true; connection.authenticated = true;
  connection.activeSessionId = 7; connection.lastSuccessAt = scheduler.now;
  connection.consecutiveFailures = 3;
  await runNext(scheduler);
  assert.equal(connection.pollTimerDueAt, 6000);
  assert.equal(connection.send({ type: "tool_result", id: "call_retry_queue" }), true);
  assert.equal(connection.sendForSession({ type: "resume_calls_ack", missing_ids: [] }, 7).ok, true);
  assert.equal(connection.pollTimerDueAt, 6000, "queued work accelerated exponential failure backoff");
  scheduler.advance(750); await connection.poll();
  assert.equal(attempts, 1);
  await runNext(scheduler);
  assert.equal(attempts, 2);
  assert.deepEqual(envelopes[1].messages.map((item) => item.seq), [1, 2], "backoff dropped or duplicated queued envelopes");
  connection.stop();
  await testAuthenticationExpiry(fixture, identity, publicDeviceJwkJson(root));
}

async function testAuthenticationExpiry({ MemoryStorage, ORIGIN, SERVER, VERSION, NOW }, identity, publicKeyJson) {
  const issued = Math.floor(NOW / 1000);
  const body = Buffer.from("{}");
  const headers = new Headers(createDaemonHttpRelayHeaders(identity, ORIGIN, SERVER, VERSION, body, NOW));
  for (const age of [DAEMON_HTTP_RELAY_TTL_SECONDS - 1, DAEMON_HTTP_RELAY_TTL_SECONDS, DAEMON_HTTP_RELAY_TTL_SECONDS + 1]) {
    const storage = new MemoryStorage();
    const accepted = age < DAEMON_HTTP_RELAY_TTL_SECONDS;
    assert.equal(await verifyDaemonHttpRelayRequest({
      storage, publicKeyJson, headers, body, workerOrigin: ORIGIN, server: SERVER, version: VERSION, now: issued + age,
    }), accepted, "HTTP authentication expiry boundary did not fail closed");
    assert.equal(storage.putCalls, accepted ? 1 : 0, "expired HTTP authentication wrote a replay nonce");
  }
  const preflightHeaders = new Headers(createDaemonPreflightHeaders(identity, ORIGIN, SERVER, VERSION, NOW));
  for (const age of [DAEMON_PREFLIGHT_TTL_SECONDS - 1, DAEMON_PREFLIGHT_TTL_SECONDS, DAEMON_PREFLIGHT_TTL_SECONDS + 1]) {
    const authorization = await verifyDaemonPreflight({
      publicKeyJson, headers: preflightHeaders, workerOrigin: ORIGIN, server: SERVER, version: VERSION, now: issued + age,
    });
    assert.equal(Boolean(authorization), age < DAEMON_PREFLIGHT_TTL_SECONDS, "WebSocket preflight accepted the exact expiry");
  }
  const authorization = await verifyDaemonPreflight({
    publicKeyJson, headers: preflightHeaders, workerOrigin: ORIGIN, server: SERVER, version: VERSION, now: issued,
  });
  assert(authorization);
  const storage = new MemoryStorage();
  assert.equal(await consumeDaemonPreflightNonce(storage, authorization, authorization.expiresAt), false,
    "verification-to-consumption expiry raised an exception or accepted an expired nonce");
  assert.equal(storage.putCalls, 0);
  assert.equal(await consumeDaemonPreflightNonce(storage, {
    ...authorization, certificateExpiresAt: issued - 1,
  }, issued), false, "an expired certificate allowed a still-live preflight nonce to be consumed");
  assert.equal(storage.putCalls, 0);
}
