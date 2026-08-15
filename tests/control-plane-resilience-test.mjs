import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { enqueueSecurityAudit } from "../src/local/security-audit-dispatch.mjs";
import {
  SECURITY_AUDIT_MAX_BYTES,
  SECURITY_AUDIT_MAX_EVENTS,
  auditErrorClass,
  auditSnapshotFromState,
  createAuditStorageSession,
  readVerifiedAuditState,
  recordAuditBatch,
  unhealthyAuditSnapshot,
} from "../src/local/security-audit-storage.mjs";
import { terminateProcessTree } from "../src/local/process-tree-signal.mjs";
import { terminateProcessTreeWithEscalation } from "../src/local/process-tree-supervisor.mjs";
import { toolCallCapacityConfig } from "../src/shared/tool-call-capacity.mjs";
import {
  MAX_PENDING_CALLS,
  RESERVED_CONTROL_PENDING_CALLS,
  WORKER_PENDING_CALL_CAPACITY,
  WORKER_PENDING_REGISTRY_OPTIONS,
  assertWorkerPendingCallAdmission,
  pendingCallAdmission,
  pendingRegistrySnapshot,
} from "../src/worker/pending-call-capacity.ts";
import { WorkerToolError } from "../src/worker/errors.ts";

await testAuditDispatchBoundaries();
await testAuditStorageBoundaries();
await testProcessSignalFallbacks();
await testProcessSupervisorFailures();
testWorkerCapacityBoundaries();
console.log("control-plane resilience test ok");

async function testAuditDispatchBoundaries() {
  const reports = [];
  const reporter = { report(event, fields, message) { reports.push({ event, fields, message }); } };
  const operation = () => ({
    tool: "read_file",
    args: { path: "fixture.txt" },
    context: {
      origin: "relay",
      authority: { principal: { kind: "account", accountId: "private-account" } },
      operationAuthorization: { category: "ordinary operation", targetHash: "a".repeat(64) },
    },
  });

  enqueueSecurityAudit(null, operation(), { outcome: "completed" }, reporter);
  const local = operation();
  local.context.origin = "stdio";
  let localRecorded = false;
  enqueueSecurityAudit({ record() { localRecorded = true; } }, local, { outcome: "completed" }, reporter);
  assert(!localRecorded, "stdio operation entered the relay security-audit path");

  const enqueueFailure = operation();
  enqueueSecurityAudit({
    record() { throw Object.assign(new Error("enqueue failed"), { code: "bad code/value" }); },
  }, enqueueFailure, { outcome: "failed" }, reporter);
  assert(enqueueFailure.context.auditWarning === "security_audit_unavailable"
    && reports[0].event === "security.audit.enqueue.failed"
    && reports[0].fields.error_class === "bad_code_value",
  "synchronous audit enqueue failure was not sanitized and reported");

  const falsePersistence = operation();
  enqueueSecurityAudit({ record() { return false; } }, falsePersistence, { outcome: "completed" }, reporter);
  const rejectedPersistence = operation();
  enqueueSecurityAudit({
    record() { return Promise.reject(Object.assign(new Error("persist failed"), { code: "disk/error" })); },
  }, rejectedPersistence, { outcome: "failed" }, reporter);
  const circular = operation();
  circular.args.self = circular.args;
  let projected = null;
  enqueueSecurityAudit({ record(value) { projected = value; return true; } }, circular, { outcome: "completed" }, reporter);

  await Promise.resolve();
  await Promise.resolve();
  assert(falsePersistence.context.auditWarning === "security_audit_unavailable"
    && rejectedPersistence.context.auditWarning === "security_audit_unavailable",
  "asynchronous audit persistence failure was not projected to operation state");
  assert(reports.some((entry) => entry.event === "security.audit.persist.failed"
      && entry.fields.error_class === "disk_error"),
  "rejected audit persistence did not emit a sanitized coarse error");
  assert(projected.inputBytes === 0 && projected.principal.accountId === "private-account",
    "audit dispatch did not bound unserializable input or preserve its worker-bound projection");
}

