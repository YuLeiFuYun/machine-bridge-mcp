import { McpResumptionStore, McpStreamLimitError, parseStreamEventId, streamEventId } from "../src/worker/mcp-resumption.ts";
import { resumptionLimits } from "../src/worker/mcp-resumption-config.ts";
import { pendingCallSnapshot } from "../src/worker/mcp-pending-call-inspection.ts";
import {
  messageSha256,
  readIndex,
  resumableMessageJson,
  storedMessage,
  validRecord,
  validateStreamIdentity,
} from "../src/worker/mcp-resumption-records.ts";

async function testEventIdentifiers() {
  const streamId = validStreamId("A");
  assert(streamEventId(streamId, 0) === `${streamId}:0`, "initial event id was malformed");
  assert(streamEventId(streamId, 1) === `${streamId}:1`, "terminal event id was malformed");
  assert(parseStreamEventId(`${streamId}:0`)?.sequence === 0, "initial event id did not parse");
  assert(parseStreamEventId(`${streamId}:1`)?.sequence === 1, "terminal event id did not parse");
  assert(parseStreamEventId(`${streamId}:2`) === null, "unknown event sequence was accepted");
  assert(parseStreamEventId("stream_short:0") === null, "short stream id was accepted");
}

async function testRecordValidationAndLimits() {
  const streamId = validStreamId("L");
  const baseEntry = { stream_id: streamId, status: "pending", created_at: 1, expires_at: 2 };
  assert(readIndex(undefined).entries.length === 0, "missing index did not initialize empty");
  for (const invalid of [
    null,
    { schema_version: 2, entries: [] },
    { schema_version: 1, entries: [{}] },
    { schema_version: 1, entries: [baseEntry, baseEntry] },
    { schema_version: 1, entries: Array.from({ length: 65 }, (_, index) => ({ ...baseEntry, stream_id: validStreamId(String.fromCharCode(65 + index % 26)) })) },
  ]) {
    await expectReject(Promise.resolve().then(() => readIndex(invalid)), Error);
  }

  const pending = {
    schema_version: 1,
    ...baseEntry,
    token_key: "token",
    session_id: "session",
    request_id: 1,
  };
  assert(validRecord(pending), "valid pending record was rejected");
  assert(!validRecord({ ...pending, message_json: "{}" }), "pending record accepted terminal content");
  assert(!validRecord({ ...pending, status: "ready" }), "ready record without integrity metadata was accepted");
  const validCall = {
    call_id: `call_${"C".repeat(43)}`,
    daemon_instance_id: "daemon_record_call_123456",
    connection_id: `connection_${"C".repeat(43)}`,
    tool: "exec_command",
    state: "attached",
    started_at: 1,
    operation_deadline_at: 10,
    remaining_timeout_ms: 9,
  };
  assert(validRecord({ ...pending, call: validCall }), "valid persisted pending-call metadata was rejected");
  for (const call of [
    { ...validCall, call_id: "call_short" },
    { ...validCall, state: "attached", reconnect_deadline_at: 20 },
    { ...validCall, state: "detached" },
    { ...validCall, remaining_timeout_ms: 0 },
    { ...validCall, transform: { kind: "project_overview", account_id: "", account_version: 1, role: "owner" } },
  ]) {
    assert(!validRecord({ ...pending, call }), "invalid persisted pending-call metadata was accepted");
  }

  for (const input of [
    ["stream_short", "token", "session", 1],
    [streamId, "", "session", 1],
    [streamId, "token", "s".repeat(257), 1],
    [streamId, "token", "session", null],
  ]) {
    await expectReject(Promise.resolve().then(() => validateStreamIdentity(...input)), Error);
  }

  const invalidJson = "{";
  const corruptRecord = {
    ...pending,
    status: "ready",
    message_json: invalidJson,
    message_sha256: await messageSha256(invalidJson),
  };
  assert((await storedMessage(corruptRecord)).error?.code === -32005, "invalid stored JSON did not fail closed");
  const scalarJson = "null";
  assert((await storedMessage({ ...corruptRecord, message_json: scalarJson, message_sha256: await messageSha256(scalarJson) })).error?.code === -32005, "scalar stored JSON was accepted as JSON-RPC");
  assert(JSON.parse(resumableMessageJson(undefined, 2, 512)).error.code === -32002, "non-serializable result did not use bounded fallback");

  const limits = resumptionLimits({
    retentionMs: 9_999_999,
    pendingRetentionMs: 9_999_999,
    maximumStreams: 999,
    maximumMessageBytes: 9_999_999,
  });
  assert(limits.retentionMs === 120_000, "terminal retention exceeded the shared hard ceiling");
  assert(limits.pendingRetentionMs === 730_000, "pending retention exceeded the execution plus replay hard ceiling");
  assert(limits.maximumStreams === 64 && limits.maximumMessageBytes === 1_500_000, "configured limits exceeded the shared hard ceilings");
}

