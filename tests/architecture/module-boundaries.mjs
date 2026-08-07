import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const localRoot = join(root, "src", "local");
const modules = readdirSync(localRoot).filter((name) => name.endsWith(".mjs")).sort();
const graph = new Map();

for (const name of modules) {
  const file = join(localRoot, name);
  const source = readFileSync(file, "utf8");
  if (source.includes("LocalDaemon") || source.includes('"./daemon.mjs"') || source.includes("'./daemon.mjs'")) {
    throw new Error(`obsolete daemon/runtime naming returned in ${relative(root, file)}`);
  }
  const dependencies = [];
  for (const match of source.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*)["'](\.\/[^"']+)["']/g)) {
    const target = resolve(dirname(file), match[1]);
    const modulePath = extname(target) ? target : `${target}.mjs`;
    if (!existsSync(modulePath)) throw new Error(`missing relative module ${match[1]} imported by ${relative(root, file)}`);
    if (dirname(modulePath) === localRoot && modulePath.endsWith(".mjs")) dependencies.push(modulePath);
  }
  graph.set(file, dependencies);
}

const visiting = new Set();
const visited = new Set();
for (const file of graph.keys()) visitModule(file, []);

const adapterModules = new Set([
  "cli.mjs", "cli-service.mjs", "daemon-process.mjs", "stdio.mjs", "service.mjs",
  "service-restart-handoff.mjs", "service-restart-scheduler.mjs", "windows-service.mjs", "windows-service-convergence.mjs", "relay-connection.mjs", "runtime-relay.mjs", "worker-deployment.mjs", "hardened-npm.mjs", "hardened-npm-download.mjs", "hardened-npm-extract.mjs", "hardened-npm-verification.mjs", "wrangler-toolchain.mjs", "wrangler-toolchain-verification.mjs",
]);
const boundaryModules = new Set([
  "agent-context.mjs",
  "agent-context-projection.mjs",
  "agent-skill-discovery.mjs",
  "agent-text-file.mjs",
  "agent-contract.mjs",
  "app-automation.mjs",
  "browser-command.mjs",
  "browser-operation-service.mjs",
  "bounded-output.mjs",
  "capability-observer.mjs",
  "default-instructions.mjs",
  "network-proxy.mjs",
  "worker-health.mjs",
  "process-sessions.mjs",
  "process-output-stream.mjs",
  "process-result-projection.mjs",
  "process-contract.mjs",
  "process-tree.mjs",
  "process-tree-ownership.mjs",
  "execution-limits.mjs",
  "project-package.mjs",
  "policy.mjs",
  "errors.mjs",
  "call-registry.mjs",
  "owner-state-lock.mjs",
  "exclusive-file.mjs",
  "child-process-settlement.mjs",
  "tool-executor.mjs",
  "observability.mjs",
  "process-tracker.mjs",
  "process-execution.mjs",
  "git-service.mjs",
  "file-mutation-coordinator.mjs",
  "filesystem-identity.mjs",
  "workspace-file-transaction.mjs",
  "workspace-file-service.mjs",
  "cli-options.mjs",
  "cli-policy.mjs",
  "lifecycle.mjs",
  "loopback-health.mjs",
  "cli-local-admin.mjs",
  "capability-ranking.mjs",
  "execution-routing.mjs",
  "managed-job-plan.mjs",
  "numbers.mjs",
  "private-toolchain-integrity.mjs",
  "project-metadata.mjs",
  "records.mjs",
  "state-inventory.mjs",
  "browser-extension-protocol.mjs",
  "browser-extension-identity.mjs",
  "browser-pairing-store.mjs",
  "browser-pairing-http.mjs",
  "worker-secret-file.mjs",
  "service-environment.mjs",
  "service-status.mjs",
  "service-ownership.mjs",
  "monotonic-deadline.mjs",
  "runtime-capabilities.mjs",
  "runtime-diagnostics.mjs",
  "system-network-route.mjs",
  "runtime-reporting.mjs",
  "runtime-info-projection.mjs",
  "runtime-resource-service.mjs",
  "runtime-tool-handlers.mjs",
  "runtime-paths.mjs",
  "relay-call-recovery.mjs",
  "relay-connection-classification.mjs",
  "browser-request-registry.mjs",
  "browser-bridge-http.mjs",
  "browser-broker-routes.mjs",
  "browser-broker-server.mjs",
  "windows-launcher.mjs",
  "managed-job-lock.mjs",
  "managed-job-projection.mjs",
  "managed-job-storage.mjs",
  "managed-job-runner.mjs",
  "managed-job-cancellation.mjs",
  "managed-job-directory.mjs",
]);
for (const name of boundaryModules) {
  const file = join(localRoot, name);
  if (!graph.has(file)) throw new Error(`architecture boundary module is missing: ${name}`);
  for (const dependency of graph.get(file) || []) {
    const dependencyName = relative(localRoot, dependency);
    if (adapterModules.has(dependencyName)) throw new Error(`${name} crosses the domain/adapter boundary by importing ${dependencyName}`);
  }
}