async function testAuditStorageBoundaries() {
  const root = mkdtempSync(path.join(tmpdir(), "mbm-audit-storage-boundaries-"));
  try {
    const empty = readVerifiedAuditState(root);
    assert(empty.events.length === 0 && auditSnapshotFromState(empty).last_event_at === null,
      "empty audit state or snapshot is invalid");
    const emptyBatch = await recordAuditBatch(root, []);
    assert(emptyBatch.retained === 0 && emptyBatch.chain_verified, "empty audit batch did not preserve a verified state");

    const rawAccount = "acct-private-value";
    await recordAuditBatch(root, [{
      nowMs: Date.UTC(2026, 6, 31, 8, 0, 0),
      input: {
        outcome: "completed with spaces",
        tool: "read file/unsafe",
        riskCategory: "line\nbreak\tcategory",
        targetHash: "not-a-hash",
        principal: {
          kind: "account", accountId: rawAccount, clientId: "client-private", familyId: "family-private",
          accountVersion: 3, role: "owner role",
        },
        durationMs: -1,
        inputBytes: Number.POSITIVE_INFINITY,
        outputBytes: Number.MAX_SAFE_INTEGER + 100,
        errorCode: "bad code",
      },
    }]);
    const baseline = JSON.parse(readFileSync(path.join(root, "security-audit.json"), "utf8"));
    const event = baseline.events[0];
    assert(event.tool === "read_file_unsafe" && event.outcome === "completed_with_spaces"
      && event.risk_category === "line break category" && event.target_hash === null,
    "audit event token/text projection is not bounded");
    assert(event.account_ref && event.account_ref !== rawAccount && event.duration_ms === 0
      && event.input_bytes === 0 && event.output_bytes === Number.MAX_SAFE_INTEGER,
    "audit event private reference or numeric projection is invalid");

    const file = path.join(root, "security-audit.json");
    writeFileSync(file, "{not-json\n", { mode: 0o600 });
    expectThrow(() => readVerifiedAuditState(root), "not valid JSON");
    assertInvalidState(root, baseline, (state) => { state.schemaVersion = 2; }, "schema is invalid");
    assertInvalidState(root, baseline, (state) => { state.identity_salt = "bad"; }, "identity is invalid");
    assertInvalidState(root, baseline, (state) => { state.next_sequence = 0; }, "sequence is invalid");
    assertInvalidState(root, baseline, (state) => { state.events = {}; }, "events are invalid");
    assertInvalidState(root, baseline, (state) => { state.events[0].sequence = 0; }, "events are invalid");
    assertInvalidState(root, baseline, (state) => { state.next_sequence = state.events[0].sequence; }, "did not advance");
    assertInvalidState(root, baseline, (state) => { state.events[0].hash = "0".repeat(64); }, "hash chain verification failed");

    writeFileSync(file, `${JSON.stringify(baseline)}\n`, { mode: 0o600 });
    await expectReject(() => recordAuditBatch(root, [{ input: { tool: "bad-time" }, nowMs: Number.NaN }]), "Invalid time value");
    assert(auditErrorClass({ code: "bad/error class" }) === "bad_error_class"
      && auditErrorClass(null) === "audit_error"
      && unhealthyAuditSnapshot({ name: "SyntheticFailure" }).last_error_class === "SyntheticFailure",
    "audit error classification is unstable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const trimRoot = mkdtempSync(path.join(tmpdir(), "mbm-audit-storage-trim-"));
  try {
    const records = Array.from({ length: SECURITY_AUDIT_MAX_EVENTS + 1 }, (_, index) => ({
      nowMs: Date.UTC(2026, 6, 31, 9, 0, 0) + index,
      input: { outcome: "completed", tool: "trim", durationMs: index },
    }));
    const snapshot = await recordAuditBatch(trimRoot, records);
    const state = readVerifiedAuditState(trimRoot);
    assert(snapshot.retained === SECURITY_AUDIT_MAX_EVENTS
      && state.events[0].sequence === 2
      && state.next_sequence === SECURITY_AUDIT_MAX_EVENTS + 2,
    "audit retention did not advance its anchor and preserve the bounded chain");
  } finally {
    rmSync(trimRoot, { recursive: true, force: true });
  }

  const cacheRoot = mkdtempSync(path.join(tmpdir(), "mbm-audit-storage-cache-"));
  try {
    const session = createAuditStorageSession(cacheRoot);
    await session.recordBatch([{
      nowMs: Date.UTC(2026, 6, 31, 10, 0, 0), input: { outcome: "completed", tool: "cached" },
    }]);
    const file = path.join(cacheRoot, "security-audit.json");
    const tampered = JSON.parse(readFileSync(file, "utf8"));
    tampered.events[0].tool = "altered";
    writeFileSync(file, `${JSON.stringify(tampered)}\n`, { mode: 0o600 });
    await expectReject(() => session.recordBatch([{
      nowMs: Date.UTC(2026, 6, 31, 10, 0, 1), input: { outcome: "completed", tool: "must-not-overwrite" },
    }]), "hash chain verification failed");
    assert(JSON.parse(readFileSync(file, "utf8")).events.length === 1,
      "cached audit session overwrote externally altered state");
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }

  const byteTrimRoot = mkdtempSync(path.join(tmpdir(), "mbm-audit-storage-byte-trim-"));
  try {
    const token = "x".repeat(128);
    const records = Array.from({ length: SECURITY_AUDIT_MAX_EVENTS }, (_, index) => ({
      nowMs: Date.UTC(2026, 6, 31, 11, 0, 0) + index,
      input: {
        outcome: token, tool: token, riskCategory: "r".repeat(160), targetHash: "a".repeat(64),
        principal: {
          kind: "account", accountId: token, clientId: token, familyId: token,
          accountVersion: Number.MAX_SAFE_INTEGER, role: token,
        },
        durationMs: Number.MAX_SAFE_INTEGER, inputBytes: Number.MAX_SAFE_INTEGER,
        outputBytes: Number.MAX_SAFE_INTEGER, errorCode: token,
      },
    }));
    const snapshot = await recordAuditBatch(byteTrimRoot, records);
    const file = path.join(byteTrimRoot, "security-audit.json");
    const state = readVerifiedAuditState(byteTrimRoot);
    assert(readFileSync(file).byteLength <= SECURITY_AUDIT_MAX_BYTES
      && snapshot.maximum_bytes === SECURITY_AUDIT_MAX_BYTES
      && snapshot.retained === state.events.length
      && snapshot.retained > 0
      && snapshot.retained < SECURITY_AUDIT_MAX_EVENTS
      && state.events[0].sequence > 1
      && state.next_sequence === SECURITY_AUDIT_MAX_EVENTS + 1,
    "audit byte retention did not evict old events while preserving a verifiable chain");
  } finally {
    rmSync(byteTrimRoot, { recursive: true, force: true });
  }
}

async function testProcessSignalFallbacks() {
  assert(terminateProcessTree(null) === false, "missing process identity was accepted for termination");
  const groupSignals = [];
  assert(terminateProcessTree({ pid: 101 }, "SIGTERM", {
    platform: "linux", killProcess(pid, signal) { groupSignals.push({ pid, signal }); },
  }), "POSIX process-group termination failed");
  assert(groupSignals[0].pid === -101 && groupSignals[0].signal === "SIGTERM",
    "POSIX termination did not target the process group");

  let childFallbacks = 0;
  assert(terminateProcessTree({ pid: 102, kill() { childFallbacks += 1; return true; } }, "SIGKILL", {
    platform: "linux", killProcess() { throw new Error("no process group"); },
  }), "POSIX child fallback was not used");
  assert(childFallbacks === 1, "POSIX child fallback ran the wrong number of times");
  assert(!terminateProcessTree({ pid: 103, kill() { throw new Error("gone"); } }, "SIGTERM", {
    platform: "linux", killProcess() { throw new Error("gone"); },
  }), "failed POSIX termination was reported as successful");

  const killer = new EventEmitter();
  killer.unref = () => {};
  let windowsFallbacks = 0;
  assert(terminateProcessTree({ pid: 104, kill() { windowsFallbacks += 1; return true; } }, "SIGTERM", {
    platform: "win32", spawnProcess() { return killer; },
  }), "Windows taskkill request failed");
  killer.emit("exit", 1);
  killer.emit("error", new Error("late taskkill error"));
  assert(windowsFallbacks === 1, "taskkill error/exit race did not use an idempotent child fallback");

  let spawnFallbacks = 0;
  assert(terminateProcessTree({ pid: 105, kill() { spawnFallbacks += 1; return true; } }, "SIGKILL", {
    platform: "win32", spawnProcess() { throw new Error("taskkill unavailable"); },
    killProcess() { throw new Error("group unavailable"); },
  }), "Windows spawn failure did not reach the child fallback");
  assert(spawnFallbacks === 1, "Windows spawn failure used the wrong fallback");
}

async function testProcessSupervisorFailures() {
  await runSupervisorCase({
    captureOwnership() { throw new Error("capture failed"); },
  }, { kills: 0, settled: 1 });
  await runSupervisorCase({
    captureOwnership() { return Promise.reject(new Error("capture rejected")); },
  }, { kills: 0, settled: 1 });
  await runSupervisorCase({
    captureOwnership() { return { pid: 1 }; },
    refreshOwnership() { throw new Error("refresh failed"); },
  }, { kills: 0, settled: 1 });
  await runSupervisorCase({
    captureOwnership() { return { pid: 1 }; },
    refreshOwnership() { return Promise.reject(new Error("refresh rejected")); },
  }, { kills: 0, settled: 1 });
  await runSupervisorCase({
    captureOwnership() { return { pid: 1 }; },
    refreshOwnership(value) { return value; },
    isTerminationTargetOwned() { return false; },
  }, { kills: 0, settled: 1 });
  await runSupervisorCase({
    captureOwnership() { return { pid: 1 }; },
    refreshOwnership(value) { return value; },
    isTerminationTargetOwned() { return true; },
    onEscalated() { throw new Error("callback failed"); },
    onTerminationSettled() { throw new Error("settlement callback failed"); },
  }, { kills: 1, settled: 1, escalated: 1 });

  let callback = null;
  const handle = terminateProcessTreeWithEscalation({}, {
    setTimeout(value, delay) { callback = value; assert(delay === 2000, "default escalation grace drifted"); return "default-handle"; },
  });
  assert(handle === "default-handle", "supervisor did not return the scheduler handle");
  await callback();
}

async function runSupervisorCase(overrides, expected) {
  let callback = null;
  let kills = 0;
  let settled = 0;
  let escalated = 0;
  terminateProcessTreeWithEscalation({ pid: 501 }, {
    graceMs: 0,
    captureOwnership: overrides.captureOwnership ?? (() => ({ pid: 501 })),
    refreshOwnership: overrides.refreshOwnership ?? ((value) => value),
    isTerminationTargetOwned: overrides.isTerminationTargetOwned ?? (() => true),
    terminate(_child, signal) {
      if (signal === "SIGKILL") kills += 1;
      if (signal === "SIGTERM" && overrides.throwSigterm) throw new Error("SIGTERM failed");
      if (signal === "SIGKILL" && overrides.throwSigkill) throw new Error("SIGKILL failed");
    },
    setTimeout(value) { callback = value; return "case-handle"; },
    onEscalated() { escalated += 1; overrides.onEscalated?.(); },
    onTerminationSettled() { settled += 1; overrides.onTerminationSettled?.(); },
  });
  await callback();
  assert(kills === expected.kills && settled === expected.settled
    && escalated === (expected.escalated ?? 0),
  `supervisor failure boundary mismatch: kills=${kills}, settled=${settled}, escalated=${escalated}`);
}

function testWorkerCapacityBoundaries() {
  assert(MAX_PENDING_CALLS === 32 && RESERVED_CONTROL_PENDING_CALLS === 2
    && WORKER_PENDING_REGISTRY_OPTIONS.reservedCapacity === 2,
  "Worker pending-call constants drifted");
  const config = toolCallCapacityConfig(4, 1, ["diagnose_runtime", "list_roots"]);
  const records = [
    { tool: "read_file", socket: {}, startedAt: 10 },
    { tool: "exec_command", socket: undefined, startedAt: 20 },
    { tool: "diagnose_runtime", socket: {}, startedAt: 30 },
  ];
  const snapshot = pendingRegistrySnapshot(records, 2, 50, config);
  assert(snapshot.active === 3 && snapshot.active_ordinary === 2 && snapshot.active_reserved === 1
    && snapshot.detached === 1 && snapshot.oldest_ms === 40,
  "pending registry capacity snapshot is invalid");

  assert(pendingCallAdmission(
    { active: 3, by_tool: { read_file: 3 } }, "diagnose_runtime", config,
  ).allowed, "reserved control call was rejected under ordinary saturation");
  assert(!pendingCallAdmission(
    { active: 3, by_tool: { read_file: 3 } }, "read_file", config,
  ).allowed, "ordinary call consumed reserved capacity");

  assertWorkerPendingCallAdmission({ active: 0, by_tool: {} }, "read_file");
  expectWorkerLimit(() => assertWorkerPendingCallAdmission(
    { active: 30, by_tool: { read_file: 30 } }, "read_file",
  ), "ordinary daemon-call capacity reached");
  expectWorkerLimit(() => assertWorkerPendingCallAdmission(
    { active: 32, by_tool: { diagnose_runtime: 2, read_file: 30 } }, "list_roots",
  ), "too many concurrent daemon tool calls");
  assert(WORKER_PENDING_CALL_CAPACITY.maximum === 32,
    "default Worker capacity configuration is invalid");
}

function assertInvalidState(root, baseline, mutate, message) {
  const value = structuredClone(baseline);
  mutate(value);
  writeFileSync(path.join(root, "security-audit.json"), `${JSON.stringify(value)}\n`, { mode: 0o600 });
  expectThrow(() => readVerifiedAuditState(root), message);
}

function expectThrow(operation, message) {
  try { operation(); } catch (error) {
    assert(String(error?.message || error).includes(message), `unexpected error: ${String(error?.message || error)}`);
    return;
  }
  throw new Error(`expected failure containing: ${message}`);
}

async function expectReject(operation, message) {
  try { await operation(); } catch (error) {
    assert(String(error?.message || error).includes(message), `unexpected rejection: ${String(error?.message || error)}`);
    return;
  }
  throw new Error(`expected rejection containing: ${message}`);
}

function expectWorkerLimit(operation, message) {
  try { operation(); } catch (error) {
    assert(error instanceof WorkerToolError && error.code === "limit_exceeded"
      && error.message.includes(message), `unexpected Worker capacity error: ${String(error?.message || error)}`);
    return;
  }
  throw new Error(`expected Worker capacity rejection containing: ${message}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