async function testCompletedResultResumption() {
  const storage = new MemoryStorage();
  const store = new McpResumptionStore(storage, { now: () => 1000 });
  const streamId = validStreamId("B");
  await store.begin({ streamId, tokenKey: "token-owner", sessionId: "session-owner", requestId: 7 });
  await store.complete(streamId, { jsonrpc: "2.0", id: 7, result: { ok: true } });
  await store.complete(streamId, { jsonrpc: "2.0", id: 7, result: { ignored_duplicate: true } });

  const resumed = await store.resume({ lastEventId: `${streamId}:0`, tokenKey: "token-owner", sessionId: "session-owner" });
  assert(resumed.kind === "message", "completed stream was not resumable");
  const storedPoll = await store.pollMessage(streamId);
  assert(storedPoll.kind === "message" && storedPoll.message.result.ok === true, "trusted internal poll lost the stored terminal result");

  const complete = await store.resume({ lastEventId: `${streamId}:1`, tokenKey: "token-owner", sessionId: "session-owner" });
  assert(complete.kind === "complete", "terminal event was replayed after the client acknowledged it");
  const wrongToken = await store.resume({ lastEventId: `${streamId}:0`, tokenKey: "token-other", sessionId: "session-owner" });
  assert(wrongToken.kind === "not_found", "another OAuth token could discover a resumable stream");
  const wrongSession = await store.resume({ lastEventId: `${streamId}:0`, tokenKey: "token-owner", sessionId: "session-other" });
  assert(wrongSession.kind === "not_found", "another MCP session could discover a resumable stream");
}


async function testStorageWriteBudget() {
  const rows = [];
  const storage = new MemoryStorage();
  const store = new McpResumptionStore(storage, { now: () => 1000 }, () => {}, (count) => rows.push(count));
  const streamId = validStreamId("Q");
  await store.begin({ streamId, tokenKey: "token-budget", sessionId: "session-budget", requestId: 30 });
  await store.complete(streamId, { jsonrpc: "2.0", id: 30, result: { ok: true } });
  await store.complete(streamId, { jsonrpc: "2.0", id: 30, result: { duplicate: true } });
  assert(rows[0] === 2 && rows[1] === 2 && rows[2] === 0, "normal stream lifecycle exceeded or misreported its four-row write budget");
  assert(rows.reduce((sum, value) => sum + value, 0) === 4, "duplicate terminal settlement consumed additional storage writes");

  rows.length = 0;
  const durableId = validStreamId("R");
  const callId = `call_${"R".repeat(43)}`;
  const connectionId = `connection_${"R".repeat(43)}`;
  await store.begin({ streamId: durableId, tokenKey: "token-budget", sessionId: "session-budget", requestId: 31 });
  await store.calls.activate({
    streamId: durableId,
    callId,
    daemonInstanceId: "daemon_budget_call_123456",
    connectionId,
    tool: "exec_command",
    timeoutMs: 100,
  });
  await store.calls.complete(callId, connectionId, { jsonrpc: "2.0", id: 31, result: { ok: true } });
  await store.calls.complete(callId, connectionId, { jsonrpc: "2.0", id: 31, result: { duplicate: true } });
  assert(JSON.stringify(rows) === JSON.stringify([2, 2, 2]), "durable call lifecycle exceeded its fixed six-row write budget");
}

