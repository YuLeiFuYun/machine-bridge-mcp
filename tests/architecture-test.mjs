import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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

const adapterModules = new Set(["cli.mjs", "daemon-process.mjs", "stdio.mjs", "service.mjs", "relay-connection.mjs"]);
const boundaryModules = new Set([
  "agent-context.mjs",
  "app-automation.mjs",
  "browser-command.mjs",
  "capability-observer.mjs",
  "default-instructions.mjs",
  "network-proxy.mjs",
  "process-sessions.mjs",
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
  "cli-local-admin.mjs",
  "capability-ranking.mjs",
  "managed-job-plan.mjs",
  "browser-extension-protocol.mjs",
  "browser-pairing-store.mjs",
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
  "src/local/runtime.mjs": 900,
  "src/local/cli.mjs": 1250,
  "src/worker/index.ts": 1050,
  "src/local/process-execution.mjs": 300,
  "src/local/git-service.mjs": 220,
  "src/local/workspace-file-service.mjs": 550,
  "src/local/tool-executor.mjs": 180,
  "src/local/call-registry.mjs": 180,
  "src/local/lifecycle.mjs": 130,
  "src/local/cli-local-admin.mjs": 400,
  "src/local/agent-context.mjs": 950,
  "src/local/capability-ranking.mjs": 150,
  "src/local/managed-jobs.mjs": 900,
  "src/local/managed-job-plan.mjs": 300,
  "src/local/browser-bridge.mjs": 850,
  "src/local/browser-extension-protocol.mjs": 120,
  "src/local/browser-pairing-store.mjs": 120,
});
for (const [name, maximum] of Object.entries(lineLimits)) {
  const lines = readFileSync(join(root, name), "utf8").split(/\r?\n/).length;
  if (lines > maximum) throw new Error(`${name} exceeds its responsibility boundary (${lines} > ${maximum} lines)`);
}

for (const name of ["app-automation.mjs", "browser-bridge.mjs", "managed-jobs.mjs", "process-sessions.mjs"]) {
  const source = readFileSync(join(localRoot, name), "utf8");
  if (/\bassert(?:Full|Enabled)\s*\(/.test(source) || /disabled by daemon policy|requires the canonical full profile/.test(source)) {
    throw new Error(`${name} reimplements tool authorization instead of using PolicyGate`);
  }
  if (!source.includes("authorizeTool")) throw new Error(`${name} lost the shared authorization gate`);
}

const runtimeBoundarySource = readFileSync(join(localRoot, "runtime.mjs"), "utf8");
for (const forbidden of ["spawn(", "parsePatchEnvelope", "applyUpdateHunks", "workspaceShellCommand("]) {
  if (runtimeBoundarySource.includes(forbidden)) throw new Error(`LocalRuntime regained low-level responsibility: ${forbidden}`);
}
const localPolicySource = readFileSync(join(localRoot, "policy.mjs"), "utf8");
const workerPolicySource = readFileSync(join(root, "src", "worker", "policy.ts"), "utf8");
if (!localPolicySource.includes('policy-contract.json') || !workerPolicySource.includes('policy-contract.json')) {
  throw new Error("local and Worker policy enforcement do not share the generated policy contract");
}
const workerIndexBoundary = readFileSync(join(root, "src", "worker", "index.ts"), "utf8");
for (const duplicate of ["function validateAuthorizationRequest", "function readBoundedText", "class HttpError", "new Map<string, PendingCall>"]) {
  if (workerIndexBoundary.includes(duplicate)) throw new Error(`Worker index regained extracted responsibility: ${duplicate}`);
}
for (const module of ["pending-calls", "policy", "errors", "http", "oauth-state", "observability"]) {
  if (!workerIndexBoundary.includes(`./${module}`)) throw new Error(`Worker index lost boundary module: ${module}`);
}

const docs = [
  join(root, "README.md"),
  join(root, "SECURITY.md"),
  join(root, "CONTRIBUTING.md"),
  ...readdirSync(join(root, "docs")).filter((name) => name.endsWith(".md")).map((name) => join(root, "docs", name)),
];
for (const file of docs) validateRelativeLinks(file);

const repositoryFiles = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root })
  .toString("utf8")
  .split("\0")
  .filter(Boolean);
