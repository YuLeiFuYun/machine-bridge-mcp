import { McpResumptionStore, McpStreamLimitError, parseStreamEventId, streamEventId } from "../src/worker/mcp-resumption.ts";
import { resumptionLimits } from "../src/worker/mcp-resumption-config.ts";
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
  assert((await resumed.message).result.ok === true, "completed stream lost its terminal result");

  const complete = await store.resume({ lastEventId: `${streamId}:1`, tokenKey: "token-owner", sessionId: "session-owner" });
  assert(complete.kind === "complete", "terminal event was replayed after the client acknowledged it");
  const wrongToken = await store.resume({ lastEventId: `${streamId}:0`, tokenKey: "token-other", sessionId: "session-owner" });
  assert(wrongToken.kind === "not_found", "another OAuth token could discover a resumable stream");
  const wrongSession = await store.resume({ lastEventId: `${streamId}:0`, tokenKey: "token-owner", sessionId: "session-other" });
  assert(wrongSession.kind === "not_found", "another MCP session could discover a resumable stream");
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
  let resolveResult;
  const live = new Promise((resolve) => { resolveResult = resolve; });
  store.attach(streamId, live);
  const resumed = await store.resume({ lastEventId: `${streamId}:0`, tokenKey: "token-live", sessionId: "session-live" });
  assert(resumed.kind === "message", "active stream did not expose its live terminal promise");
  resolveResult({ jsonrpc: "2.0", id: "live", result: { resumed: true } });
  assert((await resumed.message).result.resumed === true, "active stream resumption lost the eventual result");
}

async function testRestartFallback() {
  const storage = new MemoryStorage();
  const first = new McpResumptionStore(storage);
  const streamId = validStreamId("D");
  await first.begin({ streamId, tokenKey: "token-restart", sessionId: "session-restart", requestId: 9 });

  const restarted = new McpResumptionStore(storage);
  const resumed = await restarted.resume({ lastEventId: `${streamId}:0`, tokenKey: "token-restart", sessionId: "session-restart" });
  assert(resumed.kind === "message", "orphaned pending stream did not produce a terminal result");
  const message = await resumed.message;
  assert(message.error?.code === -32003, "orphaned pending stream did not report lost execution state");
  const repeated = await restarted.resume({ lastEventId: `${streamId}:0`, tokenKey: "token-restart", sessionId: "session-restart" });
  assert((await repeated.message).error?.code === -32003, "restart fallback was not persisted for repeat delivery");
}

async function testOversizedFallback() {
  const storage = new MemoryStorage();
  const store = new McpResumptionStore(storage, { maximumMessageBytes: 128 });
  const streamId = validStreamId("E");
  await store.begin({ streamId, tokenKey: "token-large", sessionId: "session-large", requestId: 10 });
  await store.complete(streamId, { jsonrpc: "2.0", id: 10, result: { text: "x".repeat(500) } });
  const resumed = await store.resume({ lastEventId: `${streamId}:0`, tokenKey: "token-large", sessionId: "session-large" });
  const message = await resumed.message;
  assert(message.error?.code === -32002, "oversized result was stored beyond the resumable message budget");
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
  assert((await resumed.message).error?.code === -32005, "tampered stored result passed integrity validation");
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
  const terminal = Promise.resolve(message);
  store.attach(streamId, terminal);
  storage.failReadyPut = true;
  await expectReject(store.complete(streamId, message), Error);
  const resumed = await store.resume({ lastEventId: `${streamId}:0`, tokenKey: "token-failure", sessionId: "session-failure" });
  assert(resumed.kind === "message", "transient persistence failure discarded the live terminal result");
  assert((await resumed.message).result.retained_in_memory === true, "live terminal result changed after persistence failure");
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
await testMissingAndCorruptCompletionState();
await testLiveResultResumption();
await testRestartFallback();
await testOversizedFallback();
await testStoredIntegrityFailure();
await testCompletionStartsResultRetention();
await testTransientPersistenceFailure();
await testExpiryAndCapacity();
console.log("MCP resumption test ok");
