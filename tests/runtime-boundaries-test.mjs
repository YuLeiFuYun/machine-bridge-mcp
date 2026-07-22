import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProjectOverview, buildRuntimeInfo } from "../src/local/runtime-reporting.mjs";
import { diagnoseRuntime } from "../src/local/runtime-diagnostics.mjs";
import { resolveTaskCapabilities, sessionBootstrap } from "../src/local/runtime-capabilities.mjs";
import { policyProfile } from "../src/local/policy.mjs";

await testRuntimeReporting();
await testRuntimeDiagnostics();
await testRuntimeCapabilities();
console.log("runtime boundary services test ok");

async function testRuntimeReporting() {
  const full = policyProfile("full");
  const info = buildRuntimeInfo({
    workspace: "/workspace/project",
    displayPath: (value) => value,
    policy: full,
    toolNames: ["read_file"],
    capabilityObserver: { snapshot: () => ({ bootstrap_count: 1 }) },
    observability: { snapshot: () => ({ calls: { started: 2 } }) },
    callRegistry: { snapshot: () => ({ active: 0 }) },
    lifecycle: { snapshot: () => ({ state: "running" }) },
    relayStatus: () => ({ ready: true }),
    runtimeDir: "/private/runtime",
    processTracker: { snapshot: () => ({ active_processes: 0 }) },
    processSessionManager: { status: () => ({ active: 0 }) },
    managedJobManager: {
      status: () => ({ active: 0 }),
      resourceInfo: () => ({ count: 0 }),
    },
  });
  assert(info.workspace_name === "project", "runtime info lost the exposed workspace name");
  assert(info.runtime.runtime_dir === "/private/runtime", "full policy runtime path was unexpectedly redacted");
  assert(info.policy_contract.named_profile_is_canonical === true, "canonical policy was not recognized");
  assert(info.observability.relay_readiness === "end-to-end-relay-probe-verified", "runtime observability describes stale hello-only readiness");
  const oneShot = info.runtime.execution_guardrails.one_shot_processes;
  assert(oneShot.output_max_bytes_per_stream === oneShot.inline_output_max_bytes_per_stream
    && oneShot.continuation_tool === "read_process"
    && oneShot.continuation_retention.includes("best-effort"),
  "runtime info lost the compatible one-shot output limit or continuation semantics");
  assert(oneShot.process_tree_termination === "sigterm-then-sigkill", "runtime info omitted process-tree supervision");
  assert(info.runtime.execution_guardrails.operating_system_enforcement.cpu_quota === "not-enforced"
    && info.runtime.execution_guardrails.operating_system_enforcement.memory_quota === "not-enforced"
    && info.runtime.execution_guardrails.operating_system_enforcement.network_isolation === "not-enforced",
  "runtime info falsely advertised OS resource or network isolation");

  const review = policyProfile("review");
  const redacted = buildRuntimeInfo({
    workspace: "/workspace/project",
    displayPath: () => ".",
    policy: review,
    toolNames: [],
    capabilityObserver: { snapshot: () => ({}) },
    observability: { snapshot: () => ({}) },
    callRegistry: { snapshot: () => ({}) },
    lifecycle: { snapshot: () => ({}) },
    relayStatus: () => null,
    runtimeDir: "/private/runtime",
    processTracker: { snapshot: () => ({}) },
    processSessionManager: { status: () => ({}) },
    managedJobManager: { status: () => ({}), resourceInfo: () => ({}) },
  });
  assert(redacted.workspace_name === "workspace" && redacted.runtime.runtime_dir === "<private-runtime-dir>", "review policy leaked private paths");

  const overview = await buildProjectOverview({
    workspace: "/workspace/project",
    displayPath: (value) => value,
    policy: full,
    toolNames: ["read_file"],
    capabilityObserver: { snapshot: () => ({ resolutions: 1 }) },
    listTopLevel: async () => ({ entries: [{ name: "README.md" }] }),
    gitExecutable: () => "/usr/bin/git",
    runInternalProcess: async () => ({ code: 0, stdout: "/workspace/project\n" }),
    safeErrorMessage: (error) => String(error?.message || error),
    throwIfCancelled() {},
  });
  assert(overview.gitRoot === "/workspace/project" && overview.topLevel.length === 1, "project overview lost repository metadata");
  assert(overview.daemonPolicy.profile === "full" && overview.daemonTools.includes("read_file"), "project overview omitted the explicit daemon ceiling");

  const degraded = await buildProjectOverview({
    workspace: "/workspace/project",
    displayPath: () => ".",
    policy: review,
    toolNames: [],
    capabilityObserver: { snapshot: () => ({}) },
    listTopLevel: async () => { throw new Error("unreadable"); },
    gitExecutable: () => "/usr/bin/git",
    runInternalProcess: async () => ({ code: 1, stdout: "" }),
    safeErrorMessage: () => "safe",
    throwIfCancelled() {},
  });
  assert(degraded.gitRoot === "" && degraded.topLevel.length === 0, "project overview did not degrade safely");
}

