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
  "service-restart-handoff.mjs", "service-restart-scheduler.mjs", "windows-service.mjs", "relay-connection.mjs", "runtime-relay.mjs", "worker-deployment.mjs",
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
  "tool-executor.mjs",
  "observability.mjs",
  "process-tracker.mjs",
  "process-execution.mjs",
  "git-service.mjs",
  "workspace-file-service.mjs",
  "cli-options.mjs",
  "cli-policy.mjs",
  "lifecycle.mjs",
  "loopback-health.mjs",
  "cli-local-admin.mjs",
  "capability-ranking.mjs",
  "managed-job-plan.mjs",
  "numbers.mjs",
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
  "runtime-reporting.mjs",
  "runtime-resource-service.mjs",
  "runtime-tool-handlers.mjs",
  "runtime-paths.mjs",
  "relay-call-recovery.mjs",
  "browser-request-registry.mjs",
  "browser-bridge-http.mjs",
  "browser-broker-routes.mjs",
  "browser-broker-server.mjs",
  "windows-launcher.mjs",
  "managed-job-lock.mjs",
  "managed-job-projection.mjs",
  "managed-job-storage.mjs",
  "managed-job-runner.mjs",
]);
for (const name of boundaryModules) {
  const file = join(localRoot, name);
  if (!graph.has(file)) throw new Error(`architecture boundary module is missing: ${name}`);
  for (const dependency of graph.get(file) || []) {
    const dependencyName = relative(localRoot, dependency);
    if (adapterModules.has(dependencyName)) throw new Error(`${name} crosses the domain/adapter boundary by importing ${dependencyName}`);
  }
}

