import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FAST_CHECK_TASKS, FULL_CHECK_TASKS, PLATFORM_CHECK_TASKS } from "../../scripts/check-plan.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const readLfSource = (...segments) => readFileSync(join(root, ...segments), "utf8").replace(/\r\n/g, "\n");
const relayContract = JSON.parse(readFileSync(join(root, "src", "shared", "relay-contract.json"), "utf8"));
const cliSource = readFileSync(join(root, "src", "local", "cli.mjs"), "utf8");
if (/not found\|does not exist\|could not find/i.test(cliSource) || !cliSource.includes("if (result.code === 0)")) {
  throw new Error("Worker deletion regained stderr-text-based success classification");
}
const cliActivateSource = readFileSync(join(root, "src", "local", "cli-activate.mjs"), "utf8");
const runtimeActivationSource = readFileSync(join(root, "src", "local", "runtime-activation.mjs"), "utf8");
const activationRecoverySource = readFileSync(join(root, "src", "shared", "activation-recovery.mjs"), "utf8");
for (const required of [
  "recovery?.candidateServiceStarted && candidateRelayVerified && recoverablePostReadySettlement(error)",
  "isActivationRecoveryReason",
  "activationRecovered: true",
  "recoveryReason: activationRecoveryReason(error)",
  "recoveryDetail: activationRecoveryDetail(error)",
  "canonicalActivationRecoveryDetail(activationRecoveryReason(error))",
  "if (settlement?.ok === true) return settlement",
]) {
  if (!runtimeActivationSource.includes(required)) throw new Error(`runtime activation lost verified recovered-success boundary: ${required}`);
}
for (const required of [
  "relay_authentication_failed", "autostart_install_failed", "autostart_start_failed",
  "canonicalActivationRecoveryDetail", "normalizeActivationRecovery",
]) {
  if (!activationRecoverySource.includes(required)) throw new Error(`activation recovery evidence lost canonical privacy boundary: ${required}`);
}
if (activationRecoverySource.includes("error.message") || activationRecoverySource.includes("String(error")) {
  throw new Error("activation recovery evidence regained lower-layer exception text");
}
const nonReplayableSettlementSource = readFileSync(join(root, "src", "local", "process-nonreplayable-settlement.mjs"), "utf8");
if (!nonReplayableSettlementSource.includes('"process failed before spawn"')
    || nonReplayableSettlementSource.includes("boundedMessage(error)")) {
  throw new Error("non-replayable pre-spawn settlement regained lower-layer exception text");
}
for (const required of ["activation_recovered", "activation_recovery_reason", "activation_recovery_detail", "verified candidate-service recovery"]) {
  if (!cliActivateSource.includes(required)) throw new Error(`candidate activation CLI lost recovered-result visibility: ${required}`);
}
if ((cliActivateSource.match(/provisionInitialOwner: false/g) || []).length !== 2
    || !cliSource.includes("provisionInitialOwner = true")
    || !cliSource.includes("args.daemonOnly || provisionInitialOwner === false")) {
  throw new Error("candidate activation must skip first-run owner provisioning while ordinary startup keeps it enabled");
}

const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const packageLock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
if ((packageJson.files || []).some((entry) => {
  const normalized = String(entry).replace(/^\.\//, "").replace(/\/$/, "");
  return normalized === "tests" || normalized.startsWith("tests/");
})) {
  throw new Error("repository verification tests unexpectedly became npm tarball content; update release-impact policy and documentation explicitly before shipping that change");
}
const contributingSource = readFileSync(join(root, "CONTRIBUTING.md"), "utf8");
if (!contributingSource.includes("Repository tests are verification inputs, not npm tarball entries under the current `package.json.files` manifest")) {
  throw new Error("contributor package-impact guidance no longer distinguishes test evidence from npm tarball bytes");
}
const releaseImpactTestSource = readFileSync(join(root, "tests", "release-impact-test.mjs"), "utf8");
if (!releaseImpactTestSource.includes("test-only change outside package files should not require an npm version bump")) {
  throw new Error("release-impact regression lost the test-only non-package case");
}
const npmrcSource = readFileSync(join(root, ".npmrc"), "utf8");
if (!/^engine-strict=true$/m.test(npmrcSource) || !/^save-exact=true$/m.test(npmrcSource)) {
  throw new Error("repository npm configuration must enforce engines and preserve exact dependency pins on future saves");
}
const wranglerConfigSource = readFileSync(join(root, "wrangler.jsonc"), "utf8");
for (const requiredFlag of ["nodejs_compat", "enable_request_signal", "request_signal_passthrough"]) {
  if (!wranglerConfigSource.includes(`"${requiredFlag}"`)) {
    throw new Error(`Worker compatibility contract is missing ${requiredFlag}`);
  }
}
for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
  for (const [name, version] of Object.entries(packageJson[field] || {})) {
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(String(version))) {
      throw new Error(`${field} must pin ${name} to one exact semantic version, received ${version}`);
    }
  }
}
if (Object.hasOwn(packageJson.dependencies || {}, "wrangler") || packageJson.devDependencies?.wrangler !== "4.127.0") {
  throw new Error("Wrangler must remain outside the published production dependency graph and exact in development");
}
if (packageJson.engines?.node !== ">=26.0.0" || packageJson.devEngines?.runtime?.version !== ">=26.0.0"
    || packageJson.devEngines?.runtime?.onFail !== "warn") {
  throw new Error("Node 26 runtime enforcement or metadata-only Dependabot compatibility drifted");
}
const toolchainManifest = JSON.parse(readFileSync(join(root, "src", "local", "wrangler-toolchain", "package.json"), "utf8"));
const toolchainLock = JSON.parse(readFileSync(join(root, "src", "local", "wrangler-toolchain", "package-lock.json"), "utf8"));
if (toolchainManifest.private !== true || toolchainManifest.dependencies?.wrangler !== "4.127.0"
    || toolchainManifest.overrides?.undici !== "7.29.0" || toolchainManifest.overrides?.sharp !== "0.35.3"
    || toolchainLock.packages?.["node_modules/wrangler"]?.version !== "4.127.0"
    || toolchainLock.packages?.["node_modules/undici"]?.version !== "7.29.0"
    || toolchainLock.packages?.["node_modules/sharp"]?.version !== "0.35.3") {
  throw new Error("private Wrangler toolchain manifest or lock lost its exact security contract");
}
const patchedSharpVersion = "0.35.3";
if (packageJson.overrides?.sharp !== patchedSharpVersion) throw new Error("the audited Sharp override is missing or drifted");
if (packageLock.packages?.["node_modules/sharp"]?.version !== patchedSharpVersion) throw new Error("package-lock does not resolve the audited Sharp version");
if (packageJson.allowScripts?.[`sharp@${patchedSharpVersion}`] !== true) throw new Error("the audited Sharp lifecycle-script allowlist entry is missing");
const resolvedWorkerdVersion = packageLock.packages?.["node_modules/workerd"]?.version;
if (!/^1\.\d{8}\.\d+$/.test(String(resolvedWorkerdVersion || ""))) throw new Error("package-lock does not resolve an exact workerd build");
const allowedWorkerdScripts = Object.entries(packageJson.allowScripts || {})
  .filter(([name, allowed]) => name.startsWith("workerd@") && allowed === true)
  .map(([name]) => name);
