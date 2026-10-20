import assert from "node:assert/strict";
import { dispatchWorkerTaskOperation, createWorkerTaskSeed } from "../src/worker/mcp-tasks.ts";
import { McpTaskStore, MAX_MCP_TASK_RESULT_BYTES } from "../src/worker/mcp-task-store.ts";
import { statusMessageFor, taskStatusForJob } from "../src/worker/mcp-task-projection.ts";
import { WorkerToolError } from "../src/worker/errors.ts";
import { McpController } from "../src/worker/mcp-controller.ts";
import { MCP_SERVER_CAPABILITIES } from "../src/worker/worker-mcp-config.ts";
import { isMcpTaskJobId, MCP_TASK_EXTENSION_ID, MCP_TASK_JOB_ID_PATTERN, MCP_TASK_TTL_MS } from "../src/shared/mcp-task-contract.mjs";

const authorized = {
  tokenKey: "token-key",
  accountId: "acct_test-account-00000000000000000000",
  accountVersion: 1,
  clientId: "mcp_client_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN",
  familyId: "mcp_family_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN",
  role: "owner",
};
const capabilities = { extensions: { [MCP_TASK_EXTENSION_ID]: {} } };
assert.equal(MCP_TASK_JOB_ID_PATTERN, "^job_[A-Za-z0-9_-]{24,}$");
assert.equal(isMcpTaskJobId("job_" + "a".repeat(24)), true);
assert.equal(isMcpTaskJobId("job_short"), false);
assert.equal(isMcpTaskJobId({ job_id: "job_" + "a".repeat(32) }), false);
assert.deepEqual(MCP_SERVER_CAPABILITIES.extensions[MCP_TASK_EXTENSION_ID], {}, "remote Worker must advertise the Tasks extension");
const taskMeta = { "io.modelcontextprotocol/clientCapabilities": capabilities };
const recoveryKey = "mcp_jr_" + "A".repeat(43);
const controlKey = "mcp_jc_" + "B".repeat(43);
const serverInfo = { name: "machine-bridge-mcp", version: "test" };
const taskId = (suffix = "a") => "job_" + suffix.repeat(32);
const clone = (value) => value === undefined ? undefined : structuredClone(value);

class MemoryDurableObjectStorage {
  values = new Map();
  transactionTail = Promise.resolve();
  async get(key) { return clone(this.values.get(key)); }
  async put(key, value) { this.values.set(key, clone(value)); }
  async delete(key) { return this.values.delete(key); }
  async transaction(callback) {
    const previous = this.transactionTail;
    let release;
    this.transactionTail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      const next = new Map([...this.values.entries()].map(([key, value]) => [key, clone(value)]));
      const transaction = {
        get: async (key) => clone(next.get(key)),
        put: async (key, value) => { next.set(key, clone(value)); },
        delete: async (key) => next.delete(key),
      };
      const result = await callback(transaction);
      this.values = next;
      return result;
    } finally {
      release();
    }
  }
}

const storage = new MemoryDurableObjectStorage();
const store = new McpTaskStore(storage);
const resolveCredentials = async () => ({ recovery_key: recoveryKey, control_key: controlKey });
const signal = new AbortController().signal;
const now = Date.now();

assert.equal(statusMessageFor({ current_phase: "dependency_wait" }, "working"), "Waiting for dependency jobs.",
  "dependency-wait task status should use a client-readable phase message");
assert.equal(taskStatusForJob("cleaning"), "working", "managed-job cleanup must remain an active task state");
assert.equal(taskStatusForJob("interrupted"), "working", "recoverable interrupted jobs must remain active task states");

function request(method, id, params = {}, clientCapabilities = capabilities) {
  return {
    jsonrpc: "2.0",
    id,
    method,
    params: {
      ...params,
      _meta: { "io.modelcontextprotocol/clientCapabilities": clientCapabilities },
    },
  };
}

function taskViewRequest(method, id, idValue, clientCapabilities = capabilities) {
  return request(method, id, { taskId: idValue }, clientCapabilities);
}

