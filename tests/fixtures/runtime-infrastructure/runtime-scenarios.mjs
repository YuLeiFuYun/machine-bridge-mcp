import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeError, actionableGuidance, errorCode, publicError } from "../../../src/local/errors.mjs";
import { CallRegistry } from "../../../src/local/call-registry.mjs";
import { RuntimeObservability } from "../../../src/local/observability.mjs";
import { ToolExecutor, composeMiddleware } from "../../../src/local/tool-executor.mjs";
import { MAX_TOOL_RESULT_BYTES, normalizeToolResult } from "../../../src/local/tool-result-boundary.mjs";
import { LocalRuntime } from "../../../src/local/runtime.mjs";
import { FileMutationCoordinator } from "../../../src/local/file-mutation-coordinator.mjs";
import { DIRECTORY_METADATA_BATCH_SIZE, directoryEntriesWithMetadata } from "../../../src/local/directory-metadata.mjs";
import { SEARCH_FILE_BATCH_SIZE, searchWorkspaceFiles } from "../../../src/local/workspace-search.mjs";
import { projectRuntimeInfo } from "../../../src/local/runtime-info-projection.mjs";
import { startAutostartLogMaintenance } from "../../../src/local/autostart-log-maintenance.mjs";
import { createSecurityAuditFailureReporter } from "../../../src/local/security-audit-warning.mjs";
import { resourceAdmissionLogFields } from "../../../src/local/resource-admission-diagnostics.mjs";
import { LifecycleController } from "../../../src/local/lifecycle.mjs";
import { boundedProcessErrorMessage } from "../../../src/local/process-execution.mjs";
import { assert, deferred, expectBridgeError, expectReject } from "./common.mjs";

export async function runRuntimeInfrastructureScenarios() {
  await testCallRegistry();
  await testToolExecutor();
  await testToolExecutorConcurrency();
  await testToolExecutorLateCancellationSettlement();
  await testFileMutationCoordinator();
  await testDirectoryMetadataFanout();
  await testWorkspaceSearchFanout();
  await testRuntimeInfoProjection();
  testToolResultBoundary();
  testRuntimeConvenienceMethods();
  await testRuntimeStartStopRace();
  testAutostartLogMaintenance();
  testSecurityAuditWarningRateLimit();
  testErrors();
}

async function testCallRegistry() {
  const timers = new Map();
  let nextTimer = 1;
  const cancelled = [];
  const registry = new CallRegistry({
    maximum: 2,
    now: () => 100,
    scheduler: {
      setTimeout(callback) { const id = nextTimer++; timers.set(id, callback); return id; },
      clearTimeout(id) { timers.delete(id); },
    },
    onCancel(record) { cancelled.push({ id: record.id, reason: record.cancelReason }); },
  });
  const first = registry.open({ callId: "one", tool: "read_file", origin: "stdio", timeoutMs: 50 });
  registry.open({ callId: "two", tool: "git_status", origin: "relay" });
  assert(registry.idsByOrigin("relay").join(",") === "two", "origin index did not expose the active relay call");
  expectBridgeError(() => registry.open({ callId: "three" }), "limit_exceeded");
  expectBridgeError(() => registry.open({ callId: "one" }), "conflict");
  [...timers.values()][0]();
  expectBridgeError(() => registry.throwIfCancelled(first), "timeout");
  assert(cancelled[0]?.reason === "deadline exceeded", "deadline did not use the central cancellation path");
  assert(registry.snapshot().active === 2, "cancelled call vanished before lifecycle finish");
  const prototypeOriginRegistry = new CallRegistry({ maximum: 1 });
  prototypeOriginRegistry.open({ callId: "prototype-origin", tool: "read_file", origin: "__proto__" });
  const prototypeOriginSnapshot = prototypeOriginRegistry.snapshot();
  assert(Object.hasOwn(prototypeOriginSnapshot.by_origin, "__proto__") && prototypeOriginSnapshot.by_origin.__proto__ === 1,
    "call-registry diagnostics lost a prototype-shaped origin key");
  assert(Object.getPrototypeOf(prototypeOriginSnapshot.by_origin) === null, "call-registry origin diagnostics regained prototype semantics");
  prototypeOriginRegistry.finish("prototype-origin");
  registry.finish("one");
  assert(registry.cancelOrigin("relay", "relay disconnected") === 1, "relay origin cancellation did not find its call");
  assert(cancelled.at(-1)?.reason === "relay disconnected", "relay origin cancellation lost its reason");
  registry.finish("two");
  assert(registry.snapshot().active === 0, "finished calls leaked from registry");

  const authority = new CallRegistry({ maximum: 3 });
  const accountId = `acct_${"r".repeat(32)}`;
  const clientId = `mcp_client_${"r".repeat(43)}`;
  const familyId = `mcp_family_${"r".repeat(43)}`;
  authority.open({ callId: "invalid-kind", tool: "read_file", origin: "relay" });
  assert(authority.bindPrincipal("invalid-kind", { kind: "unexpected" }) === false,
    "unknown principal kind was misattributed as local authority");
  authority.finish("invalid-kind");
  authority.open({ callId: "invalid-authority", tool: "read_file", origin: "relay" });
  assert(authority.bindPrincipal("invalid-authority", {
    kind: "account", accountId: [accountId], accountVersion: 4, clientId, familyId, role: "operator",
  }) === false, "malformed account principal crossed the call-attribution boundary");
  assert(authority.cancelAuthority({ accountId, accountVersion: 4, clientId, familyId }) === 0,
    "malformed account principal created revocable authority metadata");
  authority.finish("invalid-authority");
  authority.open({ callId: "family-call", tool: "run_process", origin: "relay" });
  authority.bindPrincipal("family-call", { kind: "account", accountId, accountVersion: 4, clientId, familyId, role: "operator" });
  authority.open({ callId: "new-version", tool: "read_file", origin: "relay" });
  authority.bindPrincipal("new-version", { kind: "account", accountId, accountVersion: 5, clientId, familyId, role: "operator" });
  assert(authority.cancelAuthority({ accountId, accountVersion: 4, clientId, familyId }) === 1,
    "family authority revocation did not cancel the exact old-version call");
  expectBridgeError(() => authority.throwIfCancelled({ callId: "family-call" }), "authorization_denied");
  authority.throwIfCancelled({ callId: "new-version" });
  authority.finish("family-call");
  authority.finish("new-version");

  const defaultCapacity = new CallRegistry();
  assert(defaultCapacity.snapshot().maximum === 16,
    "default local call capacity drifted from the sixteen-call runtime contract");

  const reserved = new CallRegistry({ maximum: 3, reserved: 1, reservedTools: ["diagnose_runtime"] });
  reserved.open({ callId: "ordinary-one", tool: "exec_command" });
  reserved.open({ callId: "ordinary-two", tool: "read_file" });
  expectBridgeError(() => reserved.open({ callId: "ordinary-three", tool: "git_status" }), "limit_exceeded");
  reserved.open({ callId: "control", tool: "diagnose_runtime" });
  assert(reserved.snapshot().active_reserved === 1 && reserved.snapshot().ordinary_capacity === 2,
    "control-plane reservation did not preserve diagnostic capacity");

  registry.open({ callId: "stop-one", tool: "read_file" });
  registry.open({ callId: "stop-two", tool: "git_status" });
  const callDrain = registry.cancelAllAndWait("runtime stopped", 100);
  assert(registry.snapshot().active === 2, "call shutdown discarded handlers before lifecycle settlement");
  expectBridgeError(() => registry.open({ callId: "late-stop-call", tool: "read_file" }), "unavailable");
  registry.finish("stop-one");
  let drainSettled = false;
  callDrain.then(() => { drainSettled = true; });
  await Promise.resolve();
  assert(!drainSettled, "call shutdown settled while a handler was still registered");
  registry.finish("stop-two");
  await callDrain;
  assert(registry.snapshot().active === 0, "call shutdown left settled calls registered");

  const stalledCalls = new CallRegistry({ maximum: 1 });
  stalledCalls.open({ callId: "stalled-stop-call", tool: "run_process" });
  await expectReject(() => stalledCalls.cancelAllAndWait("runtime stopped", 20), "unavailable", "tool call shutdown did not settle");
  assert(stalledCalls.snapshot().active === 1, "failed call shutdown discarded the retained in-flight handler");
  expectBridgeError(() => stalledCalls.open({ callId: "post-timeout-call", tool: "read_file" }), "unavailable");
  stalledCalls.finish("stalled-stop-call");
}