async function testRuntimeDiagnostics() {
  const runtimeDir = await mkdtemp(join(tmpdir(), "mbm-runtime-diagnostics-"));
  try {
    const managedJobManager = {
      diagnoseStorage: () => ({ ok: true }),
      listResources: () => ({ count: 2, resources: [
        { name: "ok", available: true },
        { name: "missing", available: false, error_class: "not_found" },
      ] }),
    };
    const shell = await diagnoseRuntime({
      policy: policyProfile("full"),
      runtimeDir,
      workspace: runtimeDir,
      runProcess: async () => ({ code: 0, stdout: "ok", stderr: "" }),
      probeShell: async () => ({ code: 0, stdout: "", stderr: "" }),
      managedJobManager,
      relayStatus: () => ({
        ready: true, network_route: "system-network-stack", network_route_scope: "application-proxy-selection-only",
        outage_active: false, outage_count: 2, last_close_category: "relay_transport_error", last_close_code: 1006,
        last_transport_error_class: "network_error", last_ready_duration_ms: 5000, next_reconnect_in_ms: 0,
      }),
      throwIfCancelled() {},
    });
    assert(shell.request_reached_local_runtime === true, "runtime diagnostic lost local reachability evidence");
    assert(shell.checks.some((check) => check.layer === "local-shell" && check.ok), "shell diagnostic was not executed");
    const relayCheck = shell.checks.find((check) => check.layer === "remote-relay");
    assert(relayCheck?.ok === true && relayCheck.outage_count === 2 && relayCheck.network_route === "system-network-stack", "relay diagnostic history was omitted");
    assert(shell.ok === false, "unavailable local resource was hidden from diagnostic result");

    const review = await diagnoseRuntime({
      policy: policyProfile("review"),
      runtimeDir,
      workspace: runtimeDir,
      runProcess: async () => { throw new Error("must not run"); },
      probeShell: async () => { throw new Error("must not run"); },
      managedJobManager: {
        diagnoseStorage: () => ({ ok: true }),
        listResources: () => ({ count: 0, resources: [] }),
      },
      throwIfCancelled() {},
    });
    assert(review.checks.filter((check) => ["local-process-spawn", "local-shell"].includes(check.layer) && check.skipped).length === 2, "review diagnostics executed forbidden process probes");
    assert(review.checks.some((check) => check.layer === "remote-relay" && check.skipped), "stdio/local diagnostics misreported a remote relay");
    assert(review.ok === false, "policy denial was not reflected in diagnostic status");

    const failed = await diagnoseRuntime({
      policy: policyProfile("agent"),
      runtimeDir,
      workspace: runtimeDir,
      runProcess: async () => { throw new Error("spawn failed"); },
      probeShell: async () => ({ code: 1, stdout: "", stderr: "" }),
      managedJobManager: {
        diagnoseStorage: () => ({ ok: false, error_class: "permission_denied" }),
        listResources: () => ({ count: 0, resources: [] }),
      },
      relayStatus: () => ({
        ready: false, network_route: "", network_route_scope: "", outage_active: true, outage_count: 0,
        last_close_category: "", last_close_code: "not-a-number", last_transport_error_class: "",
        last_disconnected_at: "", last_ready_at: "", last_ready_duration_ms: 0, next_reconnect_in_ms: 12,
      }),
      throwIfCancelled() {},
    });
    assert(failed.checks.some((check) => check.layer === "local-process-spawn" && !check.ok), "process failure was not classified");
    const failedRelay = failed.checks.find((check) => check.layer === "remote-relay");
    assert(failedRelay?.outage_active === true && failedRelay.network_route === "unknown"
      && failedRelay.last_close_code === null && failedRelay.next_reconnect_in_ms === 12,
    "degraded relay diagnostics did not normalize missing or invalid fields");
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
}

async function testRuntimeCapabilities() {
  const bootstrapObserver = [];
  const bootstrap = await sessionBootstrap({
    agentContextManager: { sessionBootstrap: async () => ({ instructions: "rules" }) },
    appAutomationManager: { capabilities: () => ({ structured: true }) },
    capabilityObserver: { recordBootstrap: (value) => bootstrapObserver.push(value) },
    policy: policyProfile("full"),
  }, { path: "." }, {});
  assert(bootstrap.local_automation.browser.existing_profile === true, "full bootstrap omitted browser capability");
  assert(bootstrapObserver.length === 1, "bootstrap routing observation was not recorded");

  const reviewBootstrap = await sessionBootstrap({
    agentContextManager: { sessionBootstrap: async () => ({ instructions: "rules" }) },
    appAutomationManager: { capabilities: () => ({ structured: true }) },
    capabilityObserver: { recordBootstrap() {} },
    policy: policyProfile("review"),
  });
  assert(reviewBootstrap.local_automation.browser === null, "review bootstrap advertised full browser authority");

  const resolutions = [];
  const full = await resolveTaskCapabilities({
    agentContextManager: { resolveTaskCapabilities: async () => ({ recommended_tools: ["agent_context"] }) },
    appAutomationManager: { listApplications: async () => ({ applications: [
      { name: "Google Chrome", id: "com.google.Chrome" },
      { name: "Notes", id: "com.example.Notes" },
    ] }) },
    capabilityObserver: { recordResolution: (task, value) => resolutions.push({ task, value }) },
    policy: policyProfile("full"),
  }, { task: "Open Google Chrome and fill a browser form" }, {});
  assert(full.application_matches[0].name === "Google Chrome", "application ranking lost an exact task match");
  assert(full.recommended_tools.includes("operate_local_application"), "application match did not add structured tools");
  assert(full.browser_backend?.existing_profile === true, "full capability resolution omitted existing-profile browser backend");
  assert(resolutions.length === 1, "capability routing observation was not recorded");

  const review = await resolveTaskCapabilities({
    agentContextManager: { resolveTaskCapabilities: async () => ({ recommended_tools: [] }) },
    appAutomationManager: { listApplications: async () => { throw new Error("must not scan"); } },
    capabilityObserver: { recordResolution() {} },
    policy: policyProfile("review"),
  }, { task: "open app" });
  assert(review.application_matches.length === 0 && review.browser_backend === null, "review capability resolution expanded automation authority");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