// Task creation is capability-gated and must commit durable state before replying.
{
  const seed = await createWorkerTaskSeed({
    name: "start_job",
    result: { job_id: taskId(), status: "queued", recovery_key: recoveryKey, control_key: controlKey },
    authorized, clientCapabilities: capabilities, store, resolveCredentials, now,
  });
  assert.equal(seed.taskId, taskId());
  assert.equal(seed.status, "working");
  assert.equal(seed.ttlMs, MCP_TASK_TTL_MS);
  assert.equal(await store.get(taskId(), authorized, now) !== null, true);
  assert.equal(await createWorkerTaskSeed({
    name: "read_file",
    result: { job_id: taskId("b"), status: "queued", recovery_key: recoveryKey, control_key: controlKey },
    authorized, clientCapabilities: capabilities, store, resolveCredentials, now,
  }), null, "ordinary synchronous tools must not be task-augmented");
  assert.equal(await createWorkerTaskSeed({
    name: "start_job",
    result: { job_id: taskId("c"), status: "queued", recovery_key: recoveryKey, control_key: controlKey },
    authorized, clientCapabilities: {}, store, resolveCredentials, now,
  }), null, "task creation must require the per-request extension capability");
  assert.equal(await createWorkerTaskSeed({
    name: "start_job",
    result: { job_id: taskId("d"), status: "queued", recovery_key: recoveryKey, control_key: controlKey },
    authorized, clientCapabilities: capabilities, store,
    resolveCredentials: async () => ({ recovery_key: "mcp_jr_" + "C".repeat(43), control_key: controlKey }),
    now,
  }), null, "a mismatched capability must not create a task");
}

// Each active task reserves enough bounded storage for its eventual result. When
// capacity is exhausted the server falls back to the ordinary tool result.
{
  const boundedStore = new McpTaskStore(new MemoryDurableObjectStorage());
  for (const suffix of ["i", "j", "k", "l"]) {
    const seed = await createWorkerTaskSeed({
      name: "start_job",
      result: { job_id: taskId(suffix), status: "queued", recovery_key: recoveryKey, control_key: controlKey },
      authorized, clientCapabilities: capabilities, store: boundedStore, resolveCredentials, now,
    });
    assert.notEqual(seed, null);
  }
  const overCapacity = await createWorkerTaskSeed({
    name: "start_job",
    result: { job_id: taskId("m"), status: "queued", recovery_key: recoveryKey, control_key: controlKey },
    authorized, clientCapabilities: capabilities, store: boundedStore, resolveCredentials, now,
  });
  assert.equal(overCapacity, null, "the server must not promise a task when its result reservation cannot be guaranteed");
}

const invokerCalls = [];
let jobStatus = "running";
const invoker = async ({ name, args }) => {
  invokerCalls.push({ name, args });
  if (name === "read_job") {
    if (args.recovery_key !== recoveryKey) throw new Error("recovery capability was not forwarded");
    if (jobStatus === "succeeded") {
      return { status: "succeeded", steps: [{ stdout: "completed output" }], error_class: null };
    }
    if (jobStatus === "cancelled_before_start") {
      return { status: "cancelled_before_start", steps: [], error_class: "cancelled" };
    }
    return { status: jobStatus, current_phase: "execute", current_step: 0 };
  }
  if (name === "cancel_job") {
    assert.equal(args.control_key, controlKey, "cancellation must use the control capability");
    return { status: "cancellation_requested" };
  }
  throw new Error("unexpected tool: " + name);
};