if (allowedWorkerdScripts.length !== 1 || allowedWorkerdScripts[0] !== `workerd@${resolvedWorkerdVersion}`) {
  throw new Error("the reviewed workerd lifecycle-script allowlist does not exactly match package-lock");
}
if (packageJson.scripts?.["browser-service-worker:test"] !== "node tests/browser-service-worker-test.mjs") throw new Error("browser service-worker behavior test is missing");
if (packageJson.scripts?.["browser-pairing-content:test"] !== "node tests/browser-pairing-content-test.mjs") throw new Error("browser pairing content bootstrap behavior test is missing");
if (packageJson.scripts?.["browser-pairing-launch:test"] !== "node tests/browser-pairing-launch-test.mjs") throw new Error("browser ephemeral pairing launch behavior test is missing");
if (packageJson.scripts?.["browser-cli-pairing:test"] !== "node tests/browser-cli-pairing-test.mjs") throw new Error("browser CLI pairing launch regression test is missing");
if (packageJson.scripts?.["resource-admission:test"] !== "node tests/resource-admission-test.mjs") throw new Error("machine-wide resource admission regression test is missing");
if (packageJson.scripts?.["resource-build-root:test"] !== "node tests/resource-build-root-test.mjs") throw new Error("shared build-root regression test is missing");
if (packageJson.scripts?.["browser-identity:test"] !== "node tests/browser-extension-identity-test.mjs") throw new Error("browser extension identity regression test is missing");
if (packageJson.scripts?.["service-platform:test"] !== "node tests/service-platform-test.mjs") throw new Error("cross-platform service quoting test is missing");
if (packageJson.scripts?.["coverage:test"] !== "node scripts/coverage-check.mjs") throw new Error("critical-module coverage gate is missing");
if (packageJson.scripts?.["check-plan:test"] !== "node tests/check-plan-test.mjs") throw new Error("layered check-plan regression test is missing");
if (packageJson.scripts?.["worker-deployment:test"] !== "node tests/worker-deployment-test.mjs") throw new Error("Worker deployment idempotency/proxy regression test is missing");
if (packageJson.scripts?.["policy-docs:check"] !== "node scripts/generate-policy-reference.mjs --check") throw new Error("generated policy documentation gate is missing");
if (packageJson.scripts?.["markdown:test"] !== "node tests/markdown-test.mjs") throw new Error("shared Markdown helper test is missing");
if (packageJson.scripts?.["project-metadata:test"] !== "node tests/project-metadata-test.mjs") throw new Error("project metadata helper test is missing");
if (packageJson.scripts?.["numbers:test"] !== "node tests/numbers-test.mjs") throw new Error("integer normalization helper test is missing");
if (packageJson.scripts?.["deadline:test"] !== "node tests/monotonic-deadline-test.mjs") throw new Error("monotonic deadline regression test is missing");
if (packageJson.scripts?.["oauth-browser:test"] !== "node tests/oauth-browser-navigation-test.mjs") throw new Error("real-browser OAuth navigation regression test is missing");
if (packageJson.scripts?.["records:test"] !== "node tests/records-test.mjs") throw new Error("plain-record helper test is missing");
if (packageJson.scripts?.["state-inventory:test"] !== "node tests/state-inventory-test.mjs") throw new Error("state inventory regression test is missing");
if (packageJson.scripts?.["state-root-retirement:test"] !== "node tests/state-root-retirement-test.mjs" || !FAST_CHECK_TASKS.includes("state-root-retirement:test")) throw new Error("state-root generation-removal regression is missing from the fast gate");
for (const file of ["generate-worker-types.mjs", "run-worker-dry-run.mjs", "wrangler-command-lifecycle.mjs"]) {
  if (!existsSync(join(root, "scripts", file))) throw new Error(`bounded Wrangler command lifecycle file is missing: ${file}`);
}
if (packageJson.scripts?.["worker:types"] !== "node scripts/generate-worker-types.mjs") throw new Error("generated Worker types are not isolated behind the cross-platform generator");
if (packageJson.scripts?.["worker:dry-run"] !== "node scripts/run-worker-dry-run.mjs") throw new Error("Worker deployment dry-run bypasses the bounded Wrangler lifecycle adapter");
const workerTypesGeneratorSource = readFileSync(join(root, "scripts", "generate-worker-types.mjs"), "utf8");
const workerToolCatalogSource = readFileSync(join(root, "src", "worker", "tool-catalog.ts"), "utf8");
if (workerToolCatalogSource.includes("use process sessions or managed jobs for longer work")
    || !workerToolCatalogSource.includes("split longer browser/application workflows into independently terminal calls")
    || !workerToolCatalogSource.includes("start_process only when interactive stdin or incremental process output is actually required")) {
  throw new Error("Worker configurable-foreground guidance can still route generic long work into process sessions");
}
for (const stale of ["host response/execution budget", "host budget is nearly exhausted", "continue only while the host", "read an active job at most once", "stop polling until a later user turn"]) {
  if (workerToolCatalogSource.includes(stale)) throw new Error(`Worker tool guidance can still trigger speculative or forced hosted handoff: ${stale}`);
}
for (const required of ["HOSTED_CONTINUATION_RULE", "Do not infer or preempt a host/tool deadline from elapsed wall-clock time", "server-side long-poll", "wait_ms=0", "defaultManagedJobReadWaitMs", "maximumManagedJobReadWaitMs", "same MCP call", "cooldown boundary", "Tool schema generation", "workerToolSchemaGeneration"]) {
  if (!workerToolCatalogSource.includes(required)) throw new Error(`Worker tool catalog lost autonomous/paced/schema-freshness guidance: ${required}`);
}
if (workerToolCatalogSource.indexOf("const HOSTED_CONTINUATION_RULE") > workerToolCatalogSource.indexOf("export const workspaceTools")) {
  throw new Error("Worker eager tool-catalog initialization can access hosted continuation guidance before initialization");
}
const workerMcpConfigSource = readFileSync(join(root, "src", "worker", "worker-mcp-config.ts"), "utf8");
const mcpControllerSource = readFileSync(join(root, "src", "worker", "mcp-controller.ts"), "utf8");
const mcpSubscriptionCapacitySource = readFileSync(join(root, "src", "worker", "mcp-subscription-capacity.ts"), "utf8");
const mcpSubscriptionRegistrySource = readFileSync(join(root, "src", "worker", "mcp-subscription-registry.ts"), "utf8");
if (!workerMcpConfigSource.includes("MCP_DISCOVERY_TTL_MS = 0") || !workerMcpConfigSource.includes("MCP_TOOL_LIST_TTL_MS = 0")) {
  throw new Error("Worker discovery/tool contracts again advertise reusable cross-release semantic caches");
}
const managedJobPlanSource = readFileSync(join(root, "src", "local", "managed-job-plan.mjs"), "utf8");
if (!managedJobPlanSource.includes("MAX_MANAGED_JOB_STEP_TIMEOUT_SECONDS = 6 * 60 * 60")
    || !managedJobPlanSource.includes("MAX_MANAGED_JOB_STEP_TIMEOUT_SECONDS,")) {
  throw new Error("managed-job plan lost the six-hour single-step timeout needed for 100+ minute durable work");
}
if (!managedJobPlanSource.includes('import { MANAGED_JOB_ID } from "./managed-job-directory.mjs"')
    || managedJobPlanSource.includes("const MANAGED_JOB_ID =")) {
  throw new Error("managed-job plan duplicated the canonical managed-job ID contract instead of importing it");
}
const managedJobPlanIntegritySource = readFileSync(join(root, "src", "local", "managed-job-plan-integrity.mjs"), "utf8");
for (const required of ["managedJobPlanSha256", "assertManagedJobPlanIntegrity"]) {
  if (!managedJobPlanIntegritySource.includes(required)) throw new Error(`managed-job plan integrity boundary lost ${required}`);
}
for (const relative of ["managed-jobs.mjs", "managed-job-relaunch.mjs", "job-runner.mjs", "managed-job-dependency-retention.mjs"]) {
  const source = readFileSync(join(root, "src", "local", relative), "utf8");
  if (!source.includes("assertManagedJobPlanIntegrity")) {
    throw new Error(`${relative} bypasses the canonical managed-job plan integrity boundary`);
  }
}
const sharedToolCatalogSource = readFileSync(join(root, "src", "shared", "tool-catalog.json"), "utf8");
if ((sharedToolCatalogSource.match(/\"maximum\": 21600/g) || []).length !== 4) {
  throw new Error("stage_job/start_job schemas no longer expose the six-hour step/finally timeout ceiling");
}
if (!sharedToolCatalogSource.includes("A package script name is not implicitly registered")
    || sharedToolCatalogSource.includes("registered command or package script")) {
  throw new Error("run_local_command again implies that arbitrary package scripts are implicit registered commands");
}
if ((sharedToolCatalogSource.match(/multi-step start_job/g) || []).length < 3
    || !sharedToolCatalogSource.includes("nonterminal progress is coalesced for at least thirty seconds by default")
    || !sharedToolCatalogSource.includes("current_step-only churn does not wake a host call by itself")) {
  throw new Error("hosted tool guidance lost multi-command batching or nonterminal progress anti-amplification semantics");
}
if (!workerTypesGeneratorSource.includes("relative(cwd, targetPath)")
    || !workerTypesGeneratorSource.includes("Wrangler types target must remain inside its working directory")
    || workerTypesGeneratorSource.includes('args: ["types", targetPath]')) {
  throw new Error("Worker type generation can leak or escape through an absolute generated-file path");
}
const wranglerLifecycleSource = readFileSync(join(root, "scripts", "wrangler-command-lifecycle.mjs"), "utf8");
for (const required of [
  "completionMarker", 'child.kill("SIGTERM")', 'child.kill("SIGKILL")', "forceSettlementGraceMs",
  "forceSettlementTimer", "completed but did not exit", "timed out after",
]) {
  if (!wranglerLifecycleSource.includes(required)) throw new Error(`bounded Wrangler lifecycle contract regressed: ${required}`);
}
if (wranglerLifecycleSource.includes("killed !== true")) {
  throw new Error("Wrangler lifecycle again treats a kill-request return value as process-settlement proof");
}
if (packageJson.scripts?.["typecheck:local"] !== "tsc -p tsconfig.local.json --noEmit") throw new Error("local JavaScript contract typecheck is missing");
if (!String(packageJson.scripts?.typecheck || "").includes("npm run typecheck:local")) throw new Error("complete typecheck omits local JavaScript contracts");
if (packageJson.scripts?.["tool-docs:check"] !== "node scripts/generate-tool-reference.mjs --check") throw new Error("generated MCP tool documentation gate is missing");
if (packageJson.scripts?.["commit-message:test"] !== "node tests/commit-message-test.mjs") throw new Error("commit-message policy regression test is missing");
if (packageJson.scripts?.["logging-structure:test"] !== "node tests/logging-structure-test.mjs") throw new Error("structured logging regression test is missing");
if (packageJson.scripts?.["sarif-security:test"] !== "node tests/sarif-security-gate-test.mjs") throw new Error("SARIF security gate regression test is missing");
if (packageJson.scripts?.["security-properties:test"] !== "node tests/security-properties-test.js") throw new Error("security property test suite is missing");
if (packageJson.scripts?.["shell:test"] !== "node tests/shell-test.mjs") throw new Error("Wrangler executable boundary regression test is missing");
if (packageJson.scripts?.["runtime-handlers:test"] !== "node tests/runtime-handler-matrix-test.mjs") throw new Error("runtime handler matrix test is missing");
if (packageJson.scripts?.["runtime-boundaries:test"] !== "node tests/runtime-boundaries-test.mjs") throw new Error("extracted runtime boundary test is missing");
if (packageJson.scripts?.["release-publication-guard:test"] !== "node tests/release-publication-guard-test.mjs") throw new Error("GitHub publication ownership test is missing");
if (packageJson.scripts?.["release-oauth-canary:test"] !== "node tests/release-oauth-canary-test.mjs") throw new Error("deployed OAuth canary regression test is missing");
if (packageJson.scripts?.["release:oauth-canary"] !== "node scripts/release-oauth-canary.mjs") throw new Error("deployed OAuth canary release command is missing");
if (packageJson.scripts?.["prerelease:oauth-canary"] || packageJson.scripts?.["postrelease:oauth-canary"]) {
  throw new Error("release OAuth canary must not acquire implicit npm pre/post lifecycle work");
}
if (packageJson.scripts?.["worker-oauth-controller:test"] !== "node tests/worker-oauth-controller-test.mjs") throw new Error("Worker OAuth controller state-machine test is missing");
if (packageJson.scripts?.["cli-entrypoint:test"] !== "node tests/cli-entrypoint-test.mjs") throw new Error("CLI entrypoint regression test is missing");
if (packageJson.scripts?.["cli-service:test"] !== "node tests/cli-service-test.mjs") throw new Error("CLI service adapter regression test is missing");
if (packageJson.scripts?.["service-restart:test"] !== "node tests/service-restart-handoff-test.mjs") throw new Error("service restart/status boundary regression test is missing");
const stateSource = readLfSource("src", "local", "state.mjs");
const daemonProcessSource = readFileSync(join(root, "src", "local", "daemon-process.mjs"), "utf8");
const stateInventorySource = readFileSync(join(root, "src", "local", "state-inventory.mjs"), "utf8");
const stateOwnerLockInventorySource = readFileSync(join(root, "src", "local", "state-owner-lock-inventory.mjs"), "utf8");
const stateOwnedNamespacesSource = readFileSync(join(root, "src", "local", "state-root-owned-namespaces.mjs"), "utf8");
const releaseRuntimeLockSource = readFileSync(join(root, "src", "local", "release-runtime-lock.mjs"), "utf8");
for (const required of ['"toolchains"', '"release-channels"', '"release-tasks"', "currentEntrypointInsideStateRoot", "canonicalizePotentialPath(entry)", "validateOwnedStateNamespaces(canonical)"]) {
  if (!stateSource.includes(required)) throw new Error(`state-root removal lost owned namespace/self-runtime guard: ${required}`);
}
for (const required of ["nodeVersion: process.versions.node", "expectedNodeVersion", "node_version_mismatch", "expectedNodeExecutable", "node_executable_mismatch"]) {
  const source = required === "nodeVersion: process.versions.node" ? stateSource : daemonProcessSource;
  if (!source.includes(required)) throw new Error(`daemon runtime provenance lost Node identity binding: ${required}`);
}
for (const required of ["TOOLCHAIN_DIRECTORY", "TOOLCHAIN_LOCK_TEMP", "ACTIVATION_RECORD", "ACTIVATION_TEMP", "RUNTIME_DIRECTORY", "LEGACY_RELEASE_TASK", '"wrangler-toolchain.lock"', '"activations"', '"runtimes"']) {
  if (!stateOwnedNamespacesSource.includes(required)) throw new Error(`state-root owned namespace validation lost required boundary: ${required}`);
}
for (const required of ['const LOCK_FILE = "release-runtime.lock"', 'const LOCK_PURPOSE = "release-runtime"', "fileName: LOCK_FILE", "purpose: LOCK_PURPOSE", "assertStateMaintenanceAvailable(stateRoot)", "machineServiceControlRoot(options)"]) {
  if (!releaseRuntimeLockSource.includes(required)) throw new Error(`release-runtime lock lost required control-root/maintenance boundary: ${required}`);
}
if (!stateInventorySource.includes("activeOwnerStateLocks(root)")
    || !stateOwnerLockInventorySource.includes('"wrangler-toolchain.lock"')
    || !stateOwnerLockInventorySource.includes('readOwnerStateLock(lockPath, "wrangler-toolchain")')
    || !stateOwnerLockInventorySource.includes('"invalid_or_unreadable_lock"')) {
  throw new Error("state-root destructive inventory lost the private-toolchain owner-lock blocker");
}
if (!cliSource.includes('promptOnFirstRun ? defaultFirstRunWorkspace() : process.cwd()')
    || !cliSource.includes("Workspace folder [${fallback}] (press Enter to use the default): ")
    || !cliSource.includes("ensureWorkspaceDirectory(answer.trim() || fallback)")
    || !stateSource.includes('path.join(home, "MachineBridge")')) {
  throw new Error("Windows first-run workspace prompt/default behavior is missing");
}
if (packageJson.scripts?.["capability-ranking:test"] !== "node tests/capability-ranking-test.mjs") throw new Error("capability ranking regression test is missing");
if (packageJson.scripts?.syntax !== "node scripts/syntax-check.mjs") {
  throw new Error("package syntax check is not using the dynamic repository scanner");
}
if (packageJson.scripts?.lint !== "eslint eslint.config.mjs bin src/local src/shared scripts tests browser-extension .github/scripts") {
  throw new Error("production/test undefined-identifier lint gate is missing or drifted");
}
if (packageJson.scripts?.["lint:test"] !== "node tests/lint-gate-test.mjs") {
  throw new Error("semantic lint configuration regression test is missing");
}
if (packageJson.scripts?.check !== "npm run check:full"
    || packageJson.scripts?.["check:fast"] !== "node scripts/run-checks.mjs fast"
    || packageJson.scripts?.["check:platform"] !== "node scripts/run-checks.mjs platform"
    || packageJson.scripts?.["check:full"] !== "node scripts/run-checks.mjs full") {
  throw new Error("layered fast/full verification entrypoints are missing or drifted");
}
for (const required of ["runtime-boundaries:test", "worker-oauth-controller:test", "shell:test", "lint:test", "lint", "deadline:test", "release-channel:test", "release-candidate-manifest:test", "release-soak:test", "runtime-activation:test", "release-publication-guard:test", "npm-environment:test", "hardened-npm:test", "consumer-package-security:test", "wrangler-toolchain:test"]) {
  if (!FAST_CHECK_TASKS.includes(required)) throw new Error(`fast check plan omits required task: ${required}`);
}
for (const required of ["self-test", "service-platform:test", "full-access:test", "managed-jobs:test"]) {
  if (!PLATFORM_CHECK_TASKS.includes(required)) throw new Error(`platform check plan omits required task: ${required}`);
}
const localSelfTestSource = readLfSource("tests", "local-self-test.mjs");
const managedJobsTestSource = readLfSource("tests", "managed-jobs-test.mjs");
const managedJobDependenciesSource = readLfSource("src", "local", "managed-job-dependencies.mjs");
const workerTypesGeneratorTestSource = readLfSource("tests", "worker-types-generator-test.mjs");
const managedJobResourceHookSource = readLfSource("tests", "fixtures", "managed-job-resource-hook.mjs");
const managedJobResourceFixtureSource = readLfSource("tests", "fixtures", "managed-job-resource-admission-fixture.mjs");
for (const required of ["mbm-resource-cli-coordinator-", "mbm-resource-cli-build-", "resourceCliEnv", "previousResourceRoot", "previousBuildRoot", "delete process.env.AGENT_RESOURCE_COORDINATOR_ROOT", "delete process.env.AGENT_BUILD_ROOT"]) {
  if (!localSelfTestSource.includes(required)) throw new Error(`local resource CLI self-test lost isolated resource roots or environment restoration: ${required}`);
}
if (!cliSource.includes("export function assertNoActiveJobsForUninstall(stateRoot)")
    || !localSelfTestSource.includes("assertNoActiveJobsForUninstall(stateRoot)")
    || localSelfTestSource.includes('[entry, "uninstall", "--state-dir", stateRoot')) {
  throw new Error("local self-test regained a machine-level uninstall side effect instead of testing the uninstall managed-state preflight directly");
}
const uninstallStateRootIndex = cliSource.indexOf("async function uninstallStateRoot({ stateRoot, deleteRemote })");
const uninstallPreflightIndex = cliSource.indexOf("assertNoActiveJobsForUninstall(stateRoot);", uninstallStateRootIndex);
const uninstallAutostartIndex = cliSource.indexOf("const autostartRemoved = await removeAutostartBestEffort(stateRoot);", uninstallStateRootIndex);
if (uninstallStateRootIndex < 0 || uninstallPreflightIndex < uninstallStateRootIndex
    || uninstallAutostartIndex < 0 || uninstallPreflightIndex > uninstallAutostartIndex) {
  throw new Error("uninstall no longer proves managed-job state is safe before mutating machine autostart state");
}
if (!managedJobsTestSource.includes('const runnerDiagnosticRoot = join(root, "runner-diagnostic-jobs")')
    || !managedJobsTestSource.includes("const runnerDiagnosticManager = new ManagedJobManager({")
    || !managedJobsTestSource.includes('policy: { allowWrite: true, execMode: "direct", minimalEnv: true, unrestrictedPaths: true }')
    || !/runnerDiagnosticManager\.stage\(\{\s*name: "bounded runner diagnostics",\s*steps: \[\{ argv: \[process\.execPath, "--version"\]/.test(managedJobsTestSource)
    || !managedJobsTestSource.includes('!Object.hasOwn(trimmedLogInspection.review_plan?.steps?.[0]?.env || {}, "NODE_V8_COVERAGE")')) {
  throw new Error("bounded managed-runner diagnostic fixture regained shared coverage or adaptive host scheduling instead of an isolated deterministic light probe");
}
if (!managedJobsTestSource.includes("const isolateFullEnvStepCoverage = options?.policy?.minimalEnv === false;")
    || !managedJobsTestSource.includes("original(isolateFullEnvStepCoverage ? isolateStepCoverage(plan) : plan, ...rest)")) {
  throw new Error("managed-job test harness again injects Node coverage environment into minimal-env jobs and can distort production resource classification");
}
if (!managedJobsTestSource.includes("runnerSpawnProcess: options.runnerSpawnProcess ?? spawnManagedJobTestRunner")
    || !managedJobsTestSource.includes('["--import", runnerResourceHook, ...args]')
    || !managedJobsTestSource.includes('const runnerResourceHook = new URL("./fixtures/managed-job-resource-hook.mjs", import.meta.url).href;')
    || !managedJobResourceHookSource.includes('specifier === "./resource-admission.mjs" && context.parentURL === runnerUrl')
    || !managedJobResourceFixtureSource.includes("extends ProductionResourceCoordinator")
    || !managedJobResourceFixtureSource.includes("sampleHost: healthyResourceHost")) {
  throw new Error("managed-job integration fixtures lost test-process-only healthy-host injection or broadened its import interception boundary");
}
if (!/name: "old protected dependency result",\s*steps: \[\{ argv: \[process\.execPath, "--version"\]/.test(managedJobsTestSource)) {
  throw new Error("dependency-retention fail-closed setup regained adaptive business work instead of a deterministic light probe");
}
if (managedJobsTestSource.includes("manager.read({ job_id: orphanUpstream.job_id })")
    || !managedJobsTestSource.includes("orphanResult.result?.dependency_failure?.dependency_job_id === orphanUpstream.job_id")
    || !managedJobsTestSource.includes('orphanResult.result?.dependency_failure?.dependency_status === "failed"')
    || !managedJobsTestSource.includes('orphanResult.result?.dependency_failure?.dependency_error_class === "dependency_failed"')) {
  throw new Error("same-daemon dependency recovery fixture no longer proves autonomous upstream recovery through the downstream dependency witness");
}
if (!managedJobDependenciesSource.includes("export const DEPENDENCY_STATE_READ_RECOVERY_GRACE_MS = 45_000")
    || !managedJobDependenciesSource.includes('new Set(["identity_changed", "permission_denied", "resource_unavailable"])')
    || !managedJobsTestSource.includes("testManagedJobDependencyReadRecoveryPolicy")
    || !managedJobsTestSource.includes('persistentFailure?.details?.cause_class === "permission_denied"')) {
  throw new Error("managed-job dependency wait lost its bounded transient Windows state-read recovery contract");
}
if (!workerTypesGeneratorTestSource.includes("maxRetries: 5")
    || !workerTypesGeneratorTestSource.includes("retryDelay: 50")) {
  throw new Error("Wrangler lifecycle fixture cleanup lost bounded retries for transient Windows filesystem locks");
}
for (const required of ["install:test", "oauth-browser:test", "coverage:test", "worker:integration-test", "promotion-digest:test", "published-release:test"]) {
  if (!FULL_CHECK_TASKS.includes(required)) throw new Error(`full check plan omits required task: ${required}`);
}
if (packageJson.scripts?.["release:acceptance:test"] !== "node tests/release-acceptance-test.mjs") throw new Error("local release acceptance regression test is missing");
for (const [name, command] of Object.entries({
  "release-channel:test": "node tests/release-channel-test.mjs",
  "release-candidate-manifest:test": "node tests/release-candidate-manifest-test.mjs",
  "promotion-digest:test": "node tests/promotion-digest-test.mjs",
  "prerelease-activation:test": "node tests/prerelease-activation-test.mjs",
  "release-soak:test": "node tests/release-soak-test.mjs",
  "published-release:test": "node tests/published-release-test.mjs",
  "npm-publication-policy:test": "node tests/npm-publication-policy-test.mjs",
  "publish-npm:test": "node tests/publish-npm-test.mjs",
  "runtime-activation:test": "node tests/runtime-activation-test.mjs",
  "candidate-runtime-store:test": "node tests/candidate-runtime-store-test.mjs",
  "device-key-id-stability:test": "node tests/device-key-id-stability-test.mjs",
})) {
  if (packageJson.scripts?.[name] !== command) throw new Error(`release state-machine test is missing or drifted: ${name}`);
}
for (const [name, command] of Object.entries({
  "release:candidate:activate": "node scripts/start-release-candidate.mjs --activate-service",
  "prerelease:release": "node scripts/github-release.mjs --publish-prerelease",
  "prerelease:publish": "node scripts/publish-npm.mjs prerelease",
  "prerelease:install": "node scripts/install-published-prerelease.mjs",
  "prerelease:soak:accept": "node scripts/release-soak.mjs --record",
  "release:soak:verify": "node scripts/release-soak.mjs --verify",
  "stable:publish": "node scripts/publish-npm.mjs stable",
})) {
  if (packageJson.scripts?.[name] !== command) throw new Error(`release channel command is missing or drifted: ${name}`);
}
const releaseSoakSource = readFileSync(join(root, "scripts", "release-soak.mjs"), "utf8");
for (const required of ["createHardenedNpmSession", "readPublishedWithHardenedNpm", "session.dispose()", "await recordCurrentPrereleaseSoak", "expectedArtifactSha256: acceptance.artifactSha256"]) {
  if (!releaseSoakSource.includes(required)) throw new Error(`release soak registry verification lost hardened npm boundary: ${required}`);
}
if (packageJson.scripts?.prepack !== "npm run version:check && npm run privacy:check && npm run release-impact:check") {
  throw new Error("prepack must remain a non-mutating version/privacy/release-impact verification only");
}
for (const lifecycle of ["prepare", "postpack", "prepublish", "publish", "postpublish"]) {
  if (Object.hasOwn(packageJson.scripts || {}, lifecycle)) {
    throw new Error(`package lifecycle ${lifecycle} is incompatible with exact accepted-tarball publication`);
  }
}
if (packageJson.scripts?.["release:candidate"] !== "node scripts/local-release-acceptance.mjs --prepare") throw new Error("release candidate command is missing or bypasses exact candidate preparation");
const verificationStateSource = readFileSync(join(root, "scripts", "verification-state.mjs"), "utf8");
const runChecksSource = readFileSync(join(root, "scripts", "run-checks.mjs"), "utf8");
const localReleaseAcceptanceSource = readFileSync(join(root, "scripts", "local-release-acceptance.mjs"), "utf8");
for (const required of ["captureVerificationRunGeneration", "captureVerifiedSourceGeneration", "clearFullVerificationReceipt", "writeFullVerificationReceipt"]) {
  if (!runChecksSource.includes(required)) throw new Error(`full verification runner lost candidate-receipt boundary: ${required}`);
}
for (const required of ["assertFreshFullVerificationReceipt", "full verification receipt", "run npm run check:full"]) {
  if (!verificationStateSource.includes(required) && !localReleaseAcceptanceSource.includes(required)) {
    throw new Error(`release candidate lost exact-tree full-verification receipt contract: ${required}`);
  }
}
if (!localReleaseAcceptanceSource.includes("assertFreshFullVerificationReceipt(root)")) throw new Error("candidate preparation no longer consumes the frozen-tree full verification receipt");
if (packageJson.scripts?.["release:candidate:start"] !== "node scripts/start-release-candidate.mjs") throw new Error("isolated candidate startup command is missing");
const coverageRunnerSource = readFileSync(join(root, "scripts", "coverage-check.mjs"), "utf8");
for (const required of ['"tests/prerelease-activation-test.mjs"', '"src/shared/activation-recovery.mjs"']) {
  if (!coverageRunnerSource.includes(required)) throw new Error(`critical release recovery coverage lost boundary: ${required}`);
}
if (!coverageRunnerSource.includes("maxRetries") || !coverageRunnerSource.includes("retryDelay")) {
  throw new Error("coverage temporary-directory cleanup lost its concurrent-writer retry boundary");
}
for (const fixture of ["tests/secure-file-test.mjs", "tests/worker-secret-file-test.mjs", "tests/atomic-fs-test.mjs", "tests/state-root-retirement-test.mjs"]) {
  if (!coverageRunnerSource.includes(fixture)) throw new Error(`critical filesystem coverage lost direct fault fixture: ${fixture}`);
}
if (!coverageRunnerSource.includes('"src/local/state-root-retirement.mjs"')) throw new Error("critical state-root generation-removal coverage threshold is missing");
for (const fixture of [
  "tests/process-nonreplayable-test.mjs", "tests/browser-bridge-test.mjs", "tests/browser-request-settlement-test.mjs",
  "tests/browser-operation-service-test.mjs", "tests/browser-computer-observation-test.mjs", "tests/computer-use-test.mjs", "tests/computer-use-result-budget-test.mjs",
]) {
  if (!coverageRunnerSource.includes(fixture)) throw new Error(`critical Computer Use settlement coverage lost direct fixture: ${fixture}`);
}
for (const threshold of [
  '"src/local/process-nonreplayable-settlement.mjs"',
  '"src/local/browser-request-settlement.mjs"',
  '"src/local/computer-use-result-budget.mjs"',
]) {
  if (!coverageRunnerSource.includes(threshold)) throw new Error(`critical Computer Use settlement coverage lost threshold: ${threshold}`);
}
const stateRootRetirementSource = readFileSync(join(root, "src", "local", "state-root-retirement.mjs"), "utf8");
for (const forbidden of ["restoreRetiredRoot", "renameSync(retired, root)", "could not be restored"]) {
  if (stateRootRetirementSource.includes(forbidden)) throw new Error(`state-root retirement regained unsafe pathname rollback: ${forbidden}`);
}
for (const required of ["pinDirectoryGeneration", "O_NOFOLLOW", "O_DIRECTORY", "fstatSync", "sameFilesystemIdentity(expectedIdentity, identity)", "verified retired state root"]) {
  if (!stateRootRetirementSource.includes(required)) throw new Error(`state-root retirement lost POSIX descriptor generation pin: ${required}`);
}
for (const fixture of ["tests/coverage-range-merge-test.mjs", "tests/coverage-generation-test.mjs"]) {
  if (!coverageRunnerSource.includes(fixture)) throw new Error(`critical coverage evidence lost self-test fixture: ${fixture}`);
}
for (const required of ["captureCoverageGeneration", "generationBefore", "generationAfter", "mergeFunctionExecutions"]) {
  if (!coverageRunnerSource.includes(required)) throw new Error(`critical coverage evidence lost generation/range contract: ${required}`);
}
for (const fixture of ["tests/resource-admission-test.mjs", "tests/resource-build-root-test.mjs"]) {
  if (!coverageRunnerSource.includes(fixture)) throw new Error(`critical resource coverage lost direct scheduler fixture: ${fixture}`);
}
for (const threshold of [
  '"src/local/resource-admission.mjs"', '"src/local/resource-admission-policy.mjs"',
  '"src/local/resource-waiters.mjs"', '"src/local/resource-cargo-concurrency.mjs"', '"src/local/resource-cmake-concurrency.mjs"', '"src/local/resource-go-concurrency.mjs"', '"src/local/resource-gradle-concurrency.mjs"', '"src/local/resource-swift-concurrency.mjs"', '"src/local/resource-xcode-concurrency.mjs"', '"src/local/resource-xcode-command.mjs"', '"src/local/resource-xcode-non-build.mjs"', '"src/local/resource-make-concurrency.mjs"', '"src/local/resource-ninja-command-concurrency.mjs"', '"src/local/resource-ninja-concurrency.mjs"', '"src/local/resource-command-profile.mjs"', '"src/local/resource-foreground-wait.mjs"',
  '"src/local/resource-command-concurrency.mjs"', '"src/local/resource-maven-concurrency.mjs"', '"src/local/resource-pytest-concurrency.mjs"', '"src/local/resource-elastic-memory.mjs"', '"src/local/resource-elastic-request.mjs"',
  '"src/local/npm-cli.mjs"', '"src/local/resource-light-command.mjs"', '"src/local/resource-release-control-classification.mjs"', '"src/local/resource-release-control-executable.mjs"', '"src/local/resource-release-control-workspace.mjs"', '"src/local/resource-script-classification.mjs"', '"src/local/resource-host-cache.mjs"',
  '"src/local/resource-host-darwin.mjs"', '"src/local/resource-host-linux.mjs"', '"src/local/resource-wait.mjs"',
  '"src/local/resource-lease-accounting.mjs"', '"src/local/resource-coordinator-accounting.mjs"',
  '"src/local/resource-probe-command.mjs"', '"src/local/resource-process-ancestry.mjs"',
  '"src/local/resource-process-ancestry-cache.mjs"', '"src/local/resource-process-priority.mjs"',
  '"src/local/resource-project-key.mjs"',
  '"src/local/resource-request-contract.mjs"',
]) {
  if (!coverageRunnerSource.includes(threshold)) throw new Error(`critical resource coverage lost scheduler threshold: ${threshold}`);
}
for (const threshold of [
  '"src/worker/daemon-ready-waiters.ts"', '"src/worker/daemon-recovery-budget.ts"',
]) {
  if (!coverageRunnerSource.includes(threshold)) throw new Error(`critical Worker recovery coverage lost threshold: ${threshold}`);
}
const resourceReleaseControlSource = readFileSync(join(root, "src", "local", "resource-release-control-classification.mjs"), "utf8");
const resourceReleaseExecutableSource = readFileSync(join(root, "src", "local", "resource-release-control-executable.mjs"), "utf8");
const resourceReleaseWorkspaceSource = readFileSync(join(root, "src", "local", "resource-release-control-workspace.mjs"), "utf8");
const resourceCommandProfileSource = readFileSync(join(root, "src", "local", "resource-command-profile.mjs"), "utf8");
const resourceProcessAdmissionSource = readFileSync(join(root, "src", "local", "resource-process-admission.mjs"), "utf8");
const resourceAdmissionTestSource = readFileSync(join(root, "tests", "resource-admission-test.mjs"), "utf8");
const releaseControlCanarySource = readFileSync(join(root, "scripts", "release-oauth-canary.mjs"), "utf8");
const npmCliSource = readFileSync(join(root, "src", "local", "npm-cli.mjs"), "utf8");
for (const required of ["NODE_TARGET_NAMES", "CANARY_ENTRY_NAME", "CANARY_FLAG", "releaseControlCommandIsLight", "values.length !== 2", "path.isAbsolute(entry)", "path.basename(entry)", '"node.exe"']) {
  if (!resourceReleaseControlSource.includes(required)) throw new Error(`release OAuth canary lost exact activated-runtime direct-Node classification: ${required}`);
}
for (const required of ["RELEASE_CONTROL_UNSAFE_ENVIRONMENT_KEYS", "releaseControlEnvironmentIsTrusted", "process.execPath", "resolveInvokedExecutable", "path.win32", "path.posix", "environment?.PATH", "fsConstants.X_OK", "if (result) return result", "samePath", '"NODE_OPTIONS"', '"NODE_DEBUG"', '"NODE_PRESERVE_SYMLINKS"', '"NODE_TLS_REJECT_UNAUTHORIZED"', '"SSLKEYLOGFILE"', '"UV_THREADPOOL_SIZE"', '"LD_PRELOAD"', '"DYLD_INSERT_LIBRARIES"']) {
  if (!resourceReleaseExecutableSource.includes(required)) throw new Error(`release OAuth canary lost runtime-Node executable/environment proof: ${required}`);
}
for (const required of ["packageName", "packageVersion", "packageRoot", "CANARY_ENTRY", "readOptionalRegularUtf8", "target === runtime", "releaseControlWorkspaceForCommand", "releaseControlCommandIsLight", "releaseControlExecutableIsTrusted", "releaseControlRuntimeEntrypointMatches", "realpath(String(entry", "realpath(join(packageRoot, CANARY_ENTRY))"]) {
  if (!resourceReleaseWorkspaceSource.includes(required)) throw new Error(`release OAuth canary lost activated-runtime code identity or workspace binding: ${required}`);
}
for (const required of ["nodeExecutable", "allowLifecycleNpmCli", "allowFallbackLocations", "npm-cli.js", "realpathSync", "statSync"]) {
  if (!npmCliSource.includes(required)) throw new Error(`release OAuth canary lost bounded npm CLI resolution: ${required}`);
}
if (!releaseControlCanarySource.includes('from "../src/local/npm-cli.mjs"')
    || !releaseControlCanarySource.includes('from "../src/local/resource-release-control-executable.mjs"')
    || !releaseControlCanarySource.includes("releaseControlEnvironmentIsTrusted(process.env)")
    || !releaseControlCanarySource.includes("const canaryArgs = process.argv.slice(2)")
    || !releaseControlCanarySource.includes("canaryArgs.length !== 1")
    || !releaseControlCanarySource.includes("canaryArgs[0] !== CANARY_FLAG")
    || !releaseControlCanarySource.includes("process.execArgv.length !== 0")
    || !releaseControlCanarySource.includes("refuses Node CLI startup options")
    || !releaseControlCanarySource.includes("const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), \"..\")")
    || !releaseControlCanarySource.includes("const root = resolve(process.cwd())")
    || !releaseControlCanarySource.includes("runtime package.json")
    || !releaseControlCanarySource.includes("source package identity does not match the activated runtime package")
    || !releaseControlCanarySource.includes("assertPrereleaseActivationRuntimeRoot(activation, runtimeRoot)")
    || !releaseControlCanarySource.includes("inspectWorkspaceDaemon(state")
    || !releaseControlCanarySource.includes('expectedEntryScript: join(runtimeRoot, "bin", "machine-mcp.mjs")')
    || !releaseControlCanarySource.includes("expectedNodeExecutable: process.execPath")
    || !releaseControlCanarySource.includes("expectedNodeVersion: process.versions.node")
    || !releaseControlCanarySource.includes("daemon.verified_service_daemon")
    || !releaseControlCanarySource.includes("daemon.startup_readiness_verified")
    || !releaseControlCanarySource.includes("allowLifecycleNpmCli: false")
    || !releaseControlCanarySource.includes("allowFallbackLocations: false")
    || releaseControlCanarySource.includes("process.env.npm_execpath")
    || releaseControlCanarySource.includes("argumentValue(")
    || releaseControlCanarySource.includes('"--state-dir"')
    || releaseControlCanarySource.includes('"--workspace"')) {
  throw new Error("release OAuth canary regained workspace-code, npm-lifecycle, or unsafe-process-environment dependence");
}
const canaryDaemonIdentityCheck = releaseControlCanarySource.indexOf("inspectWorkspaceDaemon(state");
const canaryActivationCheck = releaseControlCanarySource.indexOf("verifyPrereleaseActivation(manifest, stateRoot)");
const canaryPromotionDigestCheck = releaseControlCanarySource.indexOf("computePromotionContentDigest(root, { npmCli })");
if ([canaryDaemonIdentityCheck, canaryActivationCheck, canaryPromotionDigestCheck].some((value) => value < 0)
    || canaryDaemonIdentityCheck > canaryPromotionDigestCheck
    || canaryActivationCheck > canaryPromotionDigestCheck) {
  throw new Error("release OAuth canary must prove live daemon/activation identity before package-digest work");
}
if (!resourceCommandProfileSource.includes("releaseControlCommandIsLight")
    || !resourceCommandProfileSource.includes("options.releaseControlWorkspace === true")
    || !resourceProcessAdmissionSource.includes("await releaseControlWorkspaceForCommand(command, args, options.cwd, environment)")
    || !resourceAdmissionTestSource.includes("runtimeReleaseCanaryEntry")
    || !resourceAdmissionTestSource.includes("directReleaseCanaryArgs")
    || !resourceAdmissionTestSource.includes("workspace-relative canary entrypoint")
    || !resourceAdmissionTestSource.includes("non-runtime canary path received release-control eligibility")
    || !resourceAdmissionTestSource.includes("shadowedEnvironment")
    || !resourceAdmissionTestSource.includes('"NODE_OPTIONS"')
    || !resourceAdmissionTestSource.includes('"NODE_DEBUG"')
    || !resourceAdmissionTestSource.includes('"NODE_PRESERVE_SYMLINKS"')
    || !resourceAdmissionTestSource.includes('"NODE_TLS_REJECT_UNAUTHORIZED"')
    || !resourceAdmissionTestSource.includes('"SSLKEYLOGFILE"')
    || !resourceAdmissionTestSource.includes('"LD_PRELOAD"')
    || !resourceAdmissionTestSource.includes("winOptions")
    || !resourceAdmissionTestSource.includes("npm lifecycle invocation regained the release-control exception")) {
  throw new Error("release OAuth canary light profile lost its narrow direct-Node negative-regression boundary");
}
const agentContextTestSource = readFileSync(join(root, "tests", "agent-context-test.mjs"), "utf8");
if (!agentContextTestSource.includes('resourceCoordinatorRoot: join(root, "resource-coordinator")')
    || !agentContextTestSource.includes("resourceCoordinatorOptions: { sampleHost: healthyResourceHost }")
    || !agentContextTestSource.includes("processResourceWaitMs: 10_000")
    || agentContextTestSource.includes("processResourceWaitMs: 5 * 60_000")) {
  throw new Error("agent-context coverage fixture lost its isolated, short-bounded resource admission contract");
}
const fullAccessSource = readFileSync(join(root, "src", "local", "full-access-test.mjs"), "utf8");
if (!fullAccessSource.includes('resourceCoordinatorRoot: join(root, "resource-coordinator")')
    || !readFileSync(join(root, "tests", "full-access-test.mjs"), "utf8").includes("resourceCoordinatorOptions: { sampleHost: healthyResourceHost }")
    || !fullAccessSource.includes("processResourceWaitMs: FULL_ACCESS_RESOURCE_WAIT_MS")
    || !fullAccessSource.includes("const FULL_ACCESS_RESOURCE_WAIT_MS = 10_000")
    || fullAccessSource.includes("const FULL_ACCESS_RESOURCE_WAIT_MS = 5 * 60_000")) {
  throw new Error("full-access diagnostic lost its isolated, short-bounded process resource admission contract");
}
const runtimeProcessRoutingSource = readFileSync(join(root, "src", "local", "runtime-process-routing.mjs"), "utf8");
if (!runtimeProcessRoutingSource.includes("runRuntimeExecCommand(runtime, args, context = {})")
    || runtimeProcessRoutingSource.includes("legacyCall")
    || runtimeProcessRoutingSource.includes("timeoutOrContext")
    || !fullAccessSource.includes("runtime.execCommand({ command: shellCommand, timeout_seconds: 10 })")) {
  throw new Error("runtime exec_command regained the obsolete string/timeout overload instead of the public argument-record contract");
}
const runtimeSelfTestSource = readFileSync(join(root, "tests", "runtime-self-test.mjs"), "utf8");
if (!runtimeSelfTestSource.includes("const SELF_TEST_RESOURCE_WAIT_MS = 10_000")
    || !runtimeSelfTestSource.includes("resourceCoordinatorOptions: { sampleHost: healthyResourceHost }")
    || runtimeSelfTestSource.includes("const SELF_TEST_RESOURCE_WAIT_MS = 5 * 60_000")
    || !localSelfTestSource.includes("const RESOURCE_CLI_SELF_TEST_TIMEOUT_MS = 5 * 60_000")
    || !localSelfTestSource.includes("waitForSelfTestJob(manager, jobId, deadline, label)")
    || !localSelfTestSource.includes('[process.execPath, "--version"]')
    || localSelfTestSource.includes("CLI_FIXTURE_WAIT_ATTEMPTS")
    || !localSelfTestSource.includes("function waitForChildExit(child, timeoutMs = DAEMON_FIXTURE_TIMEOUT_MS)")
    || !localSelfTestSource.includes('child.once("exit", onExit);\n    if (child.exitCode !== null || child.signalCode !== null) onExit();')
    || !localSelfTestSource.includes("local self-test phase started:")
    || !localSelfTestSource.includes("local self-test phase completed:")) {
  throw new Error("runtime/local self-test lost deterministic host-pressure isolation, child-exit bounds, or phase observability");
}
if (!fullAccessSource.includes('from "./managed-job-terminal.mjs"') || fullAccessSource.includes("TERMINAL_JOB_STATES")) {
  throw new Error("full-access diagnostic regained a divergent managed-job terminal-state enum");
}
const checkRunnerSource = readFileSync(join(root, "scripts", "check-runner.mjs"), "utf8");
for (const required of ["SPARSE_PROGRESS_TASKS", "local self-test phase started:", "local self-test phase completed:", "sparseLineForwarder"]) {
  if (!checkRunnerSource.includes(required)) throw new Error(`check runner lost sparse self-test phase observability: ${required}`);
}
const checkEntrypointSource = readFileSync(join(root, "scripts", "run-checks.mjs"), "utf8");
const verificationIdleSleepGuardSource = readFileSync(join(root, "scripts", "verification-idle-sleep-guard.mjs"), "utf8");
const macosIdleSleepAssertionSource = readFileSync(join(root, "src", "local", "macos-idle-sleep-assertion.mjs"), "utf8");
const remoteActivityIdleSleepGuardSource = readFileSync(join(root, "src", "local", "remote-activity-idle-sleep-guard.mjs"), "utf8");
const processSessionRemoteActivitySource = readFileSync(join(root, "src", "local", "process-session-remote-activity.mjs"), "utf8");
const processSessionsSource = readFileSync(join(root, "src", "local", "process-sessions.mjs"), "utf8");
const managedJobRunnerSource = readFileSync(join(root, "src", "local", "job-runner.mjs"), "utf8");
const managedJobsManagerSource = readFileSync(join(root, "src", "local", "managed-jobs.mjs"), "utf8");
const managedJobRelaunchSource = readFileSync(join(root, "src", "local", "managed-job-relaunch.mjs"), "utf8");
const managedJobActiveChildSource = readFileSync(join(root, "src", "local", "managed-job-active-child.mjs"), "utf8");
const managedJobRunnerExitRecoverySource = readFileSync(join(root, "src", "local", "managed-job-runner-exit-recovery.mjs"), "utf8");
const atomicFsSource = readFileSync(join(root, "src", "local", "atomic-fs.mjs"), "utf8");
const managedJobTerminalMaintenanceSource = readFileSync(join(root, "src", "local", "managed-job-terminal-maintenance.mjs"), "utf8");
const managedJobListingSource = readFileSync(join(root, "src", "local", "managed-job-listing.mjs"), "utf8");
const managedJobRecoveryListingSource = readFileSync(join(root, "src", "local", "managed-job-recovery-listing.mjs"), "utf8");
const managedJobTransientRecoverySource = readFileSync(join(root, "src", "local", "managed-job-transient-recovery.mjs"), "utf8");
const runtimeSource = readFileSync(join(root, "src", "local", "runtime.mjs"), "utf8");
const runtimeRelayControlSource = readFileSync(join(root, "src", "local", "runtime-relay-control.mjs"), "utf8");
const runtimeRelayAcknowledgementsSource = readFileSync(join(root, "src", "local", "runtime-relay-acknowledgements.mjs"), "utf8");
const runtimeRelayShutdownDrainSource = readFileSync(join(root, "src", "local", "runtime-relay-shutdown-drain.mjs"), "utf8");
const workerDaemonRegistrySource = readFileSync(join(root, "src", "worker", "daemon-registry.ts"), "utf8");
const workerDaemonReadyMessagesSource = readFileSync(join(root, "src", "worker", "daemon-ready-messages.ts"), "utf8");
const workerDaemonPlannedDrainSource = readFileSync(join(root, "src", "worker", "daemon-planned-drain.ts"), "utf8");
const workerToolRecoverySource = readFileSync(join(root, "src", "worker", "tool-call-recovery.ts"), "utf8");
const workerContinuityEvidenceSource = readFileSync(join(root, "src", "worker", "worker-continuity-evidence.ts"), "utf8");
const workerSocketDisconnectEvidenceSource = readFileSync(join(root, "src", "worker", "worker-socket-disconnect-evidence.ts"), "utf8");
const workerContinuityPrivacySource = `${workerContinuityEvidenceSource}\n${workerSocketDisconnectEvidenceSource}`;
const workerServerInfoContinuitySource = readFileSync(join(root, "src", "worker", "server-info.ts"), "utf8");
const workerIndexContinuitySource = readFileSync(join(root, "src", "worker", "index.ts"), "utf8");
const toolExecutorSource = readFileSync(join(root, "src", "local", "tool-executor.mjs"), "utf8");
const runtimeDiagnosticStateSource = readFileSync(join(root, "src", "local", "runtime-diagnostic-state.mjs"), "utf8");
const checkRunnerTestSource = readFileSync(join(root, "tests", "check-runner-test.mjs"), "utf8");
const verificationGenerationGuardSource = readFileSync(join(root, "scripts", "verification-generation-guard.mjs"), "utf8");
if (!managedJobRunnerSource.includes("const resourceCoordinator = new ResourceCoordinator();")
    || managedJobRunnerSource.includes("healthyResourceHost")
    || managedJobRunnerSource.includes("runnerSpawnProcess")
    || !managedJobsManagerSource.includes("runnerSpawnProcess = null")
    || !managedJobsManagerSource.includes("this.runnerSpawnProcess = runnerSpawnProcess")
    || !managedJobRelaunchSource.includes("runnerSpawnProcess")
    || runtimeSource.includes("runnerSpawnProcess:")) {
  throw new Error("managed-job test runner injection escaped its in-process constructor seam or altered the production runner resource coordinator");
}
if (!managedJobRelaunchSource.includes("removePathSync")
    || !atomicFsSource.includes('"EACCES", "EBUSY", "EPERM", "ENOTEMPTY"')
    || !managedJobRunnerExitRecoverySource.includes("RETRYABLE_ERROR_CLASSES")
    || !managedJobRunnerExitRecoverySource.includes("retry_scheduled: retryScheduled")) {
  throw new Error("managed-job runner recovery lost bounded Windows filesystem-contention retries");
}
const plannedDrainIndex = runtimeSource.indexOf("await this.relayShutdownDrain?.begin(this.activeRelayCalls.size);");
const relayStopIndex = runtimeSource.indexOf("this.relay?.stop();");
if (plannedDrainIndex < 0 || relayStopIndex <= plannedDrainIndex
    || !runtimeRelayShutdownDrainSource.includes('type: "daemon_draining"')
    || !runtimeRelayControlSource.includes("handleRuntimeRelayAcknowledgement")
    || !runtimeRelayAcknowledgementsSource.includes('message.type !== "daemon_draining_ack"')
    || !runtimeRelayAcknowledgementsSource.includes("handleRuntimeRelayShutdownAck")
    || !workerDaemonReadyMessagesSource.includes('body.type === "daemon_draining"')
    || !workerDaemonReadyMessagesSource.includes("settleDaemonPlannedDrain")
    || !workerDaemonRegistrySource.includes("private readonly draining = new WeakSet<DaemonChannel>()")
    || !workerDaemonRegistrySource.includes("selected.filter((channel) => !this.isDraining(channel))")
    || !workerDaemonRegistrySource.includes("socket.serializeAttachment({ ...attachment, draining: true }")
    || !workerDaemonRegistrySource.includes("?.draining === true")
    || !workerDaemonPlannedDrainSource.includes("input.beginDrain(input.channel)")
    || !workerDaemonPlannedDrainSource.includes("dispatchedDaemonPlannedDrainError(record.recovery)")
    || !workerDaemonPlannedDrainSource.includes('type: "daemon_draining_ack"')
    || !workerToolRecoverySource.includes('name === "read_job"')
    || !workerToolRecoverySource.includes('mode: "read_same_job"')
    || !workerToolRecoverySource.includes('action: "retry_read_job_with_same_job_id"')) {
  throw new Error("planned daemon shutdown lost structured Worker drain settlement or same-job read recovery");
}
if (!workerContinuityEvidenceSource.includes('const KEY = "worker-continuity-evidence"')
    || !workerContinuityEvidenceSource.includes("const SCHEMA_VERSION = 2")
    || !workerContinuityEvidenceSource.includes("storage.transaction")
    || !workerContinuityEvidenceSource.includes("last_planned_drain_at")
    || !workerContinuityEvidenceSource.includes("last_socket_disconnect")
    || !workerContinuityEvidenceSource.includes("ready_socket_disconnects")
    || !workerContinuityEvidenceSource.includes("unplanned_ready_socket_disconnects")
    || !workerContinuityEvidenceSource.includes("last_ready_socket_disconnect")
    || !workerContinuityEvidenceSource.includes("last_request_abort_at")
    || !workerContinuityEvidenceSource.includes("last_stream_cancel_control_at")
    || !workerSocketDisconnectEvidenceSource.includes('role: "candidate" | "probing" | "daemon" | null')
    || !workerSocketDisconnectEvidenceSource.includes("was_ready: boolean")
    || !workerSocketDisconnectEvidenceSource.includes("connected_at: string | null")
    || !workerDaemonPlannedDrainSource.includes("recordWorkerPlannedDrain")
    || !workerIndexContinuitySource.includes("recordWorkerSocketDisconnect")
    || !workerIndexContinuitySource.includes("if (cleanup.first) await recordWorkerSocketDisconnect")
    || !workerIndexContinuitySource.includes("recordWorkerClientCancellation")
    || !workerServerInfoContinuitySource.includes("continuity_evidence: input.continuityEvidence")
    || ["account_id", "client_id", "call_id", "tool_name", "arguments", "endpoint", "close_reason", "error_text", "connection_id", "instance_id"].some((field) => workerContinuityPrivacySource.includes(field))) {
  throw new Error("Worker durable continuity evidence lost its transactional privacy-bounded causal summary contract");
}
if (!managedJobListingSource.includes("durable_terminal: durableTerminal")
    || !managedJobListingSource.includes("transient_terminal: transientTerminal")
    || !managedJobListingSource.includes('from "./managed-job-recovery-listing.mjs"')
    || !managedJobListingSource.includes("recent_process_recovery: recentProcessRecovery")
    || !managedJobRecoveryListingSource.includes('return retentionClass === "transient_process" ? 4 : 3')
    || !managedJobRecoveryListingSource.includes("TRANSIENT_PROCESS_RECOVERY_SLOTS")
    || !managedJobRecoveryListingSource.includes("transientProcessWithinRecoveryGrace")
    || !managedJobRecoveryListingSource.includes("Number(right.recoveryPending === true)")
    || !managedJobRecoveryListingSource.includes("!visibleJobIds.has(record.job.job_id)")) {
  throw new Error("managed-job bounded recovery inventory lost durable-terminal priority or owner-only retention composition diagnostics");
}
if (!macosIdleSleepAssertionSource.includes('"/usr/bin/caffeinate"')
    || !macosIdleSleepAssertionSource.includes('["-i", "-s", "-w", String(this.processId)]')
    || !macosIdleSleepAssertionSource.includes("requests_system_sleep_prevention_on_ac")
    || !macosIdleSleepAssertionSource.includes('shell: false')
    || macosIdleSleepAssertionSource.includes('MBM_REMOTE_ACTIVITY_IDLE_SLEEP_GRACE_SECONDS')
    || !remoteActivityIdleSleepGuardSource.includes('from "./macos-idle-sleep-assertion.mjs"')
    || remoteActivityIdleSleepGuardSource.includes('MBM_REMOTE_ACTIVITY_IDLE_SLEEP_GRACE_SECONDS')
    || !remoteActivityIdleSleepGuardSource.includes('DEFAULT_REMOTE_ACTIVITY_IDLE_SLEEP_GRACE_MS = 30 * 60_000')
    || !remoteActivityIdleSleepGuardSource.includes('this.activeActivities += 1;')
    || !remoteActivityIdleSleepGuardSource.includes('this.activeActivities > 0 || !this.assertion.snapshot().active')
    || !runtimeSource.includes('onAuthorizedRelayActivityStart: () => this.remoteActivityIdleSleepGuard.beginActivity()')
    || !runtimeSource.includes('onAuthorizedRelayActivityEnd: () => this.remoteActivityIdleSleepGuard.endActivity()')
    || !toolExecutorSource.includes('invokeHandler(this.handlers, this.onAuthorizedRelayActivityStart, this.onAuthorizedRelayActivityEnd)')
    || !toolExecutorSource.includes('finally { if (relayActivity) bestEffortActivityHook(onAuthorizedRelayActivityEnd); }')
    || !runtimeSource.includes('this.remoteActivityIdleSleepGuard.stop();')
    || !runtimeDiagnosticStateSource.includes('idle_sleep_guard: state.idleSleepGuard ?? null')) {
  throw new Error("runtime remote-activity idle-sleep guard lost its bounded fixed-command lifecycle or diagnostic projection");
}
const processSessionAdmissionIndex = processSessionsSource.indexOf("const admitted = await acquireProcessResources");
const processSessionActivityIndex = processSessionsSource.indexOf("beginRemoteProcessSessionActivity(context, this.remoteActivityGuard)");
if (!processSessionRemoteActivitySource.includes('context?.origin !== "relay"')
    || !runtimeSource.includes('remoteActivityGuard: this.remoteActivityIdleSleepGuard')
    || processSessionAdmissionIndex < 0 || processSessionActivityIndex <= processSessionAdmissionIndex
    || !processSessionsSource.includes('endRemoteProcessSessionActivity(remoteActivityHeld, this.remoteActivityGuard);')
    || runtimeSource.indexOf("this.remoteActivityIdleSleepGuard.stop();") < runtimeSource.indexOf("await this.processSessionManager.clearAndWait();")) {
  throw new Error("remote process-session idle-sleep activity lost its post-admission child-lifetime ownership boundary");
}
const managedJobClaimIndex = managedJobRunnerSource.indexOf("await confirmRunnerClaim({");
const managedJobRemoteOwnerIndex = managedJobRunnerSource.indexOf('if (initial.owner_kind === "account")');
const managedJobAssertionIndex = managedJobRunnerSource.indexOf("jobIdleSleepAssertion = new MacosIdleSleepAssertion");
const managedJobMainIndex = managedJobRunnerSource.indexOf("await main(plan, initial);");
const managedJobReleaseIndex = managedJobRunnerSource.indexOf("jobIdleSleepAssertion?.release();");
if (managedJobClaimIndex < 0 || managedJobRemoteOwnerIndex <= managedJobClaimIndex
    || managedJobAssertionIndex <= managedJobRemoteOwnerIndex || managedJobMainIndex <= managedJobAssertionIndex || managedJobReleaseIndex <= managedJobMainIndex
    || !managedJobRunnerSource.includes("managed job idle-sleep assertion unavailable: error_class=")) {
  throw new Error("managed-job runner idle-sleep assertion lost its confirmed-ownership lifetime or coarse failure logging");
}
if (!checkEntrypointSource.includes("runVerificationPlan")
    || !checkEntrypointSource.includes("runWithStableGeneration")
    || !checkEntrypointSource.includes("captureVerificationRunGeneration")
    || !checkEntrypointSource.includes("captureVerifiedSourceGeneration")
    || !verificationStateSource.includes("captureCoverageGeneration")
    || !verificationStateSource.includes('"docs"')
    || !verificationStateSource.includes('".github"')
    || !verificationStateSource.includes('"release-acceptance"')
    || !checkEntrypointSource.includes('value !== undefined && value !== ""')
    || !checkEntrypointSource.includes("MBM_CHECK_CONCURRENCY must be an integer from 1 to 16")
    || !checkEntrypointSource.includes("Math.min(4, availableParallelism())")
    || !checkEntrypointSource.includes("rerunVerificationUnderIdleSleepGuard")
    || !verificationIdleSleepGuardSource.includes('"/usr/bin/caffeinate"')
    || !verificationIdleSleepGuardSource.includes('["-i", executable, ...argv]')
    || !verificationIdleSleepGuardSource.includes("MBM_CHECK_IDLE_SLEEP_GUARD")
    || !verificationIdleSleepGuardSource.includes("shell: false")
    || !checkRunnerTestSource.includes("already-guarded verification recursively invoked caffeinate")
    || !checkRunnerTestSource.includes("non-macOS verification spawned caffeinate")
    || !verificationGenerationGuardSource.includes("if (after !== before)")
    || !verificationGenerationGuardSource.includes("discard this run")
    || !checkRunnerSource.includes("process.execPath")
    || !checkRunnerSource.includes("npmCli")
    || checkRunnerSource.includes("npm.cmd")) {
  throw new Error("cross-platform check runner, frozen-input guard, or bounded concurrency contract drifted");
}
const localAcceptanceSource = readFileSync(join(root, "scripts", "local-release-acceptance.mjs"), "utf8");
const directCandidateVerifyCommand = "node scripts/start-release-candidate.mjs --install-only";
const activatedRuntimeCanaryCommand = "node <activated-runtime-package>/scripts/release-oauth-canary.mjs --allow-live-oauth-canary";
for (const required of ["GIT_INDEX_FILE", "resolveTrustedGitExecutable", "createHardenedNpmSession", "runWithHardenedNpm", "packProject(root, candidateDirectory, { npmCli", "verifyCurrentReleaseAcceptance(root, { npmCli", "readReleaseOAuthCanaryEvidence", 'git, ["read-tree", "HEAD"]', 'git, ["add", "--all"', "--print-digest", "package_content_sha256", directCandidateVerifyCommand, activatedRuntimeCanaryCommand, "activation record runtime_entry"]) {
  if (!localAcceptanceSource.includes(required)) throw new Error(`local acceptance recorder lost portable digest/runtime-canary boundary: ${required}`);
}
for (const file of ["AGENTS.md", "CONTRIBUTING.md", "docs/ENGINEERING.md", "docs/PROJECT_STANDARDS.md", "docs/RELEASING.md"]) {
  if (!readFileSync(join(root, file), "utf8").includes(activatedRuntimeCanaryCommand)) {
    throw new Error(`release workflow documentation lost the activated-runtime OAuth canary command: ${file}`);
  }
}
const releaseOauthCanarySource = readFileSync(join(root, "scripts", "release-oauth-canary.mjs"), "utf8");
const releaseOauthCanaryCore = readFileSync(join(root, "scripts", "release-oauth-canary-core.mjs"), "utf8");
const releaseOauthCanaryEvidence = readFileSync(join(root, "scripts", "release-oauth-canary-evidence.mjs"), "utf8");
for (const required of ["--allow-live-oauth-canary", "assertCandidateMatchesCurrentSource", "readPrereleaseActivation", "runReleaseOAuthCanaryFlow", "writeReleaseOAuthCanaryEvidence"]) {
  if (!releaseOauthCanarySource.includes(required)) throw new Error(`deployed OAuth canary runner lost candidate/live boundary: ${required}`);
}
for (const required of ["role: \"reviewer\"", "authorization-code token exchange", "refresh-token exchange", "authenticated MCP", "stale client discovery", "stale account discovery", "admin.removeClient", "admin.remove", "temporary state cleanup was incomplete"]) {
  if (!releaseOauthCanaryCore.includes(required)) throw new Error(`deployed OAuth canary core lost flow/cleanup boundary: ${required}`);
}
for (const forbidden of ["console.log(password", "console.log(accessToken", "console.log(refreshToken", "account_password:", "access_token:", "refresh_token:"]) {
  if (releaseOauthCanarySource.includes(forbidden)) throw new Error(`deployed OAuth canary runner may expose credential material: ${forbidden}`);
}
for (const required of ["readBoundedRegularFileSync", "rejectMultipleLinks: true", "integrity", "promotion_content_sha256", "cleanup_completed"]) {
  if (!releaseOauthCanaryEvidence.includes(required)) throw new Error(`deployed OAuth canary evidence lost binding/privacy boundary: ${required}`);
}
const workerDeploymentSource = readFileSync(join(root, "src", "local", "worker-deployment.mjs"), "utf8");
const workerFingerprintSource = readFileSync(join(root, "src", "local", "worker-deployment-fingerprint.mjs"), "utf8");
if (!workerDeploymentSource.includes('export { workerDeploymentFingerprint } from "./worker-deployment-fingerprint.mjs"')) {
  throw new Error("Worker deployment state machine lost its dedicated fingerprint boundary");
}
const workerAuthProbe = workerDeploymentSource.indexOf('const whoami = await runWranglerFn(["whoami"]');
const workerJsonAuthGuard = workerDeploymentSource.indexOf("if (args.json) throw workerAuthenticationRequiredError()");
const workerInteractiveLogin = workerDeploymentSource.indexOf('await runWranglerFn(["login"]');
const workerAuthRecheck = workerDeploymentSource.indexOf('const verified = await runWranglerFn(["whoami"]');
const workerDeployStart = workerDeploymentSource.indexOf('logger.info?.("Deploying Cloudflare Worker")');
if ([workerAuthProbe, workerJsonAuthGuard, workerInteractiveLogin, workerAuthRecheck, workerDeployStart].some((value) => value < 0)
    || workerAuthProbe > workerJsonAuthGuard
    || workerJsonAuthGuard > workerInteractiveLogin
    || workerInteractiveLogin > workerAuthRecheck
    || workerAuthRecheck > workerDeployStart) {
  throw new Error("Worker deployment regained interactive Wrangler login in JSON mode or lost post-login authentication verification");
}
for (const required of ["mbm-worker-deploy-v5", "addFingerprintField", "source.files.length", 'replaceAll(path.sep, "/")', "readBoundedRegularFileSync", "rejectMultipleLinks: true", "lstatSync", "realpathSync", "requireRealDeploymentRoot", "collectRequiredHashPath", "must not be a symbolic link", "required source is missing"]) {
  if (!workerFingerprintSource.includes(required)) throw new Error(`Worker deployment fingerprint lost fail-closed v5 boundary: ${required}`);
}
const workerFingerprintTraversal = workerFingerprintSource.slice(
  workerFingerprintSource.indexOf("function workerDeployHashFiles"),
);
if (/\bexistsSync\(target\)/.test(workerFingerprintTraversal) || /(?<!l)statSync\(target\)/.test(workerFingerprintTraversal)) {
  throw new Error("Worker deployment fingerprint regained existence-probe or symlink-following traversal");
}
const oauthBrowserTestSource = readFileSync(join(root, "tests", "oauth-browser-navigation-test.mjs"), "utf8");
for (const required of [
  'detached: process.platform !== "win32"',
  'process.kill(-browser.pid, signal)',
  'signalBrowserTree(browser, "SIGTERM")',
  'signalBrowserTree(browser, "SIGKILL")',
  'spawnSync("taskkill"',
  "closeHttpServer",
  "closeAllConnections",
  "removeBrowserProfile",
  "OAuth browser navigation failed and browser cleanup was incomplete",
]) {
  if (!oauthBrowserTestSource.includes(required)) {
    throw new Error(`OAuth browser regression lost bounded process-tree cleanup boundary: ${required}`);
  }
}
const publicationGuardSource = readFileSync(join(root, "scripts", "release-publication-guard.mjs"), "utf8");
if (!publicationGuardSource.includes("resolveTrustedGitExecutable") || publicationGuardSource.includes('spawnSync("git"')) {
  throw new Error("release publication lock regained PATH-resolved Git metadata lookup");
}
if (!releaseSoakSource.includes("resolveTrustedGitExecutable") || releaseSoakSource.includes('run("git"')) {
  throw new Error("release soak evidence regained PATH-resolved Git tag lookup");
}
if (packageJson.scripts?.release !== "node scripts/github-release.mjs --publish") throw new Error("source release command is missing");
if (Object.hasOwn(packageJson.scripts || {}, "release:publish")) throw new Error("removed release:publish alias returned to the live npm command surface");
if (packageJson.scripts?.["release:accept"] !== "node scripts/local-release-acceptance.mjs --record") throw new Error("candidate acceptance command is missing");
if (packageJson.scripts?.["release:acceptance:verify"] !== "node scripts/local-release-acceptance.mjs --verify") throw new Error("release acceptance verification command is missing");
if (packageJson.scripts?.["github:push"] !== "node scripts/github-push.mjs") throw new Error("guarded GitHub push command is missing");
const githubReleaseSource = readFileSync(join(root, "scripts", "github-release.mjs"), "utf8");
const githubPublicationGuardSource = readFileSync(join(root, "scripts", "release-publication-guard.mjs"), "utf8");
if (!githubReleaseSource.includes("withGithubPublicationLock")) throw new Error("GitHub release helper lost publication serialization");
for (const forbidden of ["assertGithubPublicationAuthorized", "--owner-confirm"]) {
  if (githubReleaseSource.includes(forbidden)) throw new Error(`GitHub release helper regained a conversational authorization gate: ${forbidden}`);
}
for (const required of [
  "stageAcceptedCandidateTarball", "candidate.path", "artifactSha256",
  "createHardenedNpmSession", "sourceDependencyTreeInstallArguments", "installSourceDependencyTree", "runNpmScript", "nestedNpmEnvironment",
  "runExecutable", "hardTimeout: true",
  "githubReleaseByTagEndpoint", "waitForGithubReleaseAsset", 'gh, ["api"',
  "GitHub release bytes were verified", "mutationError", "remote-state reconciliation",
  "waitForPublishedReleaseState", "defaultReleaseStateWait", "404 Not Found",
  "GitHub REST release metadata is invalid",
]) {
  if (!githubReleaseSource.includes(required)) throw new Error(`GitHub release helper lost exact accepted-asset boundary: ${required}`);
}
const githubDependencyInstall = githubReleaseSource.indexOf("await installSourceDependencyTree(npmSession.cli)");
const githubFullVerification = githubReleaseSource.indexOf('await runNpmScript(npmSession.cli, "check")');
const githubAcceptanceVerification = githubReleaseSource.indexOf("assertLocalAcceptance(npmSession.cli)");
if ([githubDependencyInstall, githubFullVerification, githubAcceptanceVerification].some((value) => value < 0)
    || githubDependencyInstall > githubFullVerification
    || githubFullVerification > githubAcceptanceVerification) {
  throw new Error("GitHub release no longer rebuilds the exact source dependency tree before full verification and acceptance revalidation");
}
if (githubReleaseSource.includes("packReleaseAsset") || githubReleaseSource.includes('["pack", "--silent"')) {
  throw new Error("GitHub release publication regressed to repacking the source directory");
}
if (githubReleaseSource.includes('run("npm", ["run"')) {
  throw new Error("GitHub release publication regained PATH-resolved ambient npm execution");
}
for (const [label, source] of [["release", githubReleaseSource], ["push", readFileSync(join(root, "scripts", "github-push.mjs"), "utf8")], ["backlog", readFileSync(join(root, "scripts", "github-backlog.mjs"), "utf8")]]) {
  for (const required of ["resolveTrustedGitExecutable", "resolveTrustedGithubCli"]) {
    if (!source.includes(required)) throw new Error(`GitHub ${label} helper lost trusted executable resolution: ${required}`);
  }
  if (/\b(?:run|output|runNetwork|outputNetwork)\(\s*["'](?:git|gh)["']/.test(source)) {
    throw new Error(`GitHub ${label} helper regained PATH-resolved git/gh execution`);
  }
}
const githubCandidateStage = githubReleaseSource.indexOf("stageAcceptedCandidateTarball(root, acceptance, { npmCli: npmSession.cli, env: process.env })");
const githubRemoteTagRead = githubReleaseSource.indexOf("remoteTagCommit(tag)", githubCandidateStage);
const githubReleaseUpload = githubReleaseSource.indexOf("ensureRelease(tag, pkg.version, candidate.path", githubCandidateStage);
const githubAssetVerification = githubReleaseSource.indexOf("releaseAssetInfo(tag, acceptance.metadata.filename, acceptance.artifactSha256)", githubCandidateStage);
if ([githubCandidateStage, githubRemoteTagRead, githubReleaseUpload, githubAssetVerification].some((value) => value < 0)
    || githubCandidateStage > githubRemoteTagRead
    || githubRemoteTagRead > githubReleaseUpload
    || githubReleaseUpload > githubAssetVerification) {
  throw new Error("GitHub publication no longer stages accepted bytes before remote mutation and verifies the uploaded asset digest");
}
const githubAssetSource = readFileSync(join(root, "scripts", "github-release-asset.mjs"), "utf8");
for (const required of ["tag_name", "matches.length !== 1", "sha256:", "expectedSha256", "asset.digest", "waitForGithubReleaseAsset", "defaultAssetWait"]) {
  if (!githubAssetSource.includes(required)) throw new Error(`GitHub release asset verifier lost required boundary: ${required}`);
}
for (const required of ["withOwnerStateLock", "--git-common-dir", "github-publication", "github-publication.lock"]) {
  if (!githubPublicationGuardSource.includes(required)) throw new Error(`GitHub publication guard lost required boundary: ${required}`);
}
for (const forbidden of ["explicit owner authorization", "--owner-confirm", "isTTY"]) {
  if (githubPublicationGuardSource.includes(forbidden)) throw new Error(`GitHub publication lock regained a conversational/TTY authorization boundary: ${forbidden}`);
}
const publicationLockCall = githubReleaseSource.lastIndexOf("await withGithubPublicationLock");
const prereleasePublishCall = githubReleaseSource.lastIndexOf("publishCurrent({ prereleaseMode: true })");
if (publicationLockCall < 0 || prereleasePublishCall < 0 || publicationLockCall > prereleasePublishCall) {
  throw new Error("GitHub publication no longer acquires its lock before remote mutation");
}
const githubBacklogPushSource = readFileSync(join(root, "scripts", "github-push.mjs"), "utf8");
if (!githubBacklogPushSource.includes("assertGitHubBacklogReady") || !githubBacklogPushSource.includes('runNetwork(git, ["fetch", "origin", "main", "--prune"]')) {
  throw new Error("guarded GitHub push lost the issue/PR backlog boundary");
}
const githubBacklogSource = readFileSync(join(root, "scripts", "github-backlog.mjs"), "utf8");
for (const required of ["githubBacklogCommandTimeoutMs = 120_000", "timeout: githubBacklogCommandTimeoutMs", 'killSignal: "SIGKILL"', "maxBuffer: 8 * 1024 * 1024"]) {
  if (!githubBacklogSource.includes(required)) throw new Error(`standalone GitHub backlog command lost its bounded process boundary: ${required}`);
}
for (const required of ["createHardenedNpmSession", "verifyCurrentReleaseAcceptance(root, { npmCli: npmSession.cli", "verifyCurrentStableSoak(root, { npmCli: npmSession.cli", "runNetwork(git", "runBacklogCommand", "npmSession.dispose()"]) {
  if (!githubBacklogPushSource.includes(required)) throw new Error(`guarded GitHub push lost hardened/network boundary: ${required}`);
}
const pushAcceptance = githubBacklogPushSource.indexOf("verifyCurrentReleaseAcceptance(root");
const pushNpmDispose = githubBacklogPushSource.indexOf("npmSession.dispose()");
const pushRemoteMutation = githubBacklogPushSource.indexOf('runNetwork(git, ["push"');
if ([pushAcceptance, pushNpmDispose, pushRemoteMutation].some((value) => value < 0)
    || pushAcceptance > pushNpmDispose || pushNpmDispose > pushRemoteMutation) {
  throw new Error("guarded GitHub push no longer verifies accepted bytes through hardened npm and disposes it before remote mutation");
}
const candidateStartSource = readFileSync(join(root, "scripts", "start-release-candidate.mjs"), "utf8");
for (const required of ["verifyTarball", ".release-candidate", "resolveNpmGlobalPrefix", "resolveNpmCli", "allowLifecycleNpmCli: false", "allowFallbackLocations: false", "sourceNpmCli", "createHardenedNpmSession", "nestedNpmEnvironment", "--dry-run=false", "--workspaces=false", "--global", "--prefix", "--omit=optional", "--allow-scripts=esbuild,workerd,sharp,fsevents", "--allow-worker-deploy", "--activate-service", "--install-only", "createCandidateRuntimePrefix", "publishReleaseBrowserExtension", "pruneInactiveCandidateRuntimes", "writePrereleaseActivation", "validateActivationRecoveryPayload", "activation_recovery_detail", "temporary runtime was removed", '"activate"', 'stdio: "inherit"', "withReleaseRuntimeLock"]) {
  if (!candidateStartSource.includes(required)) throw new Error(`candidate startup helper lost required boundary: ${required}`);
}
const candidateSourceGuard = candidateStartSource.indexOf("assertCandidateMatchesCurrentSource(manifest");
const candidateTarballVerification = candidateStartSource.indexOf("verifyTarball(tarball, manifest)");
const candidateAuthorization = candidateStartSource.indexOf("if (!installOnly && !allowWorkerDeploy)");
const candidatePersistentRuntime = candidateStartSource.indexOf("const persistentActivation = activateService && !installOnly");
const candidateHardenedNpm = candidateStartSource.indexOf("npmSession = await createHardenedNpmSession()");
const candidateInstall = candidateStartSource.indexOf('"install",');
if (candidateSourceGuard < 0 || candidateTarballVerification < 0 || candidateAuthorization < 0 || candidatePersistentRuntime < 0 || candidateHardenedNpm < 0 || candidateInstall < 0
    || candidateSourceGuard > candidateTarballVerification
    || candidateTarballVerification > candidateAuthorization
    || candidateAuthorization > candidateHardenedNpm
    || candidatePersistentRuntime > candidateHardenedNpm
    || candidateHardenedNpm > candidateInstall) {
  throw new Error("candidate startup no longer rejects stale source and tarball bytes before hardened npm network/setup and installation");
}
const candidateInstallOnlyBranch = candidateStartSource.indexOf("if (installOnly) {");
const candidateForegroundLaunch = candidateStartSource.indexOf("const child = spawn(process.execPath");
if (candidateInstallOnlyBranch < 0 || candidateForegroundLaunch < 0 || candidateInstallOnlyBranch > candidateForegroundLaunch
    || !candidateStartSource.includes("temporary runtime was removed and startup was skipped by --install-only")) {
  throw new Error("candidate verify no longer exits through disposable install-only cleanup before foreground/live startup");
}
const candidateReleaseRuntimeLock = candidateStartSource.indexOf("await withReleaseRuntimeLock(stateRoot");
const candidatePersistentPrefix = candidateStartSource.indexOf("const installPrefix = createCandidateRuntimePrefix");
const candidateInstallCall = candidateStartSource.indexOf("installCandidateRuntime({ installPrefix, manifest, tarball })");
const candidatePersistentActivationCall = candidateStartSource.indexOf("activatePersistentCandidate({");
const candidateWorkerAuthPreflight = candidateStartSource.indexOf("await preflightPersistentActivationWorkerAuth({");
if ([candidateWorkerAuthPreflight, candidateReleaseRuntimeLock, candidatePersistentPrefix, candidateInstallCall, candidatePersistentActivationCall].some((value) => value < 0)
    || candidateWorkerAuthPreflight > candidateReleaseRuntimeLock
    || candidateReleaseRuntimeLock > candidatePersistentPrefix
    || candidatePersistentPrefix > candidateInstallCall
    || candidateInstallCall > candidatePersistentActivationCall) {
  throw new Error("persistent candidate activation lost pre-handoff Wrangler authentication or escaped the global release-runtime lock");
}
const persistentActivationAuthSource = readFileSync(join(root, "scripts", "persistent-activation-process.mjs"), "utf8");
for (const required of ["preflightPersistentActivationWorkerAuth", "EXECUTION_SURFACE.managedJob", '["whoami"]', '["login"]', "worker_authentication_required", "sideEffectsStarted = false"]) {
  if (!persistentActivationAuthSource.includes(required)) throw new Error(`persistent activation Wrangler-auth preflight drifted: ${required}`);
}
if (!cliSource.includes("await withReleaseRuntimeLock(stateRoot, () => uninstallStateRoot({ stateRoot, deleteRemote }))")) {
  throw new Error("uninstall no longer serializes state removal against persistent candidate runtime construction");
}
if (!candidateStartSource.includes("persistentActivationSpawnOptions")
    || (candidateStartSource.match(/killSignal: "SIGKILL"/g) || []).length !== 1) {
  throw new Error("candidate startup must hard-bound npm installation without externally killing the activation transaction");
}
const candidateBaselineRead = candidateStartSource.indexOf("const previousInstallation = persistentActivation");
const candidateNpmDispose = candidateStartSource.indexOf("disposeNpmSession();");
const candidateActivationCall = candidateStartSource.indexOf("activatePersistentCandidate({");
const candidateActivationVerified = candidateStartSource.indexOf("const recovery = validateActivationRecoveryPayload(activation);");
const candidateBrowserExtensionPublish = candidateStartSource.indexOf("publishedBrowserExtension = publishReleaseBrowserExtension({");
const candidateRuntimePrune = candidateStartSource.indexOf("removedRuntimes = pruneInactiveCandidateRuntimes");
const candidateActivationRecord = candidateStartSource.indexOf("recordPath = writePrereleaseActivation");
if ([candidateBaselineRead, candidateNpmDispose, candidateActivationCall, candidateActivationVerified, candidateBrowserExtensionPublish, candidateRuntimePrune, candidateActivationRecord].some((value) => value < 0)
    || candidateBaselineRead > candidateNpmDispose
    || candidateNpmDispose > candidateActivationCall
    || candidateActivationVerified > candidateBrowserExtensionPublish
    || candidateBrowserExtensionPublish > candidateRuntimePrune
    || candidateRuntimePrune > candidateActivationRecord) {
  throw new Error("candidate activation no longer verifies live convergence, publishes the stable browser extension, and completes runtime cleanup before writing activation evidence");
}
const browserBridgeSource = readFileSync(join(root, "src", "local", "browser-bridge.mjs"), "utf8");
const browserAdminSource = readFileSync(join(root, "src", "local", "cli-local-admin.mjs"), "utf8");
if (!browserBridgeSource.includes("browserExtensionPathForRuntime({ stateRoot: this.stateRoot, packageDirectory: packageRoot })")
    || !browserAdminSource.includes("browserExtensionPathForRuntime({ stateRoot")) {
  throw new Error("browser bridge/setup no longer routes versioned release runtimes through the stable unpacked-extension path");
}
const npmPublishSource = readFileSync(join(root, "scripts", "publish-npm.mjs"), "utf8");
for (const required of [
  "assertNpmPublicationAuthorized", "--owner-confirm", "explicit owner authorization",
  "verifyCurrentReleaseAcceptance", "sourceDependencyTreeInstallArguments", "stageAcceptedCandidateTarball", "prepublishOnly",
  "candidate.path", "--ignore-scripts=true", "--if-present=false", '"--tag", parsed.npmTag', "validateNpmPublishDryRun",
  '"--dry-run=true"', "disposePublicationResources", "readPublishedNpmPrereleaseIfPresent",
  "waitForPublishedCandidate", "alreadyPublished", "publication outcome is ambiguous",
]) {
  if (!npmPublishSource.includes(required)) throw new Error(`npm publication lost exact accepted-tarball boundary: ${required}`);
}
const npmDependencyInstall = npmPublishSource.indexOf('"npm source dependency installation"');
const npmAcceptanceReverify = npmPublishSource.indexOf("verifyAcceptance(repository");
const npmCandidateStage = npmPublishSource.indexOf("prepareCandidate(repository, acceptance");
const npmPrepublicationVerification = npmPublishSource.indexOf('"prepublishOnly"');
if ([npmDependencyInstall, npmAcceptanceReverify, npmCandidateStage, npmPrepublicationVerification].some((value) => value < 0)
    || npmDependencyInstall > npmAcceptanceReverify
    || npmAcceptanceReverify > npmCandidateStage
    || npmCandidateStage > npmPrepublicationVerification) {
  throw new Error("npm publication no longer rebuilds dependencies and revalidates acceptance through hardened npm before prepublication verification");
}
for (const required of [
  "runExecutable", "hardTimeout: true", "npmPrepublicationTimeoutMs = 30 * 60 * 1000",
  "npmPublicationStageTimeoutMs = 10 * 60 * 1000", "prepublicationTimeoutMs", "publicationStageTimeoutMs",
]) {
  if (!npmPublishSource.includes(required)) throw new Error(`npm publication lost process-tree/deadline boundary: ${required}`);
}
if (npmPublishSource.includes("spawnSync")) {
  throw new Error("npm publication returned to direct-child-only synchronous timeout handling");
}
const npmAuthorizationCall = npmPublishSource.indexOf("assertNpmPublicationAuthorized();");
const npmMainPublicationCall = npmPublishSource.indexOf("publishCurrentNpmPackage(root, mode)");
if (npmAuthorizationCall < 0 || npmMainPublicationCall < 0 || npmAuthorizationCall > npmMainPublicationCall) {
  throw new Error("npm publication no longer verifies explicit current-task authorization before publication work");
}
const prepublicationStage = npmPublishSource.indexOf('"prepublishOnly"');
const publishDryRunStage = npmPublishSource.indexOf('"npm publish dry-run"');
const publishDryRunValidation = npmPublishSource.indexOf("validateNpmPublishDryRun(preflight.stdout");
const exactPublishStage = npmPublishSource.lastIndexOf("publishArgs[0], candidate.path");
if ([prepublicationStage, publishDryRunStage, publishDryRunValidation, exactPublishStage].some((value) => value < 0)
    || prepublicationStage > publishDryRunStage
    || publishDryRunStage > publishDryRunValidation
    || publishDryRunValidation > exactPublishStage) {
  throw new Error("npm publication no longer verifies gates and npm dry-run identity before publishing the staged accepted tarball");
}
if (npmPublishSource.includes("[npmCli, ...publishArgs") || npmPublishSource.includes("npm publish from source")) {
  throw new Error("npm publication regressed to repacking the source directory");
}
const npmGlobalPrefixSource = readFileSync(join(root, "scripts", "npm-global-prefix.mjs"), "utf8");
for (const required of ["prefix", "--global", "--json=false", "--parseable=false", "nestedNpmEnvironment", "isAbsolute(prefix)"]) {
  if (!npmGlobalPrefixSource.includes(required)) throw new Error(`npm global prefix resolution lost required boundary: ${required}`);
}
if (!npmGlobalPrefixSource.includes("releaseCommandFailure") || npmGlobalPrefixSource.includes("result.stderr || result.stdout")) {
  throw new Error("npm global prefix failures again expose raw process output");
}
const hardenedNpmSessionSource = readFileSync(join(root, "scripts", "hardened-npm-session.mjs"), "utf8");
const candidateStartSourceForSettlement = readFileSync(join(root, "scripts", "start-release-candidate.mjs"), "utf8");
const publishedInstallSource = readFileSync(join(root, "scripts", "install-published-prerelease.mjs"), "utf8");
if (!hardenedNpmSessionSource.includes("export function settleHardenedNpmSession")
    || !candidateStartSourceForSettlement.includes("settleHardenedNpmSession(")
    || !publishedInstallSource.includes("settleHardenedNpmSession(")
    || candidateStartSourceForSettlement.includes("new AggregateError([primaryError, cleanupError]")
    || publishedInstallSource.includes("new AggregateError([primaryError, cleanupError]")) {
  throw new Error("hardened npm session settlement is no longer centralized across owner activation entrypoints");
}
const acceptedCandidateSource = readFileSync(join(root, "scripts", "accepted-candidate-tarball.mjs"), "utf8");
for (const required of [
  "rejectMultipleLinks: true", "verifyTarball", "mkdtempSync", 'mode: 0o600',
  "packProject", "computePromotionContentDigest", "options.npmCli", "rematerialized accepted candidate",
  "accepted candidate staging failed and temporary cleanup was incomplete",
]) {
  if (!acceptedCandidateSource.includes(required)) throw new Error(`accepted candidate staging lost required boundary: ${required}`);
}
const publishedPrereleaseInstallSource = readFileSync(join(root, "scripts", "install-published-prerelease.mjs"), "utf8");
for (const required of ["createHardenedNpmSession", "resolveNpmGlobalPrefix", "readGithubPrerelease", "expectedArtifactSha256: acceptance.artifactSha256", "nestedNpmEnvironment", "--dry-run=false", "--workspaces=false", "--include=prod", "validateActivationRecoveryPayload", "globalInstallAttempted", "globalInstallCompleted", "may have changed the installed package", "withReleaseRuntimeLock", "Browser soak reminder: reload the unpacked Machine Bridge extension"]) {
  if (!publishedPrereleaseInstallSource.includes(required)) throw new Error(`published prerelease installation lost hardened activation boundary: ${required}`);
}
const publishedAcceptanceCheck = publishedPrereleaseInstallSource.indexOf("verifyCurrentReleaseAcceptance(root");
const publishedDigestCheck = publishedPrereleaseInstallSource.indexOf("computePromotionContentDigest(root");
const publishedGithubAssetCheck = publishedPrereleaseInstallSource.indexOf("readGithubPrerelease(prerelease.raw");
const publishedHardenedNpm = publishedPrereleaseInstallSource.indexOf("npmSession = await createHardenedNpmSession()");
const publishedRegistryRead = publishedPrereleaseInstallSource.indexOf("readPublishedNpmPrerelease(");
const publishedReleaseRuntimeLock = publishedPrereleaseInstallSource.indexOf("await withReleaseRuntimeLock(stateRoot");
const publishedInstallAttempted = publishedPrereleaseInstallSource.indexOf("globalInstallAttempted = true");
const publishedInstallCall = publishedPrereleaseInstallSource.indexOf('"install", "--dry-run=false"');
const publishedInstallCompleted = publishedPrereleaseInstallSource.indexOf("globalInstallCompleted = true");
const publishedActivationCall = publishedPrereleaseInstallSource.indexOf("const activation = runActivation(");
const publishedActivationRecord = publishedPrereleaseInstallSource.indexOf("const recordPath = writePrereleaseActivation(");
if ([publishedReleaseRuntimeLock, publishedInstallAttempted, publishedInstallCall, publishedInstallCompleted, publishedActivationCall, publishedActivationRecord].some((value) => value < 0)
    || publishedReleaseRuntimeLock > publishedInstallAttempted
    || publishedInstallAttempted > publishedInstallCall
    || publishedInstallCall > publishedInstallCompleted
    || publishedInstallCompleted > publishedActivationCall
    || publishedActivationCall > publishedActivationRecord) {
  throw new Error("published prerelease mutation/activation escaped the global release-runtime lock or lost ambiguous-install markers");
}
if ([publishedAcceptanceCheck, publishedDigestCheck, publishedGithubAssetCheck, publishedHardenedNpm, publishedRegistryRead].some((value) => value < 0)
    || publishedAcceptanceCheck > publishedGithubAssetCheck
    || publishedDigestCheck > publishedGithubAssetCheck
    || publishedGithubAssetCheck > publishedHardenedNpm
    || publishedHardenedNpm > publishedRegistryRead) {
  throw new Error("published prerelease activation no longer validates local acceptance, source, and GitHub asset bytes before npm registry installation");
}
const publishedReleaseSource = readFileSync(join(root, "scripts", "published-release.mjs"), "utf8");
for (const required of ["githubReleaseByTagEndpoint", "normalizeGithubReleaseAsset", "expectedArtifactSha256", 'assetRun(["api"', "verifiedAsset.size !== normalized.asset.size", "readPublishedNpmPrereleaseIfPresent", "npm_version_not_found"]) {
  if (!publishedReleaseSource.includes(required)) throw new Error(`published release verification lost GitHub asset digest boundary: ${required}`);
}
const prereleaseActivationSource = readFileSync(join(root, "scripts", "prerelease-activation.mjs"), "utf8");
for (const required of ["ACTIVATION_SCHEMA_VERSION = 2", "ACTIVATION_FIELDS", "global_package_rollback_baseline", "assertPrereleaseActivationRuntimeRoot", "realpathSync", "runtime_entry", "does not match the executing canary", "unsupported prerelease activation schema", "unsupported fields"]) {
  if (!prereleaseActivationSource.includes(required)) throw new Error(`prerelease activation schema lost current-only rollback-baseline semantics: ${required}`);
}
for (const removed of ["LEGACY_ACTIVATION_SCHEMA_VERSION", "value.previous", "hasLegacyBaseline", "legacy prerelease activation"]) {
  if (prereleaseActivationSource.includes(removed)) throw new Error(`prerelease activation restored removed schema compatibility: ${removed}`);
}
for (const [label, source] of [["candidate", candidateStartSource], ["published prerelease", publishedPrereleaseInstallSource]]) {
  for (const required of ["ACTIVATION_SCHEMA_VERSION", "global_package_rollback_baseline", "activation_recovery_detail"]) {
    if (!source.includes(required)) throw new Error(`${label} activation writer lost the current explicit rollback-baseline contract: ${required}`);
  }
  if (source.includes("{ previous:") || source.includes("{ previous }")) {
    throw new Error(`${label} activation writer restored the removed previous rollback-baseline field`);
  }
}
if (!publishedPrereleaseInstallSource.includes("persistentActivationSpawnOptions")
    || (publishedPrereleaseInstallSource.match(/killSignal: "SIGKILL"/g) || []).length !== 1) {
  throw new Error("published prerelease installation must hard-bound npm without externally killing the activation transaction");
}
const persistentActivationProcessSource = readFileSync(join(root, "scripts", "persistent-activation-process.mjs"), "utf8");
if (!persistentActivationProcessSource.includes("transactional cleanup")
    || !persistentActivationProcessSource.includes("validateActivationRecoveryPayload")
    || /timeout\s*:|killSignal\s*:/.test(persistentActivationProcessSource)) {
  throw new Error("persistent activation subprocess regained an outer timeout that can bypass compensation");
}
const foregroundRecoverySource = readFileSync(join(root, "scripts", "foreground-daemon-recovery.mjs"), "utf8");
for (const required of ["inspectProcessInstance", "processCommandLine", "splitProcessCommandLine", "machine-bridge-mcp", "--workspace", "--state-dir", "--daemon-only"]) {
  if (!foregroundRecoverySource.includes(required)) throw new Error(`foreground recovery resolver lost required identity boundary: ${required}`);
}
if (!candidateStartSource.includes("discoverForegroundDaemonRecovery")
    || !candidateStartSource.includes("previousRuntime")) {
  throw new Error("candidate activation refusal lost exact previous-runtime recovery discovery");
}

const candidateRuntimeStoreSource = readFileSync(join(root, "scripts", "candidate-runtime-store.mjs"), "utf8");
for (const required of ["release-channels", "runtimes", "withFileTypes", "entry.isDirectory()", "isCandidateRuntimeDirectoryName", "active candidate runtime is outside", "must be a real directory", "requireSameDirectory"]) {
  if (!candidateRuntimeStoreSource.includes(required)) throw new Error(`candidate runtime store lost required boundary: ${required}`);
}
if (!FULL_CHECK_TASKS.includes("release:acceptance:test")) throw new Error("complete check omits local release acceptance regression coverage");
if (packageJson.scripts?.["privacy:history"] !== "node scripts/privacy-check.mjs --history") {
  throw new Error("package privacy history check is missing or drifted");
}
if (packageJson.scripts?.["sbom:test"] !== "node scripts/sbom-check.mjs"
    || packageJson.scripts?.["sbom-check:test"] !== "node tests/sbom-check-test.mjs"
    || !FULL_CHECK_TASKS.includes("sbom:test") || !FAST_CHECK_TASKS.includes("sbom-check:test")) {
  throw new Error("SBOM generation or validation is missing from the release gates");
}
if (packageJson.scripts?.["consumer-security:test"] !== "node scripts/consumer-package-security.mjs"
    || packageJson.scripts?.["release:check"] !== "npm run consumer-security:test && node scripts/github-release.mjs --check") {
  throw new Error("consumer package security is missing from release verification");
}
const consumerSecuritySource = readFileSync(join(root, "scripts", "consumer-package-security.mjs"), "utf8");
for (const required of ["prepareHardenedNpm", "result = await verifyConsumerTarball", "canonicalConsumerTarballPath", "realpathSync(consumer)", "accepted-package.tgz", "readBoundedRegularFileSync", "--dry-run=false", "--workspaces=false", "--omit=dev", "--audit-level=low", "signatures", "--sbom-format", "cyclonedx", "dependencyByReference.size !== references.size", "wrangler", "miniflare", "vulnerableUndici", "nestedNpmEnvironment"]) {
  if (!consumerSecuritySource.includes(required)) throw new Error(`consumer package security gate lost required boundary: ${required}`);
}
if (consumerSecuritySource.includes('"--omit=optional"')) throw new Error("consumer package security no longer models an ordinary optional-dependency installation");
const toolchainSource = readFileSync(join(root, "src", "local", "wrangler-toolchain.mjs"), "utf8");
const toolchainVerificationSource = readFileSync(join(root, "src", "local", "wrangler-toolchain-verification.mjs"), "utf8");
for (const required of ["withOwnerStateLock", "npm", "ci", "audit", "signatures", "--dry-run=false", "--workspaces=false", "7.29.0", "0.35.3"]) {
  if (!toolchainSource.includes(required)) throw new Error(`private Wrangler toolchain lost required boundary: ${required}`);
}
for (const required of ["TOOLCHAIN_MARKER", "MAX_TREE_NODES", "throwOperationalOrIntegrity", "privateToolchainIntegrityError"]) {
  if (!toolchainVerificationSource.includes(required)) throw new Error(`private Wrangler verification lost required boundary: ${required}`);
}
const sbomCheckSource = readFileSync(join(root, "scripts", "sbom-check.mjs"), "utf8");
for (const required of ["npm_execpath", "--workspaces=false", "--sbom-format", "cyclonedx", "CycloneDX 1.5", "dependencyByReference.size !== references.size", "SIGKILL", "MAX_SBOM_BYTES"]) {
  if (!sbomCheckSource.includes(required)) throw new Error(`SBOM validation lost required boundary: ${required}`);
}
const syntaxCheckSource = readFileSync(join(root, "scripts", "syntax-check.mjs"), "utf8");
const eslintConfigSource = readFileSync(join(root, "eslint.config.mjs"), "utf8");
if (!syntaxCheckSource.includes('".github/scripts"')
    || !packageJson.scripts?.lint?.includes(".github/scripts")
    || !eslintConfigSource.includes('".github/scripts/**/*.{js,mjs}"')) {
  throw new Error("GitHub workflow control scripts are missing from syntax or lint gates");
}
if (!syntaxCheckSource.includes('"src/shared"')
    || !packageJson.scripts?.lint?.includes("src/shared")
    || !eslintConfigSource.includes('"src/shared/**/*.{js,mjs}"')) {
  throw new Error("shared runtime modules are missing from syntax or correctness lint gates");
}
const localTypecheckSource = readFileSync(join(root, "tsconfig.local.json"), "utf8");
if (!localTypecheckSource.includes('"src/shared/activation-recovery.mjs"')) {
  throw new Error("activation recovery evidence contract is missing from strict local typecheck");
}
if (!localTypecheckSource.includes('"src/local/application-capability-projection.mjs"')) {
  throw new Error("application authority projection is missing from strict local typecheck");
}
const stateEntrypointBoundaryStart = stateSource.indexOf("function currentEntrypointInsideStateRoot(root)");
const stateEntrypointBoundaryEnd = stateSource.indexOf("\nfunction looksLikeSourceTree", stateEntrypointBoundaryStart);
const stateEntrypointBoundary = stateEntrypointBoundaryStart >= 0 && stateEntrypointBoundaryEnd > stateEntrypointBoundaryStart
  ? stateSource.slice(stateEntrypointBoundaryStart, stateEntrypointBoundaryEnd)
  : "";
for (const required of ["canonicalizePotentialPath(root)", "canonicalizePotentialPath(entry)", "path.relative(canonicalRoot, resolved)"]) {
  if (!stateEntrypointBoundary.includes(required)) throw new Error(`state-root current-CLI removal guard lost canonical path-family alignment: ${required}`);
}
const secureFileSource = readFileSync(join(root, "src", "local", "secure-file.mjs"), "utf8");
if (!secureFileSource.includes("inspectPathIfPresentSync") || !secureFileSource.includes('error?.code === "ENOENT"')) {
  throw new Error("shared present-path inspection no longer distinguishes only ENOENT as absence");
}
for (const [label, file] of [
  ["browser pairing", "src/local/browser-pairing-store.mjs"],
  ["service environment", "src/local/service-environment.mjs"],
  ["service owner", "src/local/service-owner.mjs"],
  ["global configuration", "src/local/state.mjs"],
]) {
  const source = readFileSync(join(root, file), "utf8");
  if (!source.includes("inspectPathIfPresentSync")) throw new Error(`${label} lost fail-closed path inspection`);
  if (/existsSync/.test(source) && file !== "src/local/state.mjs") throw new Error(`${label} regained existsSync absence classification`);
}
for (const required of [
  "removeObsoleteOperationLeaseState", '"operation-leases.json"', "inspectPathIfPresentSync",
  "info.isSymbolicLink()", "!info.isFile()", "info.nlink !== 1n", "filesystemIdentity",
  "unlinkRegularFileIfIdentitySync", "changed before migration cleanup",
]) {
  if (!stateSource.includes(required)) throw new Error(`obsolete operation-lease migration cleanup lost fail-closed boundary: ${required}`);
}
const browserPairingSource = readFileSync(join(root, "src", "local", "browser-pairing-store.mjs"), "utf8");
for (const required of ["const PAIRING_SCHEMA_VERSION = 2", "const PAIRING_AUTH_VERSION = 2", "pairingAuthVersion: PAIRING_AUTH_VERSION", "migrationPending: true"]) {
  if (!browserPairingSource.includes(required)) throw new Error(`browser pairing envelope lost beta.55 rollback readability or hardened-auth identity: ${required}`);
}
if (!readFileSync(join(root, "tests", "browser-extension-identity-test.mjs"), "utf8").includes("beta55AcceptsPairingState")) {
  throw new Error("browser pairing rollback compatibility fixture is missing");
}
const managedJobSource = readFileSync(join(root, "src", "local", "managed-jobs.mjs"), "utf8");
const managedJobRunnerLivenessSource = readFileSync(join(root, "src", "local", "managed-job-runner-liveness.mjs"), "utf8");
const managedJobHostedReconcileSource = readFileSync(join(root, "src", "local", "managed-job-hosted-reconcile.mjs"), "utf8");
const runtimeToolHandlersSource = readFileSync(join(root, "src", "local", "runtime-tool-handlers.mjs"), "utf8");
const cliOptionsSource = readFileSync(join(root, "src", "local", "cli-options.mjs"), "utf8");
for (const removed of ["approval: new Set", "approve: 2", "APPROVAL_POSITIONAL_LIMITS", "approval(args)"]) {
  if (cliOptionsSource.includes(removed)) throw new Error(`removed approval CLI parsing surface returned: ${removed}`);
}
const managedJobProjectionSource = readFileSync(join(root, "src", "local", "managed-job-projection.mjs"), "utf8");
const managedJobRetentionSource = readFileSync(join(root, "src", "local", "managed-job-retention.mjs"), "utf8");
const managedJobRetentionPolicySource = readFileSync(join(root, "src", "local", "managed-job-retention-policy.mjs"), "utf8");
const managedJobDurableProcessSource = readFileSync(join(root, "src", "local", "managed-job-durable-process.mjs"), "utf8");
const relayCallRecoverySource = readFileSync(join(root, "src", "local", "relay-call-recovery.mjs"), "utf8");
const relayResultRetentionSource = readFileSync(join(root, "src", "local", "relay-result-retention.mjs"), "utf8");
const relayRedeliverySafetySource = readFileSync(join(root, "src", "local", "relay-redelivery-safety.mjs"), "utf8");
const managedJobTerminalSource = readFileSync(join(root, "src", "local", "managed-job-terminal.mjs"), "utf8");
const managedJobClaimSource = readFileSync(join(root, "src", "local", "managed-job-runner-claim.mjs"), "utf8");
const managedJobCancellationSource = readFileSync(join(root, "src", "local", "managed-job-cancellation.mjs"), "utf8");
const managedJobDirectorySource = readFileSync(join(root, "src", "local", "managed-job-directory.mjs"), "utf8");
const managedJobDirectoryGenerationSource = readFileSync(join(root, "src", "local", "managed-job-directory-generation.mjs"), "utf8");
const managedJobCapacitySource = readFileSync(join(root, "src", "local", "managed-job-capacity.mjs"), "utf8");
const managedJobsIntegrationSource = readFileSync(join(root, "tests", "managed-jobs-test.mjs"), "utf8");
if (!managedJobsIntegrationSource.includes("RECOVERY_RESOURCE_LOCK_HOLD_MS = 5_500")
    || !managedJobsIntegrationSource.includes("withFixtureResourceTransactionLock(coordinatorRoot")
    || !managedJobsIntegrationSource.includes("}, 30_000);")
    || !managedJobsIntegrationSource.includes('code !== "MBM_MULTIPLE_HARD_LINKS"')
    || !managedJobsIntegrationSource.includes("withResourceTransactionLock(root, callback, { timeoutMs: Math.max(1, deadline - Date.now()) })")) {
  throw new Error("managed-job resource-contention regression lost its setup/acquisition timing separation");
}
if (!managedJobRunnerLivenessSource.includes("inspectProcessInstanceAsync")
    || !managedJobRunnerLivenessSource.includes("readManagedJobRunnerClaim")
    || managedJobRunnerLivenessSource.includes("readBoundedFile")
    || !managedJobClaimSource.includes("export function readManagedJobRunnerClaim")
    || !managedJobClaimSource.includes("retryTransientMultipleLinksSync")
    || !managedJobClaimSource.includes("validRunnerClaim")
    || !managedJobClaimSource.includes("Number.isInteger(claim.pid)")
    || !managedJobClaimSource.includes('typeof claim.committed !== "boolean"')
    || !managedJobSource.includes("async readHosted")
    || !managedJobSource.includes("await reconcileManagedJobStatusHosted(this, dir)")
    || !managedJobHostedReconcileSource.includes("await runnerProcessIsCurrentAsync(initial, dir)")
    || !managedJobHostedReconcileSource.includes("manager.reconcileStatus(dir)")
    || !runtimeToolHandlersSource.includes('context?.authority?.origin === "relay"')
    || !runtimeToolHandlersSource.includes("runtime.managedJobManager.readHosted(args, context)")) {
  throw new Error("hosted managed-job reconciliation regained synchronous runner process-identity sampling on the long-task status path");
}
if (!managedJobRunnerSource.includes('current_phase: "resource_admission"')
    || !managedJobRunnerSource.includes("onAdmissionStart?.();")
    || !managedJobRunnerSource.includes("onAdmissionComplete?.();")
    || !managedJobRunnerSource.includes("await releaseProcessResources(admitted.lease)")
    || !managedJobRunnerSource.includes("managed job admission status update and resource lease cleanup both failed")
    || !managedJobRunnerSource.includes("resource_admission_ms: raw.resourceAdmissionMs")
    || !managedJobRunnerSource.includes('current_phase: phase === "finally_steps" && recover ? "recovery-cleanup" : phase')) {
  throw new Error("managed-job status lost explicit pre-spawn resource-admission observability, phase restoration, or admission-status failure cleanup");
}
if (!managedJobProjectionSource.includes("resource_admission_ms: _resourceAdmissionMs")
    || !managedJobSource.includes("projectManagedJobResult(result, { includeResourceAdmissionTiming: context?.authority?.owner !== false })")
    || !managedJobsIntegrationSource.includes("delegated managed-job read exposed machine-user resource admission timing")
    || !managedJobsIntegrationSource.includes("owner managed-job read lost resource admission timing needed for queue diagnosis")) {
  throw new Error("managed-job admission timing lost its owner-only projection or delegated privacy regression");
}
if (!managedJobTerminalSource.includes('export const ACTIVE_JOB_STATES = new Set(["queued", "running", "cleaning", "interrupted"])')
    || !managedJobRunnerSource.includes("ACTIVE_JOB_STATES.has(status.status)")
    || !managedJobRetentionSource.includes("...ACTIVE_JOB_STATES")
    || managedJobRunnerSource.includes("FATAL_RECORDABLE_STATUSES")) {
  throw new Error("managed-job active lifecycle states no longer have one shared source of truth");
}
if (!coverageRunnerSource.includes('"src/local/managed-job-capacity.mjs"')) {
  throw new Error("critical managed-job capacity coverage threshold is missing");
}
if (managedJobCapacitySource.includes("entry.isDirectory() && MANAGED_JOB_ID")
    || !managedJobCapacitySource.includes("job_state_unreadable")) {
  throw new Error("managed-job capacity again ignores wrong-type state in the reserved public job namespace");
}
if (!coverageRunnerSource.includes('"src/local/managed-job-directory-generation.mjs"')) {
  throw new Error("critical managed-job directory-generation coverage threshold is missing");
}
if (!coverageRunnerSource.includes('"src/local/managed-job-retention.mjs"')) {
  throw new Error("critical managed-job retention coverage threshold is missing");
}
if (!managedJobSource.includes('retentionClass = "managed"')
    || !managedJobSource.includes("transientProcessRecoveryStatusFields(retentionClass, context)")
    || !managedJobTransientRecoverySource.includes('retentionClass !== "transient_process"')
    || !managedJobTransientRecoverySource.includes('context?.origin === "relay"')
    || !managedJobTransientRecoverySource.includes('context?.authority?.origin === "relay"')
    || !managedJobTransientRecoverySource.includes('transient_recovery_pending: true')
    || !managedJobSource.includes("incomingRetentionClass: retentionClass")
    || !managedJobDurableProcessSource.includes('retentionClass: "transient_process"')
    || !managedJobRetentionSource.includes("orderManagedJobTerminalEviction(removable")
    || !managedJobRetentionPolicySource.includes("TRANSIENT_PROCESS_RECOVERY_GRACE_MS = 30 * 60 * 1000")
    || !managedJobRetentionPolicySource.includes("TRANSIENT_PROCESS_RECOVERY_SLOTS = 16")
    || !managedJobRetentionPolicySource.includes("transientProcessWithinRecoveryGrace")
    || !managedJobRetentionPolicySource.includes("export function transientProcessRecoveryIds")
    || !managedJobRetentionPolicySource.includes("export function orderManagedJobTerminalEviction")
    || !managedJobRetentionPolicySource.includes("TRANSIENT_PROCESS_RECOVERY_SLOTS - incomingSlots")
    || !managedJobRetentionPolicySource.includes("status?.transient_recovery_pending === true")
    || !managedJobsIntegrationSource.includes("transient recovery grace excluded its exact documented boundary")
    || !managedJobsIntegrationSource.includes("saturated managed-job retention did not preserve the bounded recent transient recovery reserve")
    || !managedJobsIntegrationSource.includes("follow-up-required transient recovery did not outrank ordinary durable terminal history at saturation")
    || !managedJobsIntegrationSource.includes("follow-up-required transient recovery was displaced by newer terminal-delivered helper churn")
    || !managedJobsIntegrationSource.includes("durable one-step process carrier did not persist its private follow-up recovery state through terminal settlement")
    || !managedJobsIntegrationSource.includes("transient_recovery_pending")
    || !managedJobsIntegrationSource.includes('missingJobError?.code === "not_found"')) {
  throw new Error("managed-job retention lost its bounded recent transient recovery reserve, durable-history preference, dependency protection, or typed missing-state contract");
}
if (!relayRedeliverySafetySource.includes("#unsafeCallIds = new Set()")
    || !relayRedeliverySafetySource.includes("#globalRedeliveryDisabled = false")
    || !relayRedeliverySafetySource.includes("canProveMissing(callId)")
    || !relayRedeliverySafetySource.includes("observeResumedCallIds(callIds)")
    || !relayRedeliverySafetySource.includes("markUnsafe(callId)")
    || !relayResultRetentionSource.includes("onOwnershipLost")
    || !relayResultRetentionSource.includes("discardAll()")
    || !relayCallRecoverySource.includes("this.redeliverySafety.canProveMissing(callId)")
    || !relayCallRecoverySource.includes("this.redeliverySafety.observeResumedCallIds(resumed)")
    || !relayCallRecoverySource.includes("this.resultRetention.discardAll()")
    || !readFileSync(join(root, "tests", "runtime-infrastructure-test.mjs"), "utf8").includes("globally disabled unrelated recovery")) {
  throw new Error("relay acknowledgement loss can again replay an unsafe call or globally disable unrelated missing-call recovery");
}
if (!coverageRunnerSource.includes('"src/local/managed-job-terminal-maintenance.mjs"')) {
  throw new Error("critical managed-job terminal-maintenance coverage threshold is missing");
}
if (!managedJobDirectoryGenerationSource.includes('startsWith("retired_job_")') || managedJobDirectoryGenerationSource.includes("job_retired_")) {
  throw new Error("managed-job retired namespace no longer reserves malformed internal names or drifted toward the public job-id grammar");
}
for (const forbidden of ["existsSync(dir)", "quarantine could not be restored", "renameSync(quarantine, dir)"]) {
  if (managedJobDirectoryGenerationSource.includes(forbidden)) throw new Error(`managed-job retirement regained unsafe pathname rollback: ${forbidden}`);
}
if (!managedJobSource.includes('state_kind: "retired_managed_job"') || !managedJobSource.includes("managedJobCapacitySnapshot")) {
  throw new Error("managed-job retired-state privacy/capacity projection contract is missing");
}
for (const removed of ["approve(args", '"pending-local-operator"', "start the staged job through"]) {
  if (managedJobSource.includes(removed)) throw new Error(`removed staged-job promotion contract returned: ${removed}`);
}
for (const required of ["writeManagedJobCancellation", "resolveManagedJobDirectory", "resolveManagedJobRootIfPresent"]) {
  if (!managedJobSource.includes(required)) throw new Error(`managed job manager lost secure boundary: ${required}`);
}
if (managedJobRunnerSource.includes("existsSync(cancelFile)")
    || !managedJobRunnerSource.includes("managedJobCancellationRequested(cancelFile)")) {
  throw new Error("managed job runner again treats cancellation inspection failure as absence");
}
if (managedJobRunnerSource.includes('child.on("error", (error) => { settlement.cancel()')
    || !managedJobRunnerSource.includes('child.on("error", (error) => { childError ||= error; })')) {
  throw new Error("managed job runner again settles process ownership directly from child error before close/exit settlement");
}
if (!managedJobRunnerSource.includes("RECOVERY_LOCK_HANDOFF_WAIT_MS = 30_000")
    || !/await confirmRunnerClaim[\s\S]{0,600}if \(recover\) \{\s*await terminateManagedJobActiveChild\(activeChildFile\);\s*await releaseRecoveryClaim\(\);\s*\}[\s\S]{0,220}runnerClaimConfirmed = true;/.test(managedJobRunnerSource)) {
  throw new Error("recovery runner can again terminalize a job before recovery-lock handoff is complete");
}
for (const required of [
  "processStartTimeMs", "inspectProcessInstance", "terminateProcessTreeWithEscalation", "removeOwnedJsonFileSync",
  "managedJobActiveChildRecoveryState", "managed job active child ownership cannot be verified",
]) {
  if (!managedJobActiveChildSource.includes(required)) throw new Error(`managed-job active-child ownership boundary lost: ${required}`);
}
if (!/spawn\([\s\S]{0,1200}publishManagedJobActiveChild\(activeChildFile, child\)[\s\S]{0,600}bindProcessResources\(admitted\.lease, child\)/.test(managedJobRunnerSource)
    || !managedJobRunnerSource.includes("clearManagedJobActiveChild(activeChildFile, activeChildClaim)")) {
  throw new Error("managed-job runner no longer publishes and clears child ownership around business process execution");
}
if (!managedJobRunnerExitRecoverySource.includes("DEFAULT_RECONCILE_DELAY_MS = 10_100")
    || !managedJobRunnerExitRecoverySource.includes("reconcileStatus(dir)")
    || !runtimeSource.includes("this.managedJobManager.stopRunnerExitRecovery();")) {
  throw new Error("managed-job same-daemon runner-exit recovery lost its bounded observer lifecycle");
}
if (!managedJobTerminalMaintenanceSource.includes("managedJobActiveChildRecoveryReady(managedJobActiveChildFile(dir))")
    || !managedJobTerminalMaintenanceSource.includes('"active_child_unsettled"')) {
  throw new Error("terminal artifact maintenance can again erase unresolved managed-job child ownership evidence");
}
if (managedJobClaimSource.includes("existsSync") || !managedJobClaimSource.includes("inspectPathIfPresentSync")) {
  throw new Error("managed job runner claim again treats inspection failure as absence");
}
for (const required of ["replaceFileAtomicallySync", "verifyPathIdentity: true", "rejectMultipleLinks: true", "managed job cancellation marker is invalid"]) {
  if (!managedJobCancellationSource.includes(required)) throw new Error(`managed job cancellation boundary lost: ${required}`);
}
for (const required of ["MANAGED_JOB_ID", "requireContained", "identity changed during inspection", "openSync", "fstatSync", "O_NOFOLLOW", "O_DIRECTORY", "0o700", "bigint: true"]) {
  if (!managedJobDirectorySource.includes(required)) throw new Error(`managed job directory boundary lost: ${required}`);
}
if (packageJson.scripts?.["managed-job-boundary:test"] !== "node tests/managed-job-boundary-test.mjs"
    || !FAST_CHECK_TASKS.includes("managed-job-boundary:test")) {
  throw new Error("managed job filesystem fault injection is missing from the fast gate");
}
const sshKeySource = readFileSync(join(root, "src", "local", "ssh-key.mjs"), "utf8");
for (const required of ["GENERATED_KEY_IDENTITIES", "chmodRegularFileIfIdentitySync", "installedLinkIdentity(opened.fd, source, target)", "removeGeneratedSshKeyPair", "refusing path-only cleanup"]) {
  if (!sshKeySource.includes(required)) throw new Error(`SSH key transaction lost identity-bound compensation: ${required}`);
}
if (sshKeySource.includes("copyFile(source, target") || sshKeySource.includes("rm(request.privateKeyPath") || sshKeySource.includes("chmodRegularFileSync")) {
  throw new Error("SSH key handling regained unreachable cross-filesystem fallback, pathname-only rollback, or pathname-only chmod");
}
const serviceDefinitionSource = readFileSync(join(root, "src", "local", "service-definition.mjs"), "utf8");
const serviceStatusSource = readFileSync(join(root, "src", "local", "service-status.mjs"), "utf8");
const serviceSource = readFileSync(join(root, "src", "local", "service.mjs"), "utf8");
for (const required of ["verifyPathIdentity: true", "rejectMultipleLinks: true", "unlinkRegularFileIfIdentitySync"]) {
  if (!serviceDefinitionSource.includes(required)) throw new Error(`service definition lost snapshot-bound removal: ${required}`);
}
for (const required of ["snapshotServiceDefinition", "removeServiceDefinitionIfCurrent", 'reason: "definition_changed"']) {
  if (!serviceSource.includes(required)) throw new Error(`service uninstall lost definition-generation guard: ${required}`);
}
for (const required of ["LAUNCHD_MISSING_SERVICE_CODE = 113", "status_available: statusAvailable", 'missing ? "inactive" : "unknown"']) {
  if (!serviceStatusSource.includes(required)) throw new Error(`launchd status lost fail-closed query evidence: ${required}`);
}
for (const required of ["const safelyAbsent", "const safelyInactive", 'state === "active" ? true : safelyInactive || safelyAbsent ? false : null']) {
  if (!serviceStatusSource.includes(required)) throw new Error(`systemd status lost tri-state activity evidence: ${required}`);
}
if ((serviceSource.match(/before\.status_available !== true/g) || []).length < 2
    || (serviceSource.match(/typeof before\.active !== "boolean"/g) || []).length < 4
    || (serviceSource.match(/before\.installed !== true/g) || []).length < 2) {
  throw new Error("service start/restart paths no longer fail closed on unavailable provider status or missing definitions");
}
for (const required of ["stopLaunchdService", "launchdStatusIsSafelyUnloaded", "status?.status_available === true", "status?.loaded === false", "status?.active === false"]) {
  if (!serviceSource.includes(required)) throw new Error(`launchd stop lost verified-unloaded boundary: ${required}`);
}
if (serviceSource.includes("waitForInactiveStatus(statusLaunchd)")) {
  throw new Error("launchd stop again accepts inactive process state without verified domain unload");
}
const windowsServiceSource = readFileSync(join(root, "src", "local", "windows-service.mjs"), "utf8");
for (const required of ["snapshotServiceDefinition", "removeServiceDefinitionIfCurrent", 'reason: "launcher_changed"']) {
  if (!windowsServiceSource.includes(required)) throw new Error(`Windows service uninstall lost launcher-generation guard: ${required}`);
}
if (existsSync(join(root, "src", "local", "state-locations.mjs"))) {
  throw new Error("dead divergent state-locations module returned to the release surface");
}

for (const [label, file] of [
  ["prerelease activation", "scripts/prerelease-activation.mjs"],
  ["release soak", "scripts/release-soak.mjs"],
  ["official conformance", "scripts/official-mcp-conformance.mjs"],
]) {
  const source = readFileSync(join(root, file), "utf8");
  if (!source.includes('error?.code === "ENOENT"') || source.includes("existsSync")) {
    throw new Error(`${label} no longer treats only ENOENT as missing evidence`);
  }
}
const githubReleaseDiagnosticSource = readFileSync(join(root, "scripts", "github-release.mjs"), "utf8");
if (!githubReleaseDiagnosticSource.includes("releaseCommandFailure(command, args, result")
    || githubReleaseDiagnosticSource.includes('args.join(" ")')) {
  throw new Error("GitHub release errors again expose complete command arguments");
}
const releaseDiagnosticSource = readFileSync(join(root, "scripts", "release-diagnostic.mjs"), "utf8");
for (const required of ["sanitizePortableLogText", "releaseCommandFailure", "releaseCommandLabel", "releaseDiagnosticEvent", "EVENT_NAME_PATTERN", "HOME_PATHS"]) {
  if (!releaseDiagnosticSource.includes(required)) throw new Error(`release diagnostic redaction lost required boundary: ${required}`);
}
if (packageJson.scripts?.["release-diagnostic:test"] !== "node tests/release-diagnostic-test.mjs"
    || !FAST_CHECK_TASKS.includes("release-diagnostic:test")) {
  throw new Error("release diagnostic redaction test is missing from local gates");
}
for (const [file, event] of [
  [
    "scripts/github-push.mjs",
    "github.push.blocked"
  ],
  [
    "scripts/github-backlog.mjs",
    "github.backlog.failed"
  ],
  [
    "scripts/npm-publication-policy.mjs",
    "npm.publication_policy.failed"
  ],
  [
    "scripts/install-published-prerelease.mjs",
    "prerelease.install.failed"
  ],
  [
    "scripts/local-release-acceptance.mjs",
    "release.acceptance.failed"
  ],
  [
    "scripts/github-release.mjs",
    "github.release.failed"
  ],
  [
    "scripts/publish-npm.mjs",
    "npm.publish.failed"
  ],
  [
    "scripts/release-soak.mjs",
    "release.soak.failed"
  ],
  [
    "scripts/start-release-candidate.mjs",
    "release.candidate.failed"
  ]
]) {
  const source = readFileSync(join(root, file), "utf8");
  const requiredSink = `console.error(JSON.stringify(releaseDiagnosticEvent("${event}",`;
  if (!source.includes(requiredSink)) throw new Error(`release failure sink is not a single-line JSON event: ${file}`);
}
const workflowPolicySource = readFileSync(join(root, ".github", "scripts", "workflow-policy.mjs"), "utf8");
const workflowPolicyRulesSource = readFileSync(join(root, ".github", "scripts", "workflow-policy-rules.mjs"), "utf8");
const workflowPolicyContractSource = readFileSync(join(root, ".github", "scripts", "workflow-policy-contract.mjs"), "utf8");
const workflowPolicyWorkflow = readFileSync(join(root, ".github", "workflows", "workflow-policy.yml"), "utf8");
for (const required of ["verifyWorkflowPolicy", "readBoundedRegularFileSync", "workflow-policy-rules.mjs", "workflow-policy-contract.mjs"]) {
  if (!workflowPolicySource.includes(required)) throw new Error(`workflow policy filesystem verifier lost required boundary: ${required}`);
}
for (const required of ["ALLOWED_ACTIONS", "ALLOWED_WRITE_PERMISSIONS", "pull_request_target", "persist-credentials", "github.event", "dynamic, malformed, or unpinned"]) {
  if (!workflowPolicyRulesSource.includes(required)) throw new Error(`workflow policy rules lost required boundary: ${required}`);
}
for (const required of ["REQUIRED_WORKFLOWS", "workflow-policy.yml", "requireRunCommand", "requireActionInput", "stripYamlComment", "sarif-security-gate.mjs"]) {
  if (!workflowPolicyContractSource.includes(required)) throw new Error(`workflow policy contract lost required boundary: ${required}`);
}
for (const required of ["name: Workflow Policy Gate", "node .github/scripts/workflow-policy.mjs", "node tests/workflow-policy-test.mjs", "timeout-minutes: 5"]) {
  if (!workflowPolicyWorkflow.includes(required)) throw new Error(`workflow policy GitHub workflow lost required boundary: ${required}`);
}
if (packageJson.scripts?.["workflow-policy:check"] !== "node .github/scripts/workflow-policy.mjs"
    || packageJson.scripts?.["workflow-policy:test"] !== "node tests/workflow-policy-test.mjs"
    || !FAST_CHECK_TASKS.includes("workflow-policy:test")) {
  throw new Error("workflow policy verification is missing from local development gates");
}
const ciSource = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
if (!ciSource.includes("npm run privacy:history")) throw new Error("CI package audit no longer scans reachable Git history");
if ((ciSource.match(/npm run consumer-security:test/g) || []).length !== 1) throw new Error("CI package audit no longer verifies the final consumer artifact exactly once");
if (!ciSource.includes("npm run check:platform") || !ciSource.includes("npm run check:full")
    || !ciSource.includes("os: [macos-latest, windows-latest]") || !ciSource.includes("runs-on: ubuntu-latest")) {
  throw new Error("CI no longer separates cross-platform fast checks from the Linux full suite");
}
if (!/platform-check:[\s\S]*?timeout-minutes:\s*30[\s\S]*?strategy:/.test(ciSource)) {
  throw new Error("cross-platform verification lost the 30-minute CI envelope required by observed Windows platform+install duration");
}
const portableAcceptanceCommand = "npm pack --ignore-scripts --silent --dry-run --json | node .github/scripts/verify-release-acceptance.mjs";
if ((ciSource.split(portableAcceptanceCommand).length - 1) !== 2) throw new Error("CI no longer verifies portable local candidate acceptance in both package paths");
const portableAcceptanceSource = readFileSync(join(root, ".github", "scripts", "verify-release-acceptance.mjs"), "utf8");
for (const required of ["canonicalPackageDigest", "package_content_sha256", "promotion_content_sha256", "computePromotionContentDigest", "resolveTrustedGitExecutable", "ls-files", "--stage", "cat-file", "machine-bridge-mcp-package-content-v1"]) {
  if (!portableAcceptanceSource.includes(required)) throw new Error(`portable release acceptance verifier lost required content: ${required}`);
}
const testingGuide = readFileSync(join(root, "docs", "TESTING.md"), "utf8");
for (const [name, source] of [
  ["CI workflow", ciSource],
  ["portable acceptance verifier", portableAcceptanceSource],
  ["workflow policy contract", workflowPolicyContractSource],
  ["testing guide", testingGuide],
]) {
  if (/interactive candidate acceptance/i.test(source)) {
    throw new Error(`${name} retained obsolete interactive candidate acceptance wording`);
  }
}
if (!ciSource.includes("Verify local candidate acceptance")
    || !portableAcceptanceSource.includes("Portable local candidate acceptance matches")
    || !workflowPolicyContractSource.includes('"local candidate acceptance"')
    || !testingGuide.includes("verifies local candidate acceptance")) {
  throw new Error("current release surfaces no longer agree on local candidate acceptance terminology");
}
if ((ciSource.match(/node scripts\/prepare-pinned-npm\.mjs/g) || []).length !== 3 || ciSource.includes("npm install --global npm@")) {
  throw new Error("CI no longer bootstraps the npm baseline from an integrity-verified immutable tarball");
}
if (packageJson.scripts?.["ci-bootstrap:test"] !== "node tests/ci-bootstrap-test.mjs"
    || !FAST_CHECK_TASKS.includes("ci-bootstrap:test")) {
  throw new Error("fresh-checkout npm bootstrap regression is missing from the fast gate");
}
const npmBootstrapSource = readFileSync(join(root, "scripts", "prepare-pinned-npm.mjs"), "utf8");
const hardenedNpmSource = readFileSync(join(root, "src", "local", "hardened-npm.mjs"), "utf8");
const hardenedNpmDownloadSource = readFileSync(join(root, "src", "local", "hardened-npm-download.mjs"), "utf8");
const hardenedNpmDownloadTimeoutSource = readFileSync(join(root, "src", "local", "hardened-npm-download-timeout.mjs"), "utf8");
const hardenedNpmVerificationSource = readFileSync(join(root, "src", "local", "hardened-npm-verification.mjs"), "utf8");
if (!npmBootstrapSource.includes("prepareHardenedNpm")
    || !hardenedNpmSource.includes("npm-12.0.2.tgz") || !hardenedNpmSource.includes("sha512-uIXokLlBj6FpNUTQX1PmT5pz7BlIN9Ql")
    || !hardenedNpmSource.includes("undici-6.28.0.tgz") || !hardenedNpmSource.includes("brace-expansion-5.0.9.tgz")
    || !hardenedNpmDownloadSource.includes("proxyAgentForHttp") || !hardenedNpmDownloadSource.includes("status !== 200")
    || !hardenedNpmDownloadSource.includes("downloadHardenedNpmArtifact") || !hardenedNpmDownloadSource.includes("DOWNLOAD_ATTEMPTS = 3")
    || !hardenedNpmDownloadSource.includes("createHardenedDownloadTimeout") || !hardenedNpmDownloadSource.includes("timeout.progress()")
    || !hardenedNpmDownloadSource.includes("retryableDownloadError") || hardenedNpmDownloadSource.includes("timer.unref")
    || !hardenedNpmDownloadTimeoutSource.includes("DEFAULT_IDLE_TIMEOUT_MS = 60_000")
    || !hardenedNpmDownloadTimeoutSource.includes("DEFAULT_MAXIMUM_DURATION_MS = 300_000")
    || !hardenedNpmDownloadTimeoutSource.includes("download stalled") || !hardenedNpmDownloadTimeoutSource.includes("maximum duration")
    || hardenedNpmDownloadTimeoutSource.includes(".unref")
    || !hardenedNpmVerificationSource.includes("throwOperationalOrIntegrity")
    || !hardenedNpmVerificationSource.includes("HARDENED_NPM_MARKER")) {
  throw new Error("pinned npm bootstrap lost its hardened exact tarballs, bounded proxy-aware download, SHA-512 integrity, or redirect boundary");
}
const sourceWrapper = readFileSync(join(root, "mbm"), "utf8");
if (!sourceWrapper.includes("npm ci") || /npm install(?:\s|$)/.test(sourceWrapper)) throw new Error("source wrapper no longer installs from the committed lockfile");
const dependabotSource = readFileSync(join(root, ".github", "dependabot.yml"), "utf8");
if (!dependabotSource.includes("groups:") || !dependabotSource.includes("github-actions:") || !dependabotSource.includes('- "*"')) {
  throw new Error("Dependabot no longer groups coupled GitHub Action updates atomically");
}
const codeqlWorkflowSource = readFileSync(join(root, ".github", "workflows", "codeql.yml"), "utf8");
if (!codeqlWorkflowSource.includes("scripts/sarif-security-gate.mjs") || !codeqlWorkflowSource.includes("steps.analyze.outputs.sarif-output")) {
  throw new Error("CodeQL workflow no longer fails on unaccepted SARIF findings");
}
const scorecardWorkflowSource = readFileSync(join(root, ".github", "workflows", "scorecard.yml"), "utf8").replace(/\r\n/g, "\n");
const scorecardAnalysisBlock = scorecardWorkflowSource.split(/\n  gate:\n/, 1)[0];
if (!scorecardWorkflowSource.includes("name: Scorecard gate")
    || !scorecardWorkflowSource.includes("needs: analysis")
    || !scorecardWorkflowSource.includes("actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c")
    || !scorecardWorkflowSource.includes("scripts/sarif-security-gate.mjs .scorecard-results/results.sarif")
    || !scorecardWorkflowSource.includes(".github/scorecard-accepted-findings.json")) {
  throw new Error("Scorecard workflow no longer separates signed analysis from the reviewed SARIF gate");
}
if (scorecardAnalysisBlock.includes("\n        run:") || scorecardAnalysisBlock.includes("\n      - run:")) {
  throw new Error("Scorecard signed analysis job contains a run step rejected by the Scorecard verifier");
}
const codeqlActionRefs = [...`${codeqlWorkflowSource}\n${scorecardWorkflowSource}`.matchAll(/github\/codeql-action\/(?:init|analyze|upload-sarif)@([0-9a-f]{40})/g)].map((match) => match[1]);
if (codeqlActionRefs.length !== 3 || new Set(codeqlActionRefs).size !== 1) {
  throw new Error("CodeQL init, analyze, and upload-sarif must use one atomic immutable action commit");
}
const scorecardAccepted = JSON.parse(readFileSync(join(root, ".github", "scorecard-accepted-findings.json"), "utf8"));
const acceptedScorecardRules = new Set((scorecardAccepted.accepted || []).map((item) => item.ruleId));
for (const rule of ["CodeReviewID", "MaintainedID", "CIIBestPracticesID", "SASTID"]) {
  if (!acceptedScorecardRules.has(rule)) throw new Error(`Scorecard governance exception is missing: ${rule}`);
}
for (const rule of ["PinnedDependenciesID", "FuzzingID"]) {
  if (acceptedScorecardRules.has(rule)) throw new Error(`remediable Scorecard finding was incorrectly accepted: ${rule}`);
}
const codeqlAccepted = JSON.parse(readFileSync(join(root, ".github", "codeql-accepted-findings.json"), "utf8"));
const acceptedCodeql = new Set((codeqlAccepted.accepted || []).map((item) => `${item.ruleId}\0${item.path}`));
const expectedCodeql = new Set([
  "js/shell-command-injection-from-environment\0src/local/process-execution.mjs",
  "js/indirect-command-line-injection\0src/local/process-execution.mjs",
  "js/insufficient-password-hash\0src/local/account-admin.mjs",
]);
if (acceptedCodeql.size !== expectedCodeql.size || [...expectedCodeql].some((item) => !acceptedCodeql.has(item))) {
  throw new Error("CodeQL exception inventory contains an unreviewed or missing exact finding");
}
const processExecutionSource = readLfSource("src", "local", "process-execution.mjs");
const shellSource = readFileSync(join(root, "src", "local", "shell.mjs"), "utf8");
if (!processExecutionSource.includes('import { spawn } from "node:child_process";')
    || !processExecutionSource.includes("function spawnDirectProcess")
    || !processExecutionSource.includes("return spawn(command, args, {")
    || !processExecutionSource.includes("shell: false,")
    || processExecutionSource.includes("...options")) {
  throw new Error("direct process execution lost its fixed-option non-shell child_process boundary");
}
if (processExecutionSource.includes('child.on("error", (error) => {\n        void cleanupAfterClose()')
    || !processExecutionSource.includes('child.on("error", (error) => { childError ||= error; })')) {
  throw new Error("one-shot process execution again releases ownership directly from child error before close");
}
if (shellSource.includes('child.on("error", error => finish(')
    || !shellSource.includes('child.on("error", error => { childError ||= error; })')) {
  throw new Error("internal executable execution again settles directly from child error before close");
}
for (const required of ["terminateProcessTreeAndWait", "hardTermination", "termination_settled"]) {
  if (!shellSource.includes(required)) throw new Error(`internal hard timeout lost process-tree settlement barrier: ${required}`);
}
const processTreeForceSettlementSource = readFileSync(join(root, "src", "local", "process-tree-force-settlement.mjs"), "utf8");
for (const required of ['"taskkill.exe"', '"/T"', '"/F"', 'killer.once?.("close"', "DEFAULT_FORCE_TREE_SETTLEMENT_MS"]) {
  if (!processTreeForceSettlementSource.includes(required)) throw new Error(`Windows force-tree settlement lost bounded taskkill proof: ${required}`);
}
const processTreeSupervisorSource = readFileSync(join(root, "src", "local", "process-tree-supervisor.mjs"), "utf8");
for (const required of ["createSnapshotBudget", "boundedSnapshotOptions", "processSnapshotTimeoutMs", "processTreeOwnershipStillCurrent"]) {
  if (!processTreeSupervisorSource.includes(required)) throw new Error(`process-tree supervisor lost bounded ownership escalation: ${required}`);
}
if (packageJson.devDependencies?.["fast-check"] !== "4.9.0" || !readFileSync(join(root, "tests", "security-properties-test.js"), "utf8").includes('from "fast-check"')) {
  throw new Error("recognized JavaScript property-based fuzzing coverage is missing");
}
const releaseSource = readFileSync(join(root, "scripts", "github-release.mjs"), "utf8");
if (!releaseSource.includes('import { requireSuccessfulWorkflowRun } from "./release-ci.mjs";')
    || !releaseSource.includes('import { verifyCurrentReleaseAcceptance } from "./release-acceptance.mjs";')
    || !releaseSource.includes('import { verifyCurrentStableSoak } from "./release-soak.mjs";')
    || !releaseSource.includes("--publish-prerelease")
    || !releaseSource.includes("--prerelease")
    || !releaseSource.includes("--latest=false")
    || (releaseSource.match(/assertSuccessfulCi\(head\);/g) || []).length !== 2
    || !releaseSource.includes(".github/workflows/codeql.yml")
    || !releaseSource.includes(".github/workflows/scorecard.yml")
    || !releaseSource.includes(".github/workflows/governance.yml")
    || !releaseSource.includes(".github/workflows/workflow-policy.yml")
    || releaseSource.includes('["push", "origin", "HEAD:main"]')
    || !releaseSource.includes("HEAD does not match origin/main; local acceptance must be committed")) {
  throw new Error("GitHub release orchestration lost owner acceptance, exact-commit gates, or the no-main-push boundary");
}
const githubPushSource = readFileSync(join(root, "scripts", "github-push.mjs"), "utf8");
for (const required of ["verifyCurrentReleaseAcceptance", "verifyCurrentStableSoak", "working tree is not clean", "direct pushes to main are prohibited", "--set-upstream", "release-acceptance/v", "release-soak/v"]) {
  if (!githubPushSource.includes(required)) throw new Error(`guarded GitHub push lost required boundary: ${required}`);
}
if (githubPushSource.includes("interactive local candidate")) {
  throw new Error("guarded GitHub push retained obsolete interactive-acceptance wording");
}
const portableAcceptanceVerifier = readFileSync(join(root, ".github", "scripts", "verify-release-acceptance.mjs"), "utf8");
if (portableAcceptanceVerifier.includes("interactive local candidate")) {
  throw new Error("portable release-acceptance verification retained obsolete interactive-acceptance wording");
}
for (const [name, command] of Object.entries(packageJson.scripts || {})) {
  const match = /^node\s+([^\s]+\.mjs)(?:\s|$)/.exec(String(command));
  if (match && !existsSync(join(root, match[1]))) throw new Error(`package script ${name} references missing ${match[1]}`);
}
const packaged = new Set(packageJson.files || []);
if (!packaged.has("scripts") || !packaged.has("src/local") || !packaged.has("tsconfig.local.json")
    || !packaged.has("CODE_OF_CONDUCT.md") || !packaged.has("SUPPORT.md") || !packaged.has("GOVERNANCE.md")) {
  throw new Error("package files omit executable scripts, local runtime, type contract, or governance documents");
}
const localTypeConfig = JSON.parse(readFileSync(join(root, "tsconfig.local.json"), "utf8"));
for (const required of [
  "src/local/policy.mjs", "src/local/call-registry.mjs", "src/local/agent-contract.mjs",
  "src/local/browser-extension-protocol.mjs", "src/local/monotonic-deadline.mjs",
  "src/local/runtime-paths.mjs", "src/local/agent-context-projection.mjs",
  "src/local/agent-skill-discovery.mjs", "src/local/agent-text-file.mjs",
  "src/local/managed-job-projection.mjs",
]) {
  if (!localTypeConfig.include?.includes(required)) throw new Error(`local type contract omits ${required}`);
  if (!readFileSync(join(root, required), "utf8").startsWith("// @ts-check")) throw new Error(`${required} is not opt-in strict checked JavaScript`);
}


const pinnedInstallCommand = "npx --yes npm@12.0.2 install --global --omit=optional --allow-scripts=esbuild,workerd,sharp,fsevents machine-bridge-mcp@latest";
if (packageJson.engines?.npm !== ">=12.0.0") throw new Error("package metadata no longer declares the npm 12 runtime requirement");
const installSmokeSource = readFileSync(join(root, "tests", "install-smoke-test.mjs"), "utf8");
if (!installSmokeSource.includes("package-free-cwd") || !installSmokeSource.includes('pkg.engines?.npm !== ">=12.0.0"')) {
  throw new Error("global install test no longer validates package-free npm 12 installation metadata");
}
for (const required of ["assertInstalledDefaultStartup", "node_modules", "wrangler", "bin", "wrangler.js", "startup-probe-wrangler", "installed zero-argument startup", "ReferenceError", "is not defined"]) {
  if (!installSmokeSource.includes(required)) throw new Error(`global install test lost default-startup assertion: ${required}`);
}
for (const file of [join(root, "README.md"), join(root, "docs", "OPERATIONS.md")]) {
  const guidance = readFileSync(file, "utf8").replace(/\s+/g, " ");
  if (!guidance.includes(pinnedInstallCommand) || !guidance.includes('Invalid property "node"')) {
    throw new Error(`pinned npm bootstrap guidance drifted in ${relative(root, file)}`);
  }
}
for (const file of [
  join(root, "AGENTS.md"),
  join(root, "CONTRIBUTING.md"),
  join(root, "docs", "ENGINEERING.md"),
]) {
  const normalized = readFileSync(file, "utf8").replace(/\s+/g, " ");
  for (const required of [
    directCandidateVerifyCommand,
    "release:candidate:activate -- --allow-worker-deploy",
    "prerelease:publish",
    "prerelease:install -- --allow-worker-deploy",
    "release:soak:verify",
    "stable:publish",
  ]) {
    if (!normalized.includes(required)) throw new Error(`prerelease/soak guidance drifted in ${relative(root, file)}: ${required}`);
  }
}
if (!cliSource.replace(/\s+/g, " ").includes(`${pinnedInstallCommand} && machine-mcp`)) throw new Error("CLI pinned npm installation guidance drifted from user documentation");

const architecture = readFileSync(join(root, "docs", "ARCHITECTURE.md"), "utf8");
for (const stale of [
  "State schema version 5",
  "does not distinguish independently authorized human principals",
  "Duplicate in-flight JSON-RPC IDs for the same access token",
  "multiple OAuth client registrations currently share one workspace authority",
]) {
  if (architecture.includes(stale)) throw new Error(`architecture documentation retained stale authorization/state claim: ${stale}`);
}
if (!architecture.includes("State schema version 6") || !architecture.includes("monotonic elapsed time") || !architecture.includes("Persisted timestamps and retention/credential expiry continue to use wall time")) {
  throw new Error("architecture documentation omitted the current state schema or monotonic deadline contract");
}
const workerToolTimeoutSource = readFileSync(join(root, "src", "worker", "tool-timeout.ts"), "utf8");
const managedJobReadTimeoutSource = readFileSync(join(root, "src", "worker", "managed-job-read-timeout.ts"), "utf8");
const workerRuntimeSource = readFileSync(join(root, "src", "worker", "index.ts"), "utf8");
const processSessionReadSource = readFileSync(join(root, "src", "local", "process-session-read.mjs"), "utf8");
if (!workerToolTimeoutSource.includes("relayContract.processSessionStartExecutionTimeoutMs")) {
  throw new Error("process-session startup timeout drifted out of the shared relay contract");
}
const serverInfoToolDeliverySource = readFileSync(join(root, "src", "worker", "server-info-tool-delivery.ts"), "utf8");
const serverInfoSource = readFileSync(join(root, "src", "worker", "server-info.ts"), "utf8");
if (!serverInfoToolDeliverySource.includes("remote_process_session_start_execution_max_ms")
    || !serverInfoToolDeliverySource.includes("managed_job_resource_admission_wait_max_ms")
    || !serverInfoToolDeliverySource.includes("remote_managed_job_read_wait_default_ms")
    || !serverInfoToolDeliverySource.includes("remote_managed_job_read_wait_max_ms")
    || !serverInfoToolDeliverySource.includes("remote_managed_job_read_nonterminal_progress_minimum_ms")
    || !serverInfoToolDeliverySource.includes("compactRemoteToolDeliveryContract")
    || !serverInfoToolDeliverySource.includes("delete compact.remote_managed_job_read_nonterminal_progress_minimum_ms")
    || !serverInfoToolDeliverySource.includes("delete compact.remote_process_blocking_poll_wait_max_ms")
    || !serverInfoSource.includes("...compactRemoteToolDeliveryContract(input.serverVersion, input.toolListSubscription)")
    || !serverInfoSource.includes("...remoteToolDeliveryContract(input.serverVersion, input.toolListSubscription)")
    || !serverInfoToolDeliverySource.includes("remote_managed_job_read_concurrency_max_per_account")
    || !serverInfoToolDeliverySource.includes("MAX_PENDING_READ_JOB_CALLS_PER_ACCOUNT")
    || !serverInfoToolDeliverySource.includes("tool_schema_generation")
    || !serverInfoToolDeliverySource.includes("tool_schema_server_version")
    || !serverInfoToolDeliverySource.includes("discovery_ttl_ms")
    || !serverInfoToolDeliverySource.includes("tool_list_ttl_ms")
    || !serverInfoToolDeliverySource.includes("host_visible_schema_known_to_server: false")
    || !serverInfoToolDeliverySource.includes("tools_list_change_subscription_supported: true")
    || !serverInfoToolDeliverySource.includes("tools_list_change_subscription_active_for_account")
    || !serverInfoToolDeliverySource.includes("tools_list_change_subscription_opened_for_account")
    || !serverInfoToolDeliverySource.includes("tools_list_change_subscription_client_receipt_observable: false")
    || !serverInfoToolDeliverySource.includes("tools_list_change_subscription_lease_ms")
    || !serverInfoToolDeliverySource.includes("host_turn_deadline_observable: false")
    || !serverInfoToolDeliverySource.includes("managed_jobs_detached_from_mcp_response: true")
    || serverInfoToolDeliverySource.includes("remote_process_foreground_execution_max_ms")
    || serverInfoToolDeliverySource.includes("remote_process_resource_admission_wait_max_ms")
    || "maximumProcessForegroundExecutionTimeoutMs" in relayContract) {
  throw new Error("server_info or relay contract retained an obsolete/mis-scoped process timing projection");
}
if (relayContract.defaultManagedJobReadWaitMs !== 40_000
    || relayContract.maximumManagedJobReadWaitMs !== 300_000
    || relayContract.managedJobReadPollIntervalMs !== 5_000
    || relayContract.managedJobReadNonterminalProgressMinimumMs !== 30_000
    || relayContract.managedJobReadReconcileIntervalMs !== 30_000
    || relayContract.managedJobReadExecutionHeadroomMs !== 10_000
    || relayContract.maximumOrdinaryRelayToolTimeoutMs !== 50_000
    || relayContract.maximumRelayToolTimeoutMs !== 315_000
    || Math.ceil((100 * 60 * 1000) / relayContract.defaultManagedJobReadWaitMs) > 150
    || Math.ceil((100 * 60 * 1000) / relayContract.managedJobReadNonterminalProgressMinimumMs) > 200
    || !workerToolTimeoutSource.includes('name === "read_job"')
    || !managedJobReadTimeoutSource.includes("managedJobReadArgumentsWithinExecutionBudget")
    || !managedJobReadTimeoutSource.includes("managedJobReadExecutionBudgetHasHeadroom")
    || !managedJobReadTimeoutSource.includes("relayContract.managedJobReadExecutionHeadroomMs")
    || !managedJobReadTimeoutSource.includes("executionMs - relayContract.managedJobReadExecutionHeadroomMs")
    || !managedJobReadTimeoutSource.includes("relayContract.workerSettlementOverheadMs")
    || !workerRuntimeSource.includes("managedJobReadArgumentsWithinExecutionBudget(args, dispatchBudget.executionTimeoutMs)")
    || !workerRuntimeSource.includes("managedJobReadArgumentsWithinExecutionBudget(args, remainingExecutionMs)")
    || (workerRuntimeSource.match(/managedJobReadExecutionBudgetHasHeadroom/g) || []).length < 3
    || !workerRuntimeSource.includes("immediateReadyDaemonForDispatch(this.daemonRegistry) ?? await readyDaemonForDispatch")) {
  throw new Error("managed-job hosted long-poll pacing or anti-amplification density bound drifted from the host-safe forty-second default / thirty-second progress coalescing / five-minute opt-in contract");
}
const mcpResponseProxySource = readFileSync(join(root, "src", "worker", "mcp-response-proxy.ts"), "utf8");
const mcpResponseCancelSource = readFileSync(join(root, "src", "worker", "mcp-response-cancel.ts"), "utf8");
if (relayContract.streamCancelTimeoutMs !== 2_000
    || !mcpResponseProxySource.includes("cancelMcpResponseStream")
    || !mcpResponseCancelSource.includes("CANCEL_CONTROL_TIMEOUT_MS")
    || !mcpResponseCancelSource.includes("private stream cancellation settlement timed out")
    || !readFileSync(join(root, "tests", "mcp-response-proxy-test.mjs"), "utf8").includes("stalled private cancellation kept the public response stream open indefinitely")) {
  throw new Error("public MCP stream cancellation lost its bounded private-control settlement deadline");
}
if (!workerMcpConfigSource.includes("MCP_SERVER_CAPABILITIES = Object.freeze({ tools: Object.freeze({ listChanged: true }) })")
    || !workerMcpConfigSource.includes("MCP_LEGACY_SERVER_CAPABILITIES = Object.freeze({ tools: Object.freeze({ listChanged: false }) })")
    || !mcpSubscriptionCapacitySource.includes("MAX_ACTIVE_MCP_SUBSCRIPTIONS = 32")
    || !mcpSubscriptionCapacitySource.includes("MAX_ACTIVE_MCP_SUBSCRIPTIONS_PER_ACCOUNT = 8")
    || !mcpSubscriptionCapacitySource.includes("MAX_OPENED_MCP_SUBSCRIPTION_ACCOUNTS = 64")
    || !mcpSubscriptionCapacitySource.includes("accountActive >= MAX_ACTIVE_MCP_SUBSCRIPTIONS_PER_ACCOUNT")
    || !mcpControllerSource.includes("Subscription capacity exceeded")
    || !mcpControllerSource.includes("subscriptionAcknowledgement(body.id, { toolsListChanged: true })")
    || !mcpControllerSource.includes("toolsListChangedNotification(body.id)")
    || !mcpControllerSource.includes("new McpSubscriptionRegistry()")
    || !mcpControllerSource.includes("this.subscriptions.cancelRequest(requestKey)")
    || !mcpControllerSource.includes("this.subscriptions.cancelAuthority(revocation)")
    || !mcpControllerSource.includes("this.subscriptions.open({")
    || !mcpSubscriptionRegistrySource.includes("new McpSubscriptionCapacity()")
    || !mcpSubscriptionRegistrySource.includes("recordMatchesAuthorityRevocation")
    || !mcpSubscriptionRegistrySource.includes("cancelAuthority(revocation")
    || !mcpSubscriptionRegistrySource.includes("this.active.delete(active)")
    || !mcpSubscriptionRegistrySource.includes("cancelByRequestKey")
    || !mcpSubscriptionRegistrySource.includes("openSubscriptionResponse")
    || !mcpSubscriptionRegistrySource.includes('input.requestSignal.addEventListener("abort"')
    || !mcpSubscriptionRegistrySource.includes("this.cancelByRequestKey.set(input.requestKey, cancel)")
    || !mcpSubscriptionRegistrySource.includes("releaseCapacity()")
    || !workerRuntimeSource.includes("cancelReadyDaemonAuthority(this.daemonRegistry, revocation)")
    || !workerRuntimeSource.includes("this.mcp.cancelAuthority(revocation)")
    || !workerRuntimeSource.includes("authority.revocation.pre_dispatch_waiters_cancelled")) {
  throw new Error("current MCP tool-list freshness/capacity no longer serves bounded toolsListChanged subscriptions while legacy capability remains isolated");
}
if (!workerToolTimeoutSource.includes('name === "read_process"')
    || !workerToolTimeoutSource.includes("waitMs === 0 ? 5_000 : relayContract.defaultRemoteToolExecutionTimeoutMs")
    || !processSessionReadSource.includes("const cooldownDeadline = createMonotonicDeadline(remoteRead.cooldownWaitMs, now)")
    || !processSessionReadSource.includes("while (session.closedAt === null && !cooldownDeadline.expired())")) {
  throw new Error("read_process no longer keeps explicit-zero reads short or server-paces wait_for_exit through the cooldown");
}
if (relayContract.newCallReconnectGraceMs !== 15_000
    || relayContract.transportPingIntervalMs !== 5_000
    || relayContract.transportPingDispatchTimeoutMs !== 30_000
    || relayContract.transportPongTimeoutMs !== 10_000
    || relayContract.transportApplicationConfirmationTimeoutMs !== 15_000
    || relayContract.transportPingDispatchTimeoutMs <= relayContract.transportPongTimeoutMs
    || relayContract.daemonApplicationHeartbeatIntervalMs !== 25_000
    || relayContract.daemonApplicationHeartbeatTimeoutMs !== 75_000
    || relayContract.httpFallbackPollIntervalMs !== 1_000
    || relayContract.httpFallbackMinimumRequestIntervalMs !== 750
    || relayContract.httpFallbackStandbyRetryIntervalMs !== 5_000
    || relayContract.httpFallbackFailureBackoffBaseMs !== 1_000
    || relayContract.httpFallbackFailureBackoffMaximumMs !== 5_000
    || relayContract.httpFallbackActivationDelayMs !== 1_500
    || relayContract.httpFallbackRequestTimeoutMs !== 7_000
    || relayContract.httpFallbackLivenessTimeoutMs !== 12_000
    || relayContract.httpFallbackRequestTimeoutMs * 2 > relayContract.newCallReconnectGraceMs
    || 60_000 / relayContract.httpFallbackMinimumRequestIntervalMs > 80
    || relayContract.defaultRemoteToolExecutionTimeoutMs !== 20_000
    || relayContract.processSessionStartExecutionTimeoutMs !== 10_000
    || relayContract.maximumManagedJobResourceAdmissionWaitMs !== 1_800_000) {
  throw new Error("relay liveness, hosted reply-safety, or managed-job admission timing contract drifted from the incident-reviewed budget");
}
const relayHeartbeatSource = readFileSync(join(root, "src", "local", "relay-heartbeat.mjs"), "utf8");
const relayLivenessSource = readFileSync(join(root, "src", "local", "relay-liveness.mjs"), "utf8");
const relayInboundStateSource = readFileSync(join(root, "src", "local", "relay-inbound-state.mjs"), "utf8");
const relayProbeDispatchSource = readFileSync(join(root, "src", "local", "relay-probe-dispatch.mjs"), "utf8");
const relayTransportProbeSendSource = readFileSync(join(root, "src", "local", "relay-transport-probe-send.mjs"), "utf8");
const relayLivenessActionsSource = readFileSync(join(root, "src", "local", "relay-liveness-actions.mjs"), "utf8");
const relayConnectionSource = readFileSync(join(root, "src", "local", "relay-connection.mjs"), "utf8");
const relayTransportConfirmationSource = readFileSync(join(root, "src", "local", "relay-transport-confirmation.mjs"), "utf8");
const httpRelayConnectionSource = readFileSync(join(root, "src", "local", "daemon-http-relay-connection.mjs"), "utf8");
const deviceIdentitySource = readFileSync(join(root, "src", "local", "device-identity.mjs"), "utf8");
const deviceSessionAuthSource = readFileSync(join(root, "src", "shared", "device-session-auth.mjs"), "utf8");
if (!relayHeartbeatSource.includes("probeDispatch.complete")
    || !relayHeartbeatSource.includes("satisfiedByProof")
    || !relayHeartbeatSource.includes("probeDeadline.sent(dispatchedAt, true)")
    || !relayLivenessSource.includes("this.inbound.observeApplicationInbound(this.application)")
    || !relayLivenessSource.includes("this.inbound.observeApplicationProof(this.transport, this.application)")
    || !relayInboundStateSource.includes("observeApplicationInbound(application)")
    || !relayInboundStateSource.includes("observeApplicationProof(transport, application)")
    || !relayInboundStateSource.replaceAll("\r\n", "\n").includes("transport.observeInbound();\n    application.observeInbound();")
    || relayProbeDispatchSource.includes("satisfiedByInbound")
    || relayProbeDispatchSource.includes("last_probe_dispatch_inbound_recovery_age_ms")
    || !relayTransportProbeSendSource.includes("socket.ping((error) =>")
    || !relayLivenessActionsSource.includes("relay_transport_send_timeout")
    || !relayConnectionSource.includes("observeApplicationPong(relayContext = {})")
    || !relayConnectionSource.includes("if (this.socket !== socket || this.closed) return;")
    || !relayConnectionSource.includes("const DEFAULT_CONNECT_TIMEOUT_MS = 30_000")
    || !relayConnectionSource.includes("perMessageDeflate: false")
    || !relayTransportConfirmationSource.includes("this.dispatch.cancel(token)")
    || !relayTransportConfirmationSource.includes("transport_confirmation_pending")
    || !httpRelayConnectionSource.includes("this.standbyRetryIntervalMs")
    || !httpRelayConnectionSource.includes("this.consecutiveFailures > 0")
    || !httpRelayConnectionSource.includes("this.pollTimerDueAt <= dueAt")
    || !deviceSessionAuthSource.includes("24 * 60 * 60")
    || !deviceIdentitySource.includes('code: "device_session_expired"')
    || !relayConnectionSource.includes("relay_device_session_expired")) {
  throw new Error("relay Ping/confirmation/connect hardening or 24-hour daemon-session recovery contract regressed");
}
const resourceAdmissionPolicySource = readFileSync(join(root, "src", "local", "resource-admission-policy.mjs"), "utf8");
const resourceAdmissionSource = readFileSync(join(root, "src", "local", "resource-admission.mjs"), "utf8");
for (const [source, required] of [
  [resourceAdmissionPolicySource, "cpu_request_exceeds_launch_window"],
  [resourceAdmissionPolicySource, "resourceAdmissionDecisionRetryable"],
  [resourceAdmissionSource, "!resourceAdmissionDecisionRetryable(lastDecision)"],
  [resourceProcessAdmissionSource, "reduce explicit parallelism or resource demand"],
]) {
  if (!source.includes(required)) throw new Error(`resource admission lost structural-capacity fail-fast contract: ${required}`);
}
const readme = readFileSync(join(root, "README.md"), "utf8");
const testingDoc = readFileSync(join(root, "docs", "TESTING.md"), "utf8");
const computerUseDoc = readFileSync(join(root, "docs", "COMPUTER_USE.md"), "utf8");
const loggingDoc = readFileSync(join(root, "docs", "LOGGING.md"), "utf8");
const operationsDoc = readFileSync(join(root, "docs", "OPERATIONS.md"), "utf8");
const privacyDoc = readFileSync(join(root, "docs", "PRIVACY.md"), "utf8");
const managedJobsDoc = readFileSync(join(root, "docs", "MANAGED_JOBS.md"), "utf8");
const multiAccountDoc = readFileSync(join(root, "docs", "MULTI_ACCOUNT.md"), "utf8");
const serverMetadata = readFileSync(join(root, "src", "shared", "server-metadata.json"), "utf8");
for (const [file, content, stale] of [
  ["README.md", readme, "ordinary daemon tools use at most 30 seconds"],
  ["README.md", readme, "Remote foreground process, shell, browser, and application calls are bounded to 60 seconds"],
  ["docs/COMPUTER_USE.md", computerUseDoc, "The first mandatory post observation keeps the normal read-only action timeout"],
  ["docs/ARCHITECTURE.md", architecture, "may wait at most ten seconds"],
  ["docs/ARCHITECTURE.md", architecture, "process-session startup defaults to ten seconds"],
  ["docs/ARCHITECTURE.md", architecture, "general host snapshot as fresh for 1.5 seconds"],
  ["docs/ARCHITECTURE.md", architecture, "ordinary daemon tools at 30 seconds"],
  ["docs/TESTING.md", testingDoc, "hosted timeout projection (30-second ordinary"],
  ["docs/TESTING.md", testingDoc, "Ordinary daemon tools use at most 30 seconds"],
  ["docs/TESTING.md", testingDoc, "a 60-second call that spends ten seconds in recovery"],
  ["docs/TESTING.md", testingDoc, "`full-access:test` exercises the same real-machine wait path with an explicit five-minute cooperative admission budget"],
  ["docs/TESTING.md", testingDoc, "`local-self-test` uses the same five-minute budget"],
  ["docs/TESTING.md", testingDoc, "`agent-context-test` uses the same test-only five-minute budget"],
  ["docs/OPERATIONS.md", operationsDoc, "process timeout above 30 seconds"],
  ["src/shared/server-metadata.json", serverMetadata, "Ordinary daemon-backed tools use at most 30 seconds"],
  ["src/shared/server-metadata.json", serverMetadata, "are capped at 30 seconds"],
  ["src/shared/server-metadata.json", serverMetadata, "For multi-step, remote, long-running, or cleanup-sensitive work"],
]) {
  if (content.includes(stale)) throw new Error(`${file} retained stale hosted timing guidance: ${stale}`);
}
for (const [file, content, required] of [
  ["README.md", readme, "Hosted synchronous calls otherwise retain their ordinary 20-second execution plus separate five-second Worker settlement margin"],
  ["README.md", readme, "compound `computer_observe` / `computer_act` retain 30-second defaults"],
  ["README.md", readme, "independent fifteen-second application-confirmation window"],
  ["README.md", readme, "A protocol Pong or explicit application `pong` during that second stage preserves WSS"],
  ["README.md", readme, "WSS connect attempts have a thirty-second outer budget"],
  ["README.md", readme, "The daemon sends `resume_calls_ack.missing_ids` only after replacement readiness"],
  ["docs/COMPUTER_USE.md", computerUseDoc, "one end-to-end observation budget"],
  ["docs/COMPUTER_USE.md", computerUseDoc, "Every post-action capture, including the first mandatory one, is capped by both"],
  ["docs/ARCHITECTURE.md", architecture, "compound `computer_observe` and `computer_act` default to 30 seconds"],
  ["docs/ARCHITECTURE.md", architecture, "fifteen-second application-confirmation window"],
  ["docs/ARCHITECTURE.md", architecture, "thirty-second per-attempt connect budget"],
  ["docs/ARCHITECTURE.md", architecture, "application heartbeat/confirmation is gated on verified readiness"],
  ["docs/ARCHITECTURE.md", architecture, "`resume_calls_ack.missing_ids`"],
  ["docs/ARCHITECTURE.md", architecture, "no possibly executed tool call is automatically replayed"],
  ["docs/ARCHITECTURE.md", architecture, "`previous_ready_inbound_silence_ms`"],
  ["docs/ARCHITECTURE.md", architecture, "`recent_outages`, a newest-first in-memory ring capped at eight completed reconnect episodes"],
  ["docs/TESTING.md", testingDoc, "compound `computer_observe`/`computer_act` default to 30 seconds"],
  ["docs/TESTING.md", testingDoc, "five-second protocol-level transport probe"],
  ["docs/TESTING.md", testingDoc, "thirty-second local sender-dispatch bound, full ten-second response deadline measured only from confirmed probe dispatch"],
  ["docs/TESTING.md", testingDoc, "same-instance `resume_calls_ack.missing_ids` settlement"],
  ["docs/TESTING.md", testingDoc, "`previous_ready_inbound_silence_ms` retention"],
  ["docs/TESTING.md", testingDoc, "`recent_outages` to remain newest-first and capped at eight"],
  ["docs/OPERATIONS.md", operationsDoc, "compound `computer_observe` and `computer_act` default to 30 seconds"],
  ["docs/OPERATIONS.md", operationsDoc, "while a confirmed Ping retains its full ten-second Pong deadline"],
  ["docs/OPERATIONS.md", operationsDoc, "`last_connect_milestones_ms` contains only bounded relative timings"],
  ["docs/OPERATIONS.md", operationsDoc, "takeover of the Worker-issued `connection_id` for that exact disconnected WebSocket generation"],
  ["docs/LOGGING.md", loggingDoc, "`daemon.websocket.closed` records only a bounded close code plus `was_clean`"],
  ["docs/OPERATIONS.md", operationsDoc, "`resume_calls_ack.missing_ids`"],
  ["docs/OPERATIONS.md", operationsDoc, "`previous_ready_inbound_silence_ms` measures how long"],
  ["docs/OPERATIONS.md", operationsDoc, "`recent_outages`, a newest-first in-memory history capped at eight completed WebSocket reconnect episodes"],
  ["docs/OPERATIONS.md", operationsDoc, "`remote_managed_job_initial_settlement_wait_ms`"],
  ["docs/OPERATIONS.md", operationsDoc, "`server_info.daemon.previous_connection` retains only the last verified channel's transport"],
  ["docs/OPERATIONS.md", operationsDoc, "`diagnose_runtime.runtime.idle_sleep_guard`"],
  ["docs/TESTING.md", testingDoc, "distinct from production ownership"],
  ["docs/TESTING.md", testingDoc, "full execution lifetime"],
  ["docs/ARCHITECTURE.md", architecture, "fixed thirty-minute inactivity grace begins only after the last handler settles"],
  ["docs/ARCHITECTURE.md", architecture, "Remote account managed-job runners do not depend on daemon ownership"],
  ["docs/OPERATIONS.md", operationsDoc, "the thirty-minute default inactivity grace begins only after the last one settles"],
  ["docs/OPERATIONS.md", operationsDoc, "A remote `start_process` extends the same assertion only after resource admission succeeds"],
  ["docs/OPERATIONS.md", operationsDoc, "Remote account managed-job runners independently hold `/usr/bin/caffeinate -i -s -w <runner-pid>`"],
  ["docs/LOGGING.md", loggingDoc, "opens one fifteen-second application-confirmation window"],
  ["docs/LOGGING.md", loggingDoc, "`daemon.calls.not_received_after_reconnect` retains the same aggregate-only `calls` shape"],
  ["docs/LOGGING.md", loggingDoc, "`daemon.calls.redelivered_after_proven_non_delivery` with only an aggregate `calls` count"],
  ["docs/LOGGING.md", loggingDoc, "runtime.idle_sleep_guard.unavailable"],
  ["docs/LOGGING.md", loggingDoc, "`previous_ready_inbound_silence_ms`"],
  ["docs/ARCHITECTURE.md", architecture, "waits at most fifteen seconds"],
  ["docs/ARCHITECTURE.md", architecture, "`daemon-last-observation.ts` owns one in-memory, privacy-bounded last-verified-channel observation"],
  ["docs/ARCHITECTURE.md", architecture, "relay-origin `start_process` performs one admission attempt without queueing"],
  ["docs/ARCHITECTURE.md", architecture, "same-project general host snapshot as fresh for 500 milliseconds"],
  ["docs/ARCHITECTURE.md", architecture, "cpu_request_exceeds_launch_window"],
  ["docs/ARCHITECTURE.md", architecture, "explicit stop while the first connection is still waiting for readiness"],
  ["docs/ARCHITECTURE.md", architecture, "malformed internal timing cannot become an infinite timer"],
  ["docs/ARCHITECTURE.md", architecture, "Detached managed-job steps use the shared durable-delivery admission ceiling"],
  ["docs/ARCHITECTURE.md", architecture, "`waiters.drain_active`"],
  ["docs/TESTING.md", testingDoc, "relay-origin `start_process` defaults to zero admission wait"],
  ["docs/TESTING.md", testingDoc, "shared fifteen-second new-call recovery budget"],
  ["docs/TESTING.md", testingDoc, "same-ID transparent redelivery only after post-readiness `resume_calls_ack.missing_ids`"],
  ["docs/TESTING.md", testingDoc, "Ordinary daemon tools default to 20 seconds plus the separate Worker settlement margin"],
  ["docs/TESTING.md", testingDoc, "explicit stop-before-first-readiness settlement"],
  ["docs/TESTING.md", testingDoc, "reject non-finite, non-positive, non-integer, and over-contract operation/reconnect delays"],
  ["docs/TESTING.md", testingDoc, "remote release verification"],
  ["docs/TESTING.md", testingDoc, "larger explicit step timeout"],
  ["docs/TESTING.md", testingDoc, "eight-worker fixed request on an idle eight-core interactive host fails immediately"],
  ["docs/TESTING.md", testingDoc, "privacy-safe `drain_active` fairness signal"],
  ["docs/TESTING.md", testingDoc, "`read_job.current_phase=resource_admission` distinguishes that state from child execution"],
  ["docs/TESTING.md", testingDoc, "local/owner completed-step reads expose `resource_admission_ms` alongside total `duration_ms` while delegated non-owner reads omit that machine-user scheduling timing"],
  ["docs/TESTING.md", testingDoc, "Tests are verification inputs but are not npm tarball entries under the current `package.json.files` manifest"],
  ["docs/TESTING.md", testingDoc, "defaults to at most four workers and is further bounded by Node's `availableParallelism()`"],
  ["docs/TESTING.md", testingDoc, "`full-access:test` uses an isolated resource coordinator, a synthetic healthy-host sampler, and an explicit ten-second process-admission budget"],
  ["docs/TESTING.md", testingDoc, "`local-self-test` keeps process-admission behavior deterministic instead of inheriting shared-host pressure"],
  ["docs/TESTING.md", testingDoc, "`agent-context-test` likewise uses an isolated coordinator, synthetic healthy-host sampling, and a ten-second test-only resource-admission budget"],
  ["docs/TESTING.md", testingDoc, "`status_polling_mode=paced_followup`"],
  ["docs/TESTING.md", testingDoc, "`status_polling_mode=bounded_followup`"],
  ["docs/TESTING.md", testingDoc, "`host_turn_handoff_recommended=false`"],
  ["README.md", readme, "bounded same-response `read_job` follow-up"],
  ["README.md", readme, "`status_polling_mode=paced_followup`"],
  ["README.md", readme, "`status_polling_mode=bounded_followup`"],
  ["README.md", readme, "`host_turn_handoff_recommended=false`"],
  ["README.md", readme, "21,600 seconds (six hours)"],
  ["docs/MANAGED_JOBS.md", managedJobsDoc, "timeout_seconds=21600"],
  ["docs/LOGGING.md", loggingDoc, "resource_admission_reason"],
  ["docs/LOGGING.md", loggingDoc, "reason=coordinator_busy"],
  ["docs/OPERATIONS.md", operationsDoc, "managed runner can separately wait up to thirty minutes for cooperative machine-user resource admission"],
  ["docs/OPERATIONS.md", operationsDoc, "snapshot_available=false"],
  ["docs/OPERATIONS.md", operationsDoc, "reason=coordinator_busy"],
  ["docs/OPERATIONS.md", operationsDoc, "`server_info.tool_delivery.managed_job_resource_admission_wait_max_ms`"],
  ["docs/OPERATIONS.md", operationsDoc, "`read_job.current_phase` is `resource_admission`"],
  ["docs/OPERATIONS.md", operationsDoc, "hosted relay reads with omitted `wait_ms` default to the 1-second actual output/exit blocking cap"],
  ["docs/OPERATIONS.md", operationsDoc, "held inside that same MCP call until output/exit or the cooldown boundary"],
  ["docs/OPERATIONS.md", operationsDoc, "`status_polling_mode=paced_followup`"],
  ["docs/OPERATIONS.md", operationsDoc, "`blocking_poll_throttled`"],
  ["docs/OPERATIONS.md", operationsDoc, "`next_blocking_poll_after_ms`"],
  ["docs/OPERATIONS.md", operationsDoc, "`last_transport_error_reason`"],
  ["docs/OPERATIONS.md", operationsDoc, "`relay_transport_send_timeout`"],
  ["docs/OPERATIONS.md", operationsDoc, "`relay_device_session_expired`"],
  ["docs/OPERATIONS.md", operationsDoc, "thirty-second bounded dispatch window"],
  ["docs/OPERATIONS.md", operationsDoc, "original call deadline expired during reconnect"],
  ["docs/OPERATIONS.md", operationsDoc, "`read_job` may follow the known durable job repeatedly in the same assistant response"],
  ["docs/OPERATIONS.md", operationsDoc, "`status_polling_mode=bounded_followup`"],
  ["docs/OPERATIONS.md", operationsDoc, "delegated non-owner reads omit that machine-user scheduling timing"],
  ["docs/OPERATIONS.md", operationsDoc, "`waiters.drain_active`"],
  ["docs/OPERATIONS.md", operationsDoc, "`pressure.state=green` means the sampled host/reservation pressure is within limits, not that fairness can admit every queued root immediately"],
  ["docs/OPERATIONS.md", operationsDoc, "Durable process execution is a separate 1–600-second contract"],
  ["docs/PRIVACY.md", privacyDoc, "including DPoP-proof-shaped compact tokens"],
  ["docs/PRIVACY.md", privacyDoc, "not a generic IP-address anonymizer"],
  ["docs/PRIVACY.md", privacyDoc, "Wrangler-generated `.wrangler/` files are ignored"],
  ["docs/PRIVACY.md", privacyDoc, "working-directory-relative output path"],
  ["docs/PRIVACY.md", privacyDoc, "`.git/worktrees/*/gitdir` can legitimately contain absolute local filesystem paths"],
  ["docs/PRIVACY.md", privacyDoc, "Treat that stdout/JSON as secret material"],
  ["docs/MULTI_ACCOUNT.md", multiAccountDoc, "must not be copied to shared logs or support artifacts"],
  ["docs/MANAGED_JOBS.md", managedJobsDoc, "`read_job` may be used for bounded same-response follow-up until terminal state"],
  ["docs/MANAGED_JOBS.md", managedJobsDoc, "do not substitute repeated `list_jobs` calls"],
  ["src/shared/server-metadata.json", serverMetadata, "durable-first one-step jobs with a 10-second acceptance budget"],
  ["src/shared/server-metadata.json", serverMetadata, "WebSocket remains the preferred daemon transport"],
  ["src/shared/server-metadata.json", serverMetadata, "reconnect attempt history resets only after 5 seconds of generation-stable readiness"],
  ["src/shared/server-metadata.json", serverMetadata, "A protocol-level Ping is attempted every 5 seconds"],
  ["src/shared/server-metadata.json", serverMetadata, "A new daemon-backed call may wait at most 15 seconds for verified recovery"],
  ["src/shared/server-metadata.json", serverMetadata, "A resume_calls_ack.missing_ids entry is emitted only while the daemon still has a fail-closed proof"],
  ["src/shared/server-metadata.json", serverMetadata, "automatic_redelivery_safe becomes false"],
  ["src/shared/server-metadata.json", serverMetadata, "previous_ready_inbound_silence_ms"],
  ["src/shared/server-metadata.json", serverMetadata, "recent_outages"],
  ["src/shared/server-metadata.json", serverMetadata, "managed-job initial-settlement window"],
  ["src/shared/server-metadata.json", serverMetadata, "separate pre-spawn resource-admission wait of up to 30 minutes"],
  ["src/shared/server-metadata.json", serverMetadata, "read_job.current_phase=resource_admission"],
  ["src/shared/server-metadata.json", serverMetadata, "Hosted read-only status and diagnostic tools must not be used as busy loops"],
  ["src/shared/server-metadata.json", serverMetadata, "read_job's server-side paced long-poll by default"],
  ["src/shared/server-metadata.json", serverMetadata, "repeated would-block request inside the fifteen-second cooldown stays inside that same MCP call"],
  ["src/shared/server-metadata.json", serverMetadata, "Bounded same-response follow-up is allowed when the current task needs terminal state or additional output"],
  ["src/shared/server-metadata.json", serverMetadata, "Do not infer or preempt a host/tool deadline from elapsed wall-clock time"],
  ["src/shared/server-metadata.json", serverMetadata, "Acceptance transfers execution to durable ownership without forcing the current assistant response to end"],
  ["src/shared/server-metadata.json", serverMetadata, "bounded same-response read_job follow-up is allowed"],
  ["src/shared/server-metadata.json", serverMetadata, "do not infer a host/tool deadline from elapsed wall-clock time"],
  ["src/shared/server-metadata.json", serverMetadata, "\"toolSchemaGeneration\": 18"],
  ["src/shared/server-metadata.json", serverMetadata, "worker.continuity_evidence schema 2 survives Worker isolate replacement"],
  ["src/shared/server-metadata.json", serverMetadata, "ready_socket_disconnects/unplanned_ready_socket_disconnects"],
  ["src/shared/server-metadata.json", serverMetadata, "Legacy schema-1 disconnect counters are intentionally not carried into schema 2"],
  ["src/shared/server-metadata.json", serverMetadata, "recovery.mode=read_same_job"],
  ["src/shared/server-metadata.json", serverMetadata, "durable_terminal from transient_terminal"],
  ["src/shared/server-metadata.json", serverMetadata, "current response still requires read_job continuation retains stronger private recovery priority"],
  ["src/shared/server-metadata.json", serverMetadata, "recent_process_recovery remains capped at 16 additional authority-visible public job handles"],
  ["src/shared/server-metadata.json", serverMetadata, "not a polling or MCP replay/session surface"],
  ["docs/MANAGED_JOBS.md", managedJobsDoc, "A separate `recent_process_recovery` array remains capped at 16 authority-visible public handles"],
  ["src/shared/server-metadata.json", serverMetadata, "1–600-second detached execution timeout"],
  ["src/shared/server-metadata.json", serverMetadata, "ordinary one-step remote process work"],
  ["src/shared/server-metadata.json", serverMetadata, "effective account policy permits it"],
  ["src/shared/server-metadata.json", serverMetadata, "execution budget above 600 seconds"],
]) {
  if (!content.includes(required)) throw new Error(`${file} omitted current hosted timing/diagnostic guidance: ${required}`);
}
if (serverMetadata.includes("inspect completion with read_job")
  || serverMetadata.includes("use short polling")
  || serverMetadata.includes("read an active job at most once")
  || serverMetadata.includes("stop polling until a later user turn")
  || serverMetadata.includes("host response/execution budget")
  || serverMetadata.includes("host budget is nearly exhausted")
  || serverMetadata.includes("remaining host budget")) {
  throw new Error("shared server guidance can still force a hosted-turn handoff or induce busy polling");
}
if (operationsDoc.includes("Use short `read_process` polls")
  || operationsDoc.includes("hosted remote projection caps each wait at 5 seconds")
  || operationsDoc.includes("one blocking `read_process` checkpoint")
  || operationsDoc.includes("one checkpoint per assistant response")
  || operationsDoc.includes("host response/execution budget")
  || operationsDoc.includes("remaining host budget")) {
  throw new Error("operations guidance can still force one-checkpoint hosted-turn handoff");
}
for (const [file, content] of [["README.md", readme], ["docs/TESTING.md", testingDoc]]) {
  for (const stale of [
    "single live-session status checkpoint per assistant response",
    "should call it at most once for a live session",
    "Durable acceptance is also a hosted-turn handoff",
    "one-live-session-checkpoint/handoff/durable-work guidance",
    "any `running=true` checkpoint instructs host-turn handoff",
    "active `read_job` returns checkpoint/handoff metadata",
    "forbid both same-response terminal polling",
    "host response/execution budget",
    "remaining host budget",
    "nearly exhausted",
  ]) {
    if (content.includes(stale)) throw new Error(`${file} retained obsolete forced-handoff guidance: ${stale}`);
  }
}
for (const stale of ["`poll_throttled`", "`next_poll_after_ms`", "`remote_process_poll_wait_max_ms`", "`remote_process_poll_cooldown_ms`"]) {
  if (readme.includes(stale) || architecture.includes(stale) || operationsDoc.includes(stale) || testingDoc.includes(stale) || serverMetadata.includes(stale)) {
    throw new Error(`current hosted documentation retained ambiguous process-poll field name: ${stale}`);
  }
}

const engineering = readFileSync(join(root, "docs", "ENGINEERING.md"), "utf8");
if (!engineering.includes("default profile is intentionally `full`") || !engineering.includes("`.project-local/`") || !engineering.includes("`Object.hasOwn`")) {
  throw new Error("engineering invariants omitted the owner-required full default or local-knowledge boundary");
}
if (!engineering.includes("Documented read-only discovery may conservatively omit unavailable or unsupported optional metadata")) {
  throw new Error("engineering read-failure invariant does not distinguish optional discovery from security/persistence evidence");
}
for (const required of [
  "Diagnose before changing semantics",
  "Falsified fixes do not silently accumulate",
  "Hosted-runtime behavior requires hosted-runtime evidence",
  "Multi-record authority state commits through one explicit transaction boundary",
  "Verification runs require an immutable source snapshot",
  "OAuth persistence is a deployed acceptance boundary",
  "remote initialization compatibility is stateless and bounded",
]) {
  if (!engineering.includes(required)) throw new Error(`engineering incident invariant omitted: ${required}`);
}
for (const stale of ["owner-terminal ceremony", "real TTY streams", "Background agents and managed jobs may verify state but may not publish"]) {
  if (engineering.includes(stale)) throw new Error(`engineering guide retained obsolete terminal-gated publication contract: ${stale}`);
}
const architectureGuide = readFileSync(join(root, "docs", "ARCHITECTURE.md"), "utf8");
if (architectureGuide.includes("All bridge mutations are serialized in one runtime queue.")
    || !architectureGuide.includes("Operations touching the same canonical path serialize; independent paths may proceed concurrently")) {
  throw new Error("architecture mutation model drifted from canonical-path reservation semantics");
}
const threatModelGuide = readFileSync(join(root, "docs", "THREAT_MODEL.md"), "utf8");
for (const [name, guide] of [
  ["architecture guide", architectureGuide],
  ["threat model", threatModelGuide],
  ["testing guide", testingGuide],
]) {
  for (const forbidden of [
    "GitHub tag/Release publication requires an explicit confirmation flag",
    "GitHub tag/Release mutation additionally requires an explicit confirmation flag",
    "GitHub publication ownership: missing confirmation",
    "TTY-backed stdin/stdout/stderr",
    "real owner TTYs",
  ]) {
    if (guide.includes(forbidden)) throw new Error(`${name} retained obsolete GitHub user-presence publication contract: ${forbidden}`);
  }
  if (!guide.includes("sole explicit current-task owner authorization boundary") || !guide.includes("--owner-confirm")) {
    throw new Error(`${name} omitted the npm-only explicit publication authorization boundary`);
  }
}
const upgradingGuide = readFileSync(join(root, "docs", "UPGRADING.md"), "utf8");
for (const obsolete of [
  "retains a bounded beta.104 transition reader",
  "Rolling beta.104 compatibility fixtures",
  "legacy transaction-owner migration check async",
  "retained by current readers",
]) {
  if ([architectureGuide, testingGuide, upgradingGuide].some((source) => source.includes(obsolete))) {
    throw new Error(`current documentation restored expired resource-transaction compatibility: ${obsolete}`);
  }
}
if (!upgradingGuide.includes("no current reader consumes or migrates the directory format")
    || !architectureGuide.includes("unsupported legacy transaction-lock directories are retained unchanged and fail closed")
    || !testingGuide.includes("obsolete directory shape")) {
  throw new Error("current documentation lost the fail-closed obsolete transaction-lock contract");
}
if (!upgradingGuide.includes("historical migration records, not a declaration of the current candidate")
    || upgradingGuide.includes("`3.0.0-beta.7` retains the portable P-256 root by default and is the next supported candidate path")) {
  throw new Error("upgrade history regained stale present-tense candidate guidance");
}

for (const file of [join(root, "docs", "ENGINEERING.md"), join(root, "CONTRIBUTING.md")]) {
  const releaseContract = readFileSync(file, "utf8").replace(/\s+/g, " ");
  if (!releaseContract.includes("prerelease") || !releaseContract.includes("soak") || !releaseContract.includes("npm")) {
    throw new Error(`release ownership contract drifted in ${relative(root, file)}`);
  }
  for (const required of ["npm", "--owner-confirm", "sole", "authorization"]) {
    if (!releaseContract.includes(required)) throw new Error(`npm-only authorization ownership drifted in ${relative(root, file)}: ${required}`);
  }
  if (releaseContract.includes("prerelease:release -- --owner-confirm") || releaseContract.includes("release -- --owner-confirm")) {
    throw new Error(`GitHub publication regained an owner-confirm gate in ${relative(root, file)}`);
  }
}
const projectStandards = readFileSync(join(root, "docs", "PROJECT_STANDARDS.md"), "utf8");
for (const required of ["GitHub Flow", "Conventional Commits", "MCP tool catalog", "An 80% aggregate coverage target", "Unhandled process-level exceptions", "npm trusted publishing", "High cohesion and low coupling", "KISS", "DRY", "ChatGPT GitHub plugin", "`gh api`", "Incident evidence discipline", "falsified hypotheses", "frozen tree", "deployed/live canaries", "Completion ownership, prerelease activation, and soak", "Autonomous long-running task continuity", "The user is not a polling clock", "status_polling_mode=bounded_followup", "host_turn_handoff_recommended=false", "same assistant response", "server-side long-poll", "high-density host tool loop", "one-second actual output/exit blocking", "fifteen-second", "cooldown boundary", "release-blocking continuity invariant", "21,600 seconds", "six hours", "npm run release:candidate", directCandidateVerifyCommand, "npm run release:candidate:activate -- --allow-worker-deploy", "npm run prerelease:release", "npm run prerelease:publish -- --owner-confirm", "npm run prerelease:install -- --allow-worker-deploy", "promotion-content digest", "seven days", "npm run stable:publish -- --owner-confirm", "npm run github:push", "observed live verification", "If Machine Bridge or the local authenticated CLI is unavailable", "browser-side GitHub integration"]) {
  if (!projectStandards.includes(required)) throw new Error(`project standards omitted required policy: ${required}`);
}
if (projectStandards.includes("prerelease:release -- --owner-confirm") || projectStandards.includes("release -- --owner-confirm")) {
  throw new Error("project standards regained a GitHub publication authorization flag");
}
for (const required of [
  "aggregate host-response lifetime are separate constraints",
  "Response-count arithmetic alone does not prove cross-boundary recovery",
  "typed `read_job` `not_found`",
  "lower-priority terminal retention than explicit managed jobs",
]) {
  if (!projectStandards.includes(required)) throw new Error(`project standards omitted cross-host-boundary continuity evidence: ${required}`);
}
const releasingGuide = readFileSync(join(root, "docs", "RELEASING.md"), "utf8");
for (const [name, guide, required] of [
  ["project standards", projectStandards, "not a universal candidate-acceptance gate"],
  ["release guide", releasingGuide, "Do not make a fixed-duration >100-minute live managed-job soak a release-acceptance prerequisite"],
  ["upgrade guide", upgradingGuide, "fixed >100-minute soak is not a release-acceptance prerequisite"],
]) {
  if (!guide.includes(required)) throw new Error(`${name} did not remove the fixed >100-minute soak acceptance gate`);
  for (const forbidden of [
    "When the target is >100-minute continuity, also run an actual >100-minute job",
    "When the change targets >100-minute continuity, perform an actual >100-minute live managed-job soak",
    "For a >100-minute continuity change, an actual long job must",
  ]) {
    if (guide.includes(forbidden)) throw new Error(`release documentation restored obsolete fixed-duration acceptance policy: ${forbidden}`);
  }
}
for (const required of [directCandidateVerifyCommand, "npm run prerelease:release", "npm run release:backfill", "npm run release", "npm run prerelease:publish -- --owner-confirm", "npm run stable:publish -- --owner-confirm", "sole conversational authorization boundary", "detached `start_job`", "larger explicit step timeout"]) {
  if (!releasingGuide.includes(required)) throw new Error(`release guide omitted npm-only authorization/publication contract: ${required}`);
}
for (const forbidden of ["prerelease:release -- --owner-confirm", "release:backfill -- --owner-confirm", "npm run release -- --owner-confirm", "Conversational authorization is sufficient"]) {
  if (releasingGuide.includes(forbidden)) throw new Error(`release guide retained obsolete non-npm authorization gate: ${forbidden}`);
}
for (const [name, guide] of [["release guide", releasingGuide], ["upgrade guide", upgradingGuide]]) {
  for (const required of [
    "frozen approved tool/input snapshot", "Action control", "refresh/review",
    "invocation", "wait_ms=40001", "timeout_seconds=3601", "not_found",
  ]) {
    if (!guide.includes(required)) throw new Error(`${name} omitted hosted action-snapshot freshness/remediation boundary: ${required}`);
  }
}
if (!releasingGuide.includes("does not prove that the external client read either SSE frame")
    || !upgradingGuide.includes("cannot prove client receipt or catalog refresh")) {
  throw new Error("release documentation overstates a server-opened list-change subscription as external client receipt evidence");
}
for (const required of [
  "aggregate host-response lifetime",
  "after realistic `exec_command`/`run_process` helper churn",
  "typed `not_found`",
  "disables daemon-proven missing-id automatic redelivery",
]) {
  if (!releasingGuide.includes(required)) throw new Error(`release guide omitted interruption recovery acceptance boundary: ${required}`);
}
if (!testingGuide.includes("server-opened subscription evidence cannot prove external client receipt")
    || !testingGuide.includes("**Action control** snapshot")
    || !testingGuide.includes("opaque host-internal cache inspection is intentionally excluded from release acceptance")
    || !testingGuide.includes("harmless invocation probe")) {
  throw new Error("testing guide omitted the governed ChatGPT action-snapshot freshness/remediation model");
}
for (const [name, guide] of [
  ["operations guide", readFileSync(join(root, "docs", "OPERATIONS.md"), "utf8")],
  ["clients guide", readFileSync(join(root, "docs", "CLIENTS.md"), "utf8")],
]) {
  if (!guide.includes("Action control") || !guide.toLowerCase().includes("host-internal cache inspection")) {
    throw new Error(`${name} omitted the workspace/runtime freshness boundary`);
  }
}
for (const [name, guide] of [["project standards", projectStandards], ["release guide", releasingGuide], ["upgrade guide", upgradingGuide]]) {
  for (const forbidden of ["Acceptance must sample multiple host discovery paths", "query multiple host discovery paths"]) {
    if (guide.includes(forbidden)) throw new Error(`${name} retained filtered host-search results as schema-freshness authority: ${forbidden}`);
  }
  for (const required of ["ChatGPT host-control-plane UI", "Action control", "refresh/review"]) {
    if (!guide.includes(required)) throw new Error(`${name} omitted the standing-authorized ChatGPT product-control-plane discipline: ${required}`);
  }
}
for (const [name, guide] of [
  ["project standards", projectStandards],
  ["release guide", releasingGuide],
  ["upgrade guide", upgradingGuide],
  ["testing guide", testingGuide],
  ["operations guide", readFileSync(join(root, "docs", "OPERATIONS.md"), "utf8")],
  ["clients guide", readFileSync(join(root, "docs", "CLIENTS.md"), "utf8")],
]) {
  for (const forbidden of [
    "`api_tool`",
    "api_tool.list_resources",
    "tool-loader",
    "complete unfiltered host catalog snapshot as the schema-freshness authority",
    "treat that one full-catalog snapshot as the schema-freshness authority",
    "Whole-catalog freshness evidence must come from one complete unfiltered",
  ]) {
    if (guide.includes(forbidden)) throw new Error(`${name} reintroduced ChatGPT internal loader-cache inspection into the release process: ${forbidden}`);
  }
  if (!guide.includes("Action control") || !guide.includes("invocation")) {
    throw new Error(`${name} omitted the governed Workspace plus live-invocation freshness evidence model`);
  }
}
for (const stale of ["owner-terminal attempt", "real owner-terminal activation", "The coding agent must stop and present this command", "After the owner command completes"]) {
  if (releasingGuide.includes(stale)) throw new Error(`release guide retained obsolete owner-terminal activation contract: ${stale}`);
}
const operationsGuide = readFileSync(join(root, "docs", "OPERATIONS.md"), "utf8");
if (operationsGuide.includes("failed owner-terminal command")) {
  throw new Error("operations guide retained obsolete owner-terminal activation wording");
}
if (operationsGuide.includes("cooldown in which another blocking request returns immediate status")) {
  throw new Error("operations guide reintroduced the rapid process-checkpoint amplification path");
}
const toolReference = readFileSync(join(root, "docs", "TOOL_REFERENCE.md"), "utf8");
const sharedToolCatalog = JSON.parse(readFileSync(join(root, "src", "shared", "tool-catalog.json"), "utf8"));
if (!toolReference.includes("Generated from `src/shared/tool-catalog.json`") || !toolReference.includes(`Tool count: **${sharedToolCatalog.length}**`)) {
  throw new Error("generated MCP tool reference is missing or malformed");
}
const obsoleteLongWorkGuidance = "use process sessions or managed jobs for longer work";
if (sharedToolCatalog.some((tool) => String(tool?.description || "").includes(obsoleteLongWorkGuidance))
    || toolReference.includes(obsoleteLongWorkGuidance)) {
  throw new Error("current tool catalog/reference still routes generic browser/application work into process sessions");
}
const agentContract = readFileSync(join(root, "AGENTS.md"), "utf8");
for (const required of [
  "ChatGPT host-control-plane UI discipline",
  "not a separate conversational authorization boundary",
  "in-place refresh/review",
  "filtered tool/resource search is a routing aid, not authoritative schema-freshness evidence",
  "complete `machine-mcp` tool catalog **without a query filter**",
  "stale host query/search-index cache",
  "unfiltered full catalog is itself stale, partial, or mixed-generation",
  "stale filtered-search result alone must not block acceptance",
  "external acceptance blocker",
  "never replay an unknown-outcome UI mutation blindly",
]) {
  if (!agentContract.includes(required)) throw new Error(`repository automation contract omitted ChatGPT host-control-plane UI boundary: ${required}`);
}
for (const required of ["Tool-selection hard gate", "Do not call, discover, list, load, or invoke a hosted GitHub connector", "This gate applies before connector/tool discovery", "Availability of a hosted connector is not a fallback", "A violation must be treated as a process defect", "GitHub control plane", "hosted GitHub connector", "ChatGPT GitHub plugin", "`gh api`", "Do not mix local `gh`/`git` writes with connector writes", "Autonomous long-running work invariant", "User interaction must not be used as a scheduler tick", "status_polling_mode=bounded_followup", "host_turn_handoff_recommended=false", "same assistant response", "server-side long-poll", "high-density host tool loop", "cooldown boundary", "release-blocking continuity defect", "Mandatory prerelease and soak invariant", "Incident diagnosis and evidence hard gate", "observed facts", "falsified hypotheses", "frozen source snapshot", "deployed-edge canary", "npm run release:candidate", directCandidateVerifyCommand, "npm run release:candidate:activate -- --allow-worker-deploy", "npm run release:accept", "npm run github:push", "npm run prerelease:release", "npm run prerelease:publish -- --owner-confirm", "npm run prerelease:install -- --allow-worker-deploy", "npm run release:soak:verify", "npm run stable:publish -- --owner-confirm", "Sole explicit user-authorization boundary", "Before any GitHub read or mutation", "If the local Machine Bridge control plane is unavailable", "step timeout above 600 seconds", "run_process`'s 600-second step limit"]) {
  if (!agentContract.includes(required)) throw new Error(`repository automation contract omitted GitHub control-plane rule: ${required}`);
}
for (const forbidden of ["prerelease:release -- --owner-confirm", "npm run release -- --owner-confirm", "explicitly authorizes ChatGPT host-control-plane UI work"]) {
  if (agentContract.includes(forbidden)) throw new Error(`repository automation contract retained obsolete non-npm authorization gate: ${forbidden}`);
}
for (const [label, contract] of [["project standards", projectStandards], ["repository automation contract", agentContract]]) {
  for (const forbidden of [
    "read an active job at most once",
    "stop polling until a later user turn",
    "one active-job status checkpoint in the current assistant response",
  ]) {
    if (contract.includes(forbidden)) throw new Error(`${label} reintroduced forced user-turn long-job polling: ${forbidden}`);
  }
}
if (existsSync(join(root, "src", "worker", "worker-configuration.d.ts"))) {
  throw new Error("generated Worker type declarations returned to the package source tree");
}
if (!readFileSync(join(root, ".gitignore"), "utf8").split(/\r?\n/).includes(".project-local/")) {
  throw new Error("machine-specific project notes are not ignored");
}

console.log("architecture release/documentation contracts ok");
