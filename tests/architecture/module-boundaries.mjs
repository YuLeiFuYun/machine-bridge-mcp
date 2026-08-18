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
  "service-restart-handoff.mjs", "service-restart-scheduler.mjs", "windows-service.mjs", "windows-service-convergence.mjs", "relay-connection.mjs", "runtime-relay.mjs", "macos-idle-sleep-assertion.mjs", "remote-activity-idle-sleep-guard.mjs", "worker-deployment.mjs", "hardened-npm.mjs", "hardened-npm-download.mjs", "hardened-npm-extract.mjs", "hardened-npm-verification.mjs", "wrangler-toolchain.mjs", "wrangler-toolchain-verification.mjs",
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
  "computer-use.mjs",
  "computer-use-deadline.mjs",
  "computer-use-dispatch-settlement.mjs",
  "computer-use-expectation.mjs",
  "computer-use-observation.mjs",
  "computer-use-application-observation.mjs",
  "computer-use-recovery.mjs",
  "computer-use-snapshot-store.mjs",
  "computer-use-result-budget.mjs",
  "browser-computer-observation-service.mjs",
  "macos-background-input.mjs",
  "bounded-output.mjs",
  "capability-observer.mjs",
  "default-instructions.mjs",
  "network-proxy.mjs",
  "npm-cli.mjs",
  "worker-health.mjs",
  "process-sessions.mjs",
  "process-session-remote-activity.mjs",
  "process-output-stream.mjs",
  "process-result-projection.mjs",
  "process-nonreplayable-settlement.mjs",
  "process-contract.mjs",
  "process-tree.mjs",
  "process-tree-ownership.mjs",
  "execution-limits.mjs",
  "resource-admission.mjs",
  "resource-admission-policy.mjs",
  "resource-admission-diagnostics.mjs",
  "resource-build-root.mjs",
  "resource-command-profile.mjs",
  "resource-host-linux.mjs",
  "resource-host-snapshot.mjs",
  "resource-lease-accounting.mjs",
  "resource-coordinator-accounting.mjs",
  "resource-process-ancestry.mjs",
  "resource-project-key.mjs",
  "resource-process-admission.mjs",
  "resource-request-contract.mjs",
  "resource-light-command.mjs",
  "resource-release-control-classification.mjs",
  "resource-release-control-executable.mjs",
  "resource-release-control-workspace.mjs",
  "resource-script-classification.mjs",
  "resource-shell-analysis.mjs",
  "resource-waiters.mjs",
  "project-package.mjs",
  "policy.mjs",
  "errors.mjs",
  "call-registry.mjs",
  "owner-state-lock.mjs",
  "release-runtime-lock.mjs",
  "exclusive-file.mjs",
  "child-process-settlement.mjs",
  "tool-executor.mjs",
  "observability.mjs",
  "process-tracker.mjs",
  "process-execution.mjs",
  "git-service.mjs",
  "git-config-safety.mjs",
  "git-metadata-boundary.mjs",
  "git-metadata-tree-safety.mjs",
  "git-operation-state.mjs",
  "git-commit.mjs",
  "git-log-parser.mjs",
  "fixed-process-environment.mjs",
  "support-state-projection.mjs",
  "file-mutation-coordinator.mjs",
  "file-snapshot-preservation.mjs",
  "directory-metadata.mjs",
  "filesystem-identity.mjs",
  "workspace-file-transaction.mjs",
  "workspace-search.mjs",
  "workspace-file-service.mjs",
  "cli-options.mjs",
  "cli-policy.mjs",
  "lifecycle.mjs",
  "loopback-health.mjs",
  "cli-local-admin.mjs",
  "capability-ranking.mjs",
  "execution-routing.mjs",
  "resource-staging-recovery.mjs",
  "resource-wait.mjs",
  "managed-job-plan.mjs",
  "numbers.mjs",
  "private-toolchain-integrity.mjs",
  "package-identity.mjs",
  "project-metadata.mjs",
  "records.mjs",
  "state-inventory.mjs",
  "state-owner-lock-inventory.mjs",
  "state-root-owned-namespaces.mjs",
  "browser-extension-protocol.mjs",
  "browser-extension-identity.mjs",
  "browser-pairing-store.mjs",
  "browser-pairing-http.mjs",
  "worker-secret-file.mjs",
  "service-environment.mjs",
  "service-status.mjs",
  "service-ownership.mjs",
  "service-definition.mjs",
  "monotonic-deadline.mjs",
  "runtime-capabilities.mjs",
  "application-capability-projection.mjs",
  "runtime-diagnostics.mjs",
  "system-network-route.mjs",
  "systemd-removal.mjs",
  "runtime-reporting.mjs",
  "runtime-info-projection.mjs",
  "runtime-resource-service.mjs",
  "runtime-tool-handlers.mjs",
  "runtime-paths.mjs",
  "relay-call-recovery.mjs",
  "relay-connection-classification.mjs",
  "relay-liveness.mjs",
  "browser-request-registry.mjs",
  "browser-request-settlement.mjs",
  "browser-bridge-http.mjs",
  "browser-broker-routes.mjs",
  "browser-broker-auth.mjs",
  "browser-pairing-grant.mjs",
  "browser-pairing-launch.mjs",
  "browser-broker-auth-http.mjs",
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

