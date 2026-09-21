import assert from "node:assert/strict";
import relayContract from "../src/shared/relay-contract.json" with { type: "json" };
import { DAEMON_HTTP_RELAY_TTL_SECONDS } from "../src/shared/daemon-auth.mjs";
import { DaemonHttpRegistry } from "../src/worker/daemon-http-registry.ts";
import { scheduleRuntimeAlarm, processRuntimeAlarm } from "../src/worker/runtime-alarm.ts";
import { consumeBoundedNonce } from "../src/worker/nonce-store.ts";

// Executes the production idle HTTP registry, nonce store and alarm scheduler.
// Counts API mutations, not provider billable rows or a whole-account budget.
export async function testExecutedIdleRelayBudget() {
  const start = 1_800_000_000_000; const end = start + 86_400_000;
  let alarm = null; let writes = 0; let alarmWrites = 0; let alarmCallbacks = 0; let polls = 0;
  const values = new Map();
  const storage = {
    get: async (key) => values.get(key),
    put: async (key, value) => { writes += 1; values.set(key, structuredClone(value)); },
    transaction: async (callback) => callback(storage),
    getAlarm: async () => alarm,
    setAlarm: async (value) => { alarmWrites += 1; alarm = Number(value); },
    deleteAlarm: async () => { throw new Error("healthy idle scenario unexpectedly deleted its liveness alarm"); },
  };
  const http = new DaemonHttpRegistry();
  const channel = http.beginCandidate("relay_http_" + "a".repeat(43), {
    role: "candidate", instanceId: "synthetic_budget_instance",
    connectedAt: new Date(start).toISOString(), lastSeenAt: new Date(start).toISOString(),
  }, start);
  channel.activate(start); channel.verifyReady(start);
  const context = {
    storage, pending: { expireDue: async () => {}, nextDeadlineDelayMs: () => Infinity },
    daemonRegistry: {
      http, candidateSockets: () => [], probingSockets: () => [], readyRoleSockets: () => [],
      httpCandidates: (now) => http.candidates(now),
    },
    invalidateDaemonSocket: async () => { throw new Error("unexpected socket expiry"); },
    invalidateDaemonChannel: async () => { throw new Error("healthy HTTP relay expired"); },
    onScheduleError: (error) => { throw error; },
  };
  await scheduleRuntimeAlarm(context, start);
  let nextPoll = start + relayContract.httpFallbackPollIntervalMs;
  while (Math.min(alarm ?? Infinity, nextPoll) <= end) {
    const now = Math.min(alarm ?? Infinity, nextPoll);
    if (alarm === now) { alarm = null; alarmCallbacks += 1; await processRuntimeAlarm(context, now); }
    if (nextPoll === now) {
      polls += 1; channel.touch(now);
      await consumeBoundedNonce(storage, {
        key: "daemon-http-relay-nonces", nonce: String(polls).padStart(43, "a"),
        expiresAt: Math.floor(now / 1000) + DAEMON_HTTP_RELAY_TTL_SECONDS, now: Math.floor(now / 1000),
        noncePattern: /^[A-Za-z0-9_-]{24,128}$/, maximum: 1024, maxFutureSeconds: DAEMON_HTTP_RELAY_TTL_SECONDS * 2,
      });
      await scheduleRuntimeAlarm(context, now);
      nextPoll += relayContract.httpFallbackPollIntervalMs;
    }
  }
  assert.equal(polls, 17_280, "idle request count drifted from the executed day scenario");
  assert.equal(writes, polls, "accepted polls did not each consume exactly one nonce write");
  assert(alarmCallbacks > 8_000, "budget fixture failed to execute recurring liveness alarms");
  assert.equal(alarmWrites, alarmCallbacks + 1);
  assert(writes + alarmWrites < 30_000, "idle nonce plus alarm mutations exceeded the scenario budget");
}
