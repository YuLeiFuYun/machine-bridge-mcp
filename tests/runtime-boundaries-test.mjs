import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProjectOverview, buildRuntimeInfo } from "../src/local/runtime-reporting.mjs";
import { diagnoseRuntime } from "../src/local/runtime-diagnostics.mjs";
import { classifySystemRouteInterface, inspectSystemNetworkRoute, systemNetworkRouteCheck } from "../src/local/system-network-route.mjs";
import { resolveTaskCapabilities, sessionBootstrap } from "../src/local/runtime-capabilities.mjs";
import { policyProfile } from "../src/local/policy.mjs";
import { openDirectoryIfExists, pathEntryIfExists } from "../src/local/path-inspection.mjs";
import { RuntimeResourceService } from "../src/local/runtime-resource-service.mjs";

await testRuntimeReporting();
await testRuntimeDiagnostics();
await testRuntimeCapabilities();
await testRuntimeResourceService();
await testPathInspectionFailures();
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
      runFixedInternal: async () => ({ code: 0, stdout: "   interface: utun4\n", stderr: "" }),
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
    const routeCheck = shell.checks.find((check) => check.layer === "system-network-route");
    if (process.platform === "darwin") {
      assert(routeCheck?.ok === true && routeCheck.route_class === "tunnel-or-vpn"
        && routeCheck.operating_system_interception === true,
      "runtime diagnostics did not identify a system VPN/TUN default route");
    } else {
      assert(routeCheck?.skipped === true && routeCheck.error_class === "unsupported_platform",
        "non-macOS runtime diagnostics did not skip the macOS-only default-route probe");
    }
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
    assert(classifySystemRouteInterface("en0") === "physical-or-other"
      && classifySystemRouteInterface("utun12") === "tunnel-or-vpn"
      && classifySystemRouteInterface("lo0") === "loopback",
    "system route interface classification drifted");
    const unsupportedRoute = await inspectSystemNetworkRoute({ platform: "win32" });
    assert(unsupportedRoute.supported === false, "unsupported route inspection did not degrade safely");
    const unsupportedRouteCheck = await systemNetworkRouteCheck({ platform: "linux" });
    assert(unsupportedRouteCheck.skipped === true && unsupportedRouteCheck.error_class === "unsupported_platform",
      "unsupported platform route diagnostics did not expose a bounded skipped result");
    const missingRunner = await inspectSystemNetworkRoute({ platform: "darwin" });
    assert(missingRunner.supported === false, "missing fixed-command boundary did not disable route inspection");
    const unavailableRoute = await systemNetworkRouteCheck({
      platform: "darwin",
      runFixedInternal: async () => ({ code: 1, stdout: "", stderr: "unavailable" }),
    });
    assert(unavailableRoute.skipped === true && unavailableRoute.error_class === "unavailable",
      "failed default-route lookup was not represented as an unavailable diagnostic");
    const malformedRoute = await inspectSystemNetworkRoute({
      platform: "darwin",
      runFixedInternal: async () => ({ code: 0, stdout: "route without interface", stderr: "" }),
    });
    assert(malformedRoute.supported === true && malformedRoute.available === false,
      "default-route output without an interface was treated as usable");
    const physicalRoute = await inspectSystemNetworkRoute({
      platform: "darwin",
      runFixedInternal: async (...args) => {
        assert(args[5]?.request === "diagnostic", "route inspection dropped the request cancellation context");
        return { code: 0, stdout: " interface: en0\n", stderr: "" };
      },
      context: { request: "diagnostic" },
    });
    assert(physicalRoute.route_class === "physical-or-other" && physicalRoute.operating_system_interception === false,
      "physical route was classified as operating-system tunnel interception");
    const failedRoute = await systemNetworkRouteCheck({
      platform: "darwin",
      runFixedInternal: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); },
      classifyError: () => "permission_denied",
    });
    assert(failedRoute.skipped === true && failedRoute.error_class === "permission_denied",
      "system route diagnostic leaked or misclassified a fixed-command failure");
    const defaultClassifiedFailure = await systemNetworkRouteCheck({
      platform: "darwin",
      runFixedInternal: async () => { throw new Error("unknown"); },
    });
    assert(defaultClassifiedFailure.error_class === "unavailable",
      "system route diagnostic default error classification drifted");
    assert(classifySystemRouteInterface("") === "unknown"
      && classifySystemRouteInterface("bridge0") === "other",
    "unknown and non-standard route interfaces were not bounded to coarse classes");
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
  assert(full.application_discovery.available === true && full.application_discovery.warning_count === 0,
    "successful application discovery was not represented in capability routing");
  assert(full.recommended_tools.includes("operate_local_application"), "application match did not add structured tools");
  assert(full.browser_backend?.existing_profile === true, "full capability resolution omitted existing-profile browser backend");
  assert(resolutions.length === 1, "capability routing observation was not recorded");

  const degradedFull = await resolveTaskCapabilities({
    agentContextManager: { resolveTaskCapabilities: async () => ({ recommended_tools: [] }) },
    appAutomationManager: { listApplications: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } },
    capabilityObserver: { recordResolution() {} },
    policy: policyProfile("full"),
  }, { task: "open app" });
  assert(degradedFull.application_matches.length === 0
    && degradedFull.application_discovery.available === false
    && degradedFull.application_discovery.error_class === "permission_denied",
  "application discovery failure was silently converted to an empty successful result");

  const review = await resolveTaskCapabilities({
    agentContextManager: { resolveTaskCapabilities: async () => ({ recommended_tools: [] }) },
    appAutomationManager: { listApplications: async () => { throw new Error("must not scan"); } },
    capabilityObserver: { recordResolution() {} },
    policy: policyProfile("review"),
  }, { task: "open app" });
  assert(review.application_matches.length === 0 && review.browser_backend === null, "review capability resolution expanded automation authority");
  assert(review.application_discovery.reason === "policy", "policy-disabled application discovery was reported as an operational failure");
}