async function testToolExecutor() {
  const events = [];
  const metrics = new RuntimeObservability({ now: () => 1000 });
  const boundedMetrics = new RuntimeObservability();
  for (let index = 0; index < 512; index += 1) {
    const tool = "synthetic_tool_" + index;
    boundedMetrics.start(tool);
    boundedMetrics.finish(tool, { status: "failed", errorCode: "synthetic_error_" + index, durationMs: 1 });
  }
  const boundedSnapshot = boundedMetrics.snapshot();
  assert(Object.keys(boundedSnapshot.tools).length === 128 && Object.keys(boundedSnapshot.errors).length === 64,
    "runtime metrics exceeded their cardinality limits");
  assert(boundedSnapshot.active === 0 && boundedSnapshot.calls.started === 512
    && Object.values(boundedSnapshot.tools).reduce((sum, metric) => sum + metric.failed, 0) === 512
    && Object.values(boundedSnapshot.errors).reduce((sum, count) => sum + count, 0) === 512,
  "runtime metric overflow lost or duplicated call/error counts");
  const registry = new CallRegistry({ maximum: 4 });
  const fullPolicy = { profile: "full", origin: "explicit", revision: 5, allowWrite: true, allowExec: true, execMode: "shell", unrestrictedPaths: true, minimalEnv: false, exposeAbsolutePaths: true };
  const gate = { policy: fullPolicy, assert(name) { if (name === "write_file") throw new BridgeError("policy_denied", "denied"); } };
  const accountAccessGate = {
    assert(role, name) { if (role !== "owner" || name === "account-denied") throw new BridgeError("policy_denied", "account denied"); },
    authority() { return { principal: { kind: "account", role: "owner" }, effectivePolicy: fullPolicy, owner: true }; },
  };
  const executor = new ToolExecutor({
    handlers: {
      read_file: async (args, context) => ({ value: args.path, call_id: context.callId }),
      git_status: async () => { throw new Error("raw implementation failure"); },
      exec_command: async () => ({ unexpected: true }),
    },
    policyGate: gate,
    accountAccessGate,
    operationAuthorizer: {
      async authorize(operation) {
        if (operation.tool === "exec_command") throw new BridgeError("authorization_denied", "request exceeds the account role ceiling");
        return { allowed: true, source: "trusted-owner", category: "ordinary operation", scopes: [] };
      },
    },
    callRegistry: registry,
    observability: metrics,
    logger: { event(level, name, fields) { events.push({ level, name, fields }); } },
    safeMessage: () => "safe failure",
  });
  const result = await executor.execute("read_file", { path: "fixture.txt" }, { callId: "ok-call", origin: "stdio" });
  assert(result.value === "fixture.txt" && result.call_id === "ok-call", "tool executor lost arguments or lifecycle context");
  await expectReject(() => executor.execute("git_status", {}, { callId: "fail-call", origin: "relay", authorization: { role: "owner" } }), "execution_failed", "safe failure");
  await expectReject(() => executor.execute("write_file", { path: "denied.txt", content: "x" }, { callId: "deny-call" }), "policy_denied", "denied");
  const authorityError = await expectReject(
    () => executor.execute("exec_command", { command: "true" }, { callId: "authority-call", origin: "relay", authorization: { role: "owner" } }),
    "authorization_denied",
    "request exceeds the account role ceiling",
  );
  assert(authorityError.retryable === false, "role-ceiling denial was incorrectly made retryable");
  const snapshot = metrics.snapshot();
  assert(snapshot.calls.started === 4, "authorization attempts are missing from execution metrics");
  assert(snapshot.calls.completed === 1 && snapshot.calls.failed === 3, "tool metrics lost terminal outcomes");
  assert(snapshot.errors.execution_failed === 1 && snapshot.errors.policy_denied === 1 && snapshot.errors.authorization_denied === 1, "tool metrics lost stable error codes");
  assert(events.some((event) => event.name === "tool.call.started") && events.some((event) => event.name === "tool.call.failed"), "structured lifecycle events were not emitted");
  assert(registry.snapshot().active === 0, "tool executor leaked call lifecycle state");

  const managedJobReadExecutor = new ToolExecutor({
    handlers: { read_job: async (args) => ({ wait_ms: args.wait_ms }) },
    policyGate: gate,
    accountAccessGate,
    operationAuthorizer: { async authorize() { return { allowed: true, source: "trusted-owner", category: "ordinary operation", scopes: [] }; } },
    callRegistry: new CallRegistry({ maximum: 2 }),
    observability: new RuntimeObservability(),
    logger: { event() {} },
  });
  assert((await managedJobReadExecutor.execute("read_job", { job_id: "job_123456789012345678901234", wait_ms: 40_001 }, {
    callId: "relay-read-job-over-local-maximum", origin: "relay", authorization: { role: "owner" },
  })).wait_ms === 40_001, "relay read_job did not accept the hosted wait extension above the local schema maximum");
  assert((await managedJobReadExecutor.execute("read_job", { job_id: "job_123456789012345678901234", wait_ms: 60_000 }, {
    callId: "relay-read-job-hosted-maximum", origin: "relay", authorization: { role: "owner" },
  })).wait_ms === 60_000, "relay read_job did not accept the hosted maximum wait");
  await expectReject(() => managedJobReadExecutor.execute("read_job", {
    job_id: "job_123456789012345678901234", wait_ms: 60_001,
  }, { callId: "relay-read-job-over-hosted-maximum", origin: "relay", authorization: { role: "owner" } }),
  "invalid_request", "tool arguments do not match the input schema");
  await expectReject(() => managedJobReadExecutor.execute("read_job", {
    job_id: "job_123456789012345678901234", wait_ms: 40_001,
  }, { callId: "local-read-job-over-local-maximum", origin: "stdio" }),
  "invalid_request", "tool arguments do not match the input schema");
  await expectReject(() => managedJobReadExecutor.execute("read_job", {
    job_id: "job_123456789012345678901234", wait_ms: 40_000.5,
  }, { callId: "relay-read-job-non-integer", origin: "relay", authorization: { role: "owner" } }),
  "invalid_request", "tool arguments do not match the input schema");

  let authorizedRelayActivityStarts = 0;
  let authorizedRelayActivityEnds = 0;
  let authorizedHandlerRuns = 0;
  let authorizedRiskClassifications = 0;
  const activityExecutor = new ToolExecutor({
    handlers: { read_file: async ({ path }) => {
      authorizedHandlerRuns += 1;
      if (path === "handler-failure.txt") throw new BridgeError("unavailable", "handler failed after activity start");
      return "authorized";
    } },
    policyGate: gate,
    accountAccessGate,
    operationAuthorizer: { async authorize() {
      authorizedRiskClassifications += 1;
      return { allowed: true, source: "trusted-owner", category: "ordinary operation", scopes: [] };
    } },
    callRegistry: new CallRegistry({ maximum: 2 }),
    observability: new RuntimeObservability(),
    logger: { event() {} },
    onAuthorizedRelayActivityStart() { authorizedRelayActivityStarts += 1; },
    onAuthorizedRelayActivityEnd() { authorizedRelayActivityEnds += 1; },
  });
  assert(await activityExecutor.execute("read_file", { path: "authorized.txt" }, {
    callId: "authorized-activity", origin: "relay", authorization: { role: "owner" },
  }) === "authorized", "authorized relay activity did not reach its handler");
  assert(authorizedRelayActivityStarts === 1 && authorizedRelayActivityEnds === 1 && authorizedHandlerRuns === 1,
    "authorized schema-valid relay activity did not hold one balanced auxiliary activity lease");
  assert(authorizedRiskClassifications === 1, "schema-valid relay activity did not reach operation authorization exactly once");
  await expectReject(() => activityExecutor.execute("read_file", {}, {
    callId: "invalid-activity", origin: "relay", authorization: { role: "owner" },
  }), "invalid_request", "tool arguments do not match the input schema");
  assert(authorizedRiskClassifications === 1,
    "schema-invalid relay traffic reached operation risk/path authorization before static argument validation");
  await expectReject(() => activityExecutor.execute("read_file", { path: "denied.txt" }, {
    callId: "denied-activity", origin: "relay", authorization: { role: "viewer" },
  }), "policy_denied", "account denied");
  assert(authorizedRelayActivityStarts === 1 && authorizedRelayActivityEnds === 1 && authorizedHandlerRuns === 1,
    "invalid or unauthorized relay traffic was able to hold remote activity or invoke a handler");
  assert(await activityExecutor.execute("read_file", { path: "local.txt" }, {
    callId: "local-activity", origin: "stdio",
  }) === "authorized" && authorizedRelayActivityStarts === 1 && authorizedRelayActivityEnds === 1 && authorizedHandlerRuns === 2,
  "local activity incorrectly held the remote idle-sleep lease");
  await expectReject(() => activityExecutor.execute("read_file", { path: "handler-failure.txt" }, {
    callId: "failing-activity", origin: "relay", authorization: { role: "owner" },
  }), "unavailable", "handler failed after activity start");
  assert(authorizedRelayActivityStarts === 2 && authorizedRelayActivityEnds === 2 && authorizedHandlerRuns === 3,
    "relay handler failure leaked or skipped the balanced remote-activity end hook");

  const resourceEvents = [];
  const resourceExecutor = new ToolExecutor({
    handlers: {
      list_roots: async () => {
        throw new BridgeError("unavailable", "local heavy-resource capacity is temporarily unavailable", {
          retryable: true,
          details: { reason: "resource_admission", pressure_state: "red", admission_reason: "host_pressure_red" },
        });
      },
    },
    policyGate: gate,
    accountAccessGate,
    operationAuthorizer: { async authorize() { return { allowed: true, category: "ordinary operation" }; } },
    callRegistry: new CallRegistry({ maximum: 2 }),
    observability: new RuntimeObservability(),
    logger: { event(level, name, fields) { resourceEvents.push({ level, name, fields }); } },
  });
  await expectReject(
    () => resourceExecutor.execute("list_roots", {}, { callId: "resource-pressure", origin: "stdio" }),
    "unavailable",
    "local heavy-resource capacity is temporarily unavailable",
  );
  const resourceFailure = resourceEvents.find((event) => event.name === "tool.call.failed");
  assert(resourceFailure?.level === "debug"
    && resourceFailure.fields?.resource_admission_reason === "host_pressure_red"
    && resourceFailure.fields?.resource_pressure_state === "red",
  "resource-admission failure lost its coarse privacy-safe debug diagnosis");
  const redactedResourceFields = resourceAdmissionLogFields({
    details: { reason: "resource_admission", admission_reason: "private/path/value", pressure_state: "red\nsecret" },
  });
  assert(redactedResourceFields.resource_admission_reason === "resource_busy"
    && redactedResourceFields.resource_pressure_state === "unknown"
    && Object.keys(redactedResourceFields).length === 2,
  "resource-admission debug projection allowed free-form diagnostic text into logs");
  const unrelatedResourceFields = resourceAdmissionLogFields({
    details: { reason: "unrelated", admission_reason: "host_pressure_red", pressure_state: "red" },
  });
  assert(Object.keys(unrelatedResourceFields).length === 0, "non-resource failures gained resource-admission log fields");

  let releaseAudit;
  let auditQueued = 0;
  const auditPending = new Promise((resolvePromise) => { releaseAudit = resolvePromise; });
  const nonBlockingAuditExecutor = new ToolExecutor({
    handlers: { read_file: async () => "audit-independent-result" },
    policyGate: gate,
    accountAccessGate,
    operationAuthorizer: { async authorize() { return { allowed: true, category: "ordinary operation", targetHash: "" }; } },
    callRegistry: new CallRegistry({ maximum: 2 }),
    observability: new RuntimeObservability(),
    securityAudit: { record() { auditQueued += 1; return auditPending; } },
    logger: { event(level, name, fields) { events.push({ level, name, fields }); } },
  });
  const auditIndependentResult = await Promise.race([
    nonBlockingAuditExecutor.execute("read_file", { path: "fixture.txt" }, {
      callId: "audit-independent", origin: "relay", authorization: { role: "owner" },
    }),
    new Promise((_, reject) => { setTimeout(() => reject(new Error("tool result waited for security-audit persistence")), 100); }),
  ]);
  assert(auditIndependentResult === "audit-independent-result" && auditQueued === 1,
    "security audit was not queued independently from result delivery");
  releaseAudit(true);
  await Promise.resolve();

  let blockedMutationRuns = 0;
  const unavailableAuditExecutor = new ToolExecutor({
    handlers: {
      exec_command: async () => { blockedMutationRuns += 1; return "should-not-run"; },
      read_file: async () => "diagnostic-ok",
    },
    policyGate: gate,
    accountAccessGate,
    operationAuthorizer: { async authorize() { return { allowed: true, category: "remote execution", targetHash: "" }; } },
    callRegistry: new CallRegistry({ maximum: 2 }),
    observability: new RuntimeObservability(),
    securityAudit: { async flush() { return false; }, record() { return Promise.resolve(false); } },
    logger: { event() {} },
  });
  const auditUnavailable = await expectReject(() => unavailableAuditExecutor.execute("exec_command", { command: "true" }, {
    callId: "audit-unavailable-mutation", origin: "relay", authorization: { role: "owner" },
  }), "unavailable", "security audit is unavailable");
  assert(auditUnavailable.retryable === true && auditUnavailable.details?.reason === "security_audit_unavailable"
    && blockedMutationRuns === 0,
  "known-unhealthy security audit did not block a remote mutation before dispatch");
  assert(await unavailableAuditExecutor.execute("read_file", { path: "fixture.txt" }, {
    callId: "audit-unavailable-read", origin: "relay", authorization: { role: "owner" },
  }) === "diagnostic-ok", "security audit failure blocked read-only recovery diagnostics");

  let missingAuditMutationRuns = 0;
  const missingAuditExecutor = new ToolExecutor({
    handlers: { exec_command: async () => { missingAuditMutationRuns += 1; return "should-not-run"; } },
    policyGate: gate,
    accountAccessGate,
    operationAuthorizer: { async authorize() { return { allowed: true, category: "remote execution", targetHash: "" }; } },
    callRegistry: new CallRegistry({ maximum: 2 }),
    observability: new RuntimeObservability(),
    logger: { event() {} },
  });
  await expectReject(() => missingAuditExecutor.execute("exec_command", { command: "true" }, {
    callId: "audit-missing-mutation", origin: "relay", authorization: { role: "owner" },
  }), "unavailable", "security audit is unavailable");
  assert(missingAuditMutationRuns === 0,
    "missing security-audit dependency bypassed the remote mutation pre-dispatch boundary");

  const mutationAuditOrder = [];
  let healthyMutationRuns = 0;
  const healthyAuditExecutor = new ToolExecutor({
    handlers: { exec_command: async () => { healthyMutationRuns += 1; mutationAuditOrder.push("handler"); return "mutation-ok"; } },
    policyGate: gate,
    accountAccessGate,
    operationAuthorizer: { async authorize() { return { allowed: true, category: "remote execution", targetHash: "" }; } },
    callRegistry: new CallRegistry({ maximum: 2 }),
    observability: new RuntimeObservability(),
    securityAudit: {
      async flush() { mutationAuditOrder.push("flush"); return true; },
      record(input) { mutationAuditOrder.push(input.outcome); return Promise.resolve(true); },
    },
    logger: { event() {} },
  });
  assert(await healthyAuditExecutor.execute("exec_command", { command: "true" }, {
    callId: "audit-healthy-mutation", origin: "relay", authorization: { role: "owner" },
  }) === "mutation-ok" && healthyMutationRuns === 1,
  "healthy audit pre-dispatch barrier did not allow exactly one remote mutation");
  assert(mutationAuditOrder.slice(0, 3).join(",") === "flush,dispatch_intent,handler"
    && mutationAuditOrder.includes("completed"),
  "remote mutation handler ran before its durable audit intent or lost its terminal audit event");

  const ambiguousAudit = [];
  const ambiguousAuditExecutor = new ToolExecutor({
    handlers: {
      git_status: async () => {
        throw new BridgeError("execution_failed", "ambiguous mutation settlement", {
          retryable: false,
          details: {
            request_delivery: "sent",
            side_effects_started: "unknown",
            effect_settlement: "unknown",
            termination_requested: false,
          },
        });
      },
    },
    policyGate: gate,
    accountAccessGate,
    operationAuthorizer: { async authorize() { return { allowed: true, category: "ordinary operation", targetHash: "" }; } },
    callRegistry: new CallRegistry({ maximum: 2 }),
    observability: new RuntimeObservability(),
    securityAudit: { record(input) { ambiguousAudit.push(input); return Promise.resolve(true); } },
    logger: { event() {} },
  });
  await expectReject(() => ambiguousAuditExecutor.execute("git_status", {}, {
    callId: "ambiguous-audit", origin: "relay", authorization: { role: "owner" },
  }), "execution_failed", "ambiguous mutation settlement");
  assert(ambiguousAudit.length === 1
    && ambiguousAudit[0].requestDelivery === "sent"
    && ambiguousAudit[0].sideEffectsStarted === "unknown"
    && ambiguousAudit[0].effectSettlement === "unknown"
    && ambiguousAudit[0].terminationRequested === false,
  "security audit attribution lost fixed ambiguous-side-effect settlement metadata");

  const order = [];
  const pipeline = composeMiddleware([
    async (operation, next) => { order.push("a-before"); const value = await next(operation); order.push("a-after"); return value; },
    async (operation, next) => { order.push("b-before"); const value = await next(operation); order.push("b-after"); return value; },
  ], async () => { order.push("handler"); return true; });
  await pipeline({});
  assert(order.join(",") === "a-before,b-before,handler,b-after,a-after", "middleware composition order is invalid");
}