// Polling returns a standard complete result and persists terminal results for repeat reads.
{
  const working = await dispatchWorkerTaskOperation(
    taskViewRequest("tasks/get", 1, taskId()), invoker, "https://example.test", authorized,
    signal, store, resolveCredentials, serverInfo,
  );
  assert.equal(working.status, 200);
  assert.equal(working.message.result.resultType, "complete");
  assert.equal(working.message.result.status, "working");
  assert.equal(working.message.result.taskId, taskId());
  assert.equal(working.message.result.pollIntervalMs, 2000);
  assert.equal(invokerCalls.at(-1).args.job_id, taskId());

  jobStatus = "succeeded";
  const completed = await dispatchWorkerTaskOperation(
    taskViewRequest("tasks/get", 2, taskId()), invoker, "https://example.test", authorized,
    signal, store, resolveCredentials, serverInfo,
  );
  assert.equal(completed.message.result.status, "completed");
  assert.equal(completed.message.result.result.isError, false);
  assert.match(completed.message.result.result.content[0].text, /completed output/);
  const cached = await store.getResult(taskId(), authorized);
  assert.equal(cached.isError, false, "terminal result was not persisted for repeat polling");

  const stalePoll = await store.updateStatus(taskId(), authorized, "working", "stale working snapshot");
  assert.equal(stalePoll.status, "completed", "a stale poll regressed terminal task state");

  const concurrentId = taskId("o");
  await store.create(concurrentId, authorized, now);
  const concurrentResult = { content: [{ type: "text", text: "concurrent terminal output" }], isError: false };
  await Promise.all([
    store.updateStatus(concurrentId, authorized, "working", "stale working snapshot", undefined, now + 1),
    store.updateStatus(concurrentId, authorized, "completed", "Execution completed.", concurrentResult, now + 2),
  ]);
  assert.equal((await store.get(concurrentId, authorized, now + 3)).status, "completed",
    "a concurrent working snapshot regressed a later terminal transaction");
  assert.equal((await store.getResult(concurrentId, authorized, now + 3)).content[0].text, "concurrent terminal output",
    "the terminal transaction lost its result under concurrent polling");

  const terminalFirstId = taskId("p");
  await store.create(terminalFirstId, authorized, now);
  await Promise.all([
    store.updateStatus(terminalFirstId, authorized, "completed", "Execution completed.", concurrentResult, now + 4),
    store.updateStatus(terminalFirstId, authorized, "working", "stale working snapshot", undefined, now + 5),
  ]);
  assert.equal((await store.get(terminalFirstId, authorized, now + 6)).status, "completed",
    "a concurrent stale snapshot regressed a terminal task");

  const repeated = await dispatchWorkerTaskOperation(
    taskViewRequest("tasks/get", 3, taskId()), invoker, "https://example.test", authorized,
    signal, store, resolveCredentials, serverInfo,
  );
  assert.equal(repeated.message.result.status, "completed");
  assert.equal(repeated.message.result.result.content[0].text, cached.content[0].text);
}

// Capability failures, authorization scoping, and removal of the old task API.
{
  const missing = await dispatchWorkerTaskOperation(
    taskViewRequest("tasks/get", 4, taskId(), {}), invoker, "https://example.test", authorized,
    signal, store, resolveCredentials, serverInfo,
  );
  assert.equal(missing.message.error.code, -32021);
  assert.deepEqual(missing.message.error.data.requiredCapabilities.extensions[MCP_TASK_EXTENSION_ID], {});

  const otherPrincipal = { ...authorized, accountVersion: 2 };
  const unauthorized = await dispatchWorkerTaskOperation(
    taskViewRequest("tasks/get", 5, taskId()), invoker, "https://example.test", otherPrincipal,
    signal, store, resolveCredentials, serverInfo,
  );
  assert.equal(unauthorized.message.error.code, -32000);

  assert.equal(await dispatchWorkerTaskOperation(
    request("tasks/list", 6), invoker, "https://example.test", authorized,
    signal, store, resolveCredentials, serverInfo,
  ), null);
  assert.equal(await dispatchWorkerTaskOperation(
    taskViewRequest("tasks/result", 7, taskId()), invoker, "https://example.test", authorized,
    signal, store, resolveCredentials, serverInfo,
  ), null);
}

