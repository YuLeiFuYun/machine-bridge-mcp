import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { securityAuditRecentActivity } from "../src/local/security-audit-activity.mjs";
import { SecurityAuditLog } from "../src/local/security-audit-log.mjs";
import { createAuditStorageSession } from "../src/local/security-audit-storage.mjs";
import { appendAuditRecords, decodeAndVerifyAuditState, emptyAuditState } from "../src/local/security-audit-state.mjs";

const root = mkdtempSync(path.join(tmpdir(), "mbm-security-audit-"));
let now = Date.UTC(2026, 6, 21, 0, 0, 0);
try {
  const malformedAnchor = "a".repeat(64);
  const malformedEvent = {
    sequence: 1,
    timestamp: [new Date(now).toISOString()],
    outcome: "completed",
    tool: "read_file",
    risk_category: "ordinary operation",
    target_hash: null,
    account_ref: null,
    client_ref: null,
    family_ref: null,
    account_version: null,
    role: "local",
    duration_ms: 0,
    input_bytes: 0,
    output_bytes: 0,
    error_code: null,
    previous_hash: malformedAnchor,
  };
  const malformedHash = createHash("sha256").update(JSON.stringify(malformedEvent)).digest("hex");
  let malformedTypeRejected = false;
  try {
    decodeAndVerifyAuditState(Buffer.from(JSON.stringify({
      schemaVersion: 1,
      identity_salt: "b".repeat(64),
      anchor: malformedAnchor,
      next_sequence: 2,
      events: [{ ...malformedEvent, hash: malformedHash }],
    })), 3, 4096);
  } catch (error) {
    malformedTypeRejected = error instanceof Error && error.message.includes("security audit events are invalid");
  }
  assert(malformedTypeRejected,
    "security audit accepted a hash-consistent event whose timestamp had the wrong JSON type");
  const malformedInputState = emptyAuditState(3);
  appendAuditRecords(malformedInputState, [{
    nowMs: now,
    input: {
      outcome: ["completed"],
      tool: ["read_file"],
      riskCategory: ["credential-sensitive read"],
      targetHash: ["d".repeat(64)],
      pseudonymEpoch: "f".repeat(64),
      principal: { accountId: ["e".repeat(64)], role: ["owner"] },
      durationMs: ["12"],
    },
  }]);
  const malformedInputEvent = malformedInputState.events[0];
  assert(malformedInputEvent.outcome === "unknown" && malformedInputEvent.tool === "unknown"
    && malformedInputEvent.risk_category === "ordinary operation" && malformedInputEvent.target_hash === null
    && malformedInputEvent.account_ref === null && malformedInputEvent.role === "unknown",
  "security audit coerced malformed evidence input into valid-looking persisted evidence");
  assert(malformedInputEvent.pseudonym_epoch === "f".repeat(64),
    "direct storage input lost a valid pseudonym correlation epoch");
  assert(malformedInputEvent.duration_ms === 0,
    "security audit coerced a non-number duration into numeric evidence");
  let malformedEpochRejected = false;
  try {
    appendAuditRecords(emptyAuditState(3), [{
      nowMs: now,
      input: { outcome: "completed", tool: "read_file", pseudonymEpoch: ["f".repeat(64)] },
    }]);
  } catch (error) {
    malformedEpochRejected = error instanceof Error && error.message.includes("security audit pseudonym epoch is invalid");
  }
  assert(malformedEpochRejected, "security audit accepted a malformed pseudonym epoch before persistence");

  const malformedStateIdentity = emptyAuditState(3);
  malformedStateIdentity.identity_salt = [malformedStateIdentity.identity_salt];
  let malformedStateIdentityRejected = false;
  try {
    decodeAndVerifyAuditState(Buffer.from(JSON.stringify(malformedStateIdentity)), 3, 4096);
  } catch (error) {
    malformedStateIdentityRejected = error instanceof Error && error.message.includes("security audit state identity is invalid");
  }
  assert(malformedStateIdentityRejected,
    "security audit accepted a coercible non-string identity salt");

  const priorSchema = emptyAuditState(1);
  const priorEvent = {
    sequence: 1,
    timestamp: new Date(now).toISOString(),
    outcome: "completed",
    tool: "read_file",
    risk_category: "ordinary operation",
    target_hash: null,
    account_ref: null,
    client_ref: null,
    family_ref: null,
    account_version: null,
    role: "local",
    duration_ms: 1,
    input_bytes: 2,
    output_bytes: 3,
    error_code: null,
    previous_hash: priorSchema.anchor,
  };
  priorSchema.events.push({
    ...priorEvent,
    hash: createHash("sha256").update(JSON.stringify(priorEvent)).digest("hex"),
  });
  priorSchema.next_sequence = 2;
  const impossiblePrior = structuredClone(priorSchema);
  impossiblePrior.events[0].duration_ms = -1;
  {
    const { hash: _ignored, ...body } = impossiblePrior.events[0];
    impossiblePrior.events[0].hash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  }
  let impossiblePriorRejected = false;
  try {
    decodeAndVerifyAuditState(Buffer.from(JSON.stringify(impossiblePrior)), 3, 4096);
  } catch (error) {
    impossiblePriorRejected = error instanceof Error && error.message.includes("security audit events are invalid");
  }
  assert(impossiblePriorRejected,
    "beta.198 audit migration accepted a hash-consistent numeric value that the beta.198 writer could never emit");
  const migratedPrior = decodeAndVerifyAuditState(Buffer.from(JSON.stringify(priorSchema)), 3, 4096);
  assert(migratedPrior.schemaVersion === 3 && migratedPrior.legacy_event_count === 1
    && migratedPrior.events[0].hash === priorSchema.events[0].hash
    && migratedPrior.events[0].pseudonym_epoch === undefined,
  "immediately preceding security-audit chain was not migrated losslessly into the current envelope");
  appendAuditRecords(migratedPrior, [{
    nowMs: now + 1,
    input: { outcome: "completed", tool: "migration_roundtrip", pseudonymEpoch: "9".repeat(64) },
  }]);
  const migratedRoundTrip = decodeAndVerifyAuditState(Buffer.from(JSON.stringify(migratedPrior)), 3, 4096);
  assert(migratedRoundTrip.legacy_event_count === 1 && migratedRoundTrip.events.length === 2
    && migratedRoundTrip.events[0].hash === priorSchema.events[0].hash
    && migratedRoundTrip.events[1].pseudonym_epoch === "9".repeat(64),
  "schema-3 audit state could not reread its preserved beta.198 prefix plus current events");

  const unsupportedIntermediate = emptyAuditState(2);
  let unsupportedIntermediateRejected = false;
  try {
    decodeAndVerifyAuditState(Buffer.from(JSON.stringify(unsupportedIntermediate)), 3, 4096);
  } catch (error) {
    unsupportedIntermediateRejected = error instanceof Error && error.message.includes("security audit state schema is invalid");
  }
  assert(unsupportedIntermediateRejected, "unsupported intermediate security-audit schema was accepted");

  const directorySyncRoot = mkdtempSync(path.join(tmpdir(), "mbm-security-audit-directory-sync-"));
  try {
    let syncedDirectory = "";
    const storage = createAuditStorageSession(directorySyncRoot, {
      now: () => now,
      syncDirectory(directory) { syncedDirectory = directory; },
    });
    await storage.recordBatch([{
      nowMs: now,
      input: { outcome: "completed", tool: "read_file", pseudonymEpoch: "7".repeat(64) },
    }]);
    assert(syncedDirectory === directorySyncRoot,
      "security audit acknowledged a committed batch without invoking its parent-directory durability barrier");
    const failingStorage = createAuditStorageSession(directorySyncRoot, {
      now: () => now,
      syncDirectory() { throw new Error("synthetic audit directory sync failure"); },
    });
    let directorySyncRejected = false;
    try {
      await failingStorage.recordBatch([{
        nowMs: now + 1,
        input: { outcome: "completed", tool: "read_file", pseudonymEpoch: "7".repeat(64) },
      }]);
    } catch (error) {
      directorySyncRejected = error instanceof Error && error.message.includes("synthetic audit directory sync failure");
    }
    assert(directorySyncRejected,
      "security audit treated a post-rename parent-directory sync failure as durable success");
  } finally {
    rmSync(directorySyncRoot, { recursive: true, force: true });
  }

  const impossibleCurrent = emptyAuditState(3);
  appendAuditRecords(impossibleCurrent, [{
    nowMs: now,
    input: { outcome: "completed", tool: "read_file", pseudonymEpoch: "8".repeat(64), durationMs: 1 },
  }]);
  impossibleCurrent.events[0].duration_ms = 0.5;
  {
    const { hash: _ignored, ...body } = impossibleCurrent.events[0];
    impossibleCurrent.events[0].hash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  }
  let impossibleCurrentRejected = false;
  try {
    decodeAndVerifyAuditState(Buffer.from(JSON.stringify(impossibleCurrent)), 3, 4096);
  } catch (error) {
    impossibleCurrentRejected = error instanceof Error && error.message.includes("security audit events are invalid");
  }
  assert(impossibleCurrentRejected,
    "current audit reader accepted a hash-consistent fractional numeric value that the writer cannot emit");

  const audit = new SecurityAuditLog({ root, now: () => now });
  const principal = {
    kind: "account",
    accountId: `acct_${"a".repeat(32)}`,
    accountVersion: 3,
    clientId: `mcp_client_${"b".repeat(43)}`,
    familyId: `mcp_family_${"c".repeat(43)}`,
    role: "owner",
  };
  assert(await audit.record({
    outcome: "completed",
    tool: "read_file",
    operationId: "call-audit-correlation",
    riskCategory: "credential-sensitive read",
    targetHash: "d".repeat(64),
    principal,
    durationMs: 12.8,
    inputBytes: 100,
    outputBytes: 200,
  }), "security audit event was not recorded");
  now += 1000;
  assert(await audit.record({
    outcome: "failed",
    tool: "exec_command",
    operationId: "call-audit-correlation",
    riskCategory: "remote shell or process control",
    principal,
    durationMs: 20,
    errorCode: "execution_failed",
    requestDelivery: "sent",
    sideEffectsStarted: "unknown",
    effectSettlement: "unknown",
    terminationRequested: false,
  }), "second security audit event was not recorded");

  assert(await audit.flush(), "security audit flush barrier did not complete");
  const snapshot = audit.snapshot();
  assert(snapshot.enabled && snapshot.healthy && snapshot.chain_verified && snapshot.retained === 2,
    "security audit snapshot did not verify its chain");
  assert(snapshot.persistence === "worker-thread-batched-atomic" && snapshot.queue_depth === 0,
    "security audit did not expose its non-blocking persistence contract");
  const file = path.join(root, "security-audit.json");
  const state = JSON.parse(readFileSync(file, "utf8"));
  assert(!JSON.stringify(state).includes(principal.accountId), "security audit persisted the raw account id");
  assert(!JSON.stringify(state).includes(principal.clientId), "security audit persisted the raw client id");
  assert(!JSON.stringify(state).includes(principal.familyId), "security audit persisted the raw token family id");
  const publiclySaltedAccountRef = createHash("sha256").update(state.identity_salt).update("\0").update(principal.accountId).digest("hex");
  assert(state.events[0].account_ref !== publiclySaltedAccountRef,
    "security audit account reference remained offline-enumerable from the public salt stored beside the events");
  assert(/^[a-f0-9]{64}$/.test(state.events[0].pseudonym_epoch)
    && state.events[1].pseudonym_epoch === state.events[0].pseudonym_epoch,
  "security audit did not record a stable per-runtime pseudonym correlation epoch");
  assert(/^[a-f0-9]{64}$/.test(state.events[0].operation_ref)
    && state.events[1].operation_ref === state.events[0].operation_ref
    && !JSON.stringify(state).includes("call-audit-correlation"),
  "security audit did not preserve a runtime-private operation correlation reference");
  assert(!JSON.stringify(state).includes("credential contents"), "security audit persisted operation content");
  assert(state.events[1].previous_hash === state.events[0].hash, "security audit chain did not link adjacent events");
  assert(state.events[1].request_delivery === "sent" && state.events[1].side_effects_started === "unknown"
    && state.events[1].effect_settlement === "unknown" && state.events[1].termination_requested === false,
  "security audit lost fixed ambiguous-side-effect attribution fields");
  const activity = securityAuditRecentActivity({ events: [
    { timestamp: new Date(now - 11 * 60_000).toISOString(), outcome: "dispatch_intent", tool: "run_process", operation_ref: "1".repeat(64), output_bytes: 0 },
    { timestamp: new Date(now - 10 * 60_000 - 1).toISOString(), outcome: "dispatch_intent", tool: "run_process", operation_ref: "2".repeat(64), output_bytes: 0 },
    { timestamp: new Date(now - 16 * 60_000).toISOString(), outcome: "failed", tool: "old", output_bytes: 999, effect_settlement: "unknown" },
    { timestamp: new Date(now - 10 * 60_000).toISOString(), outcome: "failed", tool: "run_process", operation_ref: "2".repeat(64), output_bytes: 65_536, effect_settlement: "pending" },
    { timestamp: new Date(now - 2 * 60_000).toISOString(), outcome: "failed", tool: "exec_command", output_bytes: 1_024, effect_settlement: "unknown" },
    { timestamp: new Date(now).toISOString(), outcome: "completed", tool: "read_job", output_bytes: 0 },
  ] }, now);
  assert(activity.calls_last_15m === 3 && activity.failures_last_15m === 2
    && activity.unknown_effect_settlements_last_15m === 1 && activity.pending_effect_settlements_last_15m === 1
    && activity.dispatch_intents_last_15m === 2 && activity.unsettled_dispatch_intents_last_15m === 1
    && activity.process_helper_calls_last_15m === 2 && activity.read_job_calls_last_15m === 1,
  "security audit recent activity double-counted dispatch intents or misattributed unresolved intent/settlement evidence");
  const staleActivity = securityAuditRecentActivity({
    events: [{ timestamp: new Date(now).toISOString(), outcome: "failed", tool: "exec_command", effect_settlement: "unknown" }],
  }, now + 16 * 60_000);
  assert(staleActivity.calls_last_15m === 0 && staleActivity.unknown_effect_settlements_last_15m === 0
    && staleActivity.window_end_at === new Date(now + 16 * 60_000).toISOString(),
  "security audit recent activity used the last event timestamp instead of the observation time");

  const concurrentA = new SecurityAuditLog({ root, now: () => now });
  const concurrentB = new SecurityAuditLog({ root, now: () => now });
  const concurrentResults = await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2 ? concurrentA : concurrentB).record({
    outcome: "completed", tool: `concurrent_${index}`, principal, durationMs: index,
  })));
  assert(concurrentResults.every(Boolean), "cross-instance security audit write failed");
  const concurrentState = JSON.parse(readFileSync(file, "utf8"));
  assert(concurrentState.events.length === 22, "cross-instance security audit writes lost events");
  assert(concurrentState.events.every((event, index) => event.sequence === index + 1), "cross-instance security audit sequence is not continuous");
  const verifier = new SecurityAuditLog({ root, now: () => now });
  assert(await verifier.flush() && verifier.snapshot().chain_verified,
    "cross-instance security audit chain did not verify after its worker barrier");
  assert(await Promise.all([audit.close(), concurrentA.close(), concurrentB.close(), verifier.close()]).then((values) => values.every(Boolean)),
    "security audit workers did not flush and close cleanly");

  const restarted = new SecurityAuditLog({ root, now: () => now });
  assert(await restarted.record({ outcome: "completed", tool: "restart_probe", principal }),
    "restarted security audit did not record correlation evidence");
  assert(await restarted.flush() && await restarted.close(), "restarted security audit did not flush cleanly");
  const restartedState = JSON.parse(readFileSync(file, "utf8"));
  const restartedEvent = restartedState.events.at(-1);
  assert(restartedEvent.pseudonym_epoch !== state.events[0].pseudonym_epoch
    && restartedEvent.account_ref !== state.events[0].account_ref,
  "security audit pseudonym correlation survived a daemon-runtime boundary");

  restartedState.events[0].tool = "tampered";
  writeFileSync(file, `${JSON.stringify(restartedState)}\n`, { mode: 0o600 });
  const tampered = new SecurityAuditLog({ root, now: () => now });
  assert(!(await tampered.flush()) && tampered.snapshot().healthy === false
    && tampered.snapshot().chain_verified === false
    && tampered.snapshot().last_error_class !== "audit_initializing",
  "security audit tampering was not detected or the flush barrier falsely claimed durable success");
  assert(await tampered.record({ outcome: "completed", tool: "server_info" }) === false, "tampered audit state was silently overwritten");
  await tampered.close();

  const disabled = new SecurityAuditLog();
  assert(disabled.snapshot().enabled === false && disabled.snapshot().persistence === "disabled",
    "disabled security audit reported an active persistence backend");
  assert(await disabled.record({ tool: "ignored" }) === false && await disabled.flush() === false,
    "disabled security audit accepted work");
  assert(await disabled.close() === false, "disabled security audit claimed a worker shutdown");

  const deferredRoot = mkdtempSync(path.join(tmpdir(), "mbm-security-audit-deferred-init-"));
  try {
    writeFileSync(path.join(deferredRoot, "security-audit.json"), "{invalid-json\n", { mode: 0o600 });
    class DeferredWorker extends EventEmitter {
      static last = null;
      constructor() { super(); DeferredWorker.last = this; }
      postMessage() {}
      terminate() { return Promise.resolve(0); }
    }
    const deferred = new SecurityAuditLog({ root: deferredRoot, WorkerClass: DeferredWorker });
    assert(deferred.snapshot().last_error_class === "audit_initializing"
      && deferred.snapshot().chain_verified === false,
    "security audit constructor synchronously read or verified persistent state");
    DeferredWorker.last.emit("error", Object.assign(new Error("deferred worker stopped"), { code: "worker_stopped" }));
    assert(await deferred.close() === false, "failed deferred audit worker claimed a clean close");
  } finally {
    rmSync(deferredRoot, { recursive: true, force: true });
  }

  const constructorFailureRoot = mkdtempSync(path.join(tmpdir(), "mbm-security-audit-worker-failure-"));
  try {
    class ThrowingWorker {
      constructor() { throw Object.assign(new Error("synthetic worker construction failure"), { code: "worker_unavailable" }); }
    }
    const unavailable = new SecurityAuditLog({ root: constructorFailureRoot, WorkerClass: ThrowingWorker });
    assert(unavailable.snapshot().healthy === false
      && unavailable.snapshot().last_error_class === "worker_unavailable",
    "security audit worker construction failure was not exposed");
    assert(await unavailable.record({ tool: "ignored" }) === false && await unavailable.close() === false,
      "unavailable security audit accepted work or claimed shutdown");
  } finally {
    rmSync(constructorFailureRoot, { recursive: true, force: true });
  }

  const writeFailureRoot = mkdtempSync(path.join(tmpdir(), "mbm-security-audit-write-failure-"));
  try {
    class WriteFailureWorker extends EventEmitter {
      static last = null;
      constructor() { super(); WriteFailureWorker.last = this; }
      postMessage(message) {
        if (message.type === "record") queueMicrotask(() => this.emit("message", {
          type: "record_batch_result", ids: [message.id], recorded: false,
          snapshot: { ...initializingAuditSnapshot(), last_error_class: "synthetic_write_failure" },
        }));
        else if (message.type === "flush" || message.type === "close") queueMicrotask(() => this.emit("message", {
          type: message.type === "close" ? "closed" : "flushed", id: message.id,
        }));
      }
      terminate() { return Promise.resolve(0); }
    }
    const failedWrite = new SecurityAuditLog({ root: writeFailureRoot, WorkerClass: WriteFailureWorker });
    WriteFailureWorker.last.emit("message", { type: "ready", snapshot: { ...initializingAuditSnapshot(), healthy: true, last_error_class: null } });
    assert(await failedWrite.record({ tool: "synthetic_write_failure" }) === false,
      "security audit synthetic write failure was reported as recorded");
    assert(await failedWrite.flush() === false,
      "security audit flush barrier claimed success after a lost audit record");
    assert(await failedWrite.close() === false,
      "security audit close barrier claimed success after a lost audit record");
  } finally {
    rmSync(writeFailureRoot, { recursive: true, force: true });
  }

  const postFailureRoot = mkdtempSync(path.join(tmpdir(), "mbm-security-audit-post-failure-"));
  try {
    class PostFailureWorker extends EventEmitter {
      postMessage(message) {
        if (message.type === "flush") {
          throw Object.assign(new Error("synthetic audit transport failure"), { code: "worker_post_failed" });
        }
      }
      terminate() { return Promise.resolve(0); }
    }
    const failedPost = new SecurityAuditLog({ root: postFailureRoot, WorkerClass: PostFailureWorker });
    const pendingRecord = failedPost.record({ tool: "pending_before_post_failure" });
    assert(await failedPost.flush() === false, "security audit flush transport failure claimed success");
    assert(await pendingRecord === false, "security audit transport failure left an earlier record unresolved");
    assert(failedPost.snapshot().healthy === false
      && failedPost.snapshot().last_error_class === "worker_post_failed"
      && failedPost.snapshot().dropped_records === 1
      && failedPost.snapshot().queue_depth === 0,
    "security audit transport failure did not fail closed or account for pending records");
    assert(await failedPost.close() === false, "failed security audit transport claimed a clean close");
  } finally {
    rmSync(postFailureRoot, { recursive: true, force: true });
  }

  const overflowRoot = mkdtempSync(path.join(tmpdir(), "mbm-security-audit-overflow-"));
  try {
    class SilentWorker extends EventEmitter {
      static last = null;
      constructor() { super(); SilentWorker.last = this; }
      postMessage() {}
      terminate() { return Promise.resolve(0); }
    }
    const saturated = new SecurityAuditLog({ root: overflowRoot, WorkerClass: SilentWorker });
    const pending = Array.from({ length: 1024 }, (_, index) => saturated.record({ tool: `queued_${index}` }));
    assert(await saturated.record({ tool: "overflow" }) === false,
      "security audit accepted work beyond its queue capacity");
    assert(saturated.snapshot().dropped_records === 1
      && saturated.snapshot().last_error_class === "audit_queue_full",
    "security audit queue overflow was not observable");
    SilentWorker.last.emit("error", Object.assign(new Error("synthetic worker failure"), { code: "worker_failed" }));
    SilentWorker.last.emit("exit", 1);
    assert((await Promise.all(pending)).every((value) => value === false),
      "security audit worker failure did not release pending callers");
    assert(saturated.snapshot().healthy === false
      && saturated.snapshot().last_error_class === "worker_failed"
      && saturated.snapshot().dropped_records === 1025,
    "security audit asynchronous worker failure or dropped-record accounting was not exposed");
    assert(await saturated.close({ timeoutMs: 1 }) === false,
      "failed security audit worker unexpectedly claimed a clean shutdown");
  } finally {
    rmSync(overflowRoot, { recursive: true, force: true });
  }

  for (const [label, timeoutMs] of [["non-finite", Number.POSITIVE_INFINITY], ["oversized", Number.MAX_SAFE_INTEGER]]) {
    const closeTimeoutRoot = mkdtempSync(path.join(tmpdir(), "mbm-security-audit-close-timeout-"));
    try {
      class HangingCloseWorker extends EventEmitter {
        static last = null;
        constructor() { super(); this.lastMessage = null; HangingCloseWorker.last = this; }
        postMessage(message) { this.lastMessage = message; }
        terminate() { return Promise.resolve(0); }
      }
      const hanging = new SecurityAuditLog({ root: closeTimeoutRoot, WorkerClass: HangingCloseWorker });
      HangingCloseWorker.last?.emit("message", {
        type: "ready",
        snapshot: { ...initializingAuditSnapshot(), healthy: true, last_error_class: null, chain_verified: true },
      });
      let settled = false;
      const closing = hanging.close({ timeoutMs }).then((value) => {
        settled = true;
        return value;
      });
      await new Promise((resolvePromise) => { setTimeout(resolvePromise, 20); });
      assert(settled === false, `${label} audit close timeout collapsed into an immediate timer`);
      const closeId = HangingCloseWorker.last?.lastMessage?.id;
      HangingCloseWorker.last?.emit("message", { type: "closed", id: closeId });
      assert(await closing === true, `audit close did not settle from the worker after ${label} timeout normalization`);
    } finally {
      rmSync(closeTimeoutRoot, { recursive: true, force: true });
    }
  }

  console.log("security audit log test ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function initializingAuditSnapshot() {
  return {
    enabled: true, healthy: false, retained: 0, maximum: 4096, maximum_bytes: 4 * 1024 * 1024,
    last_event_at: null, last_error_class: "audit_initializing", content_logged: false, chain_verified: false,
  };
}