async function testToolExecutorConcurrency() {
  let releaseBlocked;
  let markStarted;
  const blocked = new Promise((resolve) => { releaseBlocked = resolve; });
  const started = new Promise((resolve) => { markStarted = resolve; });
  const registry = new CallRegistry({ maximum: 4 });
  const executor = new ToolExecutor({
    handlers: {
      read_file: async () => {
        markStarted();
        await blocked;
        return "blocked-complete";
      },
      git_status: async () => "fast-complete",
    },
    policyGate: { policy: { profile: 'full', origin: 'explicit', revision: 5, allowWrite: true, allowExec: true, execMode: 'shell', unrestrictedPaths: true, minimalEnv: false, exposeAbsolutePaths: true }, assert() {} },
    accountAccessGate: { assert() {}, authority(_authorization, policy) { return { principal: { kind: 'account', role: 'owner' }, effectivePolicy: policy, owner: true }; } },
    callRegistry: registry,
    observability: new RuntimeObservability(),
    logger: { event() {} },
  });

  const first = executor.execute("read_file", { path: "blocked.txt" }, { callId: "concurrent-first", origin: "relay", authorization: { role: "owner" } });
  await started;
  assert(registry.snapshot().active === 1, "blocked tool was not registered as active");
  const second = await Promise.race([
    executor.execute("git_status", {}, { callId: "concurrent-second", origin: "relay", authorization: { role: "owner" } }),
    new Promise((_, reject) => { setTimeout(() => reject(new Error("independent tool call was serialized behind another call")), 250); }),
  ]);
  assert(second === "fast-complete", "concurrent tool returned the wrong result");
  assert(registry.snapshot().active === 1, "completing one concurrent call corrupted the other lifecycle");
  releaseBlocked();
  assert(await first === "blocked-complete", "blocked concurrent tool did not resume");
  assert(registry.snapshot().active === 0, "concurrent tool calls leaked lifecycle state");
}