async function testMissingAndCorruptCompletionState() {
  const missingStorage = new MemoryStorage();
  const missingStore = new McpResumptionStore(missingStorage);
  const missingId = validStreamId("M");
  await missingStore.begin({ streamId: missingId, tokenKey: "token", sessionId: "session", requestId: 14 });
  missingStorage.values.delete(`mcp-stream:${missingId}`);
  await expectReject(missingStore.complete(missingId, { jsonrpc: "2.0", id: 14, result: {} }), Error);

  const corruptStorage = new MemoryStorage();
  const corruptStore = new McpResumptionStore(corruptStorage);
  const corruptId = validStreamId("N");
  await corruptStore.begin({ streamId: corruptId, tokenKey: "token", sessionId: "session", requestId: 15 });
  corruptStorage.values.set(`mcp-stream:${corruptId}`, { broken: true });
  await expectReject(corruptStore.resume({ lastEventId: `${corruptId}:0`, tokenKey: "token", sessionId: "session" }), Error);
}

async function testLiveResultResumption() {
  const storage = new MemoryStorage();
  const store = new McpResumptionStore(storage);
  const streamId = validStreamId("C");
  await store.begin({ streamId, tokenKey: "token-live", sessionId: "session-live", requestId: "live" });
  store.activate(streamId);
  const pendingPoll = await store.pollMessage(streamId);
  assert(pendingPoll.kind === "pending", "trusted internal poll did not report active execution as pending");
  const resumed = await store.resume({ lastEventId: `${streamId}:0`, tokenKey: "token-live", sessionId: "session-live" });
  assert(resumed.kind === "message", "active stream was not resumable");
  const liveMessage = { jsonrpc: "2.0", id: "live", result: { resumed: true } };
  await store.complete(streamId, liveMessage);
  const readyPoll = await store.pollMessage(streamId);
  assert(readyPoll.kind === "message" && readyPoll.message.result.resumed === true, "trusted internal poll lost the terminal result");
  assert((await store.pollMessage("stream_short")).kind === "not_found", "trusted internal poll accepted an invalid stream id");
}

async function testRestartFallback() {
  const storage = new MemoryStorage();
  const first = new McpResumptionStore(storage);
  const streamId = validStreamId("D");
  await first.begin({ streamId, tokenKey: "token-restart", sessionId: "session-restart", requestId: 9 });

  const restarted = new McpResumptionStore(storage);
  const resumed = await restarted.resume({ lastEventId: `${streamId}:0`, tokenKey: "token-restart", sessionId: "session-restart" });
  assert(resumed.kind === "message", "orphaned pending stream did not produce a terminal result");
  const message = await restarted.pollMessage(streamId);
  assert(message.kind === "message" && message.message.error?.code === -32003, "orphaned pending stream did not report lost execution state");
  const repeated = await restarted.resume({ lastEventId: `${streamId}:0`, tokenKey: "token-restart", sessionId: "session-restart" });
  const repeatedPoll = await restarted.pollMessage(streamId);
  assert(repeated.kind === "message" && repeatedPoll.kind === "message" && repeatedPoll.message.error?.code === -32003, "restart fallback was not persisted for repeat delivery");
}