const lineLimits = Object.freeze({
  "src/local/runtime.mjs": 700,
  "src/local/runtime-tool-handlers.mjs": 100,
  "src/local/runtime-relay.mjs": 100,
  "src/local/relay-call-recovery.mjs": 170,
  "src/local/runtime-paths.mjs": 120,
  "src/local/runtime-reporting.mjs": 150,
  "src/local/runtime-resource-service.mjs": 100,
  "src/local/runtime-diagnostics.mjs": 120,
  "src/local/runtime-capabilities.mjs": 100,
  "src/local/cli.mjs": 950,
  "src/local/cli-service.mjs": 220,
  "src/worker/index.ts": 850,
  "src/worker/oauth-controller.ts": 360,
  "src/worker/oauth-authorization-page.ts": 100,
  "src/worker/oauth-tokens.ts": 260,
  "src/local/bounded-output.mjs": 80,
  "src/local/process-execution.mjs": 285,
  "src/local/process-output-stream.mjs": 110,
  "src/local/process-result-projection.mjs": 60,
  "src/local/process-sessions.mjs": 340,
  "src/local/relay-connection.mjs": 780,
  "src/local/process-contract.mjs": 40,
  "src/local/process-tree.mjs": 70,
  "src/local/process-tree-ownership.mjs": 80,
  "src/local/execution-limits.mjs": 55,
  "src/local/git-service.mjs": 220,
  "src/local/workspace-file-service.mjs": 550,
  "src/local/tool-executor.mjs": 180,
  "src/local/call-registry.mjs": 190,
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
  "src/local/managed-jobs.mjs": 700,
  "src/local/managed-job-lock.mjs": 140,
  "src/local/managed-job-projection.mjs": 100,
  "src/local/managed-job-storage.mjs": 130,
  "src/local/managed-job-runner.mjs": 100,
  "src/local/managed-job-plan.mjs": 300,
  "src/local/numbers.mjs": 30,
  "src/local/project-metadata.mjs": 80,
  "src/local/records.mjs": 20,
  "src/local/state-inventory.mjs": 170,
  "src/local/worker-health.mjs": 280,
  "src/local/worker-deployment.mjs": 220,
  "src/local/browser-bridge.mjs": 560,
  "src/local/browser-request-registry.mjs": 100,
  "src/local/browser-bridge-http.mjs": 80,
  "src/local/browser-broker-routes.mjs": 180,
  "src/local/browser-broker-server.mjs": 90,
  "src/local/browser-operation-service.mjs": 360,
  "src/local/browser-extension-protocol.mjs": 130,
  "src/local/browser-pairing-store.mjs": 120,
  "src/local/browser-pairing-http.mjs": 80,
  "src/local/worker-secret-file.mjs": 180,
  "src/local/service-environment.mjs": 140,
  "src/local/windows-service.mjs": 220,
  "src/local/windows-launcher.mjs": 90,
  "src/local/monotonic-deadline.mjs": 60,
  "src/worker/mcp-session.ts": 120,
  "src/worker/mcp-access.ts": 80,
  "src/worker/mcp-resumption-http.ts": 80,
  "src/worker/mcp-resumption-config.ts": 80,
  "src/worker/mcp-resumption.ts": 240,
  "src/worker/mcp-resumption-records.ts": 200,
  "src/worker/mcp-stream.ts": 160,
  "src/worker/tool-timeout.ts": 80,
  "src/worker/daemon-liveness.ts": 80,
  "src/worker/daemon-sockets.ts": 140,
  "src/worker/pending-calls.ts": 180,
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

const workspaceFileSource = readFileSync(join(localRoot, "workspace-file-service.mjs"), "utf8");
if (!workspaceFileSource.includes("async function writeFlushedText")
    || !workspaceFileSource.includes("await handle.sync()")
    || !workspaceFileSource.includes("staged file write failed and cleanup was incomplete")
    || (workspaceFileSource.match(/await writeFlushedText\(/g) || []).length !== 2) {
  throw new Error("workspace writes no longer flush both whole-file and patch staging files before commit");
}
if (!workspaceFileSource.includes("patch transaction failed and recovery was incomplete")
    || !workspaceFileSource.includes("Patch committed, but ${cleanupFailures.length} internal transaction artifact(s) could not be removed")) {
  throw new Error("patch transaction failures or committed-artifact cleanup errors can be silently swallowed");
}
const runtimeBoundarySource = readFileSync(join(localRoot, "runtime.mjs"), "utf8");
for (const forbidden of [
  "spawn(", "parsePatchEnvelope", "applyUpdateHunks", "workspaceShellCommand(",
  "function applicationMatchScore", "request_reached_local_runtime", "policy_contract:",
]) {
  if (runtimeBoundarySource.includes(forbidden)) throw new Error(`LocalRuntime regained low-level responsibility: ${forbidden}`);
}
const localPolicySource = readFileSync(join(localRoot, "policy.mjs"), "utf8");
const workerPolicySource = readFileSync(join(root, "src", "worker", "policy.ts"), "utf8");
if (!localPolicySource.includes('policy-contract.json') || !workerPolicySource.includes('policy-contract.json')) {
  throw new Error("local and Worker policy enforcement do not share the generated policy contract");
}
const workerIndexBoundary = readFileSync(join(root, "src", "worker", "index.ts"), "utf8");
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
  "mcp-stream", "tool-timeout", "daemon-liveness", "daemon-sockets",
]) {
  if (!workerIndexBoundary.includes(`./${module}`)) throw new Error(`Worker index lost boundary module: ${module}`);
}
const mcpResumptionBoundary = readFileSync(join(root, "src", "worker", "mcp-resumption.ts"), "utf8");
for (const required of ["./mcp-resumption-config.ts", "./mcp-resumption-records.ts", "token_key", "session_id", "workerRestartMessage"]) {
  if (!mcpResumptionBoundary.includes(required)) throw new Error(`MCP resumption lost a lifecycle or isolation boundary: ${required}`);
}
if (mcpResumptionBoundary.includes(".list(")) {
  throw new Error("MCP resumption scans full stored result values instead of its bounded metadata index");
}
const mcpResumptionRecordsBoundary = readFileSync(join(root, "src", "worker", "mcp-resumption-records.ts"), "utf8");
for (const required of ["STREAM_INDEX_KEY", "message_sha256", "sha256Hex", "DEFAULT_MAXIMUM_MESSAGE_BYTES"]) {
  if (!mcpResumptionRecordsBoundary.includes(required)) throw new Error(`MCP resumption records lost a storage-integrity boundary: ${required}`);
}
const mcpResumptionHttpBoundary = readFileSync(join(root, "src", "worker", "mcp-resumption-http.ts"), "utf8");
for (const required of ["Last-Event-ID", "resolveMcpSession", "tokenKey", "sessionId"]) {
  if (!mcpResumptionHttpBoundary.includes(required)) throw new Error(`MCP resumption HTTP boundary lost request binding: ${required}`);
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