async function testToolExecutorLateCancellationSettlement() {
  const registry = new CallRegistry({ maximum: 2 });
  const observability = new RuntimeObservability();
  const commitStarted = deferred();
  const finishCommit = deferred();
  let committed = false;
  const fullPolicy = { profile: "full", origin: "explicit", revision: 5, allowWrite: true, allowExec: true, execMode: "shell", unrestrictedPaths: true, minimalEnv: false, exposeAbsolutePaths: true };
  const executor = new ToolExecutor({
    handlers: {
      write_file: async () => {
        commitStarted.resolve();
        await finishCommit.promise;
        committed = true;
        return { ok: true, committed: true };
      },
    },
    policyGate: { policy: fullPolicy, assert() {} },
    accountAccessGate: { assert() {}, authority() { return { principal: { kind: "local", role: "owner" }, effectivePolicy: fullPolicy, owner: true }; } },
    callRegistry: registry,
    observability,
    logger: { event() {} },
  });
  const pending = executor.execute("write_file", { path: "settled.txt", content: "x" }, { callId: "late-cancel-settlement" });
  await commitStarted.promise;
  assert(registry.cancel("late-cancel-settlement", "caller stopped waiting") === true, "late cancellation did not reach the in-flight call");
  finishCommit.resolve();
  const result = await pending;
  const metrics = observability.snapshot();
  assert(committed && result.committed === true, "late cancellation replaced an already-settling mutation result");
  assert(metrics.calls.completed === 1 && metrics.calls.cancelled === 0 && metrics.calls.failed === 0,
    "late cancellation made local observability disagree with the completed handler result");
  assert(registry.snapshot().active === 0, "late-cancelled settled call leaked registry state");
}