// A missing underlying managed-job record must terminate the task instead of leaving it working forever.
{
  const missingTaskId = taskId("n");
  await store.create(missingTaskId, authorized, now);
  const missingJob = await dispatchWorkerTaskOperation(
    taskViewRequest("tasks/get", 10, missingTaskId),
    async (input) => {
      if (input.name === "read_job") throw new WorkerToolError("not_found", "managed job no longer exists");
      return invoker(input);
    },
    "https://example.test", authorized, signal, store, resolveCredentials, serverInfo,
  );
  assert.equal(missingJob.message.result.status, "failed");
  assert.match(missingJob.message.result.error.message, /could not be recovered/);
  assert.equal((await store.get(missingTaskId, authorized, now)).status, "failed",
    "missing managed-job state left the durable task stuck in working");

  const missingCompletedTaskId = taskId("q");
  await store.create(missingCompletedTaskId, authorized, now);
  await store.updateStatus(missingCompletedTaskId, authorized, "completed", "Execution completed.", undefined, now + 1);
  const missingCompletedJob = await dispatchWorkerTaskOperation(
    taskViewRequest("tasks/get", 11, missingCompletedTaskId),
    async (input) => {
      if (input.name === "read_job") throw new WorkerToolError("not_found", "managed job no longer exists");
      return invoker(input);
    },
    "https://example.test", authorized, signal, store, resolveCredentials, serverInfo,
  );
  assert.equal(missingCompletedJob.message.result.status, "failed",
    "a completed task with no persisted result remained completed after its backing job disappeared");
  assert.match(missingCompletedJob.message.result.error.message, /could not be recovered/);
}

// Update ignores unknown response keys; cancellation acknowledges intent without inventing a terminal state.
{
  const invalid = await dispatchWorkerTaskOperation(
    request("tasks/update", 8, { taskId: taskId(), inputResponses: [] }), invoker, "https://example.test", authorized,
    signal, store, resolveCredentials, serverInfo,
  );
  assert.equal(invalid.message.error.code, -32602);

  const update = await dispatchWorkerTaskOperation(
    request("tasks/update", 9, { taskId: taskId(), inputResponses: { stale_request: { ignored: true } } }),
    invoker, "https://example.test", authorized, signal, store, resolveCredentials, serverInfo,
  );
  assert.equal(update.message.result.resultType, "complete");
  assert.equal(Object.keys(update.message.result).filter((key) => key !== "resultType" && key !== "_meta").length, 0);

  const activeId = taskId("e");
  await store.create(activeId, authorized, now);
  const cancelled = await dispatchWorkerTaskOperation(
    taskViewRequest("tasks/cancel", 10, activeId), invoker, "https://example.test", authorized,
    signal, store, resolveCredentials, serverInfo,
  );
  assert.equal(cancelled.message.result.resultType, "complete");
  assert.equal(Object.keys(cancelled.message.result).filter((key) => key !== "resultType" && key !== "_meta").length, 0);
  assert.equal((await store.get(activeId, authorized)).status, "working", "cancel acknowledgement must not claim cancellation completed");

  jobStatus = "cancelled_before_start";
  const cancelledState = await dispatchWorkerTaskOperation(
    taskViewRequest("tasks/get", 11, activeId), invoker, "https://example.test", authorized,
    signal, store, resolveCredentials, serverInfo,
  );
  assert.equal(cancelledState.message.result.status, "cancelled");
  assert.equal("result" in cancelledState.message.result, false);
  jobStatus = "running";
}

// Terminal results are chunked and integrity-checked; expired task records and chunks are removed.
{
  const largeId = taskId("f");
  await store.create(largeId, authorized, now);
  const largeResult = { content: [{ type: "text", text: "结果" + "x".repeat(400_000) }], isError: false };
  await store.updateStatus(largeId, authorized, "completed", "Execution completed.", largeResult, now + 1);
  assert.deepEqual(await store.getResult(largeId, authorized, now + 1), largeResult);

  const integrityId = taskId("i");
  await store.create(integrityId, authorized, now);
  await store.updateStatus(integrityId, authorized, "completed", "Execution completed.", { content: [{ type: "text", text: "integrity" }], isError: false }, now + 1);
  const chunkKey = "mcp-task-result-v1:" + integrityId + ":0";
  const encodedChunk = storage.values.get(chunkKey);
  assert.equal(typeof encodedChunk, "string");
  storage.values.set(chunkKey, (encodedChunk[0] === "A" ? "B" : "A") + encodedChunk.slice(1));
  await assert.rejects(() => store.getResult(integrityId, authorized, now + 1), /integrity check failed/);

  const oversizedId = taskId("g");
  await store.create(oversizedId, authorized, now);
  const oversizedResult = { content: [{ type: "text", text: "x".repeat(MAX_MCP_TASK_RESULT_BYTES + 10) }], isError: false };
  await store.updateStatus(oversizedId, authorized, "completed", "Execution completed.", oversizedResult, now + 2);
  assert.equal(await store.getResult(oversizedId, authorized, now + 2), null, "result cache exceeded its configured storage bound");

  assert.equal(await store.get(largeId, authorized, now + MCP_TASK_TTL_MS + 1), null);
  assert.equal(await store.getResult(largeId, authorized, now + MCP_TASK_TTL_MS + 1), null);
  assert.equal([...storage.values.keys()].some((key) => key.startsWith("mcp-task-result-v1:" + largeId + ":")), false,
    "expired task result chunks were not deleted");
}