async function testPersistentCallRecovery() {
  let now = 1_000;
  const storage = new MemoryStorage();
  const streamId = validStreamId("P");
  const callId = `call_${"C".repeat(43)}`;
  const daemonInstanceId = "daemon_persistent_call_123456";
  const firstConnectionId = `connection_${"A".repeat(43)}`;
  const secondConnectionId = `connection_${"B".repeat(43)}`;
  const first = new McpResumptionStore(storage, { now: () => now });
  await first.begin({ streamId, tokenKey: "token-persistent", sessionId: "session-persistent", requestId: 70 });
  await first.calls.activate({
    streamId,
    callId,
    daemonInstanceId,
    connectionId: firstConnectionId,
    clientRequestKey: "session-persistent:70",
    tool: "exec_command",
    timeoutMs: 500,
  });

  const restarted = new McpResumptionStore(storage, { now: () => now });
  assert((await restarted.pollMessage(streamId)).kind === "pending", "Worker restart orphaned a persisted active stream call");
  assert((await restarted.calls.snapshot()).active === 1, "persisted call was absent from the restarted pending snapshot");
  assert((await restarted.calls.get(callId))?.streamId === streamId, "persisted call id could not be recovered");
  assert((await restarted.calls.getByRequestKey("session-persistent:70"))?.call_id === callId,
    "persisted client request key could not be recovered");
  assert(await restarted.calls.nextDeadlineDelayMs() === 500, "persisted operation deadline was not recoverable");

  now += 100;
  assert(await restarted.calls.detach(firstConnectionId, 120) === 1, "persisted call did not detach with its relay generation");
  const detached = await restarted.calls.snapshot();
  assert(detached.active === 1 && detached.detached === 1, "detached persisted call was not observable");
  assert(await restarted.calls.nextDeadlineDelayMs() === 120, "detached call did not switch to its reconnect deadline");
  const reboundIds = await restarted.calls.rebind(daemonInstanceId, secondConnectionId);
  assert(reboundIds.length === 1 && reboundIds[0] === callId, "same daemon instance did not reclaim the persisted call");
  assert(!(await restarted.calls.complete(callId, firstConnectionId, { jsonrpc: "2.0", id: 70, result: { stale: true } })),
    "stale relay generation completed a rebound persisted call");
  assert(await restarted.calls.complete(callId, secondConnectionId, { jsonrpc: "2.0", id: 70, result: { recovered: true } }),
    "rebound persisted call did not complete");
  assert(!(await restarted.calls.complete(callId, secondConnectionId, { jsonrpc: "2.0", id: 70, result: { duplicate: true } })),
    "persisted call accepted duplicate terminal settlement");
  const completed = await restarted.pollMessage(streamId);
  assert(completed.kind === "message" && completed.message.result.recovered === true,
    "persisted call recovery lost its exact terminal result");
  assert((await restarted.calls.snapshot()).active === 0, "completed persisted call leaked from the pending index");
}

async function testRepeatedReconnectExtendsActiveRecord() {
  let now = 1_000;
  const storage = new MemoryStorage();
  const streamId = validStreamId("Y");
  const callId = `call_${"Y".repeat(43)}`;
  const firstConnection = `connection_${"Y".repeat(43)}`;
  const secondConnection = `connection_${"Z".repeat(43)}`;
  const store = new McpResumptionStore(storage, {
    now: () => now,
    retentionMs: 50,
    pendingRetentionMs: 100,
  });
  await store.begin({ streamId, tokenKey: "token-repeat", sessionId: "session-repeat", requestId: 71 });
  const originalExpiry = storage.values.get(`mcp-stream:${streamId}`).expires_at;
  await store.calls.activate({
    streamId,
    callId,
    daemonInstanceId: "daemon_repeated_reconnect_1234",
    connectionId: firstConnection,
    tool: "exec_command",
    timeoutMs: 80,
  });
  now = 1_040;
  await store.calls.detach(firstConnection, 80);
  const firstExtendedExpiry = storage.values.get(`mcp-stream:${streamId}`).expires_at;
  assert(firstExtendedExpiry > originalExpiry, "first detach did not extend active-call retention beyond the original stream deadline");
  now = 1_105;
  assert((await store.pollMessage(streamId)).kind === "pending", "active call expired after its original stream deadline");
  await store.calls.rebind("daemon_repeated_reconnect_1234", secondConnection);
  now = 1_135;
  await store.calls.detach(secondConnection, 80);
  const secondExtendedExpiry = storage.values.get(`mcp-stream:${streamId}`).expires_at;
  assert(secondExtendedExpiry > firstExtendedExpiry, "repeated detach did not monotonically extend active-call retention");
  now = 1_210;
  assert((await store.pollMessage(streamId)).kind === "pending", "repeated reconnect cycles deleted a still-owned call");
  await store.calls.rebind("daemon_repeated_reconnect_1234", firstConnection);
  assert(await store.calls.complete(callId, firstConnection, { jsonrpc: "2.0", id: 71, result: { ok: true } }),
    "repeatedly rebound call did not complete");
}