async function testFileMutationCoordinator() {
  const coordinator = new FileMutationCoordinator();
  const root = join(tmpdir(), "mbm-file-mutation-coordinator");
  const firstPath = join(root, "first.txt");
  const secondPath = join(root, "second.txt");
  const thirdPath = join(root, "third.txt");
  for (const [paths, callback, label] of [
    [null, async () => {}, "non-array paths"],
    [[], async () => {}, "empty paths"],
    [[firstPath], null, "missing callback"],
    [["relative.txt"], async () => {}, "relative path"],
    [[""], async () => {}, "empty path"],
    [[`${firstPath}\0suffix`], async () => {}, "NUL path"],
  ]) {
    let invalidError;
    try { await coordinator.withPaths(paths, callback); } catch (error) { invalidError = error; }
    assert(invalidError instanceof TypeError, `file mutation coordinator accepted ${label}`);
  }
  const samePathOrder = [];
  const sameStarted = deferred();
  const sameRelease = deferred();
  let secondSameStarted = false;
  const firstSame = coordinator.withPaths([firstPath], async () => {
    samePathOrder.push("first:start");
    sameStarted.resolve();
    await sameRelease.promise;
    samePathOrder.push("first:end");
  });
  await sameStarted.promise;
  const secondSame = coordinator.withPaths([firstPath], async () => {
    secondSameStarted = true;
    samePathOrder.push("second:start");
  });
  await Promise.resolve();
  await Promise.resolve();
  assert(!secondSameStarted, "same-path file mutations overlapped");
  sameRelease.resolve();
  await Promise.all([firstSame, secondSame]);
  assert(samePathOrder.join(",") === "first:start,first:end,second:start", "same-path file mutation order changed");

  const unrelatedStarted = deferred();
  const unrelatedRelease = deferred();
  const held = coordinator.withPaths([firstPath], async () => {
    unrelatedStarted.resolve();
    await unrelatedRelease.promise;
  });
  await unrelatedStarted.promise;
  let secondPathStarted = false;
  const unrelated = coordinator.withPaths([secondPath], async () => { secondPathStarted = true; });
  await unrelated;
  assert(secondPathStarted, "unrelated file mutation was serialized behind another path");
  unrelatedRelease.resolve();
  await held;

  const multiStarted = deferred();
  const multiRelease = deferred();
  const multi = coordinator.withPaths([firstPath, secondPath, firstPath], async () => {
    multiStarted.resolve();
    await multiRelease.promise;
  });
  await multiStarted.promise;
  let overlapStarted = false;
  const overlap = coordinator.withPaths([secondPath], async () => { overlapStarted = true; });
  let thirdStarted = false;
  await coordinator.withPaths([thirdPath], async () => { thirdStarted = true; });
  await Promise.resolve();
  assert(thirdStarted, "multi-path reservation blocked an unrelated path");
  assert(!overlapStarted, "multi-path reservation did not retain every conflicting path");
  multiRelease.resolve();
  await Promise.all([multi, overlap]);
  assert(overlapStarted, "overlapping mutation never resumed after multi-path release");

  let failed = false;
  try { await coordinator.withPaths([firstPath], async () => { throw new Error("expected mutation failure"); }); }
  catch (error) { failed = error?.message === "expected mutation failure"; }
  assert(failed, "mutation coordinator swallowed a callback failure");
  let afterFailure = false;
  await coordinator.withPaths([firstPath], async () => { afterFailure = true; });
  assert(afterFailure, "failed file mutation leaked its path reservation");
}