// Authority revocation removes retained task metadata and every associated result chunk.
{
  const revocationStorage = new MemoryDurableObjectStorage();
  const revocationStore = new McpTaskStore(revocationStorage);
  const revokedId = taskId("j");
  await revocationStore.create(revokedId, authorized, now);
  await revocationStore.updateStatus(revokedId, authorized, "completed", "Execution completed.", { content: [{ type: "text", text: "private" }], isError: false }, now + 1);
  assert.equal([...revocationStorage.values.keys()].some((key) => key.startsWith("mcp-task-result-v1:" + revokedId + ":")), true);
  assert.equal(await revocationStore.cancelAuthority({
    accountId: authorized.accountId, accountVersion: authorized.accountVersion,
    clientId: authorized.clientId, familyId: authorized.familyId,
  }), 1);
  assert.equal(await revocationStore.get(revokedId, authorized), null);
  assert.equal([...revocationStorage.values.keys()].some((key) => key.startsWith("mcp-task-result-v1:" + revokedId + ":")), false);
}

// Exercise the actual controller path: no task handle is returned before its record exists.
{
  const controllerStorage = new MemoryDurableObjectStorage();
  const controllerStore = new McpTaskStore(controllerStorage);
  const controllerTaskId = taskId("h");
  const controller = new McpController({
    capabilities: MCP_SERVER_CAPABILITIES,
    serverInfo,
    instructions: "test",
    supportedVersions: ["2026-07-28"],
    discoveryTtlMs: 0,
    toolListTtlMs: 0,
    taskStore: controllerStore,
    resolveTaskCredentials: resolveCredentials,
    tools: () => [{ name: "start_job", description: "Start a durable job", inputSchema: {
      type: "object", properties: {}, additionalProperties: false,
    } }],
    recordError: () => {},
    cancelClientRequest: async () => {},
    callTool: async ({ name }) => {
      if (name === "start_job") return { job_id: controllerTaskId, status: "queued", recovery_key: recoveryKey, control_key: controlKey };
      if (name === "read_job") return { status: "succeeded", steps: [{ stdout: "controller result" }], error_class: null };
      throw new Error("unexpected controller tool: " + name);
    },
  });
  const httpRequest = new Request("https://example.test/mcp", {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
  });
  const createdResponse = await controller.handleRequest({
    request: httpRequest,
    body: { jsonrpc: "2.0", id: "create", method: "tools/call", params: {
      name: "start_job", arguments: { idempotency_key: "controller-test", steps: [{ argv: ["node", "-e", "process.exit(0)"] }] }, _meta: taskMeta,
    } },
    base: "https://example.test", authorized, proxyMode: "",
  });
  const created = await createdResponse.json();
  assert.equal(created.result?.resultType, "task", JSON.stringify(created));
  assert.equal(created.result.taskId, controllerTaskId);
  assert.notEqual(await controllerStore.get(controllerTaskId, authorized), null);

  const pollResponse = await controller.handleRequest({
    request: httpRequest,
    body: { jsonrpc: "2.0", id: "poll", method: "tasks/get", params: { taskId: controllerTaskId, _meta: taskMeta } },
    base: "https://example.test", authorized, proxyMode: "",
  });
  const polled = await pollResponse.json();
  assert.equal(polled.result.resultType, "complete");
  assert.equal(polled.result.status, "completed");
  assert.match(polled.result.result.content[0].text, /controller result/);
}

console.log("worker tasks extension tests ok");