async function testRuntimeResourceService() {
  const root = await mkdtemp(join(tmpdir(), "mbm-runtime-resources-"));
  try {
    const textPath = join(root, "text-resource");
    const binaryPath = join(root, "binary-resource");
    await writeFile(textPath, "resource-text", { mode: 0o600 });
    await writeFile(binaryPath, Buffer.from([0xff, 0xfe, 0xfd]), { mode: 0o600 });
    const authorized = [];
    const resources = {
      text: { path: textPath },
      binary: { path: binaryPath },
    };
    const service = new RuntimeResourceService({
      workspace: root,
      currentResources: () => resources,
      authorizeTool: (tool) => authorized.push(tool),
    });
    assert(service.readText("text") === "resource-text", "runtime resource service lost UTF-8 text content");
    assert(service.readBinary("text").size === Buffer.byteLength("resource-text"), "runtime resource service lost binary metadata");
    expectThrow(() => service.readText("binary"), "not valid UTF-8");
    expectThrow(() => service.readBinary("missing"), "unknown local resource");
    await expectReject(() => service.generateSshKey({ name: "generated" }), "resource state is unavailable");
    assert(authorized.join(",") === "generate_ssh_key_resource", "runtime resource service bypassed tool authorization");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testPathInspectionFailures() {
  const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
  assert(await pathEntryIfExists("ignored", async () => { throw missing; }) === null,
    "missing path was not represented as absence");
  assert(await openDirectoryIfExists("ignored", async () => { throw missing; }) === null,
    "missing directory was not represented as absence");

  for (const inspect of [pathEntryIfExists, openDirectoryIfExists]) {
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    let observed;
    try { await inspect("ignored", async () => { throw denied; }); } catch (error) { observed = error; }
    assert(observed === denied, "filesystem permission failure was misclassified as a missing path");
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function expectThrow(operation, expected) {
  try { operation(); } catch (error) {
    assert(String(error?.message || error).includes(expected), `expected ${expected}`);
    return;
  }
  throw new Error(`expected throw containing ${expected}`);
}

async function expectReject(operation, expected) {
  try { await operation(); } catch (error) {
    assert(String(error?.message || error).includes(expected), `expected ${expected}`);
    return;
  }
  throw new Error(`expected rejection containing ${expected}`);
}