async function testDirectoryMetadataFanout() {
  const fakeEntries = Array.from({ length: 20 }, (_value, index) => ({ name: `entry-${String(index).padStart(2, "0")}` }));
  const openDirectory = async () => ({
    async *[Symbol.asyncIterator]() { for (const entry of fakeEntries) yield entry; },
  });
  let active = 0;
  let maximumActive = 0;
  const inspect = async (path) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await Promise.resolve();
    active -= 1;
    return { size: path.length };
  };
  const observed = [];
  for await (const item of directoryEntriesWithMetadata("/synthetic", { openDirectory, inspect })) observed.push(item.entry.name);
  assert(maximumActive === DIRECTORY_METADATA_BATCH_SIZE,
    `directory metadata fan-out exceeded or failed to use its bounded concurrency (${maximumActive})`);
  assert(JSON.stringify(observed) === JSON.stringify(fakeEntries.map((entry) => entry.name)),
    "directory metadata fan-out changed directory enumeration order");

  const deferredError = new Error("later metadata failed");
  const twoEntries = async () => ({
    async *[Symbol.asyncIterator]() { yield { name: "first" }; yield { name: "second" }; },
  });
  const inspectWithLateFailure = async (path) => {
    if (path.endsWith("second")) throw deferredError;
    return { size: 1 };
  };
  const truncated = directoryEntriesWithMetadata("/synthetic", {
    openDirectory: twoEntries, inspect: inspectWithLateFailure, batchSize: 2,
  });
  const first = await truncated.next();
  assert(first.value?.entry?.name === "first", "directory metadata fan-out lost the first settled entry");
  await truncated.return();

  const consumed = directoryEntriesWithMetadata("/synthetic", {
    openDirectory: twoEntries, inspect: inspectWithLateFailure, batchSize: 2,
  });
  assert((await consumed.next()).value?.entry?.name === "first", "directory metadata error fixture lost its leading entry");
  let consumedError;
  try { await consumed.next(); } catch (error) { consumedError = error; }
  assert(consumedError === deferredError, "directory metadata fan-out hid or replaced an error that was actually consumed");

  let cancelled = false;
  const cancellationError = new Error("cancelled between prefetched entries");
  const cancellable = directoryEntriesWithMetadata("/synthetic", {
    openDirectory: twoEntries,
    inspect: async () => ({ size: 1 }),
    batchSize: 2,
    throwIfCancelled() { if (cancelled) throw cancellationError; },
  });
  assert((await cancellable.next()).value?.entry?.name === "first", "directory metadata cancellation fixture did not yield first entry");
  cancelled = true;
  let cancellationObserved;
  try { await cancellable.next(); } catch (error) { cancellationObserved = error; }
  assert(cancellationObserved === cancellationError, "directory metadata fan-out ignored cancellation between prefetched entries");

  const empty = directoryEntriesWithMetadata("/synthetic", {
    openDirectory: async () => ({ async *[Symbol.asyncIterator]() {} }),
    inspect,
    batchSize: 65,
  });
  assert((await empty.next()).done === true, "directory metadata fan-out did not settle an empty directory");

  const tailError = new Error("tail metadata failed");
  const tail = directoryEntriesWithMetadata("/synthetic", {
    openDirectory: async () => ({
      async *[Symbol.asyncIterator]() { yield { name: "a" }; yield { name: "b" }; yield { name: "tail" }; },
    }),
    batchSize: 2,
    inspect: async (path) => { if (path.endsWith("tail")) throw tailError; return { size: 1 }; },
  });
  assert((await tail.next()).value?.entry?.name === "a" && (await tail.next()).value?.entry?.name === "b",
    "directory metadata tail-error fixture lost its full leading batch");
  let tailObserved;
  try { await tail.next(); } catch (error) { tailObserved = error; }
  assert(tailObserved === tailError, "directory metadata fan-out hid or replaced a consumed tail-batch error");
}


async function testWorkspaceSearchFanout() {
  const files = Array.from({ length: 20 }, (_value, index) => `/synthetic/file-${String(index).padStart(2, "0")}`);
  const makeWalk = (items) => async (onFile) => {
    for (const file of items) {
      if (await onFile(file) === false) return { truncated: true, visitedEntries: items.indexOf(file) + 1 };
    }
    return { truncated: false, visitedEntries: items.length };
  };
  let active = 0;
  let maximumActive = 0;
  const result = await searchWorkspaceFiles({
    maximumFiles: files.length,
    maximumMatches: 100,
    walk: makeWalk(files),
    async searchFile(file) {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      return [{ path: file, line: 1, text: file }];
    },
  });
  assert(maximumActive === SEARCH_FILE_BATCH_SIZE,
    `workspace search fan-out exceeded or failed to use its bounded concurrency (${maximumActive})`);
  assert(JSON.stringify(result.matches.map((match) => match.path)) === JSON.stringify(files),
    "workspace search fan-out changed file or match ordering");
  assert(result.visitedFiles === files.length && result.truncated === true,
    "workspace search fan-out lost exact max_files accounting");

  const lateError = new Error("later search failed");
  const early = await searchWorkspaceFiles({
    maximumFiles: 2,
    maximumMatches: 1,
    batchSize: 2,
    walk: makeWalk(["/synthetic/first", "/synthetic/second"]),
    async searchFile(file) {
      if (file.endsWith("second")) throw lateError;
      return [{ path: file, line: 1, text: "match" }];
    },
  });
  assert(early.matches.length === 1 && early.visitedFiles === 1 && early.truncated === true,
    "workspace search exposed work beyond an earlier max_matches stop");

  let consumedError;
  try {
    await searchWorkspaceFiles({
      maximumFiles: 2,
      maximumMatches: 1,
      batchSize: 2,
      walk: makeWalk(["/synthetic/first", "/synthetic/second"]),
      async searchFile(file) {
        if (file.endsWith("second")) throw lateError;
        return [];
      },
    });
  } catch (error) { consumedError = error; }
  assert(consumedError === lateError, "workspace search hid or replaced a consumed file-search error");

  let searched = 0;
  const capped = await searchWorkspaceFiles({
    maximumFiles: 2,
    maximumMatches: 100,
    batchSize: 16,
    walk: makeWalk(files.slice(0, 4)),
    async searchFile() { searched += 1; return []; },
  });
  assert(searched === 2 && capped.visitedFiles === 2 && capped.truncated === true,
    "workspace search scheduled or counted files beyond max_files");

  const cancellationError = new Error("search cancelled during file I/O");
  let cancelled = false;
  let cancellationObserved;
  try {
    await searchWorkspaceFiles({
      maximumFiles: 1,
      maximumMatches: 1,
      walk: makeWalk(["/synthetic/cancel"]),
      async searchFile() { await Promise.resolve(); cancelled = true; return []; },
      throwIfCancelled() { if (cancelled) throw cancellationError; },
    });
  } catch (error) { cancellationObserved = error; }
  assert(cancellationObserved === cancellationError, "workspace search ignored cancellation after prefetched file I/O");
}