async function testPrototypeSafePendingInspection() {
  const call = {
    call_id: `call_${"Q".repeat(43)}`,
    daemon_instance_id: "daemon_prototype_safe_1234",
    connection_id: `connection_${"Q".repeat(43)}`,
    tool: "__proto__",
    state: "attached",
    started_at: 1,
    operation_deadline_at: 10,
    remaining_timeout_ms: 9,
  };
  const snapshot = pendingCallSnapshot([
    { stream_id: validStreamId("Q"), status: "pending", created_at: 1, expires_at: 20, call },
  ], 5, 32);
  assert(Object.prototype.hasOwnProperty.call(snapshot.by_tool, "__proto__") && snapshot.by_tool.__proto__ === 1,
    "pending-call aggregation treated a prototype-shaped tool name as object metadata");
}

async function testOversizedFallback() {
  const storage = new MemoryStorage();
  const store = new McpResumptionStore(storage, { maximumMessageBytes: 128 });
  const streamId = validStreamId("E");
  await store.begin({ streamId, tokenKey: "token-large", sessionId: "session-large", requestId: 10 });
  await store.complete(streamId, { jsonrpc: "2.0", id: 10, result: { text: "x".repeat(500) } });
  const resumed = await store.resume({ lastEventId: `${streamId}:0`, tokenKey: "token-large", sessionId: "session-large" });
  const message = await store.pollMessage(streamId);
  assert(resumed.kind === "message" && message.kind === "message" && message.message.error?.code === -32002, "oversized result was stored beyond the resumable message budget");
  assert(!JSON.stringify(message).includes("x".repeat(100)), "oversized result content leaked into the fallback record");
}

async function testStoredIntegrityFailure() {
  const storage = new MemoryStorage();
  const store = new McpResumptionStore(storage);
  const streamId = validStreamId("J");
  await store.begin({ streamId, tokenKey: "token-integrity", sessionId: "session-integrity", requestId: 12 });
  await store.complete(streamId, { jsonrpc: "2.0", id: 12, result: { trusted: true } });
  const key = `mcp-stream:${streamId}`;
  const record = storage.values.get(key);
  record.message_json = record.message_json.replace("true", "false");
  storage.values.set(key, record);
  const resumed = await store.resume({ lastEventId: `${streamId}:0`, tokenKey: "token-integrity", sessionId: "session-integrity" });
  const message = await store.pollMessage(streamId);
  assert(resumed.kind === "message" && message.kind === "message" && message.message.error?.code === -32005, "tampered stored result passed integrity validation");
}

async function testCompletionStartsResultRetention() {
  let now = 0;
  const storage = new MemoryStorage();
  const store = new McpResumptionStore(storage, {
    now: () => now,
    retentionMs: 10,
    pendingRetentionMs: 100,
  });
  const streamId = validStreamId("K");
  await store.begin({ streamId, tokenKey: "token-clock", sessionId: "session-clock", requestId: 13 });
  now = 50;
  const pending = storage.values.get(`mcp-stream:${streamId}`);
  assert(pending.status === "pending" && pending.expires_at === 100, "pending stream did not cover the execution window");
  await store.complete(streamId, { jsonrpc: "2.0", id: 13, result: { completed: true } });
  const ready = storage.values.get(`mcp-stream:${streamId}`);
  assert(ready.status === "ready" && ready.expires_at === 60, "terminal retention did not start at completion");
  now = 59;
  assert((await store.resume({ lastEventId: `${streamId}:0`, tokenKey: "token-clock", sessionId: "session-clock" })).kind === "message", "completed result expired before its own retention window");
  now = 60;
  assert((await store.resume({ lastEventId: `${streamId}:0`, tokenKey: "token-clock", sessionId: "session-clock" })).kind === "expired", "completed result survived beyond its retention window");
}