for (const name of ["process-tree-ownership.mjs", "process-identity.mjs", "resource-process-ancestry.mjs", "delegated-process-sandbox.mjs", "macos-trust-broker.mjs"]) {
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
  "src/local/runtime-activity-projection.mjs": 60,
  "src/local/runtime-info-projection.mjs": 70,
  "src/local/runtime-resource-service.mjs": 100,
  "src/local/resource-operations.mjs": 110,
  "src/local/resource-staging-recovery.mjs": 100,
  "src/local/resource-wait.mjs": 50,
  "src/local/secure-file.mjs": 180,
  "src/local/ssh-key.mjs": 290,
  "src/local/service-definition.mjs": 40,
  "src/local/cli-activate.mjs": 180,
  "src/local/account-admin.mjs": 240,
  "src/local/account-admin-response.mjs": 120,
  "src/local/runtime-diagnostics.mjs": 120,
  "src/local/runtime-diagnostic-state.mjs": 40,
  "src/local/system-network-route.mjs": 80,
  "src/local/systemd-removal.mjs": 40,
  "src/local/runtime-capabilities.mjs": 100,
  "src/local/application-capability-projection.mjs": 50,
  "src/local/cli.mjs": 900,
  "src/local/cli-ready-output.mjs": 80,
  "src/local/cli-service.mjs": 220,
  "src/worker/index.ts": 830,
  "src/worker/oauth-controller.ts": 360,
  "src/worker/oauth-record-contract.ts": 20,
  "src/worker/oauth-field-contract.ts": 40,
  "src/worker/oauth-store-validation.ts": 140,
  "src/worker/oauth-authorization-page.ts": 100,
  "src/worker/oauth-tokens.ts": 260,
  "src/local/bounded-output.mjs": 80,
  "src/local/process-execution.mjs": 285,
  "src/local/process-nonreplayable-settlement.mjs": 60,
  "src/local/process-foreground-timeout.mjs": 60,
  "src/local/process-output-stream.mjs": 110,
  "src/local/process-result-projection.mjs": 60,
  "src/local/process-sessions.mjs": 340,
  "src/local/process-session-remote-activity.mjs": 20,
  "src/local/relay-connection.mjs": 680,
  "src/local/relay-connection-classification.mjs": 160,
  "src/local/relay-liveness.mjs": 110,
  "src/local/relay-heartbeat.mjs": 130,
  "src/local/process-contract.mjs": 40,
  "src/local/process-tree.mjs": 70,
  "src/local/process-tree-signal.mjs": 50,
  "src/local/process-tree-supervisor.mjs": 70,
  "src/local/process-tree-snapshot.mjs": 100,
  "src/local/process-tree-ownership.mjs": 80,
  "src/local/execution-limits.mjs": 55,
  "src/local/resource-admission.mjs": 340,
  "src/local/resource-admission-policy.mjs": 150,
  "src/local/resource-pressure.mjs": 90,
  "src/local/resource-disk-headroom.mjs": 30,
  "src/local/resource-admission-diagnostics.mjs": 60,
  "src/local/resource-build-root.mjs": 90,
  "src/local/resource-cargo-concurrency.mjs": 45,
  "src/local/resource-cmake-concurrency.mjs": 45,
  "src/local/resource-go-concurrency.mjs": 45,
  "src/local/resource-gradle-concurrency.mjs": 60,
  "src/local/resource-swift-concurrency.mjs": 35,
  "src/local/resource-xcode-concurrency.mjs": 35,
  "src/local/resource-xcode-command.mjs": 30,
  "src/local/resource-xcode-non-build.mjs": 30,
  "src/local/resource-make-concurrency.mjs": 60,
  "src/local/resource-ninja-command-concurrency.mjs": 30,
  "src/local/resource-ninja-concurrency.mjs": 35,
  "src/local/resource-command-profile.mjs": 180,
  "src/local/resource-command-concurrency.mjs": 70,
  "src/local/resource-maven-concurrency.mjs": 40,
  "src/local/resource-pytest-concurrency.mjs": 45,
  "src/local/resource-elastic-memory.mjs": 30,
  "src/local/resource-elastic-request.mjs": 40,
  "src/local/resource-host-cache.mjs": 50,
  "src/local/resource-host-sample-file.mjs": 40,
  "src/local/resource-host-darwin.mjs": 80,
  "src/local/resource-host-linux.mjs": 80,
  "src/local/resource-host-snapshot.mjs": 100,
  "src/local/resource-lease-accounting.mjs": 130,
  "src/local/resource-cpu-window.mjs": 40,
  "src/local/resource-coordinator-accounting.mjs": 30,
  "src/local/resource-probe-command.mjs": 60,
  "src/local/resource-process-ancestry.mjs": 45,
  "src/local/resource-process-ancestry-cache.mjs": 60,
  "src/local/resource-project-key.mjs": 55,
  "src/local/resource-process-admission.mjs": 60,
  "src/local/resource-process-priority.mjs": 40,
  "src/local/resource-transaction-lock.mjs": 190,
  "src/local/resource-request-contract.mjs": 50,
  "src/local/npm-cli.mjs": 55,
  "src/local/resource-light-command.mjs": 20,
  "src/local/resource-release-control-classification.mjs": 35,
  "src/local/resource-release-control-executable.mjs": 80,
  "src/local/resource-release-control-workspace.mjs": 45,
  "src/local/resource-script-classification.mjs": 45,
  "src/local/resource-shell-analysis.mjs": 80,
  "src/local/resource-waiters.mjs": 140,
  "src/shared/tool-call-capacity.mjs": 80,
  "src/shared/project-overview-projection.mjs": 110,
  "src/shared/activation-recovery.mjs": 70,
  "src/local/call-capacity.mjs": 70,
  "src/local/git-service.mjs": 220,
  "src/local/git-config-safety.mjs": 65,
  "src/local/git-metadata-boundary.mjs": 85,
  "src/local/git-metadata-tree-safety.mjs": 60,
  "src/local/git-operation-state.mjs": 30,
  "src/local/git-commit.mjs": 80,
  "src/local/git-log-parser.mjs": 50,
  "src/local/fixed-process-environment.mjs": 25,
  "src/local/support-state-projection.mjs": 35,
  "src/local/file-mutation-coordinator.mjs": 80,
  "src/local/file-snapshot-preservation.mjs": 40,
  "src/local/directory-metadata.mjs": 60,
  "src/local/filesystem-identity.mjs": 55,
  "src/local/workspace-file-transaction.mjs": 190,
  "src/local/workspace-search.mjs": 80,
  "src/local/workspace-file-service.mjs": 430,
  "src/local/tool-executor.mjs": 180,
  "src/local/macos-idle-sleep-assertion.mjs": 80,
  "src/local/remote-activity-idle-sleep-guard.mjs": 80,
  "src/local/security-audit-log.mjs": 220,
  "src/local/security-audit-storage.mjs": 230,
  "src/local/security-audit-state.mjs": 180,
  "src/local/security-audit-worker.mjs": 110,
  "src/local/security-audit-dispatch.mjs": 60,
  "src/local/security-audit-warning.mjs": 60,
  "src/local/call-registry.mjs": 190,
  "src/local/owner-state-lock.mjs": 130,
  "src/local/release-runtime-lock.mjs": 40,
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
  "src/local/managed-job-capacity.mjs": 50,
  "src/local/managed-job-retention.mjs": 130,
  "src/local/managed-job-terminal-maintenance.mjs": 80,
  "src/local/managed-job-projection.mjs": 100,
  "src/local/managed-job-storage.mjs": 130,
  "src/local/managed-job-runner.mjs": 100,
  "src/local/managed-job-cancellation.mjs": 80,
  "src/local/managed-job-directory.mjs": 80,
  "src/local/managed-job-directory-generation.mjs": 70,
  "src/local/managed-job-plan.mjs": 300,
  "src/local/numbers.mjs": 30,
  "src/local/package-identity.mjs": 20,
  "src/local/project-metadata.mjs": 80,
  "src/local/records.mjs": 20,
  "src/local/state-inventory.mjs": 170,
  "src/local/state-owner-lock-inventory.mjs": 60,
  "src/local/state-root-owned-namespaces.mjs": 90,
  "src/local/state-root-retirement.mjs": 90,
  "src/local/worker-health.mjs": 280,
  "src/local/worker-deployment.mjs": 220,
  "src/local/hardened-npm.mjs": 230,
  "src/local/hardened-npm-download.mjs": 110,
  "src/local/hardened-npm-download-timeout.mjs": 60,
  "src/local/hardened-npm-extract.mjs": 50,
  "src/local/hardened-npm-verification.mjs": 110,
  "src/local/npm-environment.mjs": 40,
  "src/local/private-toolchain-integrity.mjs": 70,
  "src/local/wrangler-toolchain.mjs": 230,
  "src/local/wrangler-toolchain-verification.mjs": 140,
  "src/local/browser-bridge.mjs": 560,
  "src/local/browser-request-registry.mjs": 100,
  "src/local/browser-request-settlement.mjs": 80,
  "src/local/browser-bridge-http.mjs": 80,
  "src/local/browser-broker-routes.mjs": 180,
  "src/local/browser-broker-auth.mjs": 100,
  "src/local/browser-broker-auth-http.mjs": 90,
  "src/local/browser-pairing-grant.mjs": 110,
  "src/local/browser-pairing-launch.mjs": 80,
  "src/local/browser-broker-server.mjs": 90,
  "src/local/browser-operation-service.mjs": 360,
  "src/local/computer-use.mjs": 2280,
  "src/local/computer-use-deadline.mjs": 80,
  "src/local/computer-use-dispatch-settlement.mjs": 80,
  "src/local/computer-use-arguments.mjs": 310,
  "src/local/computer-use-expectation.mjs": 210,
  "src/local/computer-use-observation.mjs": 780,
  "src/local/computer-use-application-observation.mjs": 240,
  "src/local/computer-use-recovery.mjs": 90,
  "src/local/computer-use-snapshot-store.mjs": 70,
  "src/local/computer-use-result-budget.mjs": 150,
  "src/local/browser-computer-observation-service.mjs": 280,
  "src/local/macos-background-input.mjs": 410,
  "src/local/app-automation.mjs": 1180,
  "src/local/app-automation-macos-jxa.mjs": 380,
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
  "src/worker/mcp-access.ts": 80,
  "src/worker/mcp-stream-proxy-contract.ts": 100,
  "src/worker/mcp-http-accept.ts": 40,
  "src/worker/mcp-response-proxy.ts": 140,
  "src/worker/mcp-response-stream.ts": 90,
  "src/worker/mcp-controller.ts": 220,
  "src/worker/mcp-initialization-compat.ts": 170,
  "src/worker/mcp-removed-protocol.ts": 40,
  "src/worker/worker-static-routes.ts": 90,
  "src/worker/worker-metadata.ts": 80,
  "src/worker/worker-edge-guard.ts": 100,
  "src/worker/worker-rate-limit-key.ts": 50,
  "src/worker/worker-edge-log.ts": 80,
  "src/worker/oauth-token-issuance.ts": 120,
  "src/worker/oauth-token-derivation.ts": 70,
  "src/worker/oauth-refresh-exchange.ts": 180,
  "src/worker/oauth-refresh-authority.ts": 40,
  "src/worker/server-info.ts": 170,
  "src/worker/server-info-activity.ts": 40,
  "src/worker/daemon-status.ts": 60,
  "src/worker/worker-entry.ts": 80,
  "src/worker/tool-timeout.ts": 80,
  "src/worker/tool-catalog.ts": 80,
  "src/worker/daemon-liveness.ts": 80,
  "src/worker/daemon-sockets.ts": 140,
  "src/worker/daemon-channel.ts": 50,
  "src/worker/daemon-registry.ts": 70,
  "src/worker/daemon-http-auth.ts": 90,
  "src/worker/daemon-http-channel.ts": 130,
  "src/worker/daemon-http-controller.ts": 190,
  "src/worker/daemon-http-protocol.ts": 80,
  "src/worker/daemon-http-registry.ts": 100,
  "src/worker/daemon-ready-messages.ts": 80,
  "src/worker/daemon-ready-waiters.ts": 80,
  "src/worker/daemon-ready-dispatch.ts": 30,
  "src/worker/daemon-recovery-budget.ts": 30,
  "src/worker/daemon-socket-attachment.ts": 80,
  "src/worker/runtime-alarm.ts": 140,
  "src/worker/runtime-alarm-storage.ts": 60,
  "src/worker/observability.ts": 180,
  "src/worker/pending-calls.ts": 180,
  "src/worker/pending-call-capacity.ts": 150,
  "src/worker/pending-admission.ts": 40,
  "src/worker/pending-call-deadlines.ts": 80,
  "src/worker/mcp-jsonrpc.ts": 130,
  "src/worker/websocket-protocol.ts": 60,
  "browser-extension/browser-operations.js": 1920,
  "browser-extension/page-automation.js": 1200,
  "browser-extension/devtools-observation.js": 460,
  "browser-extension/broker-liveness.js": 50,
  "browser-extension/service-worker.js": 370,
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

const computerUseSource = readFileSync(join(localRoot, "computer-use.mjs"), "utf8");
const computerUseDeadlineSource = readFileSync(join(localRoot, "computer-use-deadline.mjs"), "utf8");
const computerUseDispatchSettlementSource = readFileSync(join(localRoot, "computer-use-dispatch-settlement.mjs"), "utf8");
const computerUseSnapshotStoreSource = readFileSync(join(localRoot, "computer-use-snapshot-store.mjs"), "utf8");
const appAutomationDurationSource = readFileSync(join(localRoot, "app-automation.mjs"), "utf8");
if (!computerUseSource.includes('from "./computer-use-snapshot-store.mjs"')
    || !computerUseSource.includes('from "./computer-use-deadline.mjs"')
    || !computerUseSource.includes('from "./monotonic-deadline.mjs"')
    || !computerUseSource.includes("now = () => performance.now()")
    || computerUseSource.includes("now = () => Date.now()")
    || !computerUseSnapshotStoreSource.includes("performance.now()")) {
  throw new Error("Computer Use snapshot/verification duration state lost its monotonic clock boundary");
}
if (computerUseDeadlineSource.includes("COMPUTER_USE_SETTLEMENT_RESERVE_MS")
    || !computerUseDeadlineSource.includes("Math.floor(remainingMs / 1000)")
    || computerUseDeadlineSource.includes("Math.ceil(remainingMs / 1000)")
    || !computerUseDeadlineSource.includes('reason: "computer_action_deadline_exhausted"')
    || !computerUseDeadlineSource.includes('reason: "computer_observe_deadline_exhausted"')) {
  throw new Error("Computer Use deadline budgeting escaped its dedicated monotonic-budget boundary");
}
if (!computerUseSource.includes('from "./computer-use-dispatch-settlement.mjs"')
    || !computerUseDispatchSettlementSource.includes("UNKNOWN_MUTATION_ERROR_PREFIXES")
    || !computerUseDispatchSettlementSource.includes("settleComputerUseDispatch")
    || computerUseSource.includes("UNKNOWN_MUTATION_ERROR_PREFIXES")) {
  throw new Error("Computer Use ambiguous mutation settlement escaped its dedicated boundary");
}
if (!appAutomationDurationSource.includes("expires_at: this.now() + VALUE_VERIFICATION_TTL_MS")
    || !appAutomationDurationSource.includes("const now = this.now()")
    || appAutomationDurationSource.includes("Date.now()")) {
  throw new Error("application exact-value retention or discovery duration state regained wall-clock timing");
}

const resourceAdmissionSource = readFileSync(join(localRoot, "resource-admission.mjs"), "utf8");
for (const required of ["createResourceWaiter", "selectedResourceWaiter", "process_group_isolated", "contention_key", "ResourceAdmissionError"]) {
  if (!resourceAdmissionSource.includes(required)) throw new Error(`resource admission lost durable/fair ownership contract: ${required}`);
}
if (!resourceAdmissionSource.includes('from "./resource-wait.mjs"') || resourceAdmissionSource.includes("timer.unref")) {
  throw new Error("resource admission wait liveness regressed to an unreferenced timer");
}
if (!resourceAdmissionSource.includes("withResourceTransactionLock") || resourceAdmissionSource.includes("withOwnerStateLock")) {
  throw new Error("resource admission lost the beta.60-compatible transaction-lock boundary required for rolling activation");
}
for (const required of ["PROCESS_OWNERSHIP_LOCK_WAIT_MS = 30_000", "Math.min(PROCESS_OWNERSHIP_LOCK_WAIT_MS, waitMs - (performance.now() - started))", "}, PROCESS_OWNERSHIP_LOCK_WAIT_MS);"]) {
  if (!resourceAdmissionSource.includes(required)) throw new Error(`resource coordinator lost operation-bounded transaction-lock waiting: ${required}`);
}
const resourceTransactionLockSource = readFileSync(join(localRoot, "resource-transaction-lock.mjs"), "utf8");
for (const required of ["mkdirSync(lockPath", 'OWNER_NAME = "owner.json"', "validDirectoryOwner", "validPriorFileOwner", "removeDirectoryGeneration", "recoverResourceTransactionOwnerStaging", "rmdirSync(lockPath)", "resource transaction lock was replaced before quarantine restore"]) {
  if (!resourceTransactionLockSource.includes(required)) throw new Error(`resource transaction lock lost rolling-version ownership semantics: ${required}`);
}
const resourceStagingRecoverySource = readFileSync(join(localRoot, "resource-staging-recovery.mjs"), "utf8");
for (const required of ["OWNER_STAGING", "recoverResourceTransactionOwnerStaging", "stagingPublisherMayBeCurrent", "unexpected owner-publication state"]) {
  if (!resourceStagingRecoverySource.includes(required)) throw new Error(`resource transaction owner-staging recovery regressed: ${required}`);
}
if (!resourceTransactionLockSource.includes('schema_version: 1') || !resourceTransactionLockSource.includes('kind: "file"')) {
  throw new Error("resource transaction lock no longer interoperates with beta.60 directories and prior beta.61 owner-state files");
}
const resourceWaitSource = readFileSync(join(localRoot, "resource-wait.mjs"), "utf8");
for (const required of ["setTimeout", "removeEventListener", "signal?.aborted", "resourceRetryDelayMs", "resourceChangeSignal", "signalResourceChange", "waitForResourceChange", "WeakMap", "2 ** step"]) {
  if (!resourceWaitSource.includes(required)) throw new Error(`resource wait lost liveness/cancellation cleanup: ${required}`);
}
if (!resourceAdmissionSource.includes("retryAttempt") || !resourceAdmissionSource.includes("resourceRetryDelayMs")
    || !resourceAdmissionSource.includes("waitForResourceChange") || !resourceAdmissionSource.includes("signalResourceChange(this)")
    || !resourceAdmissionSource.includes("if (removeResourceWaiter(this.waitersDir, waiter)) signalResourceChange(this)")
    || !resourceAdmissionSource.includes("if (pruned) signalResourceChange(this)") || !resourceAdmissionSource.includes("waiters.length < entries.length")) {
  throw new Error("resource admission regained fixed-cadence polling or lost same-daemon capacity/fairness wakeups");
}
for (const required of ["fitElasticRequestToPressure", "normalizedRequest(effectiveRequest)", "decision.reservation ?", "result.lease.request", "wait_${waiter.waiter_id}"]) {
  if (!resourceAdmissionSource.includes(required)) throw new Error(`resource admission lost in-queue elastic fan-out fitting: ${required}`);
}
const resourcePolicySource = readFileSync(join(localRoot, "resource-admission-policy.mjs"), "utf8");
for (const required of ["aggregateResourceLeases", "resourceRequestIncrement", "reservation: declared", "cpu_overcommit", "io_overcommit", "memory_overcommit", "cpuPressure", "ioPressure", "memoryPressure", "disk_reserve_floor", "project_resource_busy"]) {
  if (!resourcePolicySource.includes(required)) throw new Error(`resource admission lost work-conserving multi-resource policy: ${required}`);
}
const resourcePressureSource = readFileSync(join(localRoot, "resource-pressure.mjs"), "utf8");
for (const required of ["resourcePressureState", "psi_memory_full", "load_backlog", 'platform !== "darwin"', "heavy_root_count"]) {
  if (!resourcePressureSource.includes(required)) throw new Error(`resource pressure classification lost current host-signal policy: ${required}`);
}
const resourceDiskHeadroomSource = readFileSync(join(localRoot, "resource-disk-headroom.mjs"), "utf8");
for (const required of ["resourceDiskHardFloorBytes", "resourceDiskSoftFloorBytes", "Math.min(50 * GIB", "Math.min(80 * GIB"]) {
  if (!resourceDiskHeadroomSource.includes(required)) throw new Error(`resource disk headroom lost bounded proportional floors: ${required}`);
}
const resourceAccountingSource = readFileSync(join(localRoot, "resource-lease-accounting.mjs"), "utf8");
for (const required of ["resourceLeaseAccountingContext", "resourceRequestIncrement", "ancestorLeaseIds", "Math.max(own[key], childSum[key])"]) {
  if (!resourceAccountingSource.includes(required)) throw new Error(`resource lease accounting lost nested-envelope behavior: ${required}`);
}
const resourceCpuWindowSource = readFileSync(join(localRoot, "resource-cpu-window.mjs"), "utf8");
for (const required of ["unobservedResourceCpu", "leaseObservedBySample", "bound_at", 'owner?.kind !== "process"']) {
  if (!resourceCpuWindowSource.includes(required)) throw new Error(`resource CPU window lost sample-aligned startup protection: ${required}`);
}
const resourceCoordinatorAccountingSource = readFileSync(join(localRoot, "resource-coordinator-accounting.mjs"), "utf8");
for (const required of ["resourceCoordinatorEvaluator", "resourceLeaseAccountingContext", "candidate?.owner?.pid"]) {
  if (!resourceCoordinatorAccountingSource.includes(required)) throw new Error(`resource coordinator accounting lost requester ancestry: ${required}`);
}
const resourceAncestrySource = readFileSync(join(localRoot, "resource-process-ancestry.mjs"), "utf8");
for (const required of ["pid=,ppid=", "ParentProcessId", "sampleResourceProcessParentsAsync", "runResourceProbeAsync"]) {
  if (!resourceAncestrySource.includes(required)) throw new Error(`resource process ancestry lost bounded async cross-platform sampling: ${required}`);
}
if (resourceAncestrySource.includes("spawnSync") || resourceAncestrySource.includes("cachedResourceProcessParentSampler")) {
  throw new Error("resource process ancestry regained blocking transport or cache responsibility");
}
const resourceAncestryCacheSource = readFileSync(join(localRoot, "resource-process-ancestry-cache.mjs"), "utf8");
for (const required of ["cachedResourceProcessParentSamplerAsync", "DEFAULT_CACHE_MS = 1_000", "inFlight"]) {
  if (!resourceAncestryCacheSource.includes(required)) throw new Error(`resource process ancestry cache lost bounded/in-flight behavior: ${required}`);
}
for (const required of ["cachedResourceProcessParentSamplerAsync", "sampleResourceProcessParentsAsync", "resourceCoordinatorEvaluator", "resourceRequestForProject"]) {
  if (!resourceAdmissionSource.includes(required)) throw new Error(`resource admission lost hierarchy-aware async coordination: ${required}`);
}
const resourceProjectKeySource = readFileSync(join(localRoot, "resource-project-key.mjs"), "utf8");
for (const required of ["agent-resource-contention-v1", "resourceProjectContentionKey", "resourceProjectIdentityHash", "resourceProjectHash", "realpathSync", "ENOENT", "ENOTDIR", "canonicalResourceProjectPath", "normalizeResourceProjectIdentity", "extendedUnc"]) {
  if (!resourceProjectKeySource.includes(required)) throw new Error(`resource project key lost canonical cross-language identity: ${required}`);
}
const resourceProfileSource = readFileSync(join(localRoot, "resource-command-profile.mjs"), "utf8");
for (const required of ['resource_class: resourceClass', '"adaptive", 0.5', 'plan?.invalid', '"build-validation", "light"', "swiftJobPlan", "shellTokens.length === 1", "xcodeResourcePlan", "xcodeIsLightCommand", "xcodeNonBuildResourcePlan", "CARGO_BUILD_JOBS", "MBM_CHECK_CONCURRENCY", "resourceCommandEffectiveCwd", "directInterpreterHeavyScript", "packageManagerTokensHeavy", "markElasticCompilerJobs", "markPreservedCompilerJobs"]) {
  if (!resourceProfileSource.includes(required)) throw new Error(`resource command classification lost bounded/adaptive behavior: ${required}`);
}
if (!resourceProfileSource.includes('from "./resource-shell-analysis.mjs"') || !resourceProfileSource.includes('from "./resource-script-classification.mjs"') || resourceProfileSource.includes("function heavyShellScript")) {
  throw new Error("resource command profile regained script parsing/classification responsibility");
}
const resourceScriptSource = readFileSync(join(localRoot, "resource-script-classification.mjs"), "utf8");
for (const required of ["heavyScriptName", "directInterpreterHeavyScript", "packageManagerTokensHeavy", "heavyPackageScriptName", "coverage", "smoke"]) {
  if (!resourceScriptSource.includes(required)) throw new Error(`resource script classification lost actual-entrypoint behavior: ${required}`);
}
const resourceShellSource = readFileSync(join(localRoot, "resource-shell-analysis.mjs"), "utf8");
for (const required of ["heavyShellScript", "shellSegments", "commandTokens", "pythonModuleTokens", "commandString", 'from "./resource-script-classification.mjs"']) {
  if (!resourceShellSource.includes(required)) throw new Error(`resource shell analysis lost bounded command-shape behavior: ${required}`);
}
for (const forbidden of ["isLightCommand", "LIGHT_COMMANDS", "LIGHT_GIT_COMMANDS"]) {
  if (resourceShellSource.includes(forbidden)) throw new Error(`arbitrary shell regained a blanket light-resource bypass: ${forbidden}`);
}
const resourceLightCommandSource = readFileSync(join(localRoot, "resource-light-command.mjs"), "utf8");
for (const required of ["TRUSTED_LIGHT_EXECUTABLES", "isTrustedLightExecutable", '"/bin/ps"', '"/usr/bin/uptime"']) {
  if (!resourceLightCommandSource.includes(required)) throw new Error(`trusted light executable boundary lost identity rule: ${required}`);
}
if (resourceShellSource.includes("function heavyScriptName")) throw new Error("resource shell analysis regained script-name classification responsibility");
const resourceConcurrencySource = readFileSync(join(localRoot, "resource-command-concurrency.mjs"), "utf8");
for (const required of ["DEFAULT_COMPILER_JOBS = 3", "cargoJobPlan", "genericBuildJobPlan", "cmakeBuildJobPlan", "goJobPlan", "gradleJobPlan", "makeCommandJobPlan", "makeFlagsJobPlan", "mavenJobPlan", "ninjaCommandJobPlan", "ninjaJobserverPlan", "verificationFanoutPlan", "hasConfiguredValue(value)", "unboundedPlan", "MBM_CHECK_CONCURRENCY"]) {
  if (!resourceConcurrencySource.includes(required)) throw new Error(`resource command concurrency lost explicit/default fan-out accounting: ${required}`);
}
const resourceCargoConcurrencySource = readFileSync(join(localRoot, "resource-cargo-concurrency.mjs"), "utf8");
for (const required of ["CARGO_BUILD_JOBS", "availableParallelism", 'text === "default"', "cores + parsed", "cargoDeclaredJobPlan", 'current === "--"', "preserve"]) {
  if (!resourceCargoConcurrencySource.includes(required)) throw new Error(`Cargo concurrency lost relative/default explicit-job accounting: ${required}`);
}
const resourceCmakeConcurrencySource = readFileSync(join(localRoot, "resource-cmake-concurrency.mjs"), "utf8");
for (const required of ["cmakeBuildJobPlan", "CMAKE_BUILD_PARALLEL_LEVEL", "CMAKE_INT_MAX", '"--parallel"', '"--preset"', "cmakeIsFlag", "invalidPlan", "unboundedPlan", "preserve"]) {
  if (!resourceCmakeConcurrencySource.includes(required)) throw new Error(`CMake concurrency lost last-wins/preset/native fail-closed accounting: ${required}`);
}
const resourceMakeConcurrencySource = readFileSync(join(localRoot, "resource-make-concurrency.mjs"), "utf8");
for (const required of ["GNUMAKEFLAGS", "MAKEFLAGS", "makeCommandJobPlan", "makeFlagsJobPlan", "--jobserver-auth=", "compactPlan", "preserve"]) {
  if (!resourceMakeConcurrencySource.includes(required)) throw new Error(`GNU make concurrency lost argv/environment option accounting: ${required}`);
}
const resourceGradleConcurrencySource = readFileSync(join(localRoot, "resource-gradle-concurrency.mjs"), "utf8");
for (const required of ["gradleJobPlan", "JAVA_OPTS", "GRADLE_OPTS", "org.gradle.workers.max", '"--max-workers"', '"--system-prop"', "splitJvmOptions", "GRADLE_INT_MAX", "invalidPlan", "unboundedPlan", "preserve"]) {
  if (!resourceGradleConcurrencySource.includes(required)) throw new Error(`Gradle concurrency lost CLI/system-property precedence or validation accounting: ${required}`);
}
const resourceNinjaCommandSource = readFileSync(join(localRoot, "resource-ninja-command-concurrency.mjs"), "utf8");
for (const required of ["ninjaCommandJobPlan", "NINJA_INT_MAX", 'value === "-j"', 'startsWith("-j")', '"--jobs"', "invalidPlan", "unboundedPlan"]) {
  if (!resourceNinjaCommandSource.includes(required)) throw new Error(`Ninja direct concurrency lost getopt last-wins/validation accounting: ${required}`);
}
const resourceNinjaConcurrencySource = readFileSync(join(localRoot, "resource-ninja-concurrency.mjs"), "utf8");
for (const required of ["ninjaJobserverPlan", "MAKEFLAGS", "--jobserver-auth=", "--jobserver-fds=", 'platform === "win32"', 'value.startsWith("fifo:")', 'args[0].includes("n")', "descriptorPair", "cooperativePlan", "unbounded: true", "preserve: true"]) {
  if (!resourceNinjaConcurrencySource.includes(required)) throw new Error(`Ninja concurrency lost GNU jobserver preservation: ${required}`);
}
const resourceGoConcurrencySource = readFileSync(join(localRoot, "resource-go-concurrency.mjs"), "utf8");
for (const required of ["goJobPlan", "GOFLAGS", "directGoPlan", "splitGoFlags", "^--?p=", '"-args"', '"--args"', "ambiguous", "fatal", "invalidPlan", "unboundedPlan", "preserve"]) {
  if (!resourceGoConcurrencySource.includes(required)) throw new Error(`Go concurrency lost direct/GOFLAGS precedence or invalid-fast-path accounting: ${required}`);
}
const resourceSwiftConcurrencySource = readFileSync(join(localRoot, "resource-swift-concurrency.mjs"), "utf8");
for (const required of ["swiftJobPlan", "SWIFT_UINT32_MAX", '"-j", "--jobs"', "parsed === 0", "invalidPlan", "unboundedPlan"]) {
  if (!resourceSwiftConcurrencySource.includes(required)) throw new Error(`SwiftPM concurrency lost scalar last-wins/llbuild-zero accounting: ${required}`);
}
const resourceXcodeConcurrencySource = readFileSync(join(localRoot, "resource-xcode-concurrency.mjs"), "utf8");
for (const required of ["xcodeBuildJobPlan", "xcodeHasIndependentTestFanout", "xcodeResourcePlan", 'value === "-jobs"', 'startsWith("-jobs=")', "seen > 1", "parsed < 1", "invalidPlan", "unboundedPlan"]) {
  if (!resourceXcodeConcurrencySource.includes(required)) throw new Error(`Xcode concurrency lost single-jobs validation or independent-test-fanout accounting: ${required}`);
}
const resourceXcodeCommandSource = readFileSync(join(localRoot, "resource-xcode-command.mjs"), "utf8");
for (const required of ["xcodeIsLightCommand", '"-help"', '"-usage"', '"-showsdks"']) {
  if (!resourceXcodeCommandSource.includes(required)) throw new Error(`Xcode light command classification lost query safety: ${required}`);
}
const resourceXcodeNonBuildSource = readFileSync(join(localRoot, "resource-xcode-non-build.mjs"), "utf8");
for (const required of ["xcodeNonBuildResourcePlan", '"-resolvePackageDependencies"', '"-exportArchive"', '"-downloadPlatform"', '"-deleteComponent"', '"-showBuildSettings"', '"xcode-maintenance"', '"xcode-artifact"', '"xcode-package-resolution"', '"xcode-query"']) {
  if (!resourceXcodeNonBuildSource.includes(required)) throw new Error(`Xcode non-build resource classification lost workload-specific accounting: ${required}`);
}
const resourceMavenConcurrencySource = readFileSync(join(localRoot, "resource-maven-concurrency.mjs"), "utf8");
for (const required of ["mavenJobPlan", "mavenCoreMultiplierPlan", "MAVEN_ARGS", "availableParallelism", "Math.trunc", 'endsWith("C")', "preserve"]) {
  if (!resourceMavenConcurrencySource.includes(required)) throw new Error(`Maven concurrency lost exact CLI/environment thread accounting: ${required}`);
}
const resourcePytestConcurrencySource = readFileSync(join(localRoot, "resource-pytest-concurrency.mjs"), "utf8");
for (const required of ["pytestWorkerPlan", 'requested === "0"', '"auto", "logical"', '"--maxprocesses"', "unboundedPlan"]) {
  if (!resourcePytestConcurrencySource.includes(required)) throw new Error(`pytest worker concurrency lost bounded auto/logical accounting: ${required}`);
}
const resourceElasticSource = readFileSync(join(localRoot, "resource-elastic-request.mjs"), "utf8");
for (const required of ["Symbol(", "markElasticCompilerJobs", "memory_floor_mb", "cpu_overcommit", "elasticMemoryJobLimit", "markPreservedCompilerJobs", "preservesCompilerJobs", "fitElasticRequestToPressure", "cpu_busy_cores", "unobserved_reserved_cpu"]) {
  if (!resourceElasticSource.includes(required)) throw new Error(`elastic resource request lost in-memory headroom fitting: ${required}`);
}
const resourceElasticMemorySource = readFileSync(join(localRoot, "resource-elastic-memory.mjs"), "utf8");
for (const required of ["elasticMemoryJobLimit", "elasticMemoryMb", "memory_overcommit", "used?.memory_mb"]) {
  if (!resourceElasticMemorySource.includes(required)) throw new Error(`elastic resource memory fitting lost declared fan-out budget behavior: ${required}`);
}
const resourceWaitersSource = readFileSync(join(localRoot, "resource-waiters.mjs"), "utf8");
if (!resourceWaitersSource.includes("resource waiter changed during stale pruning")) throw new Error("resource waiter stale pruning lost fail-closed ownership revalidation");
if (["elasticCompilerJobs", "preserveCompilerJobs"].some((marker) => resourceAdmissionSource.includes(marker)
    || resourceWaitersSource.includes(marker))) {
  throw new Error("elastic compiler marker leaked into persisted resource coordinator request schema");
}
const resourceHostSource = readFileSync(join(localRoot, "resource-host-snapshot.mjs"), "utf8");
for (const required of ["sampleResourceHostAsync", "sampleDarwinHostAsync", "CPU_BUSY_SAMPLE_MS = 50", "options.previous", "cpuBusyWindow", "cpuTimeTotals", 'from "./resource-host-linux.mjs"']) {
  if (!resourceHostSource.includes(required)) throw new Error(`resource host snapshot lost async orchestration: ${required}`);
}
if (resourceHostSource.includes('"ps"') || resourceHostSource.includes("spawnSync") || resourceHostSource.includes("execFile") || resourceHostSource.includes("function sampleLinux") || resourceHostSource.includes("function sampleDarwin")) {
  throw new Error("resource host snapshot regained blocking transport or platform parsing responsibility");
}
const resourceDarwinHostSource = readFileSync(join(localRoot, "resource-host-darwin.mjs"), "utf8");
for (const required of ["sampleDarwinHostAsync", "Promise.all", "memory_pressure", "vm_stat", "iostat", "pmset"]) {
  if (!resourceDarwinHostSource.includes(required)) throw new Error(`Darwin resource host sampling lost parallel pressure probes: ${required}`);
}
const resourceProbeSource = readFileSync(join(localRoot, "resource-probe-command.mjs"), "utf8");
for (const required of ["runResourceProbeAsync", "execFile", "runResourceProbeSync", "spawnSync", 'killSignal: "SIGKILL"']) {
  if (!resourceProbeSource.includes(required)) throw new Error(`resource probe transport lost bounded sync/async execution: ${required}`);
}
const resourceHostCacheSource = readFileSync(join(localRoot, "resource-host-cache.mjs"), "utf8");
for (const required of ["HOST_SAMPLE_FRESH_MS = 500", "HOST_CPU_PREVIOUS_MAX_AGE_MS = 2_000", "HOST_IO_SAMPLE_FRESH_MS = 5_000", "HOST_IO_HINT_MAX_AGE_MS = 30_000", "cached?.sample_scope === scope", "previous: cpuPrevious", "withCachedIo(quick, scopedCached)", "io_sampled_at_ms"]) {
  if (!resourceHostCacheSource.includes(required)) throw new Error(`resource host cache lost global-CPU/scoped-I/O freshness split: ${required}`);
}
if (!resourceAdmissionSource.includes("hostSamplesInFlight") || !resourceAdmissionSource.includes("resourceProjectHash(cwd)") || !resourceAdmissionSource.includes("resourceHostNeedsFreshIo")) {
  throw new Error("resource admission lost in-process single-flight host sampling");
}
if (!resourceAdmissionSource.includes("sampleResourceHostAsync") || resourceAdmissionSource.includes("sampleResourceHost(")) {
  throw new Error("resource admission live path regained blocking host sampling");
}
if ((resourceAdmissionSource.match(/readdirSync\(this\.leasesDir\)\.some/g) || []).length < 2) {
  throw new Error("resource admission regained unconditional process-ancestry sampling on an empty lease set");
}
const resourceLinuxHostSource = readFileSync(join(localRoot, "resource-host-linux.mjs"), "utf8");
for (const required of ["/proc/meminfo", "/proc/pressure/cpu", "/proc/pressure/memory", "/proc/pressure/io", "MemAvailable", "avg10"]) {
  if (!resourceLinuxHostSource.includes(required)) throw new Error(`Linux resource host sampling lost kernel pressure signal: ${required}`);
}
const resourceBuildRootSource = readFileSync(join(localRoot, "resource-build-root.mjs"), "utf8");
for (const required of [
  "AgentBuilds.noindex", ".metadata_never_index", "CARGO_TARGET_DIR", "--scratch-path", "-derivedDataPath",
  "applyCompilerConcurrency", "--parallel", "--max-workers", '"-T"', '"-p"',
]) {
  if (!resourceBuildRootSource.includes(required)) throw new Error(`shared build root lost compiler-cache isolation: ${required}`);
}
const resourcePrioritySource = readFileSync(join(localRoot, "resource-process-priority.mjs"), "utf8");
for (const required of ["BACKGROUND_NICE_INCREMENT = 5", "UNBOUNDED_NICE_INCREMENT = 2", 'request?.priority === "background"', 'request?.unbounded === true', 'request?.heavy !== true']) {
  if (!resourcePrioritySource.includes(required)) throw new Error(`resource process priority lost work-conserving background behavior: ${required}`);
}
const resourceProcessAdmissionSource = readFileSync(join(localRoot, "resource-process-admission.mjs"), "utf8");
if (!resourceProcessAdmissionSource.includes("applyResourceProcessPriority")) throw new Error("resource process admission lost centralized background priority injection");
if (!resourceProcessAdmissionSource.includes("{ ...request, ...lease.request }") || resourceProcessAdmissionSource.includes("fitElastic")) {
  throw new Error("resource process admission lost coordinator-selected values or process-local compiler metadata after durable lease normalization");
}
for (const [name, required] of [["process-execution.mjs", "acquireProcessResources"], ["process-sessions.mjs", "acquireProcessResources"], ["job-runner.mjs", "acquireProcessResources"]]) {
  if (!readFileSync(join(localRoot, name), "utf8").includes(required)) throw new Error(`${name} bypasses shared machine resource admission`);
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
for (const required of ["filesystemIdentity", "sameFilesystemIdentity", "exactFilesystemInteger", "filesystemGeneration", "ctimeNs", "cannot be represented losslessly"]) {
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
const processLockStateSource = readFileSync(join(localRoot, "state.mjs"), "utf8");
for (const required of [
  'readBoundedRegularFileWithInfoSync(filePath, MAX_STATE_JSON_BYTES, "state JSON"',
  'verifyPathIdentity: true, rejectMultipleLinks: true',
  'readBoundedRegularFileWithInfoSync(markerPath, MAX_MARKER_BYTES, "state recovery marker"',
  '"state marker", { verifyPathIdentity: true, rejectMultipleLinks: true }',
  'label, { verifyPathIdentity: true, rejectMultipleLinks: true }',
]) {
  if (!processLockStateSource.includes(required)) throw new Error(`state persistence/destructive evidence lost secure read options: ${required}`);
}
if (!processLockStateSource.includes("preserveFileSnapshotSync(filePath, backupPath, opened.buffer, opened.identity")
    || processLockStateSource.includes("replaceFileSync(filePath, backupPath)")) {
  throw new Error("corrupt state backup regained path-only rename instead of exact snapshot preservation");
}
for (const required of ["readRecoveryMarker(recoveryPath", "recoverySnapshot.identity", "unlinkRegularFileIfIdentitySync(recoveryPath", "opened.identity"]) {
  if (!processLockStateSource.includes(required)) throw new Error(`state recovery marker lost identity-bound removal: ${required}`);
}
if (processLockStateSource.includes("unlinkSync(recoveryPath)")) throw new Error("state recovery marker regained path-only unlink");
for (const required of ["readBoundedRegularFileWithInfoSync(lockPath", "verifyPathIdentity: true", "rejectMultipleLinks: true", "opened.identity", "opened.identityInfo", "process lock link count"]) {
  if (!processLockStateSource.includes(required)) throw new Error(`process lock reader lost single-descriptor snapshot identity: ${required}`);
}
const projectMetadataSource = readFileSync(join(localRoot, "project-metadata.mjs"), "utf8");
for (const required of ["filesystem-identity.mjs", "sameFilesystemIdentity", "bigint: true"]) {
  if (!projectMetadataSource.includes(required)) throw new Error(`project metadata lost lossless path/descriptor identity verification: ${required}`);
}
if (/pathInfo\.(?:dev|ino)\s*[!=]==?\s*current\.(?:dev|ino)/.test(projectMetadataSource)) {
  throw new Error("project metadata regained Number-backed filesystem identity comparison");
}
const operationRiskSource = readFileSync(join(localRoot, "operation-risk.mjs"), "utf8");
const operationTargetRedaction = /function redactTarget[\s\S]*?\n}/.exec(operationRiskSource)?.[0] || "";
if (!operationTargetRedaction.includes("Object.create(null)")) {
  throw new Error("operation-risk audit target redaction regained an Object.prototype-backed dynamic-key map");
}
const localLogSource = readFileSync(join(localRoot, "log.mjs"), "utf8");
const workerObservabilitySource = readFileSync(join(root, "src", "worker", "observability.ts"), "utf8");
const workerEdgeLogSource = readFileSync(join(root, "src", "worker", "worker-edge-log.ts"), "utf8");
for (const [name, source] of [["local log", localLogSource], ["Worker observability", workerObservabilitySource], ["Worker edge log", workerEdgeLogSource]]) {
  if (!source.includes("Object.create(null)")) throw new Error(`${name} structured fields regained an Object.prototype-backed dynamic-key map`);
}
const stateBoundary = readFileSync(join(localRoot, "state.mjs"), "utf8");
const serviceBoundary = readFileSync(join(localRoot, "service.mjs"), "utf8");
const systemdRemovalBoundary = readFileSync(join(localRoot, "systemd-removal.mjs"), "utf8");
for (const required of ["definitionPresent", "disableCode", "service_active_or_transitioning", "disable_failed", "already_absent"]) {
  if (!systemdRemovalBoundary.includes(required)) throw new Error(`systemd removal decision lost structural provider evidence: ${required}`);
}
const uninstallLaunchdBoundary = /async function uninstallLaunchd[\s\S]*?async function uninstallSystemd/.exec(serviceBoundary)?.[0] || "";
if (/not loaded|not found|does not exist|could not find|no such process/i.test(uninstallLaunchdBoundary)) {
  throw new Error("launchd definition removal regained stderr-text-based success classification");
}
const uninstallSystemdBoundary = /async function uninstallSystemd[\s\S]*?export async function stopSystemdService/.exec(serviceBoundary)?.[0] || "";
if (!serviceBoundary.includes('from "./systemd-removal.mjs"')
    || /not loaded|not found|does not exist/i.test(uninstallSystemdBoundary)
    || serviceBoundary.includes("export function normalizeServiceCommandResult")) {
  throw new Error("systemd removal regained stderr-text authorization or the dead service-result adapter");
}
const systemdInactiveBoundary = /function systemdStatusIsInactive[\s\S]*?function systemdStatusRequiresRestore/.exec(serviceBoundary)?.[0] || "";
if (systemdInactiveBoundary.includes("status?.installed === false ||")) {
  throw new Error("missing systemd definition again implies inactive provider state without an activity check");
}
const logSchemaReadBoundary = /function readLogSchema[\s\S]*?function readLogTail/.exec(serviceBoundary)?.[0] || "";
for (const required of ["verifyPathIdentity: true", "rejectMultipleLinks: true"]) {
  if (!logSchemaReadBoundary.includes(required)) throw new Error(`autostart log schema lost destructive-evidence read hardening: ${required}`);
}
const stateInventoryBoundary = readFileSync(join(localRoot, "state-inventory.mjs"), "utf8");
for (const required of ['readBoundedRegularFileSync(path, MAX_STATE_BYTES, "state inventory"', "verifyPathIdentity: true", "rejectMultipleLinks: true", "inspectPathIfPresentSync", "state profile directory must be a real directory", "state profile directory contains an unexpected entry", "managed-job root must be a real directory"]) {
  if (!stateInventoryBoundary.includes(required)) throw new Error(`state inventory lost destructive-evidence read hardening: ${required}`);
}
if (stateInventoryBoundary.includes("existsSync(")) throw new Error("destructive state inventory again treats inspection failure as absence");
for (const forbidden of ["if (existsSync(statePath))", "const recoveryPending = existsSync(recoveryPath)", "if (existsSync(recoveryPath))", "if (!existsSync(file)) return;", "while (!existsSync(existing))"]) {
  if (stateBoundary.includes(forbidden)) throw new Error(`state persistence again treats inspection failure as absence: ${forbidden}`);
}
for (const required of ['inspectPathIfPresentSync(statePath, "workspace state")', 'inspectPathIfPresentSync(recoveryPath, "state recovery marker")', 'while (!inspectPathIfPresentSync(existing, "path identity"))', 'readProcessLockSnapshot(file)']) {
  if (!stateBoundary.includes(required)) throw new Error(`state persistence lost fail-closed presence inspection: ${required}`);
}
const packageIdentitySource = readFileSync(join(localRoot, "package-identity.mjs"), "utf8");
for (const required of ["server-metadata.json", "package.json", "fileURLToPath", "export const packageRoot", "export const packageName", "export const packageVersion", "export const appName"]) {
  if (!packageIdentitySource.includes(required)) throw new Error(`package identity boundary lost static package metadata ownership: ${required}`);
}
if (!stateBoundary.includes('from "./package-identity.mjs"')
    || /export const (?:packageRoot|appName)/.test(stateBoundary)
    || stateBoundary.includes("fileURLToPath(import.meta.url)")) {
  throw new Error("state module regained static package identity ownership");
}
for (const name of ["browser-extension-protocol.mjs", "shell.mjs", "worker-health.mjs", "browser-extension-identity.mjs"]) {
  const source = readFileSync(join(localRoot, name), "utf8");
  if (source.includes('from "./state.mjs"')) throw new Error(`${name} regained an unnecessary state dependency for static package identity`);
  if (!source.includes('from "./package-identity.mjs"')) throw new Error(`${name} lost the shared static package identity boundary`);
}
for (const name of ["cli.mjs", "cli-account-admin.mjs", "stdio.mjs"]) {
  const source = readFileSync(join(localRoot, name), "utf8");
  if (source.includes('readFileSync(resolve(packageRoot, "package.json")') || source.includes('new URL("../../package.json", import.meta.url)')) {
    throw new Error(`${name} regained duplicate root package identity parsing`);
  }
  if (!source.includes('from "./package-identity.mjs"')) throw new Error(`${name} lost the shared static package identity boundary`);
}
const macosTrustBrokerSource = readFileSync(join(localRoot, "macos-trust-broker.mjs"), "utf8");
if (!macosTrustBrokerSource.includes('from "./package-identity.mjs"') || macosTrustBrokerSource.includes("fileURLToPath(import.meta.url)")) {
  throw new Error("macOS trust broker regained a duplicate package-root implementation");
}
const secureFileBoundary = readFileSync(join(localRoot, "secure-file.mjs"), "utf8");
for (const required of ["sameFilesystemIdentity(identity, filesystemIdentity(pathIdentityInfo, label))", 'code: "MBM_IDENTITY_CHANGED"']) {
  if (!secureFileBoundary.includes(required)) throw new Error(`secure file identity comparison/retry classification regressed: ${required}`);
}
for (const required of ["export function ownerOnlyFile", "export function ensureOwnerOnlyDir", "export function chmodRegularFileIfIdentitySync", "export function retryTransientMultipleLinksSync", 'code: "MBM_MULTIPLE_HARD_LINKS"']) {
  if (!secureFileBoundary.includes(required)) throw new Error(`secure-file lost owner-only permission boundary: ${required}`);
}
for (const required of ["sameFilesystemIdentity(expectedIdentity, identity)", "setDescriptorMode(fd, mode)"]) {
  if (!secureFileBoundary.includes(required)) throw new Error(`secure-file identity-bound chmod contract regressed: ${required}`);
}
if (existsSync(join(localRoot, "state-locations.mjs"))) {
  throw new Error("unused divergent state-locations module returned; extract live state path semantics only with real importers and parity tests");
}
for (const obsolete of ["export function ownerOnlyFile", "export function ensureOwnerOnlyDir", "export function previewSecret"]) {
  if (stateBoundary.includes(obsolete)) throw new Error(`state module regained generic/dead helper: ${obsolete}`);
}
for (const name of ["managed-job-runner-claim.mjs", "managed-job-storage.mjs", "managed-job-runner.mjs", "managed-job-lock.mjs"]) {
  const source = readFileSync(join(localRoot, name), "utf8");
  if (source.includes('from "./state.mjs"')) throw new Error(`${name} regained an unnecessary state dependency`);
  if (!source.includes('from "./secure-file.mjs"')) throw new Error(`${name} bypasses the secure owner-only file boundary`);
}

const resourceOperationsSource = readFileSync(join(localRoot, "resource-operations.mjs"), "utf8");
for (const required of ["const lockState = loadStateFn", "await acquireLockFn(lockState", "const state = loadStateFn"]) {
  if (!resourceOperationsSource.includes(required)) throw new Error(`SSH resource registration lost lock-then-fresh-state authority: ${required}`);
}
if (!(resourceOperationsSource.indexOf("await acquireLockFn(lockState") < resourceOperationsSource.indexOf("const state = loadStateFn"))) {
  throw new Error("SSH resource registration reloads authority before acquiring the startup lock");
}
const cliSourceForStateAuthority = readFileSync(join(localRoot, "cli.mjs"), "utf8");
for (const [operation, marker] of [["start", 'state = loadState(workspace, { stateDir: args.stateDir });'], ["rotate-secrets", 'state = loadState(workspace, { stateDir: args.stateDir });']]) {
  const lockMarker = operation === "start" ? 'operation: "start"' : 'operation: "rotate-secrets"';
  const lockAt = cliSourceForStateAuthority.indexOf(lockMarker);
  const reloadAt = cliSourceForStateAuthority.indexOf(marker, lockAt);
  if (lockAt < 0 || reloadAt < 0 || reloadAt < lockAt) throw new Error(`${operation} lost post-lock state refresh`);
}
const activateCliSource = readFileSync(join(localRoot, "cli-activate.mjs"), "utf8");
for (const required of ["const lock = await acquireStartupLockWithWait", "state = loadState(workspace", "lock.release();"]) {
  if (!activateCliSource.includes(required)) throw new Error(`activation lost lock-scoped state refresh/cleanup: ${required}`);
}

const serviceDefinitionSource = readFileSync(join(localRoot, "service-definition.mjs"), "utf8");
for (const required of ["verifyPathIdentity: true", "rejectMultipleLinks: true", "unlinkRegularFileIfIdentitySync", "if (!expectedIdentity)"]) {
  if (!serviceDefinitionSource.includes(required)) throw new Error(`service-definition snapshot/removal boundary regressed: ${required}`);
}
const sshKeySource = readFileSync(join(localRoot, "ssh-key.mjs"), "utf8");
for (const required of ["GENERATED_KEY_IDENTITIES", "chmodRegularFileIfIdentitySync", "installedLinkIdentity(opened.fd, source, target)", "removeGeneratedSshKeyPair", "replacement was preserved"]) {
  if (!sshKeySource.includes(required)) throw new Error(`SSH key ownership transaction boundary regressed: ${required}`);
}
if (sshKeySource.indexOf("inspectSshKeyPair(request.privateKeyPath") > sshKeySource.indexOf("secureKeyModes(request.privateKeyPath")) {
  throw new Error("existing SSH key permissions are changed before key-pair validation");
}

for (const required of ["export async function installAutostartBestEffort", 'operation: "runtime-start-autostart"', "serviceLock?.release?.()", "await install("]) {
  if (!cliSourceForStateAuthority.includes(required)) throw new Error(`automatic autostart install lost machine-service serialization: ${required}`);
}

const managedJobPlanSource = readFileSync(join(localRoot, "managed-job-plan.mjs"), "utf8");
if (managedJobPlanSource.includes("Object.entries(resources).slice(0, MAX_RESOURCES)") || !managedJobPlanSource.includes("local resource registry limit exceeded")) {
  throw new Error("managed-job resource registry regained silent truncation instead of rejecting corrupt over-limit state");
}
const managedJobStorageSource = readFileSync(join(localRoot, "managed-job-storage.mjs"), "utf8");
for (const required of ["MANAGED_STATE_READ_ATTEMPTS = 4", 'error?.code === "MBM_IDENTITY_CHANGED"', 'return "identity_changed"']) {
  if (!managedJobStorageSource.includes(required)) throw new Error(`managed-job state bounded identity retry regressed: ${required}`);
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
const browserBridgeSource = readFileSync(join(localRoot, "browser-bridge.mjs"), "utf8");
for (const required of ["verifyBrokerServerProof(this.runtimeToken", "const authenticated = true", "proxy.authenticated", "refusing a second broker owner"]) {
  if (!browserBridgeSource.includes(required)) throw new Error(`browser broker lost authenticated-peer split-brain protection: ${required}`);
}
const brokerProofCheck = browserBridgeSource.indexOf("verifyBrokerServerProof(this.runtimeToken");
const brokerSocketOpen = browserBridgeSource.indexOf("new WebSocket(url, [protocol]");
if (brokerProofCheck < 0 || brokerSocketOpen < 0 || brokerProofCheck > brokerSocketOpen) {
  throw new Error("runtime broker exposes its WebSocket proof before authenticating the candidate loopback owner");
}
if (browserBridgeSource.indexOf("if (proxy.authenticated)") > browserBridgeSource.indexOf("if (offset === MAX_PORT_ATTEMPTS - 1)")) {
  throw new Error("browser broker can skip past an authenticated-but-unready peer and create a second owner");
}
for (const required of ["pairing.migrationPending && offset === 0", "previous browser broker occupies the migrated pairing port", "migrationPending: false"]) {
  if (!browserBridgeSource.includes(required)) throw new Error(`browser pairing migration lost fail-closed owner handoff: ${required}`);
}
const browserBrokerAuthSource = readFileSync(join(localRoot, "browser-broker-auth.mjs"), "utf8");
for (const required of ["createMonotonicDeadline", "createBrokerInitProof", "machine-bridge-browser-${role}-init-v2", "pending.delete(key)", "machine-bridge-browser-${role}-${direction}-v2", "BROKER_AUTH_REQUEST_HEADER"]) {
  if (!browserBrokerAuthSource.includes(required)) throw new Error(`browser broker authentication boundary regressed: ${required}`);
}
const brokerInitProofIndex = browserBrokerAuthSource.indexOf("createBrokerInitProof(token, role, clientChallenge)");
const brokerPendingIndex = browserBrokerAuthSource.indexOf("pending.set(clientChallenge");
if (brokerInitProofIndex < 0 || brokerPendingIndex < 0 || brokerInitProofIndex > brokerPendingIndex) {
  throw new Error("browser broker allocates normal auth pending state before proving client credential possession");
}
for (const required of ["pending.get(clientChallenge)", "serverNonce: existing.serverNonce", "pending.delete(parsed.clientChallenge)"]) {
  if (!browserBrokerAuthSource.includes(required)) throw new Error(`browser broker normal-auth replay lost client-challenge idempotence: ${required}`);
}
const browserPairingLaunchSource = readFileSync(join(localRoot, "browser-pairing-launch.mjs"), "utf8");
for (const required of ["createBrowserPairingGrant(extensionToken, targetPort)", 'server.listen(0, "127.0.0.1")', 'host.toLowerCase() !== `127.0.0.1:${listenerPort}`', "response.end(html, () => close())", "setTimeout(close, ttl)", "broker_port"]) {
  if (!browserPairingLaunchSource.includes(required)) throw new Error(`browser ephemeral pairing launch lost bounded one-shot listener behavior: ${required}`);
}
const pairingListenIndex = browserPairingLaunchSource.indexOf('server.listen(0, "127.0.0.1")');
const pairingUrlIndex = browserPairingLaunchSource.indexOf('return { url:');
if (pairingListenIndex < 0 || pairingUrlIndex < 0 || pairingListenIndex > pairingUrlIndex) throw new Error("browser ephemeral pairing launch lost bind-before-open ordering");
const cliLocalAdminBrowserSource = readFileSync(join(localRoot, "cli-local-admin.mjs"), "utf8");
for (const required of ["readBrowserPairing(context.stateRoot)", "startBrowserPairingLaunch({ brokerPort: pairing.port, extensionToken: pairing.extensionToken })", "await openTarget(launch.url)", "launch.close()"] ) {
  if (!cliLocalAdminBrowserSource.includes(required)) throw new Error(`browser CLI pairing bypassed the shared ephemeral launch boundary: ${required}`);
}
if (cliLocalAdminBrowserSource.includes("await openExternal(context.pairingUrl)")) throw new Error("browser CLI pairing reopened the long-lived broker URL directly");
const browserPairingGrantSource = readFileSync(join(localRoot, "browser-pairing-grant.mjs"), "utf8");
for (const required of ["createBrowserPairingGrant", "createPairingBootstrapRegistry", "machine-bridge-browser-pair-v2", "machine-bridge-browser-pair-init-v2", "machine-bridge-browser-pair-${direction}-v2", "pending.get(grant.id)", "serverNonce: existing.serverNonce", "used.set(grant.id", "pending.delete(grant.id)"]) {
  if (!browserPairingGrantSource.includes(required)) throw new Error(`browser pairing bootstrap boundary regressed: ${required}`);
}
const initProofIndex = browserPairingGrantSource.indexOf("bootstrapInitProof(grant.secret");
const pairingPendingIndex = browserPairingGrantSource.indexOf("pending.set(grant.id");
if (initProofIndex < 0 || pairingPendingIndex < 0 || initProofIndex > pairingPendingIndex) {
  throw new Error("browser pairing bootstrap allocates pending state before proving fragment-secret possession");
}
const browserBrokerAuthHttpSource = readFileSync(join(localRoot, "browser-broker-auth-http.mjs"), "utf8");
for (const required of ["createPairingBootstrapRegistry", "x-machine-bridge-extension-token", "hasAuthMarker(request)", 'auth.issue(url.searchParams.get("challenge"), url.searchParams.get("init"))', "pairingAuth.consume("]) {
  if (!browserBrokerAuthHttpSource.includes(required)) throw new Error(`browser broker HTTP authentication boundary regressed: ${required}`);
}
const browserBrokerServerSource = readFileSync(join(localRoot, "browser-broker-server.mjs"), "utf8");
for (const required of ["createBrowserBrokerAuthHttpHandler", "extensionAuth.consume(protocol)", "runtimeAuth.consume(protocol)"]) {
  if (!browserBrokerServerSource.includes(required)) throw new Error(`browser broker server authentication boundary regressed: ${required}`);
}
for (const legacy of ['`mbm.${extensionToken}`', '`mbm-runtime.${runtimeToken}`']) {
  if (browserBrokerServerSource.includes(legacy)) throw new Error(`browser broker regained a long-lived WebSocket bearer protocol: ${legacy}`);
}
const extensionBrokerAuthSource = readFileSync(join(root, "browser-extension", "broker-auth.js"), "utf8");
for (const required of ["BROKER_AUTH_REQUEST_HEADER", "BROKER_AUTH_REQUEST_VALUE", "machine-bridge-browser-extension-init-v2", "machine-bridge-browser-extension-server-v2", "machine-bridge-browser-extension-client-v2"]) {
  if (!extensionBrokerAuthSource.includes(required)) throw new Error(`browser extension authentication helper regressed: ${required}`);
}
const extensionPairingBootstrapSource = readFileSync(join(root, "browser-extension", "pairing-bootstrap.js"), "utf8");
for (const required of ["machine-bridge-browser-pair-init-v2", "machine-bridge-browser-pair-server-v2", "machine-bridge-browser-pair-client-v2", "x-machine-bridge-extension-token", "bootstrapPairing"]) {
  if (!extensionPairingBootstrapSource.includes(required)) throw new Error(`browser extension pairing bootstrap regressed: ${required}`);
}
const extensionServiceWorkerSource = readFileSync(join(root, "browser-extension", "service-worker.js"), "utf8");
for (const required of ["pairFromBootstrap", "browserPairingBootstrap", "machine_bridge_pairing_material"]) {
  if (!extensionServiceWorkerSource.includes(required)) throw new Error(`browser extension pairing authorization regressed: ${required}`);
}

const workspaceFileSource = readFileSync(join(localRoot, "workspace-file-service.mjs"), "utf8");
const directoryMetadataSource = readFileSync(join(localRoot, "directory-metadata.mjs"), "utf8");
const workspaceSearchSource = readFileSync(join(localRoot, "workspace-search.mjs"), "utf8");
const workspaceTransactionSource = readFileSync(join(localRoot, "workspace-file-transaction.mjs"), "utf8");
if (!workspaceFileSource.includes("directoryEntriesWithMetadata(full")
    || workspaceFileSource.includes("await pathEntryIfExists(entryPath)")) {
  throw new Error("workspace list_dir lost bounded metadata fan-out or regained serial per-entry metadata reads");
}
for (const required of ["DIRECTORY_METADATA_BATCH_SIZE = 16", "Promise.allSettled", "throwIfCancelled(context)", "if (result.status === \"rejected\") throw result.reason"]) {
  if (!directoryMetadataSource.includes(required)) throw new Error(`directory metadata fan-out lost bounded ordering/error semantics: ${required}`);
}
for (const required of ["SEARCH_FILE_BATCH_SIZE = 16", "Promise.allSettled", "scheduledFiles >= maximumFiles", "matches.length >= maximumMatches", "if (result.status === \"rejected\") throw result.reason"]) {
  if (!workspaceSearchSource.includes(required)) throw new Error(`workspace search fan-out lost bounded ordering/error semantics: ${required}`);
}
if (!workspaceFileSource.includes("searchWorkspaceFiles({") || workspaceFileSource.includes("visitedFiles += 1")) {
  throw new Error("workspace search lost bounded file fan-out or regained serial visited-file orchestration");
}
for (const reason of ["read_limit", "unsupported_path_type", "multiple_hard_links"]) {
  if (!workspaceFileSource.includes(`reason === "${reason}"`)) throw new Error(`search_text lost typed skippable-file classification: ${reason}`);
}
const searchSkipBoundary = /function isSkippableSearchFileError[\s\S]*?\n}/.exec(workspaceFileSource)?.[0] || "";
for (const obsolete of ["search file exceeds maximum size", "search file is not a regular file", "refusing to read search file with multiple hard links"]) {
  if (searchSkipBoundary.includes(obsolete)) throw new Error(`search_text regained message-coupled skip classification: ${obsolete}`);
}
if (!workspaceTransactionSource.includes("async function writeFlushedText")
    || !workspaceTransactionSource.includes("await handle.sync()")
    || !workspaceTransactionSource.includes("staged file write failed and cleanup was incomplete")
    || (workspaceTransactionSource.match(/await writeFlushedText\(/g) || []).length !== 2) {
  throw new Error("workspace transaction boundary no longer flushes whole-file and patch staging files before commit");
}
if (!workspaceTransactionSource.includes("patch transaction may have partially modified files because recovery was incomplete; inspect affected paths before retrying")
    || !workspaceTransactionSource.includes("patch transaction failed and staging cleanup was incomplete")
    || !workspaceTransactionSource.includes('details: { reason: "patch_recovery_incomplete" }')
    || !workspaceTransactionSource.includes("Patch committed, but ${cleanupFailures.length} internal transaction artifact(s) could not be removed")
    || !workspaceTransactionSource.includes("file mutation failed and staging cleanup was incomplete")
    || !workspaceTransactionSource.includes("new AggregateError([primary, ...recoveryFailures]")
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
const projectOverviewProjectionSource = readFileSync(join(root, "src", "shared", "project-overview-projection.mjs"), "utf8");
for (const required of ["projectOverviewDetail", "detail !== \"summary\"", "effectiveToolCount", "daemonToolCount", "compactCapabilityRouting", "compactTopLevel", "compactAuthorization"]) {
  if (!projectOverviewProjectionSource.includes(required)) throw new Error(`project overview compact projection lost its post-authority output boundary: ${required}`);
}
for (const forbidden of ["account_id:", "task_fingerprint:", "refresh_fingerprint:"]) {
  if (projectOverviewProjectionSource.includes(forbidden)) throw new Error(`project overview compact projection regained private cold-path field: ${forbidden}`);
}
const executionRoutingSource = readFileSync(join(localRoot, "execution-routing.mjs"), "utf8");
if (executionRoutingSource.includes("toolsForPolicy")) {
  throw new Error("execution routing deep-copies the complete tool schema catalog instead of reading bounded metadata");
}
for (const required of ["toolNamesForPolicy", "toolDefinition", "advisory_only", "general_escape_hatch_available", "schema_version: 1"]) {
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
const authorityRevocationBoundary = /async applyAuthorityRevocation\(revocation\)[\s\S]*?\n  runProcess\(/.exec(runtimeBoundarySource)?.[0] || "";
for (const required of ["async applyAuthorityRevocation", "try { calls =", "sessionRevocation = Promise.resolve(this.processSessionManager.revokeAuthority", "try { jobs =", "sessions = await sessionRevocation", "failures.length", "retained revocation must be retried"]) {
  if (!authorityRevocationBoundary.includes(required)) throw new Error(`authority revocation lost all-category fail-closed application: ${required}`);
}
const runtimeStopBoundary = /async stop\(\)[\s\S]*?\n  send\(/.exec(runtimeBoundarySource)?.[0] || "";
for (const required of [
  "await this.callRegistry.cancelAllAndWait(\"runtime stopped\")",
  "await this.processTracker.drain(\"SIGKILL\")",
  "await this.processSessionManager.clearAndWait()",
  "this.lifecycle.markStopFailed(error)",
  "this.lifecycle.markStopped()",
]) {
  if (!runtimeStopBoundary.includes(required)) throw new Error(`runtime stop lost close-settled ownership teardown: ${required}`);
}
if (!(runtimeStopBoundary.indexOf("callRegistry.cancelAllAndWait") < runtimeStopBoundary.indexOf("processTracker.drain")
  && runtimeStopBoundary.indexOf("processTracker.drain") < runtimeStopBoundary.indexOf("processSessionManager.clearAndWait"))) {
  throw new Error("runtime stop no longer drains calls before processes and process sessions");
}
const processTrackerBoundary = readFileSync(join(localRoot, "process-tracker.mjs"), "utf8");
for (const required of ["async drain(", "this.drainSignal = signal", "if (this.drainSignal) this.requestDrainTermination(child)", "process shutdown did not settle before the runtime teardown deadline"]) {
  if (!processTrackerBoundary.includes(required)) throw new Error(`process tracker lost runtime drain ownership semantics: ${required}`);
}
const toolExecutorBoundary = readFileSync(join(localRoot, "tool-executor.mjs"), "utf8");
if ((toolExecutorBoundary.match(/callRegistry\.throwIfCancelled/g) || []).length !== 1) {
  throw new Error("tool executor must check cancellation before handler execution without retroactively vetoing a settled handler result");
}
if (!toolExecutorBoundary.includes("Handler return is the local settlement point")) {
  throw new Error("tool executor lost the explicit late-cancellation settlement contract");
}
const managedJobStorageBoundary = readFileSync(join(localRoot, "managed-job-storage.mjs"), "utf8");
const managedJobJsonReadBoundary = /export function readJson[\s\S]*?export function readRequiredJson/.exec(managedJobStorageBoundary)?.[0] || "";
for (const required of ["managed job state", "verifyPathIdentity: true", "rejectMultipleLinks: true"]) {
  if (!managedJobJsonReadBoundary.includes(required)) throw new Error(`managed-job state read lost secure identity/hard-link boundary: ${required}`);
}
const managedJobGenericReadBoundary = /export function readBoundedFile[\s\S]*?export function openPrivateAppendFile/.exec(managedJobStorageBoundary)?.[0] || "";
if (managedJobGenericReadBoundary.includes("rejectMultipleLinks") || managedJobGenericReadBoundary.includes("verifyPathIdentity")) {
  throw new Error("generic managed-job external-file read inherited internal ownership-state restrictions");
}
const runtimeResourceBoundary = readFileSync(join(localRoot, "runtime-resource-service.mjs"), "utf8");
for (const required of ["includeContent: true", "buffer: inspected.content", "path: inspected.path"]) {
  if (!runtimeResourceBoundary.includes(required)) throw new Error(`runtime resource injection lost check/use single-snapshot behavior: ${required}`);
}
if (runtimeResourceBoundary.includes("readBoundedRegularFileSync")) throw new Error("runtime resource injection regained a second post-inspection file read");
const managedJobPlanBoundary = readFileSync(join(localRoot, "managed-job-plan.mjs"), "utf8");
for (const required of ["includeContent = false", '"resource file", { verifyPathIdentity: true }']) {
  if (!managedJobPlanBoundary.includes(required)) throw new Error(`resource inspection lost validated-byte snapshot behavior: ${required}`);
}
const managedJobsBoundary = readFileSync(join(localRoot, "managed-jobs.mjs"), "utf8");
const managedJobRetentionBoundary = readFileSync(join(localRoot, "managed-job-retention.mjs"), "utf8");
const managedJobTerminalMaintenanceBoundary = readFileSync(join(localRoot, "managed-job-terminal-maintenance.mjs"), "utf8");
const externalPlanBoundary = /export function loadManagedJobPlan[\s\S]*?function failRunnerLaunch/.exec(managedJobsBoundary)?.[0] || "";
if (externalPlanBoundary.includes("lstatSync(")) throw new Error("external job-plan load regained a redundant pre-open path stat");
for (const section of [
  /  cancel\(args[\s\S]*?  revokeAuthority/.exec(managedJobsBoundary)?.[0] || "",
  /function cancelManagedJob[\s\S]*?export function activeManagedJobs/.exec(managedJobsBoundary)?.[0] || "",
  /function failRunnerLaunch[\s\S]*?function markRecoveryExhausted/.exec(managedJobsBoundary)?.[0] || "",
  /function markRecoveryExhausted[\s\S]*?function relaunchInterruptedJob/.exec(managedJobsBoundary)?.[0] || "",
  /export function scrubTerminalJobArtifacts[\s\S]*$/.exec(managedJobTerminalMaintenanceBoundary)?.[0] || "",
  /function expireStagedJob[\s\S]*$/.exec(managedJobRetentionBoundary)?.[0] || "",
]) {
  if (section.includes("recovery.lock") || section.includes("transition.lock")) {
    throw new Error("managed-job terminal artifact cleanup regained bare deletion authority over an active/reclaimable job lock");
  }
}
const jobRunnerBoundary = readFileSync(join(localRoot, "job-runner.mjs"), "utf8");
const runnerJsonBoundary = /function readJson[\s\S]*?function readBoundedFile/.exec(jobRunnerBoundary)?.[0] || "";
for (const required of ["managed job runner state", "verifyPathIdentity: true", "rejectMultipleLinks: true"]) {
  if (!runnerJsonBoundary.includes(required)) throw new Error(`managed-job runner JSON read lost secure state-file boundary: ${required}`);
}
if (runnerJsonBoundary.includes('readBoundedFile(file, maxBytes)')) throw new Error("managed-job runner JSON state fell back to the generic resource-read path");
const managedJobDirectoryBoundary = readFileSync(join(localRoot, "managed-job-directory.mjs"), "utf8");
for (const required of ["openSync", "fstatSync", "O_NOFOLLOW", "O_DIRECTORY", "a.dev === b.dev && a.ino === b.ino"]) {
  if (!managedJobDirectoryBoundary.includes(required)) throw new Error(`managed-job directory lost descriptor-pinned object identity: ${required}`);
}
if (managedJobDirectoryBoundary.includes("sameFilesystemIdentity")) {
  throw new Error("managed-job directory regained change-time comparison even though child mutations legitimately change directory ctime");
}
const managedJobLockSnapshotBoundary = readFileSync(join(localRoot, "managed-job-lock.mjs"), "utf8");
for (const required of ["readBoundedRegularFileWithInfoSync", "verifyPathIdentity: true", "rejectMultipleLinks: true", "opened.identityInfo", "managed-job lock link count"]) {
  if (!managedJobLockSnapshotBoundary.includes(required)) throw new Error(`managed-job lock lost descriptor-coherent snapshot identity: ${required}`);
}
const serviceOwnerBoundary = readFileSync(join(localRoot, "service-owner.mjs"), "utf8");
for (const required of ["removeOwnedJsonFileSync(file, { transactionId, status: \"pending\" }", "readBoundedRegularFileWithInfoSync", "rejectMultipleLinks: true", "unlinkRegularFileIfIdentitySync"]) {
  const normalized = required.replace(/\\"/g, '"');
  if (!serviceOwnerBoundary.includes(normalized)) throw new Error(`service-owner cleanup lost identity/token checked removal: ${normalized}`);
}
const secureRemovalBoundary = readFileSync(join(localRoot, "secure-file.mjs"), "utf8");
for (const required of ["export function unlinkRegularFileIfIdentitySync", 'lstatSync(file, { bigint: true })', "current.nlink !== 1n", "sameFilesystemIdentity(expectedIdentity", "unlinkSync(file)"]) {
  if (!secureRemovalBoundary.includes(required)) throw new Error(`secure-file identity-checked unlink boundary regressed: ${required}`);
}
const ownerStateLockBoundary = readFileSync(join(localRoot, "owner-state-lock.mjs"), "utf8");
for (const required of ["createMonotonicDeadline", "inspectProcessInstance", "removeOwnedJsonFileSync", "new AggregateError([callbackError, releaseError]", "verifyPathIdentity: true", "rejectMultipleLinks: true", "retryTransientMultipleLinksSync"]) {
  if (!ownerStateLockBoundary.includes(required)) throw new Error(`owner-state lock lost bounded ownership or causal cleanup semantics: ${required}`);
}
for (const [name, markers] of [
  ["state.mjs", ["retryTransientMultipleLinksSync(() => readBoundedRegularFileWithInfoSync(lockPath"]],
  ["managed-job-lock.mjs", ["retryTransientMultipleLinksSync(() => readBoundedRegularFileWithInfoSync(file"]],
  ["browser-pairing-store.mjs", ["readPublishedPairing", "retryTransientMultipleLinksSync(() => readPairing(file))"]],
  ["managed-job-runner-claim.mjs", ["verifyPathIdentity: true", "rejectMultipleLinks: true", "retryTransientMultipleLinksSync"]],
]) {
  const source = readFileSync(join(localRoot, name), "utf8");
  for (const marker of markers) if (!source.includes(marker)) throw new Error(`${name} lost bounded exclusive-publication contention handling: ${marker}`);
}

const fileSnapshotPreservationBoundary = readFileSync(join(localRoot, "file-snapshot-preservation.mjs"), "utf8");
for (const required of ["options.create || createExclusiveFileSync", "options.unlinkSource || unlinkRegularFileIfIdentitySync", "options.unlinkBackup || unlinkSync", "new AggregateError([primaryError, cleanupError]"]) {
  if (!fileSnapshotPreservationBoundary.includes(required)) throw new Error(`file snapshot preservation lost commit/identity/cleanup causality: ${required}`);
}
const exclusiveFileBoundary = readFileSync(join(localRoot, "exclusive-file.mjs"), "utf8");
for (const required of ["new AggregateError([primaryError, ...cleanupErrors]", "Object.defineProperties(result", "cleanupArtifact", "ownsTemporary", "readBoundedRegularFileWithInfoSync", "opened.identityInfo", "rejectMultipleLinks: true", "current.nlink !== 1n"]) {
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
const workerHttpBoundary = readFileSync(join(root, "src", "worker", "http.ts"), "utf8");
for (const removedHeader of ["mcp-session-id", "last-event-id"]) {
  if (workerHttpBoundary.includes(`\"${removedHeader}\"`)) {
    throw new Error(`Worker CORS allowlist regained removed MCP header: ${removedHeader}`);
  }
}
const workerOAuthControllerBoundary = readFileSync(join(root, "src", "worker", "oauth-controller.ts"), "utf8");
const workerOAuthStoreValidationBoundary = readFileSync(join(root, "src", "worker", "oauth-store-validation.ts"), "utf8");
const workerOAuthRecordContractBoundary = readFileSync(join(root, "src", "worker", "oauth-record-contract.ts"), "utf8");
const workerAccountAdminBoundary = readFileSync(join(root, "src", "worker", "account-admin.ts"), "utf8");
if (workerAccountAdminBoundary.includes("clone().arrayBuffer()") || !workerAccountAdminBoundary.includes("readBoundedBytes(request, BODY_LIMIT_BYTES)")) {
  throw new Error("account-admin authorization regained an unbounded cloned-body read");
}
if (!workerAccountAdminBoundary.includes("rebuildBoundedAdminRequest")) throw new Error("account-admin authorization no longer reuses its exact bounded body for operation parsing");
for (const required of ["ACCOUNT_ID_PATTERN", "CLIENT_ID_PATTERN", "AUTHORIZATION_CODE_PATTERN", "TOKEN_HASH_PATTERN", "REFRESH_FAMILY_ID_PATTERN", "JWK_THUMBPRINT_PATTERN", "AUTHORIZATION_IDENTITY_PATTERN"]) {
  if (!workerOAuthRecordContractBoundary.includes(required)) throw new Error(`OAuth persisted-ID contract lost canonical pattern: ${required}`);
}
for (const source of [workerOAuthStoreValidationBoundary, readFileSync(join(root, "src", "worker", "oauth-client-admin.ts"), "utf8"), readFileSync(join(root, "src", "worker", "dpop.ts"), "utf8")]) {
  if (!source.includes('./oauth-record-contract.ts')) throw new Error("OAuth persisted-ID consumer regained a private duplicate pattern");
}
if (!workerOAuthControllerBoundary.includes('./oauth-store-validation.ts')
    || !workerOAuthStoreValidationBoundary.includes("entriesMatch(value.accounts")
    || !workerOAuthStoreValidationBoundary.includes("entriesMatch(value.clients")
    || !workerOAuthStoreValidationBoundary.includes("entriesMatch(value.codes")
    || !workerOAuthStoreValidationBoundary.includes("entriesMatch(value.tokens")
    || !workerOAuthStoreValidationBoundary.includes("entriesMatch(value.auth_failures")) {
  throw new Error("OAuth current-state loading lost deep persisted-record validation");
}
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
  "observability", "mcp-access", "mcp-controller", "mcp-stream-proxy-contract", "server-info",
  "worker-entry", "tool-timeout", "daemon-liveness", "daemon-registry", "daemon-channel", "daemon-status",
  "daemon-http-controller", "daemon-ready-messages",
]) {
  if (!workerIndexBoundary.includes(`./${module}`)) throw new Error(`Worker index lost boundary module: ${module}`);
}
for (const module of ["worker-static-routes", "worker-edge-guard", "worker-edge-log", "worker-rate-limit-key", "mcp-response-proxy", "mcp-stream-proxy-contract"]) {
  if (!workerEntryBoundary.includes(`./${module}`)) throw new Error(`outer Worker entry lost boundary module: ${module}`);
}
const daemonHttpControllerBoundary = readFileSync(join(root, "src", "worker", "daemon-http-controller.ts"), "utf8");
for (const required of [
  "verifyDaemonHttpRelayRequest", "daemon_http_sequence_gap", "daemon_http_ready_before_control_ack",
  'message.payload.type === "https_ready"', "channel.verifyReady()", 'relayResponse("probing"',
]) {
  if (!daemonHttpControllerBoundary.includes(required)) throw new Error(`HTTPS relay lost verified-ready/exactly-once boundary: ${required}`);
}
const daemonHttpAuthBoundary = readFileSync(join(root, "src", "worker", "daemon-http-auth.ts"), "utf8");
for (const required of ["DAEMON_HTTP_RELAY_TTL_SECONDS", "X-Bridge-Body-SHA256", "consumeBoundedNonce", "verifyP256Signature"]) {
  if (!daemonHttpAuthBoundary.includes(required)) throw new Error(`HTTPS relay lost signed body/replay protection: ${required}`);
}
const relayContractBoundary = JSON.parse(readFileSync(join(root, "src", "shared", "relay-contract.json"), "utf8"));
if (relayContractBoundary.newCallReconnectGraceMs !== 15_000
    || relayContractBoundary.httpFallbackRequestTimeoutMs >= relayContractBoundary.newCallReconnectGraceMs
    || Math.ceil(60_000 / relayContractBoundary.httpFallbackMinimumRequestIntervalMs) >= 120) {
  throw new Error("HTTPS relay fallback recovery/rate-limit contract drifted");
}
const brokerLivenessBoundary = readFileSync(join(root, "browser-extension", "broker-liveness.js"), "utf8");
for (const required of ["PONG_TIMEOUT_MS", 'type: "ping"', "pingSequence", "browser broker pong timed out"]) {
  if (!brokerLivenessBoundary.includes(required)) throw new Error(`browser broker liveness guard lost boundary: ${required}`);
}
const mcpResponseProxyBoundary = readFileSync(join(root, "src", "worker", "mcp-response-proxy.ts"), "utf8");
for (const required of ["proxyMcpResponseStream", '"direct"', '"cancel"', "waitUntil", "cancelCall"]) {
  if (!mcpResponseProxyBoundary.includes(required)) throw new Error(`current MCP response proxy lost request-scoped stream/cancellation ownership: ${required}`);
}
const mcpStreamProxyContractBoundary = readFileSync(join(root, "src", "worker", "mcp-stream-proxy-contract.ts"), "utf8");
for (const forbidden of ["prepare", "subscribe", "retry", "descriptor", "last-event-id", "Mcp-Session-Id"]) {
  if (mcpStreamProxyContractBoundary.toLowerCase().includes(forbidden.toLowerCase())) {
    throw new Error(`current MCP proxy contract regained removed compatibility state: ${forbidden}`);
  }
}
for (const required of [
  "sanitizeBridgeRequest", "MCP_STREAM_PROXY_MODE_HEADER", "MCP_STREAM_PROXY_ID_HEADER",
  "mcpStreamProxyId", "mcpStreamRequestKey", "STREAM_ID_PATTERN", "withProxyHeaders",
]) {
  if (!mcpStreamProxyContractBoundary.includes(required)) throw new Error(`MCP stream proxy contract lost boundary hardening: ${required}`);
}
const mcpControllerBoundary = readFileSync(join(root, "src", "worker", "mcp-controller.ts"), "utf8");
for (const required of ["class McpController", "server/discover", "tools/list", "tools/call", "subscriptions/listen", "jsonRpcResponseStream"]) {
  if (!mcpControllerBoundary.includes(required)) throw new Error(`current MCP controller lost request-scoped responsibility: ${required}`);
}
for (const forbidden of ["mcp-subscriptions", "subscriptionResponse(", "subscriptions/acknowledged"]) {
  if (mcpControllerBoundary.includes(forbidden)) throw new Error(`current MCP controller regained unused change-subscription machinery: ${forbidden}`);
}
for (const forbidden of ["initialize", "Mcp-Session-Id", "Last-Event-ID", "resumption", "legacy", "modern"]) {
  if (mcpControllerBoundary.includes(forbidden)) throw new Error(`current MCP controller regained removed protocol-era state: ${forbidden}`);
}
const mcpInitializationCompatibilityBoundary = readFileSync(join(root, "src", "worker", "mcp-initialization-compat.ts"), "utf8");
for (const required of ["MCP_INITIALIZATION_COMPATIBILITY_VERSIONS", "initialize", "notifications/initialized", "tools/list", "tools/call", "ping"]) {
  if (!mcpInitializationCompatibilityBoundary.includes(required)) throw new Error(`MCP initialization compatibility lost required stateless surface: ${required}`);
}
for (const forbidden of ["Last-Event-ID", "resumption", "replay", "subscribe", "DurableObjectStorage", "ctx.storage"]) {
  if (mcpInitializationCompatibilityBoundary.includes(forbidden)) throw new Error(`MCP initialization compatibility regained stateful legacy machinery: ${forbidden}`);
}
if (!mcpInitializationCompatibilityBoundary.includes('headers.has("Mcp-Session-Id")')
    || !mcpInitializationCompatibilityBoundary.includes("stateless compatibility transport")) {
  throw new Error("MCP initialization compatibility stopped rejecting session IDs explicitly");
}
for (const forbidden of ["streamJsonRpcResponse(", "resumeJsonRpcResponse(", ".resumption", "durableCalls"]) {
  if (workerIndexBoundary.includes(forbidden)) throw new Error(`BridgeRoom regained removed MCP delivery state: ${forbidden}`);
}
if (!workerIndexBoundary.includes("this.invalidateDaemonSocket(socket, message, closeReason, errorCode, false)")) {
  throw new Error("runtime alarm invalidation regained recursive alarm scheduling");
}
const daemonCleanupBoundary = /private cleanupDaemonSocket[\s\S]*?private async handleMcp/.exec(workerIndexBoundary)?.[0] || "";
if (!daemonCleanupBoundary.includes("beginCleanup") || daemonCleanupBoundary.includes("scheduleRuntimeAlarm")) {
  throw new Error("daemon socket cleanup must remain idempotent and scheduling-free");
}
const daemonDetachBoundary = /private async detachDaemonSocketCalls[\s\S]*?private reclaimStaleDaemonSockets/.exec(workerIndexBoundary)?.[0] || "";
if (!daemonDetachBoundary.includes("this.pending.rejectSocket(socket, (record) => dispatchedDaemonDisconnectError(message, record.recovery))")) {
  throw new Error("identity-damaged daemon socket cleanup regained retryable settlement for already-dispatched calls");
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
const daemonResultBoundary = /handleReadyDaemonMessage\(\{[\s\S]*?async webSocketClose/.exec(workerIndexBoundary)?.[0] || "";
if ((daemonResultBoundary.match(/scheduleRuntimeAlarm/g) || []).length !== 1) {
  throw new Error("daemon terminal result must coalesce liveness and pending-call alarm scheduling");
}
const eventExpiryBoundary = /private async expireOverdueCalls[\s\S]*?private async scheduleRuntimeAlarm/.exec(workerIndexBoundary)?.[0] || "";
if (!eventExpiryBoundary.includes("this.pending.expireDue()") || eventExpiryBoundary.includes("durable")) {
  throw new Error("event-entry expiry must remain transient-request-only");
}
const runtimeAlarmBoundary = readFileSync(join(root, "src", "worker", "runtime-alarm.ts"), "utf8");
for (const forbidden of ["durableCalls", "mcp-pending-call-store", "resumption"]) {
  if (runtimeAlarmBoundary.includes(forbidden)) throw new Error(`runtime alarm regained removed MCP durable state: ${forbidden}`);
}
const dpopBoundary = readFileSync(join(root, "src", "worker", "dpop.ts"), "utf8");
for (const forbidden of ["consumeDpopProofForInternalRetry", "DPOP_RETRY_BINDINGS_KEY", "MAX_DPOP_INTERNAL_RETRY_USES"]) {
  if (dpopBoundary.includes(forbidden)) throw new Error(`DPoP regained removed internal compatibility retry state: ${forbidden}`);
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

const serverInfoBoundary = readFileSync(join(root, "src", "worker", "server-info.ts"), "utf8");
for (const required of [
  'projectOverviewDetail(args)', 'const daemonArgs = name === "project_overview" ? {} : args',
  'projectProjectOverview(decorateProjectOverview', '), overviewDetail)',
]) {
  if (!workerIndexBoundary.includes(required)) throw new Error(`remote project_overview lost post-authority compact projection boundary: ${required}`);
}
for (const required of [
  "buildServerInfoResult", "buildServerInfoSummary", "compactPending", "compactDaemon", 'detail === "summary"',
  "pre_dispatch_waiters", "capacity_active", "capacity_active_ordinary", "capacity_active_reserved",
]) {
  if (!serverInfoBoundary.includes(required)) throw new Error(`Worker server_info lost compact/full projection boundary: ${required}`);
}
if (workerIndexBoundary.includes("function buildServerInfoSummary")) {
  throw new Error("Worker server_info projection returned to the composition root");
}
const localInfoProjectionBoundary = readFileSync(join(localRoot, "runtime-info-projection.mjs"), "utf8");
for (const required of ["projectRuntimeInfo", 'detail !== "summary"', "compactProcesses", "compactCapacity"]) {
  if (!localInfoProjectionBoundary.includes(required)) throw new Error(`local server_info lost compact/full projection boundary: ${required}`);
}
const pendingCallsBoundary = readFileSync(join(root, "src", "worker", "pending-calls.ts"), "utf8");
for (const required of ["register(input", "detachSocket", "rebindInstance", "resultOwnership"]) {
  if (!pendingCallsBoundary.includes(required)) throw new Error(`pending-call registry lost bounded JSON-call semantics: ${required}`);
}
const pendingCapacityBoundary = readFileSync(join(root, "src", "worker", "pending-call-capacity.ts"), "utf8");
for (const required of ["pendingCapacityProjection", "pre_dispatch_waiters", "capacity_active_ordinary", "capacity_active_reserved"]) {
  if (!pendingCapacityBoundary.includes(required)) throw new Error(`pending-call capacity projection lost pre-dispatch accounting: ${required}`);
}
for (const forbidden of ["registerEvent", "settlement.kind", 'kind: "event"']) {
  if (pendingCallsBoundary.includes(forbidden)) throw new Error(`obsolete event settlement returned to the transient pending registry: ${forbidden}`);
}

for (const forbidden of [
  "Mcp-Session-Id", "Last-Event-ID", "mcp-resumption", "durable-stream", "mcp-legacy", "mcp-modern",
]) {
  if (workerIndexBoundary.includes(forbidden)) throw new Error(`Worker composition root regained removed MCP compatibility state: ${forbidden}`);
}

const daemonStatusBoundary = readFileSync(join(root, "src", "worker", "daemon-status.ts"), "utf8");
for (const required of ["daemonStatusSnapshot", "readyDaemonChannels", "readyAttachment", "DAEMON_READY_TIMEOUT_MS", "DAEMON_LIVENESS_TIMEOUT_MS"]) {
  if (!daemonStatusBoundary.includes(required)) throw new Error(`daemon status projection lost bounded readiness/liveness state: ${required}`);
}
if (workerIndexBoundary.includes("connected: sockets.length > 0")) {
  throw new Error("Worker composition root regained daemon status projection logic");
}
const daemonSocketBoundary = readFileSync(join(root, "src", "worker", "daemon-sockets.ts"), "utf8");
for (const required of ["class DaemonSocketRegistry", "beginProbe", "promote", "readySockets", "probingSockets"]) {
  if (!daemonSocketBoundary.includes(required)) throw new Error(`daemon socket registry lost lifecycle responsibility: ${required}`);
}
const daemonReadyWaiterBoundary = readFileSync(join(root, "src", "worker", "daemon-ready-waiters.ts"), "utf8");
for (const required of [
  "relayContract.newCallReconnectGraceMs", "waitForReadyDaemon", "notifyReadyDaemon", "readyDaemonWaiterSnapshot", "AbortSignal",
  "PendingCapacitySnapshot", "assertWorkerPendingCallAdmission",
]) {
  if (!daemonReadyWaiterBoundary.includes(required)) throw new Error(`daemon reconnect admission lost shared-capacity new-call recovery: ${required}`);
}
if (daemonReadyWaiterBoundary.includes("DEFAULT_GRACE_MS = 10_000")) {
  throw new Error("daemon reconnect admission regained the obsolete private ten-second recovery default");
}
const daemonRecoveryBudgetBoundary = readFileSync(join(root, "src", "worker", "daemon-recovery-budget.ts"), "utf8");
for (const required of ["daemonToolTimeoutBudgetAfterDelay", "workerSettlementOverheadMs", "side_effects_started: false"]) {
  if (!daemonRecoveryBudgetBoundary.includes(required)) throw new Error(`daemon recovery budget lost hosted-deadline accounting: ${required}`);
}
const daemonReadyDispatchBoundary = readFileSync(join(root, "src", "worker", "daemon-ready-dispatch.ts"), "utf8");
for (const required of ["readyDaemonForDispatch", "recoveryDelayMs: 0", "waitForReadyDaemon", "performance.now()"]) {
  if (!daemonReadyDispatchBoundary.includes(required)) throw new Error(`daemon ready dispatch lost zero-cost ready-path accounting: ${required}`);
}
for (const required of [
  "NEW_CALL_RECONNECT_GRACE_MS",
  "readyDaemonForDispatch(this.daemonRegistry",
  "Math.min(NEW_CALL_RECONNECT_GRACE_MS, timeoutBudget.executionTimeoutMs)",
  "pending: this.pending.snapshot()",
  "tool: name",
  "daemonToolTimeoutBudgetAfterDelay",
  "pendingCapacityProjection(this.pending.snapshot(), readyDaemonWaiterSnapshot(this.daemonRegistry))",
  "notifyReadyDaemon(this.daemonRegistry)",
]) {
  if (!workerIndexBoundary.includes(required)) throw new Error(`Worker composition lost shared-capacity deadline-bounded daemon recovery: ${required}`);
}
const readyAckSend = workerIndexBoundary.indexOf('ws.send(JSON.stringify({ type: "ready_ack"');
const readyWaiterNotify = workerIndexBoundary.indexOf("notifyReadyDaemon(this.daemonRegistry)");
if (readyAckSend < 0 || readyWaiterNotify < readyAckSend) throw new Error("new daemon calls may be released before ready acknowledgement is sent");
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