const workflowFiles = repositoryFiles.filter((name) => /^\.github\/workflows\/.*\.ya?ml$/i.test(name));
for (const name of workflowFiles) {
  const source = readFileSync(join(root, name), "utf8");
  for (const match of source.matchAll(/\buses:\s*([^@\s]+)@([^\s#]+)/g)) {
    if (!/^[0-9a-f]{40}$/.test(match[2])) throw new Error(`GitHub Action ${match[1]} in ${name} is not pinned to an immutable commit SHA`);
  }
}
for (const name of repositoryFiles) {
  const file = join(root, name);
  if (!existsSync(file)) continue;
  const bytes = readFileSync(file);
  if (bytes.includes(0)) continue;
  for (let index = 0; index < bytes.length; index += 1) {
    const value = bytes[index];
    if ((value < 32 && value !== 9 && value !== 10 && value !== 13) || value === 127) {
      throw new Error(`forbidden ASCII control byte 0x${value.toString(16).padStart(2, "0")} in ${name} at byte ${index}`);
    }
  }
}

const localAutomationFiles = [
  join(root, "src", "local", "app-automation.mjs"),
  join(root, "src", "local", "browser-bridge.mjs"),
  join(root, "browser-extension", "service-worker.js"),
  join(root, "browser-extension", "browser-operations.js"),
  join(root, "browser-extension", "devtools-input.js"),
  join(root, "browser-extension", "page-automation.js"),
  join(root, "browser-extension", "pairing.js"),
];
for (const file of localAutomationFiles) {
  const source = readFileSync(file, "utf8");
  if (/\beval\s*\(|new\s+Function\s*\(/.test(source)) {
    throw new Error(`arbitrary evaluation returned in ${relative(root, file)}`);
  }
}
const extensionManifest = JSON.parse(readFileSync(join(root, "browser-extension", "manifest.json"), "utf8"));
if (extensionManifest.manifest_version !== 3 || !extensionManifest.permissions?.includes("scripting") || !extensionManifest.permissions?.includes("alarms") || !extensionManifest.permissions?.includes("debugger")) {
  throw new Error("packaged browser extension is missing required Manifest V3 capabilities");
}
if (!extensionManifest.host_permissions?.includes("<all_urls>")) {
  throw new Error("browser extension no longer declares the generic page access documented by the security model");
}
const serviceWorkerSource = readFileSync(join(root, "browser-extension", "service-worker.js"), "utf8");
const browserOperationsSource = readFileSync(join(root, "browser-extension", "browser-operations.js"), "utf8");
const pageAutomationSource = readFileSync(join(root, "browser-extension", "page-automation.js"), "utf8");
const appAutomationSource = readFileSync(join(root, "src", "local", "app-automation.mjs"), "utf8");
const cliSource = readFileSync(join(root, "src", "local", "cli.mjs"), "utf8");
const cliLocalAdminSource = readFileSync(join(root, "src", "local", "cli-local-admin.mjs"), "utf8");
const workerSource = readFileSync(join(root, "src", "worker", "index.ts"), "utf8");

if (!workerSource.includes('"browser_manage_tabs", "browser_wait", "browser_get_source"') || !workerSource.includes('"browser_screenshot", "browser_upload_files"')) {
  throw new Error("Worker timeout classification omits browser_upload_files");
}
if (!cliLocalAdminSource.includes("readBoundedRegularFileSync(pairingFile, 64 * 1024)")) {
  throw new Error("browser CLI pairing state read is not bounded");
}
if (!appAutomationSource.includes("matchesList[payload.selector.index]")) {
  throw new Error("application UI selector index is not applied to the filtered match list");
}
if (!appAutomationSource.includes("item.role === 'AXSecureTextField'") || !appAutomationSource.includes("includeValues && !item.sensitive")) {
  throw new Error("application UI inspection does not suppress secure field values");
}
if (!serviceWorkerSource.includes('importScripts("devtools-input.js", "browser-operations.js")')) throw new Error("browser service worker lost fixed browser module loading");
if (!browserOperationsSource.includes('files: ["page-automation.js"]')) {
  throw new Error("browser operations module does not inject the fixed page automation module");
}
if (serviceWorkerSource.split(/\r?\n/).length > 350) throw new Error("browser service worker regained page-operation responsibilities");
for (const obsolete of ["func: inspectDocument", "func: performAction", "func: performFormFill", "func: performFileUpload"]) {
  if (serviceWorkerSource.includes(obsolete) || browserOperationsSource.includes(obsolete)) throw new Error(`browser service worker retained cross-world helper reference: ${obsolete}`);
}
if (!pageAutomationSource.includes("__machineBridgePageAutomation") || !pageAutomationSource.includes("shadowRoot") || !pageAutomationSource.includes("waitForActionable") || !pageAutomationSource.includes("refFor")) {
  throw new Error("browser page automation module is missing its fixed API or open Shadow DOM traversal");
}
if (!browserOperationsSource.includes("performPageAction") || !browserOperationsSource.includes("safeToFallback")) throw new Error("browser operations lost fixed trusted-input integration or replay protection");
if (!serviceWorkerSource.includes('BROWSER_EXTENSION_PROTOCOL = 3') || !serviceWorkerSource.includes('hello_ack') || !serviceWorkerSource.includes('capabilities:')) throw new Error("browser extension lost its acknowledged versioned capability handshake");
if (!readFileSync(join(root, "src", "local", "browser-bridge.mjs"), "utf8").includes("extension hello required; reload the extension")) throw new Error("browser broker lost stale-extension rejection guidance");
if (!serviceWorkerSource.includes("requires_manual_repair") || !serviceWorkerSource.includes("chrome.action.onClicked")) {
  throw new Error("browser extension no longer requires a user gesture to replace established pairing");
}
if (!serviceWorkerSource.includes("pairingUrlFromEndpoint") || !serviceWorkerSource.includes("setConnectionState") || !serviceWorkerSource.includes("setBadgeText")) {
  throw new Error("browser extension lost action-click pairing access or connection status UX");
}
if (!pageAutomationSource.includes("isSensitiveElement") || !pageAutomationSource.includes("one-time-code")) {
  throw new Error("browser page inspection lost broad sensitive-field redaction");
}

const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (packageJson.scripts?.["browser-service-worker:test"] !== "node tests/browser-service-worker-test.mjs") throw new Error("browser service-worker behavior test is missing");
if (packageJson.scripts?.["service-platform:test"] !== "node tests/service-platform-test.mjs") throw new Error("cross-platform service quoting test is missing");
if (packageJson.scripts?.["coverage:test"] !== "node scripts/coverage-check.mjs") throw new Error("critical-module coverage gate is missing");
if (packageJson.scripts?.["policy-docs:check"] !== "node scripts/generate-policy-reference.mjs --check") throw new Error("generated policy documentation gate is missing");
if (packageJson.scripts?.["logging-structure:test"] !== "node tests/logging-structure-test.mjs") throw new Error("structured logging regression test is missing");
if (packageJson.scripts?.["runtime-handlers:test"] !== "node tests/runtime-handler-matrix-test.mjs") throw new Error("runtime handler matrix test is missing");
if (packageJson.scripts?.["cli-entrypoint:test"] !== "node tests/cli-entrypoint-test.mjs") throw new Error("CLI entrypoint regression test is missing");
if (packageJson.scripts?.["capability-ranking:test"] !== "node tests/capability-ranking-test.mjs") throw new Error("capability ranking regression test is missing");
if (packageJson.scripts?.syntax !== "node scripts/syntax-check.mjs") {
  throw new Error("package syntax check is not using the dynamic repository scanner");
}
if (packageJson.scripts?.["privacy:history"] !== "node scripts/privacy-check.mjs --history") {
  throw new Error("package privacy history check is missing or drifted");
}
const ciSource = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
if (!ciSource.includes("npm run privacy:history")) throw new Error("CI package audit no longer scans reachable Git history");
const releaseSource = readFileSync(join(root, "scripts", "github-release.mjs"), "utf8");
if (!releaseSource.includes('import { requireSuccessfulCiRun } from "./release-ci.mjs";')
    || (releaseSource.match(/assertSuccessfulCi\(head\);/g) || []).length !== 2) {
  throw new Error("GitHub release orchestration no longer requires exact-commit successful CI for publish and verification");
}
for (const [name, command] of Object.entries(packageJson.scripts || {})) {
  const match = /^node\s+([^\s]+\.mjs)(?:\s|$)/.exec(String(command));
  if (match && !existsSync(join(root, match[1]))) throw new Error(`package script ${name} references missing ${match[1]}`);
}
const packaged = new Set(packageJson.files || []);
if (!packaged.has("scripts") || !packaged.has("src/local")) throw new Error("package files omit executable script or local runtime directories");

const installCommand = "npm install -g --omit=optional --allow-scripts=esbuild,workerd,sharp,fsevents machine-bridge-mcp@latest";
const pinnedInstallCommand = "npx --yes npm@12.0.1 install --global --omit=optional --allow-scripts=esbuild,workerd,sharp,fsevents machine-bridge-mcp@latest";
if (packageJson.engines?.npm !== ">=12.0.0") throw new Error("package metadata no longer declares the npm 12 runtime requirement");
const installSmokeSource = readFileSync(join(root, "tests", "install-smoke-test.mjs"), "utf8");
if (!installSmokeSource.includes("package-free-cwd") || !installSmokeSource.includes('pkg.engines?.npm !== ">=12.0.0"')) {
  throw new Error("global install test no longer validates package-free npm 12 installation metadata");
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
  if (!normalized.includes(installCommand)) throw new Error(`global install/activation guidance drifted in ${relative(root, file)}`);
}
if (!cliSource.replace(/\s+/g, " ").includes(`${pinnedInstallCommand} && machine-mcp`)) throw new Error("CLI pinned npm installation guidance drifted from user documentation");

const engineering = readFileSync(join(root, "docs", "ENGINEERING.md"), "utf8");
if (!engineering.includes("default profile is intentionally `full`") || !engineering.includes("`.project-local/`")) {
  throw new Error("engineering invariants omitted the owner-required full default or local-knowledge boundary");
}
if (!readFileSync(join(root, ".gitignore"), "utf8").split(/\r?\n/).includes(".project-local/")) {
  throw new Error("machine-specific project notes are not ignored");
}

console.log(`architecture/documentation test ok (${modules.length} local modules; ${docs.length} documentation files)`);

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

function validateRelativeLinks(file) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const raw = match[1].trim();
    if (!raw || raw.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
    const path = raw.split("#", 1)[0];
    if (!path) continue;
    const target = resolve(dirname(file), decodeURIComponent(path));
    if (!existsSync(target)) throw new Error(`broken relative documentation link in ${relative(root, file)}: ${raw}`);
  }
}