async function testTransientPersistenceFailure() {
  const storage = new MemoryStorage();
  const store = new McpResumptionStore(storage);
  const streamId = validStreamId("I");
  const message = { jsonrpc: "2.0", id: 11, result: { retained_in_memory: true } };
  await store.begin({ streamId, tokenKey: "token-failure", sessionId: "session-failure", requestId: 11 });
  store.activate(streamId);
  storage.failReadyPut = true;
  await expectReject(store.complete(streamId, message), Error);
  const resumed = await store.resume({ lastEventId: `${streamId}:0`, tokenKey: "token-failure", sessionId: "session-failure" });
  const polled = await store.pollMessage(streamId);
  assert(resumed.kind === "message" && polled.kind === "message", "transient persistence failure discarded the live terminal result");
  assert(polled.message.result.retained_in_memory === true, "live terminal result changed after persistence failure");
}

async function testExpiryAndCapacity() {
  let now = 0;
  const storage = new MemoryStorage();
  const store = new McpResumptionStore(storage, {
    now: () => now,
    retentionMs: 10,
    pendingRetentionMs: 10,
    maximumStreams: 2,
  });
  const first = validStreamId("F");
  const second = validStreamId("G");
  const third = validStreamId("H");
  await store.begin({ streamId: first, tokenKey: "token", sessionId: "session", requestId: 1 });
  await store.begin({ streamId: second, tokenKey: "token", sessionId: "session", requestId: 2 });
  await expectReject(
    store.begin({ streamId: third, tokenKey: "token", sessionId: "session", requestId: 3 }),
    McpStreamLimitError,
  );
  await store.complete(first, { jsonrpc: "2.0", id: 1, result: {} });
  await store.begin({ streamId: third, tokenKey: "token", sessionId: "session", requestId: 3 });
  assert((await store.resume({ lastEventId: `${first}:0`, tokenKey: "token", sessionId: "session" })).kind === "not_found", "oldest completed stream was not evicted first");

  now = 11;
  const expired = await store.resume({ lastEventId: `${second}:0`, tokenKey: "token", sessionId: "session" });
  assert(expired.kind === "expired", "expired stream remained resumable");
  assert(!storage.values.has(`mcp-stream:${second}`), "expired stream was not deleted");
}

class MemoryStorage {
  values = new Map();

  async get(key) { return this.values.get(key); }
  failReadyPut = false;
  async put(key, value) {
    if (this.failReadyPut && value?.status === "ready") throw new Error("synthetic persistence failure");
    this.values.set(key, structuredClone(value));
  }
  async delete(keyOrKeys) {
    if (Array.isArray(keyOrKeys)) {
      let count = 0;
      for (const key of keyOrKeys) count += Number(this.values.delete(key));
      return count;
    }
    return this.values.delete(keyOrKeys);
  }
  async list(options = {}) {
    const entries = [...this.values.entries()]
      .filter(([key]) => !options.prefix || key.startsWith(options.prefix))
      .sort(([left], [right]) => left.localeCompare(right));
    return new Map(entries.map(([key, value]) => [key, structuredClone(value)]));
  }
  async transaction(callback) { return callback(this); }
}

function validStreamId(character) {
  return `stream_${character.repeat(43)}`;
}

async function expectReject(promise, constructor) {
  let rejection;
  try {
    await promise;
  } catch (error) {
    rejection = error;
  }
  if (!rejection) throw new Error("expected promise to reject");
  if (!(rejection instanceof constructor)) throw rejection;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

await testEventIdentifiers();
await testRecordValidationAndLimits();
await testCompletedResultResumption();
await testStorageWriteBudget();
await testMissingAndCorruptCompletionState();
await testLiveResultResumption();
await testRestartFallback();
await testPersistentCallRecovery();
await testRepeatedReconnectExtendsActiveRecord();
await testPrototypeSafePendingInspection();
await testOversizedFallback();
await testStoredIntegrityFailure();
await testCompletionStartsResultRetention();
await testTransientPersistenceFailure();
await testExpiryAndCapacity();
console.log("MCP resumption test ok");