function testRuntimeInfoProjection() {
  const full = { name: "fixture", policy: { profile: "custom" }, tool_delivery: { daemon_advertised_tool_count: 7 }, runtime: {} };
  assert(projectRuntimeInfo(full, "full") === full, "full local server_info projection stopped preserving the canonical object");
  const summary = projectRuntimeInfo({
    name: "fixture",
    protocol_version: "test",
    workspace: ".",
    workspace_name: "workspace",
    policy: null,
    tool_delivery: null,
    runtime: {
      relay: {
        authenticated: true, ready: true, closed: false, transport: "https", network_route: "system-network-stack",
        reconnect_attempt: 2, outage_active: false, outage_count: 4, outage_duration_ms: 321,
        last_close_category: "relay_connect_timeout", last_close_code: 1006, last_transport_error_class: "network_error",
        https_fallback_active: true, websocket_ready: false, https_fallback_last_takeover_ms: 1350,
        https_fallback_last_takeover_outage_number: 4,
        https_fallback: { session_id: "must_not_escape_summary", outbound_queue: ["content"] },
        heartbeat: { application_inbound_silence_ms: 999 }, websocket_outage_duration_ms: 888,
      },
      processes: null,
      process_sessions: [],
      managed_jobs: { active: 2, retained: 3, maximum: 9, staged: 1, capacity: { retained_state: 9, retired_state: 6, retired_unreadable: 2 } },
    },
  }, "summary");
  assert(summary.detail === "summary" && summary.policy && Object.keys(summary.policy).length === 0
    && summary.tool_delivery.daemon_advertised_tool_count === 0
    && summary.runtime.lifecycle === null && summary.runtime.relay?.ready === true
    && summary.runtime.relay?.transport === "https" && summary.runtime.relay?.outage_count === 4
    && summary.runtime.relay?.https_fallback_active === true && summary.runtime.relay?.websocket_ready === false
    && summary.runtime.relay?.https_fallback_last_takeover_ms === 1350
    && summary.runtime.relay?.https_fallback_last_takeover_outage_number === 4
    && !("https_fallback" in summary.runtime.relay) && !("heartbeat" in summary.runtime.relay)
    && !("websocket_outage_duration_ms" in summary.runtime.relay)
    && summary.runtime.processes.active_processes === 0 && summary.runtime.processes.draining_processes === 0
    && summary.runtime.process_sessions.active === 0 && !("staged" in summary.runtime.process_sessions)
    && summary.runtime.managed_jobs.active === 2 && summary.runtime.managed_jobs.staged === 1
    && summary.runtime.managed_jobs.capacity?.retained_state === 9
    && summary.runtime.managed_jobs.capacity?.retired_state === 6
    && summary.runtime.managed_jobs.capacity?.retired_unreadable === 2,
  "sparse local server_info projection lost bounded defaults or owner retained-state capacity diagnostics");
  const hiddenSummary = projectRuntimeInfo({
    runtime: { processes: { activity_hidden_by_authority: true }, process_sessions: { active: 1, retained: 1, maximum: 8 }, managed_jobs: { active: 0, retained: 0, maximum: 50 } },
  }, "summary");
  assert(hiddenSummary.runtime.processes.activity_hidden_by_authority === true
    && !("active_processes" in hiddenSummary.runtime.processes),
  "server_info summary converted hidden global process activity into false zero-valued evidence");
}


function testToolResultBoundary() {
  const source = { ok: true, nested: { value: 7 } };
  const normalized = normalizeToolResult(source);
  source.nested.value = 9;
  assert(normalized.value.nested.value === 7, "tool result boundary retained a mutable handler object");
  assert(normalized.bytes === Buffer.byteLength(JSON.stringify({ ok: true, nested: { value: 7 } })), "tool result boundary reported the wrong byte size");

  const cyclic = {};
  cyclic.self = cyclic;
  expectBridgeError(() => normalizeToolResult(cyclic), "internal_error");
  expectBridgeError(() => normalizeToolResult({ value: 1n }), "internal_error");
  expectBridgeError(() => normalizeToolResult({ value: undefined }), "internal_error");
  expectBridgeError(() => normalizeToolResult({ value() {} }), "internal_error");
  expectBridgeError(() => normalizeToolResult({ value: Symbol("x") }), "internal_error");
  expectBridgeError(() => normalizeToolResult({ value: Number.NaN }), "internal_error");
  expectBridgeError(() => normalizeToolResult(undefined), "internal_error");
  let oversized;
  try { normalizeToolResult({ data: "x".repeat(MAX_TOOL_RESULT_BYTES) }); }
  catch (error) { oversized = error; }
  assert(oversized?.code === "limit_exceeded", "oversized tool result used the wrong error code");
  assert(oversized.details.maximum_bytes === MAX_TOOL_RESULT_BYTES, "oversized tool result omitted its safe limit metadata");
}



function testRuntimeConvenienceMethods() {
  let finished = "";
  const delegated = [];
  const runtime = {
    relay: null,
    relayResumeStates: new Map([["websocket:9", { missingIds: [] }], ["https:1000000009", { missingIds: [] }]]),
    callRegistry: { finish(callId) { finished = callId; } },
    relayCallRecovery: {
      deliver(value) { delegated.push(["deliver", value.id]); return true; },
      reconcile(ids, cancel) { delegated.push(["reconcile", ids.join(","), typeof cancel]); },
      disconnected() { delegated.push(["disconnected"]); },
      ready() { delegated.push(["ready"]); },
    },
    cancelRelayCall() { return false; },
  };
  assert(LocalRuntime.prototype.send.call(runtime, { type: "noop" }) === false, "runtime send reported success without a relay");
  LocalRuntime.prototype.finishCall.call(runtime, "finished-call");
  assert(finished === "finished-call", "runtime finishCall did not delegate to the call registry");
  LocalRuntime.prototype.finishCall.call(runtime, "");
  assert(finished === "finished-call", "runtime finishCall mutated state for an empty call id");
  assert(LocalRuntime.prototype.deliverRelayToolResult.call(runtime, { id: "delegated-call" }) === true, "runtime did not delegate relay result delivery");
  LocalRuntime.prototype.reconcileRelayCalls.call(runtime, ["call_keep_12345678"]);
  LocalRuntime.prototype.handleRelayDisconnect.call(runtime, { transport: "websocket" });
  LocalRuntime.prototype.handleRelayReady.call(runtime);
  assert(!runtime.relayResumeStates.has("websocket:9") && runtime.relayResumeStates.has("https:1000000009"),
    "runtime disconnect cleared another transport generation or retained the disconnected transport state");
  assert(JSON.stringify(delegated) === JSON.stringify([
    ["deliver", "delegated-call"],
    ["reconcile", "call_keep_12345678", "function"],
    ["disconnected"],
    ["ready"],
  ]), "runtime relay-recovery delegation drifted");
}


async function testRuntimeStartStopRace() {
  let rejectRelayStart;
  const lifecycle = new LifecycleController("test runtime");
  const runtime = {
    relay: { start: () => new Promise((_, reject) => { rejectRelayStart = reject; }) },
    lifecycle,
    policy: { profile: "agent" },
    remoteActivityIdleSleepGuard: { start() {}, stop() {} },
  };
  const starting = LocalRuntime.prototype.start.call(runtime);
  await Promise.resolve();
  assert(lifecycle.snapshot().state === "starting", "runtime start-stop fixture did not enter starting state");
  lifecycle.beginStop();
  lifecycle.markStopped();
  rejectRelayStart(new Error("relay stopped during startup"));
  await starting;
  assert(lifecycle.snapshot().state === "stopped", "a late relay-start rejection overwrote an already-stopped runtime lifecycle");
}


