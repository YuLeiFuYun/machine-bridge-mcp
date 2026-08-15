import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SecurityAuditLog } from "../src/local/security-audit-log.mjs";

const root = mkdtempSync(path.join(tmpdir(), "mbm-security-audit-"));
let now = Date.UTC(2026, 6, 21, 0, 0, 0);
try {
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
    riskCategory: "remote shell or process control",
    principal,
    durationMs: 20,
    errorCode: "execution_failed",
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
  assert(!JSON.stringify(state).includes("credential contents"), "security audit persisted operation content");
  assert(state.events[1].previous_hash === state.events[0].hash, "security audit chain did not link adjacent events");

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

  concurrentState.events[0].tool = "tampered";
  writeFileSync(file, `${JSON.stringify(concurrentState)}\n`, { mode: 0o600 });
  const tampered = new SecurityAuditLog({ root, now: () => now });
  assert(await tampered.flush() && tampered.snapshot().healthy === false
    && tampered.snapshot().chain_verified === false
    && tampered.snapshot().last_error_class !== "audit_initializing",
  "security audit tampering was not detected by the worker");
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

  console.log("security audit log test ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