for (const name of ["process-tree-ownership.mjs", "process-identity.mjs", "delegated-process-sandbox.mjs", "macos-trust-broker.mjs"]) {
  const source = readFileSync(join(localRoot, name), "utf8");
  const timeoutCount = (source.match(/\btimeout:/g) || []).length;
  const hardKillCount = (source.match(/killSignal:\s*["']SIGKILL["']/g) || []).length;
  if (timeoutCount !== hardKillCount) {
    throw new Error(`${name} has a bounded synchronous runtime probe without a hard timeout signal`);
  }
}

const lineLimits = Object.freeze({
  "src/local/runtime.mjs": 700,
  "src/local/runtime-tool-handlers.mjs": 100,
  "src/local/runtime-relay.mjs": 100,
  "src/local/relay-call-recovery.mjs": 170,
  "src/local/runtime-paths.mjs": 120,
  "src/local/runtime-reporting.mjs": 150,
  "src/local/runtime-info-projection.mjs": 70,
  "src/local/runtime-resource-service.mjs": 100,
  "src/local/resource-operations.mjs": 110,
  "src/local/account-admin.mjs": 240,
  "src/local/runtime-diagnostics.mjs": 120,
  "src/local/runtime-diagnostic-state.mjs": 40,
  "src/local/system-network-route.mjs": 80,
  "src/local/runtime-capabilities.mjs": 100,
  "src/local/cli.mjs": 950,
  "src/local/cli-service.mjs": 220,
  "src/worker/index.ts": 830,
  "src/worker/oauth-controller.ts": 360,
  "src/worker/oauth-authorization-page.ts": 100,
  "src/worker/oauth-tokens.ts": 260,
  "src/local/bounded-output.mjs": 80,
  "src/local/process-execution.mjs": 285,
  "src/local/process-foreground-timeout.mjs": 60,
  "src/local/process-output-stream.mjs": 110,
  "src/local/process-result-projection.mjs": 60,
  "src/local/process-sessions.mjs": 340,
  "src/local/relay-connection.mjs": 680,
  "src/local/relay-connection-classification.mjs": 160,
  "src/local/relay-heartbeat.mjs": 130,
  "src/local/process-contract.mjs": 40,
  "src/local/process-tree.mjs": 70,
  "src/local/process-tree-signal.mjs": 50,
  "src/local/process-tree-supervisor.mjs": 70,
  "src/local/process-tree-snapshot.mjs": 100,
  "src/local/process-tree-ownership.mjs": 80,
  "src/local/execution-limits.mjs": 55,
  "src/shared/tool-call-capacity.mjs": 80,
  "src/local/call-capacity.mjs": 70,
  "src/local/git-service.mjs": 220,
  "src/local/file-mutation-coordinator.mjs": 80,
  "src/local/filesystem-identity.mjs": 55,
  "src/local/workspace-file-transaction.mjs": 190,
  "src/local/workspace-file-service.mjs": 430,
  "src/local/tool-executor.mjs": 180,
  "src/local/security-audit-log.mjs": 220,
  "src/local/security-audit-storage.mjs": 230,
  "src/local/security-audit-state.mjs": 180,
  "src/local/security-audit-worker.mjs": 110,
  "src/local/security-audit-dispatch.mjs": 60,
  "src/local/security-audit-warning.mjs": 60,
  "src/local/call-registry.mjs": 190,
  "src/local/owner-state-lock.mjs": 130,
  "src/local/exclusive-file.mjs": 160,
  "src/local/lifecycle.mjs": 130,
  "src/local/loopback-health.mjs": 80,
  "src/local/cli-local-admin.mjs": 400,
  "src/local/agent-context.mjs": 600,
  "src/local/agent-context-projection.mjs": 200,
  "src/local/agent-skill-discovery.mjs": 300,
  "src/local/agent-text-file.mjs": 70,
  "src/local/agent-contract.mjs": 230,
  "src/local/default-instructions.mjs": 280,
  "src/local/project-package.mjs": 240,
  "src/local/capability-ranking.mjs": 150,
  "src/local/execution-routing.mjs": 300,
  "src/local/managed-jobs.mjs": 700,
  "src/local/managed-job-lock.mjs": 140,
  "src/local/managed-job-projection.mjs": 100,
  "src/local/managed-job-storage.mjs": 130,
  "src/local/managed-job-runner.mjs": 100,
  "src/local/managed-job-cancellation.mjs": 80,
  "src/local/managed-job-directory.mjs": 80,
  "src/local/managed-job-plan.mjs": 300,
  "src/local/numbers.mjs": 30,
  "src/local/project-metadata.mjs": 80,
  "src/local/records.mjs": 20,
  "src/local/state-inventory.mjs": 170,
  "src/local/worker-health.mjs": 280,
  "src/local/worker-deployment.mjs": 220,
  "src/local/hardened-npm.mjs": 230,
  "src/local/hardened-npm-download.mjs": 110,
  "src/local/hardened-npm-extract.mjs": 50,
  "src/local/hardened-npm-verification.mjs": 110,
  "src/local/npm-environment.mjs": 40,
  "src/local/private-toolchain-integrity.mjs": 70,
  "src/local/wrangler-toolchain.mjs": 230,
  "src/local/wrangler-toolchain-verification.mjs": 140,
  "src/local/browser-bridge.mjs": 560,
  "src/local/browser-request-registry.mjs": 100,
  "src/local/browser-bridge-http.mjs": 80,
  "src/local/browser-broker-routes.mjs": 180,
  "src/local/browser-broker-server.mjs": 90,
  "src/local/browser-operation-service.mjs": 360,
  "src/local/browser-extension-protocol.mjs": 130,
  "src/local/browser-pairing-store.mjs": 120,
  "src/local/browser-pairing-http.mjs": 80,
  "src/local/worker-secret-file.mjs": 165,
  "src/local/service-environment.mjs": 140,
  "src/local/service-owner.mjs": 150,
  "src/local/service-runtime.mjs": 150,
  "src/local/service-runtime-convergence.mjs": 80,
  "src/local/windows-service.mjs": 220,
  "src/local/windows-service-convergence.mjs": 60,
  "src/local/windows-launcher.mjs": 90,
  "src/local/monotonic-deadline.mjs": 60,
  "src/local/path-inspection.mjs": 50,
  "src/worker/mcp-session.ts": 120,
  "src/worker/mcp-access.ts": 80,
  "src/worker/mcp-resumption-http.ts": 80,
  "src/worker/mcp-resumption-config.ts": 80,
  "src/worker/mcp-resumption.ts": 240,
  "src/worker/mcp-resumption-records.ts": 200,
  "src/worker/mcp-resumption-index.ts": 60,
  "src/worker/mcp-resumption-request-index.ts": 80,
  "src/worker/mcp-pending-call-store.ts": 300,
  "src/worker/mcp-pending-call-records.ts": 80,
  "src/worker/mcp-pending-call-expiry.ts": 40,
  "src/worker/mcp-pending-call-storage.ts": 40,
  "src/worker/mcp-pending-call-inspection.ts": 50,
  "src/worker/mcp-stream.ts": 160,
  "src/worker/mcp-legacy-stream-prepare.ts": 180,
  "src/worker/mcp-request-fingerprint.ts": 60,
  "src/worker/mcp-stream-proxy.ts": 120,
  "src/worker/mcp-stream-attempt.ts": 60,
  "src/worker/mcp-stream-prepare-retry.ts": 60,
  "src/worker/mcp-stream-terminal-socket.ts": 80,
  "src/worker/mcp-modern-proxy.ts": 130,
  "src/worker/mcp-stream-proxy-contract.ts": 100,
  "src/worker/mcp-stream-subscription.ts": 130,
  "src/worker/mcp-stream-channel.ts": 130,
  "src/worker/worker-static-routes.ts": 90,
  "src/worker/worker-metadata.ts": 80,
  "src/worker/worker-edge-guard.ts": 100,
  "src/worker/worker-rate-limit-key.ts": 50,
  "src/worker/worker-edge-log.ts": 80,
  "src/worker/oauth-token-issuance.ts": 120,
  "src/worker/oauth-token-derivation.ts": 70,
  "src/worker/oauth-refresh-exchange.ts": 180,
  "src/worker/mcp-stream-dispatch.ts": 220,
  "src/worker/server-info.ts": 170,
  "src/worker/daemon-status.ts": 60,
  "src/worker/durable-stream-calls.ts": 140,
  "src/worker/durable-stream-result.ts": 40,
  "src/worker/worker-entry.ts": 80,
  "src/worker/tool-timeout.ts": 80,
  "src/worker/tool-catalog.ts": 80,
  "src/worker/daemon-liveness.ts": 80,
  "src/worker/daemon-sockets.ts": 140,
  "src/worker/daemon-socket-attachment.ts": 80,
  "src/worker/runtime-alarm.ts": 140,
  "src/worker/runtime-alarm-storage.ts": 60,
  "src/worker/pending-calls.ts": 180,
  "src/worker/pending-call-capacity.ts": 150,
  "src/worker/pending-admission.ts": 40,
  "src/worker/pending-call-deadlines.ts": 80,
  "src/worker/mcp-jsonrpc.ts": 130,
  "src/worker/websocket-protocol.ts": 60,
});
for (const [name, maximum] of Object.entries(lineLimits)) {
  const lines = readFileSync(join(root, name), "utf8").split(/\r?\n/).length;
  if (lines > maximum) throw new Error(`${name} exceeds its responsibility boundary (${lines} > ${maximum} lines)`);
}

for (const file of [
  ...modules.map((name) => join(localRoot, name)),
  join(root, "browser-extension", "browser-operations.js"),
  join(root, "browser-extension", "page-automation.js"),
]) {
  const source = readFileSync(file, "utf8");
  if (/deadline\s*=\s*Date\.now\(\)/.test(source) || /while\s*\([^)]*Date\.now\(\)/.test(source)) {
    throw new Error(`duration wait uses wall time in ${relative(root, file)}`);
  }
}

for (const name of ["app-automation.mjs", "browser-bridge.mjs", "managed-jobs.mjs", "process-sessions.mjs"]) {
  const source = readFileSync(join(localRoot, name), "utf8");
  if (/\bassert(?:Full|Enabled)\s*\(/.test(source) || /disabled by daemon policy|requires the canonical full profile/.test(source)) {
    throw new Error(`${name} reimplements tool authorization instead of using PolicyGate`);
  }
  if (!source.includes("authorizeTool")) throw new Error(`${name} lost the shared authorization gate`);
}

for (const name of ["process-execution.mjs", "process-tracker.mjs", "job-runner.mjs", "shell.mjs"]) {
  const source = readFileSync(join(localRoot, name), "utf8");
  if (source.includes('from "./process-sessions.mjs"')) {
    throw new Error(`${name} couples generic process supervision to the interactive-session adapter`);
  }
  if (!source.includes('from "./process-tree.mjs"')) {
    throw new Error(`${name} bypasses the shared process-tree supervisor`);
  }
}
const processSessionSource = readFileSync(join(localRoot, "process-sessions.mjs"), "utf8");
if (!processSessionSource.includes('from "./process-contract.mjs"') || !processSessionSource.includes('from "./process-tree.mjs"')) {
  throw new Error("process sessions regained argv validation or process-tree supervision responsibilities");
}
const executionLimitSource = readFileSync(join(localRoot, "execution-limits.mjs"), "utf8");
for (const required of ['cpu_quota: \"not-enforced\"', 'memory_quota: \"not-enforced\"', 'network_isolation: \"not-enforced\"']) {
  if (!executionLimitSource.includes(required)) throw new Error(`execution guardrails misrepresent an unenforced OS boundary: ${required}`);
}

const filesystemIdentitySource = readFileSync(join(localRoot, "filesystem-identity.mjs"), "utf8");
for (const required of ["filesystemIdentity", "sameFilesystemIdentity", "exactFilesystemInteger", "cannot be represented losslessly"]) {
  if (!filesystemIdentitySource.includes(required)) throw new Error(`filesystem identity boundary lost lossless comparison behavior: ${required}`);
}
for (const name of ["secure-file.mjs", "exclusive-file.mjs", "worker-secret-file.mjs", "managed-job-directory.mjs", "managed-job-lock.mjs", "state.mjs", "security-audit-storage.mjs", "ssh-key.mjs"]) {
  const source = readFileSync(join(localRoot, name), "utf8");
  if (!source.includes("filesystem-identity.mjs")) throw new Error(`${name} bypasses the shared lossless filesystem identity boundary`);
  if (/Number\([^\n)]*\.(?:dev|ino)\)|(?:dev|ino):\s*Number\(/.test(source)) {
    throw new Error(`${name} converts filesystem identity through Number and may lose Windows precision`);
  }
}
for (const name of ["secure-file.mjs", "exclusive-file.mjs", "worker-secret-file.mjs", "managed-job-directory.mjs", "managed-job-lock.mjs", "state.mjs", "security-audit-storage.mjs"]) {
  const source = readFileSync(join(localRoot, name), "utf8");
  if (!source.includes("bigint: true")) throw new Error(`${name} lost a BigInt filesystem identity observation`);
}
if (readFileSync(join(localRoot, "secure-file.mjs"), "utf8").includes("return true;")) {
  throw new Error("secure file identity comparison regained an unsafe fail-open fallback");
}

const mutationCoordinatorSource = readFileSync(join(localRoot, "file-mutation-coordinator.mjs"), "utf8");
for (const required of ["this.queues = new Map()", "fileMutationPathKey", "const reservations = keys.map", "await Promise.all(reservations.map", "return await callback()"]){
  if (!mutationCoordinatorSource.includes(required)) throw new Error(`file mutation coordinator lost reservation or settlement boundary: ${required}`);
}
if (mutationCoordinatorSource.indexOf("this.queues.set(key, tail)") > mutationCoordinatorSource.indexOf("await Promise.all(reservations.map")) {
  throw new Error("file mutation coordinator waits before registering every requested path");
}
if (mutationCoordinatorSource.includes("Promise.race") || mutationCoordinatorSource.includes('addEventListener("abort"')) {
  throw new Error("file mutation coordinator can release a path before an in-flight mutation callback settles");
}
const workspaceFileSource = readFileSync(join(localRoot, "workspace-file-service.mjs"), "utf8");
const workspaceTransactionSource = readFileSync(join(localRoot, "workspace-file-transaction.mjs"), "utf8");
if (!workspaceTransactionSource.includes("async function writeFlushedText")
    || !workspaceTransactionSource.includes("await handle.sync()")
    || !workspaceTransactionSource.includes("staged file write failed and cleanup was incomplete")
    || (workspaceTransactionSource.match(/await writeFlushedText\(/g) || []).length !== 2) {
  throw new Error("workspace transaction boundary no longer flushes whole-file and patch staging files before commit");
}
if (!workspaceTransactionSource.includes("patch transaction failed and recovery was incomplete")
    || !workspaceTransactionSource.includes("Patch committed, but ${cleanupFailures.length} internal transaction artifact(s) could not be removed")
    || !workspaceTransactionSource.includes("file mutation failed and staging cleanup was incomplete")
    || !workspaceTransactionSource.includes("new AggregateError([primary, ...cleanupFailures]")
    || !workspaceTransactionSource.includes("await createTarget(stage.temp, operation.target)")
    || !workspaceTransactionSource.includes("reason: \"target_appeared\"")
    || !workspaceTransactionSource.includes("fileMutationPathKey(full, platform)")) {
  throw new Error("workspace transaction lost no-overwrite targets, shared path identity, or causal cleanup reporting");
}
for (const forbidden of ["writeFlushedText", ".mbm-backup-", "createTarget(stage.temp"]) {
  if (workspaceFileSource.includes(forbidden)) throw new Error(`workspace file service regained transaction mechanics: ${forbidden}`);
}
const patchUpdateCalls = workspaceFileSource.match(/applyUpdateHunks\([^\n]+\)/g) || [];
if (patchUpdateCalls.length !== 1 || patchUpdateCalls[0] !== "applyUpdateHunks(original, operation.hunks)") {
  throw new Error("workspace patch updates pass arguments outside the applyUpdateHunks contract");
}
const executionRoutingSource = readFileSync(join(localRoot, "execution-routing.mjs"), "utf8");
if (executionRoutingSource.includes("toolsForPolicy")) {
  throw new Error("execution routing deep-copies the complete tool schema catalog instead of reading bounded metadata");
}
for (const required of ["toolNamesForPolicy", "toolDefinition", "advisory_only", "general escape hatch", "schema_version: 1"]) {
  if (!executionRoutingSource.includes(required)) throw new Error(`execution routing lost a policy or contract boundary: ${required}`);
}
const runtimeBoundarySource = readFileSync(join(localRoot, "runtime.mjs"), "utf8");
if (runtimeBoundarySource.includes("mutationQueue") || runtimeBoundarySource.includes("withMutationLock")) throw new Error("LocalRuntime regained global file-mutation serialization");
for (const forbidden of [
  "spawn(", "parsePatchEnvelope", "applyUpdateHunks", "workspaceShellCommand(",
  "function applicationMatchScore", "request_reached_local_runtime", "policy_contract:",
]) {
  if (runtimeBoundarySource.includes(forbidden)) throw new Error(`LocalRuntime regained low-level responsibility: ${forbidden}`);
}
const toolExecutorBoundary = readFileSync(join(localRoot, "tool-executor.mjs"), "utf8");
if ((toolExecutorBoundary.match(/callRegistry\.throwIfCancelled/g) || []).length !== 1) {
  throw new Error("tool executor must check cancellation before handler execution without retroactively vetoing a settled handler result");
}
if (!toolExecutorBoundary.includes("Handler return is the local settlement point")) {
  throw new Error("tool executor lost the explicit late-cancellation settlement contract");
}
const ownerStateLockBoundary = readFileSync(join(localRoot, "owner-state-lock.mjs"), "utf8");
for (const required of ["createMonotonicDeadline", "inspectProcessInstance", "removeOwnedJsonFileSync", "new AggregateError([callbackError, releaseError]"]) {
  if (!ownerStateLockBoundary.includes(required)) throw new Error(`owner-state lock lost bounded ownership or causal cleanup semantics: ${required}`);
}
const exclusiveFileBoundary = readFileSync(join(localRoot, "exclusive-file.mjs"), "utf8");
for (const required of ["new AggregateError([primaryError, ...cleanupErrors]", "Object.defineProperties(result", "cleanupArtifact", "ownsTemporary"]) {
  if (!exclusiveFileBoundary.includes(required)) throw new Error(`exclusive-file boundary lost atomic cleanup causality or post-commit visibility: ${required}`);
}
if (exclusiveFileBoundary.includes("cleanupTargetOnFailure")) {
  throw new Error("exclusive-file boundary regained unsafe deletion of an unowned target after failed exclusive link");
}
const workerSecretBoundary = readFileSync(join(localRoot, "worker-secret-file.mjs"), "utf8");
for (const required of ["creation.cleanupArtifact", "retryExclusiveStagingCleanup", "temporary Worker secrets staging cleanup failed"]) {
  if (!workerSecretBoundary.includes(required)) throw new Error(`Worker secret lifecycle stopped consuming exclusive-file cleanup evidence: ${required}`);
}
if (workerSecretBoundary.includes("options.lstatSync || lstatSync") || (workerSecretBoundary.match(/losslessLstat\(/g) || []).length < 3) {
  throw new Error("Worker secret lifecycle regained Number-backed cleanup identity observations");
}
const localPolicySource = readFileSync(join(localRoot, "policy.mjs"), "utf8");
const workerPolicySource = readFileSync(join(root, "src", "worker", "policy.ts"), "utf8");
if (!localPolicySource.includes('policy-contract.json') || !workerPolicySource.includes('policy-contract.json')) {
  throw new Error("local and Worker policy enforcement do not share the generated policy contract");
}
const workerIndexBoundary = readFileSync(join(root, "src", "worker", "index.ts"), "utf8");
const workerEntryBoundary = readFileSync(join(root, "src", "worker", "worker-entry.ts"), "utf8");
const workerOAuthControllerBoundary = readFileSync(join(root, "src", "worker", "oauth-controller.ts"), "utf8");
const workerOAuthPageBoundary = readFileSync(join(root, "src", "worker", "oauth-authorization-page.ts"), "utf8");
for (const duplicate of [
  "function validateAuthorizationRequest", "function readBoundedText", "class HttpError",
  "new Map<string, PendingCall>", "private async oauthStore", "private async withOAuthLock",
  "AUTHORIZATION_FIELDS",
]) {
  if (workerIndexBoundary.includes(duplicate)) throw new Error(`Worker index regained extracted responsibility: ${duplicate}`);
}
for (const module of [
  "pending-calls", "policy", "errors", "http", "oauth-state", "oauth-controller",
  "observability", "mcp-session", "mcp-access", "mcp-resumption-http", "mcp-resumption",
  "mcp-stream", "mcp-stream-proxy", "mcp-stream-channel", "mcp-stream-dispatch", "mcp-legacy-stream-prepare", "server-info", "durable-stream-calls",
  "worker-entry", "tool-timeout", "daemon-liveness", "daemon-sockets", "daemon-status",
]) {
  if (!workerIndexBoundary.includes(`./${module}`)) throw new Error(`Worker index lost boundary module: ${module}`);
}
for (const module of ["worker-static-routes", "worker-edge-guard", "worker-edge-log", "worker-rate-limit-key", "mcp-stream-proxy"]) {
  if (!workerEntryBoundary.includes(`./${module}`)) throw new Error(`outer Worker entry lost boundary module: ${module}`);
}
const mcpStreamProxyBoundary = readFileSync(join(root, "src", "worker", "mcp-stream-proxy.ts"), "utf8");
for (const required of [
  "proxyMcpEventStream", "handleMcpStreamSubscribeRequest", "proxyModernMcpStream",
  "streamJsonRpcResponse", "resumeJsonRpcResponse", "subscribeTerminalMessage", "waitUntil",
]) {
  if (!mcpStreamProxyBoundary.includes(required)) throw new Error(`outer MCP stream proxy lost era routing or legacy recovery ownership: ${required}`);
}
const mcpStreamProxyContractBoundary = readFileSync(join(root, "src", "worker", "mcp-stream-proxy-contract.ts"), "utf8");
for (const required of [
  "sanitizeBridgeRequest", "MCP_STREAM_PROXY_MODE_HEADER", "MCP_STREAM_PROXY_ID_HEADER",
  "mcpStreamDescriptorResponse", "STREAM_ID_PATTERN", "Upgrade", "withProxyHeaders",
]) {
  if (!mcpStreamProxyContractBoundary.includes(required)) throw new Error(`MCP stream proxy contract lost boundary hardening: ${required}`);
}
const mcpModernProxyBoundary = readFileSync(join(root, "src", "worker", "mcp-modern-proxy.ts"), "utf8");
for (const required of [
  "modern-direct", "modern-cancel", "request.signal", "waitUntil", "streamHeartbeatMs",
]) {
  if (!mcpModernProxyBoundary.includes(required)) throw new Error(`modern MCP proxy lost non-resumable stream or cancellation behavior: ${required}`);
}
for (const forbidden of ["modern-prepare", "modern-subscribe", "ModernMcpTransientRegistry", "mcpStreamDescriptorResponse"]) {
  if (mcpModernProxyBoundary.includes(forbidden)) throw new Error(`modern MCP proxy regained cross-event delivery state: ${forbidden}`);
}
const mcpModernControllerBoundary = readFileSync(join(root, "src", "worker", "mcp-modern-controller.ts"), "utf8");
for (const forbidden of ["ModernMcpTransientRegistry", "modern-prepare", "modern-subscribe", "mcpStreamDescriptorResponse"]) {
  if (mcpModernControllerBoundary.includes(forbidden)) throw new Error(`modern MCP controller regained cross-event delivery state: ${forbidden}`);
}
const mcpStreamChannelBoundary = readFileSync(join(root, "src", "worker", "mcp-stream-channel.ts"), "utf8");
for (const required of ["acceptWebSocket", "getWebSockets", "serializeAttachment", "pollMessage", "streamSubscriberOpened"]) {
  if (!mcpStreamChannelBoundary.includes(required)) throw new Error(`MCP stream channel lost hibernatable subscription behavior: ${required}`);
}
for (const forbidden of ["setTimeout(", "setInterval(", "Promise<JsonRpcMessage>", "subscriberAdmission", "withSubscriberAdmission"]) {
  if (mcpStreamChannelBoundary.includes(forbidden)) throw new Error(`MCP stream channel regained polling, cross-event promise state, or global subscriber serialization: ${forbidden}`);
}
if (mcpStreamChannelBoundary.indexOf("acceptWebSocket(server, [tag])") > mcpStreamChannelBoundary.indexOf("const current = await resumption.pollMessage(streamId)")) {
  throw new Error("MCP stream channel rechecks storage before registering the subscriber race boundary");
}
for (const forbidden of ["streamJsonRpcResponse(", "resumeJsonRpcResponse("]) {
  if (workerIndexBoundary.includes(forbidden)) throw new Error(`BridgeRoom regained public SSE ownership: ${forbidden}`);
}

for (const forbidden of [
  "const terminal = this.dispatchJsonRpc", ".resumption.attach(", "this.ctx.waitUntil(",
]) {
  if (workerIndexBoundary.includes(forbidden)) throw new Error(`stream initiation regained a cross-event terminal promise: ${forbidden}`);
}
if (!workerIndexBoundary.includes("this.invalidateDaemonSocket(socket, message, closeReason, errorCode, false)")) {
  throw new Error("runtime alarm invalidation regained recursive alarm scheduling");
}
const daemonCleanupBoundary = /private cleanupDaemonSocket[\s\S]*?private async handleMcp/.exec(workerIndexBoundary)?.[0] || "";
if (!daemonCleanupBoundary.includes("beginCleanup") || daemonCleanupBoundary.includes("scheduleRuntimeAlarm")) {
  throw new Error("daemon socket cleanup must remain idempotent and scheduling-free");
}
const daemonWebSocketErrorBoundary = /async webSocketError[\s\S]*?private cleanupDaemonSocket/.exec(workerIndexBoundary)?.[0] || "";
if (daemonWebSocketErrorBoundary.indexOf("const cleanup = this.cleanupDaemonSocket")
  > daemonWebSocketErrorBoundary.indexOf('daemon.websocket.error')) {
  throw new Error("daemon WebSocket error logging occurs before cleanup ownership is claimed");
}
const daemonHeartbeatBoundary = /if \(body\.type === "heartbeat"[\s\S]*?if \(socketAttachment\.role === "probing"\)/.exec(workerIndexBoundary)?.[0] || "";
if (daemonHeartbeatBoundary.indexOf("trySendWebSocket") < 0
    || daemonHeartbeatBoundary.indexOf("trySendWebSocket") > daemonHeartbeatBoundary.indexOf("scheduleRuntimeAlarm")) {
  throw new Error("daemon heartbeat acknowledgement is delayed behind alarm scheduling");
}
const daemonTouchBoundary = /private touchDaemonSocket[\s\S]*?private async invalidateDaemonSocket/.exec(workerIndexBoundary)?.[0] || "";
if (daemonTouchBoundary.includes("scheduleRuntimeAlarm")) {
  throw new Error("daemon activity touch regained implicit alarm scheduling");
}
const daemonResultBoundary = /const outcome: PendingCallOutcome[\s\S]*?async webSocketClose/.exec(workerIndexBoundary)?.[0] || "";
if ((daemonResultBoundary.match(/scheduleRuntimeAlarm/g) || []).length !== 1) {
  throw new Error("daemon terminal result must coalesce liveness and pending-call alarm scheduling");
}
const legacyStreamPrepareBoundary = readFileSync(join(root, "src", "worker", "mcp-legacy-stream-prepare.ts"), "utf8");
for (const required of ["workerToolRequestFingerprint", "findByRequestKey", 'kind: "resume"', 'kind: "conflict"', "dispatchWorkspaceCall", "serverInfo(args)"]) {
  if (!legacyStreamPrepareBoundary.includes(required)) throw new Error(`legacy stream preparation lost retry identity or dispatch boundary: ${required}`);
}
for (const forbidden of ["readySockets", "invalidateDaemonSocket", "scheduleRuntimeAlarm"]) {
  if (legacyStreamPrepareBoundary.includes(forbidden)) throw new Error(`legacy stream preparation crossed into daemon lifecycle ownership: ${forbidden}`);
}
const streamProxyContractBoundary = readFileSync(join(root, "src", "worker", "mcp-stream-proxy-contract.ts"), "utf8");
for (const required of ["MCP_STREAM_PROXY_RETRY_HEADER", "headers.delete(MCP_STREAM_PROXY_RETRY_HEADER)", "mcpStreamProxyRetryId"]) {
  if (!streamProxyContractBoundary.includes(required)) throw new Error(`MCP internal retry header lost spoofing boundary: ${required}`);
}
const dpopRetryBoundary = readFileSync(join(root, "src", "worker", "dpop.ts"), "utf8");
for (const required of ["consumeDpopProofForInternalRetry", "DPOP_RETRY_BINDINGS_KEY", "MAX_DPOP_INTERNAL_RETRY_USES", "boundedNoncePresent", "storage.transaction"]) {
  if (!dpopRetryBoundary.includes(required)) throw new Error(`DPoP internal retry binding lost replay isolation: ${required}`);
}

const streamPrepareRetryBoundary = readFileSync(join(root, "src", "worker", "mcp-stream-prepare-retry.ts"), "utf8");
for (const required of ["request.clone", "boundedStreamAttempt", "response.body?.cancel", "request.signal"]) {
  if (!streamPrepareRetryBoundary.includes(required)) throw new Error(`stream prepare retry lost bounded replay behavior: ${required}`);
}
const rateLimitKeyBoundary = readFileSync(join(root, "src", "worker", "worker-rate-limit-key.ts"), "utf8");
for (const required of ["SHA-256", "authorization", "cf-connecting-ip", "globalStatefulRateLimitKey", "statefulRouteClass"]) {
  if (!rateLimitKeyBoundary.includes(required)) throw new Error(`stateful rate-limit identity lost isolation or privacy: ${required}`);
}
for (const source of [workerIndexBoundary, workerEntryBoundary]) {
  if (!source.includes("statefulRouteClass") || source.includes("path: url.pathname") || source.includes("path: new URL(request.url).pathname")) {
    throw new Error("Worker unexpected-error logging regained raw request paths instead of bounded route classes");
  }
}

const mcpStreamDispatchBoundary = readFileSync(join(root, "src", "worker", "mcp-stream-dispatch.ts"), "utf8");
const serverInfoBoundary = readFileSync(join(root, "src", "worker", "server-info.ts"), "utf8");
for (const required of ["buildServerInfoResult", "buildServerInfoSummary", "compactPending", "compactDaemon", 'detail === "summary"']) {
  if (!serverInfoBoundary.includes(required)) throw new Error(`Worker server_info lost compact/full projection boundary: ${required}`);
}
if (mcpStreamDispatchBoundary.includes("buildServerInfoResult") || workerIndexBoundary.includes("function buildServerInfoSummary")) {
  throw new Error("Worker server_info projection returned to stream dispatch or the composition root");
}
const localInfoProjectionBoundary = readFileSync(join(localRoot, "runtime-info-projection.mjs"), "utf8");
for (const required of ["projectRuntimeInfo", 'detail !== "summary"', "compactProcesses", "compactCapacity"]) {
  if (!localInfoProjectionBoundary.includes(required)) throw new Error(`local server_info lost compact/full projection boundary: ${required}`);
}
for (const required of [
  "startEventDrivenStreamCall", "resumption.calls.activate", "resumption.calls.complete", "persistImmediateStreamOutcome",
]) {
  if (!mcpStreamDispatchBoundary.includes(required)) throw new Error(`durable stream dispatch lost its lifecycle boundary: ${required}`);
}
const pendingCallsBoundary = readFileSync(join(root, "src", "worker", "pending-calls.ts"), "utf8");
for (const required of ["register(input", "detachSocket", "rebindInstance"]) {
  if (!pendingCallsBoundary.includes(required)) throw new Error(`pending-call registry lost bounded JSON-call semantics: ${required}`);
}
for (const forbidden of ["registerEvent", "settlement.kind", 'kind: "event"']) {
  if (pendingCallsBoundary.includes(forbidden)) throw new Error(`obsolete event settlement returned to the transient pending registry: ${forbidden}`);
}

const mcpResumptionBoundary = readFileSync(join(root, "src", "worker", "mcp-resumption.ts"), "utf8");
for (const required of ["./mcp-resumption-config.ts", "./mcp-resumption-records.ts", "./mcp-pending-call-store.ts", "token_key", "session_id", "workerRestartMessage", "active = new Set", "transientReady = new Map"]) {
  if (!mcpResumptionBoundary.includes(required)) throw new Error(`MCP resumption lost a lifecycle or isolation boundary: ${required}`);
}
if (mcpResumptionBoundary.includes(".list(")) {
  throw new Error("MCP resumption scans full stored result values instead of its bounded metadata index");
}
for (const forbidden of ["Map<string, Promise", "attach(streamId", "Promise<JsonRpcMessage>"]) {
  if (mcpResumptionBoundary.includes(forbidden)) throw new Error(`MCP resumption regained cross-event promise state: ${forbidden}`);
}
const mcpResumptionRecordsBoundary = readFileSync(join(root, "src", "worker", "mcp-resumption-records.ts"), "utf8");
for (const required of ["STREAM_INDEX_KEY", "message_sha256", "sha256Hex", "DEFAULT_MAXIMUM_MESSAGE_BYTES"]) {
  if (!mcpResumptionRecordsBoundary.includes(required)) throw new Error(`MCP resumption records lost a storage-integrity boundary: ${required}`);
}
const mcpResumptionHttpBoundary = readFileSync(join(root, "src", "worker", "mcp-resumption-http.ts"), "utf8");
for (const required of ["Last-Event-ID", "resolveMcpSession", "tokenKey", "sessionId", "mcpStreamDescriptorResponse"]) {
  if (!mcpResumptionHttpBoundary.includes(required)) throw new Error(`MCP resumption HTTP boundary lost request binding: ${required}`);
}
if (mcpResumptionHttpBoundary.includes("resumeJsonRpcResponse")) {
  throw new Error("Durable Object resumption boundary regained public SSE ownership");
}

const daemonStatusBoundary = readFileSync(join(root, "src", "worker", "daemon-status.ts"), "utf8");
for (const required of ["daemonStatusSnapshot", "readySockets", "readyAttachment", "DAEMON_READY_TIMEOUT_MS", "DAEMON_LIVENESS_TIMEOUT_MS"]) {
  if (!daemonStatusBoundary.includes(required)) throw new Error(`daemon status projection lost bounded readiness/liveness state: ${required}`);
}
if (workerIndexBoundary.includes("connected: sockets.length > 0")) {
  throw new Error("Worker composition root regained daemon status projection logic");
}
const daemonSocketBoundary = readFileSync(join(root, "src", "worker", "daemon-sockets.ts"), "utf8");
for (const required of ["class DaemonSocketRegistry", "beginProbe", "promote", "readySockets", "probingSockets"]) {
  if (!daemonSocketBoundary.includes(required)) throw new Error(`daemon socket registry lost lifecycle responsibility: ${required}`);
}
for (const forbidden of ["serializeAttachment({ role: \"candidate\"", "serializeAttachment({ role: \"probing\"", "serializeAttachment({ role: \"daemon\""]) {
  if (workerIndexBoundary.includes(forbidden)) throw new Error(`Worker index regained daemon socket state mutation: ${forbidden}`);
}

for (const required of ["private async oauthStore", "private async withOAuthLock", "verifyAccessToken", "./oauth-authorization-page.ts"]) {
  if (!workerOAuthControllerBoundary.includes(required)) throw new Error(`OAuth controller lost state-machine responsibility: ${required}`);
}
for (const forbidden of ["AUTHORIZATION_FIELDS", "<form method=\"post\" action=\"/oauth/authorize\">"]) {
  if (workerOAuthControllerBoundary.includes(forbidden)) throw new Error(`OAuth controller regained authorization-page rendering: ${forbidden}`);
}
for (const required of ["AUTHORIZATION_FIELDS", "authorizationPage", "redirectOrigin"]) {
  if (!workerOAuthPageBoundary.includes(required)) throw new Error(`OAuth authorization page lost rendering/security responsibility: ${required}`);
}

function visitModule(file, stack) {
  if (visited.has(file)) return;
  if (visiting.has(file)) {
    const cycle = [...stack.slice(stack.indexOf(file)), file].map((item) => relative(localRoot, item)).join(" -> ");
    throw new Error(`local module dependency cycle detected: ${cycle}`);
  }
  visiting.add(file);
  for (const dependency of graph.get(file) || []) visitModule(dependency, [...stack, file]);
  visiting.delete(file);
  visited.add(file);
}

console.log(`architecture module boundaries ok (${modules.length} local modules)`);