function testAutostartLogMaintenance() {
  let callback = null;
  let delay = 0;
  let unref = 0;
  let trims = 0;
  let failures = 0;
  const maintenance = startAutostartLogMaintenance("/state", {
    intervalMs: 1234,
    trim(root) {
      assert(root === "/state", "log maintenance changed its state root");
      trims += 1;
      if (trims === 2) throw new Error("synthetic trim failure");
    },
    onError() { failures += 1; },
    scheduler: {
      setInterval(fn, value) { callback = fn; delay = value; return { unref() { unref += 1; } }; },
    },
  });
  assert(maintenance.intervalMs === 1234 && delay === 1234 && unref === 1,
    "background log maintenance lost its bounded unreferenced schedule");
  callback();
  callback();
  assert(trims === 2 && failures === 1, "background log maintenance did not contain a trim failure");
}


function testSecurityAuditWarningRateLimit() {
  let now = 1000;
  const events = [];
  const reporter = createSecurityAuditFailureReporter({
    event(level, event, fields, message) { events.push({ level, event, fields, message }); },
  }, { now: () => now, intervalMs: 100 });
  assert(reporter.report("security.audit.persist.failed", { tool: "read_file" }, "failed"),
    "first security-audit warning was suppressed");
  assert(!reporter.report("security.audit.persist.failed", { tool: "git_status" }, "failed"),
    "duplicate security-audit warning was not suppressed");
  now += 100;
  assert(reporter.report("security.audit.persist.failed", { tool: "server_info" }, "failed"),
    "security-audit warning did not resume after its interval");
  assert(events.length === 2 && events[1].fields.suppressed === 1,
    "security-audit warning did not report its suppressed duplicate count");
}


function testErrors() {
  assert(boundedProcessErrorMessage(new Error("bad\u001b[31m\r\nvalue\u0000"))
      .split("").every((character) => !/[\u0000-\u001f\u007f-\u009f]/.test(character)),
    "bounded process error normalization retained terminal/control characters");
  assert(boundedProcessErrorMessage({ toString() { throw new Error("synthetic conversion failure"); } }, "safe fallback") === "safe fallback",
    "bounded process error normalization propagated a hostile toString failure");
  assert(boundedProcessErrorMessage(new Error("x".repeat(5000))).length === 4096,
    "bounded process error normalization exceeded its public message ceiling");
  assert(errorCode(Object.assign(new Error("missing"), { code: "ENOENT" })) === "not_found", "Node error code classification failed");
  assert(errorCode(new Error("something timed out")) === "execution_failed", "untyped messages must not be reclassified heuristically");
  const publicValue = publicError(new BridgeError("network_error", "network unavailable"));
  assert(publicValue.code === "network_error" && publicValue.retryable === true, "public error lost retryability");
  const hidden = publicError(new BridgeError("internal_error", "private", { expose: false, details: { secret: "must-not-leak" } }));
  assert(!hidden.details && hidden.message === "internal error", "non-exposed error leaked structured details");
  const rawUnknown = publicError(new Error("private path /Users/private-user and token secret"));
  assert(rawUnknown.message === "operation failed" && !rawUnknown.message.includes("private-user"), "unknown exception text was exposed remotely");
  const explicitlySafe = publicError(new Error("safe\nmessage"), { expose: true, safeMessage: "safe\nmessage" });
  assert(explicitlySafe.message === "safe message", "public error message retained unsafe controls");
  const cyclicDetails = {}; cyclicDetails.self = cyclicDetails;
  const cyclicPublic = publicError(new BridgeError("execution_failed", "bounded", { details: cyclicDetails }));
  assert(!cyclicPublic.details && cyclicPublic.message === "bounded", "cyclic public error details were not omitted");
  const hugePublic = publicError(new BridgeError("execution_failed", "bounded", { details: { data: "x".repeat(600 * 1024) } }));
  assert(!hugePublic.details, "oversized public error details were not omitted");
  const verboseError = publicError(new BridgeError("internal_error", "detailed debugging reason", { expose: false }), { verbose: true });
  assert(verboseError.message === "detailed debugging reason" && verboseError.details?.debug_error?.message === "detailed debugging reason", "verbose error failed to expose debugging message");
  const verboseUnsafe = publicError(new BridgeError("internal_error", `path /Users/private\u0000\u001b[31m`, { expose: false }), { verbose: true });
  assert(!verboseUnsafe.details?.debug_error?.message.includes("\u0000") && !verboseUnsafe.details?.debug_error?.message.includes("\u001b"), "verbose error details retained control characters");
  const verboseHuge = publicError(new BridgeError("internal_error", "y".repeat(50_000), { expose: false }), { verbose: true });
  assert(verboseHuge.message.length === 2000 && verboseHuge.details?.debug_error?.message.length === 2000,
    "verbose error details were not bounded by the single public message ceiling");
  const previousDebug = process.env.MBM_DEBUG;
  const previousVerbose = process.env.MBM_VERBOSE_ERRORS;
  process.env.MBM_DEBUG = "1";
  process.env.MBM_VERBOSE_ERRORS = "1";
  try {
    const envIgnored = publicError(new BridgeError("internal_error", "env must not expose this", { expose: false }));
    assert(envIgnored.message === "internal error" && !envIgnored.details, "process environment disabled the public error redaction boundary");
  } finally {
    if (previousDebug === undefined) delete process.env.MBM_DEBUG; else process.env.MBM_DEBUG = previousDebug;
    if (previousVerbose === undefined) delete process.env.MBM_VERBOSE_ERRORS; else process.env.MBM_VERBOSE_ERRORS = previousVerbose;
  }
  assert(actionableGuidance(new BridgeError("not_found", "missing")).includes("Verify target path"), "actionable guidance omitted for not_found");
  assert(actionableGuidance(new BridgeError("path_boundary", "outside")).includes("workspace boundary"), "actionable guidance omitted for path_boundary");
  assert(actionableGuidance(new BridgeError("conflict", "busy")).includes("inspect current state"), "actionable guidance omitted for conflict");
  // internal_error redacts its message, so the remedy is the only actionable channel the agent
  // has left; execution_failed is the highest-volume failure code and must say what to read.
  assert(actionableGuidance(new BridgeError("internal_error", "fatal"))?.includes("run doctor"),
    "internal errors lost the only actionable channel left after their message is redacted");
  assert(actionableGuidance(new BridgeError("execution_failed", "operation failed"))?.includes("details.reason"),
    "execution_failed lost its actionable remedy");
}
