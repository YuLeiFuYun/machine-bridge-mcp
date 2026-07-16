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

const adapterModules = new Set(["cli.mjs", "daemon-process.mjs", "stdio.mjs", "service.mjs", "windows-service.mjs", "relay-connection.mjs", "worker-deployment.mjs"]);
const boundaryModules = new Set([
  "agent-context.mjs",
  "app-automation.mjs",
  "browser-command.mjs",
  "capability-observer.mjs",
  "default-instructions.mjs",
  "network-proxy.mjs",
  "worker-health.mjs",
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
  "numbers.mjs",
  "project-metadata.mjs",
  "records.mjs",
  "state-inventory.mjs",
  "browser-extension-protocol.mjs",
  "browser-pairing-store.mjs",
  "worker-secret-file.mjs",
  "service-environment.mjs",
  "monotonic-deadline.mjs",
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
  "src/local/cli.mjs": 1100,
  "src/worker/index.ts": 1050,
  "src/worker/oauth-tokens.ts": 260,
  "src/local/process-execution.mjs": 300,
  "src/local/git-service.mjs": 220,
  "src/local/workspace-file-service.mjs": 550,
  "src/local/tool-executor.mjs": 180,
  "src/local/call-registry.mjs": 180,
  "src/local/lifecycle.mjs": 130,
  "src/local/cli-local-admin.mjs": 400,
  "src/local/agent-context.mjs": 920,
  "src/local/default-instructions.mjs": 280,
  "src/local/project-package.mjs": 240,
  "src/local/capability-ranking.mjs": 150,
  "src/local/managed-jobs.mjs": 900,
  "src/local/managed-job-plan.mjs": 300,
  "src/local/numbers.mjs": 20,
  "src/local/project-metadata.mjs": 80,
  "src/local/records.mjs": 10,
  "src/local/state-inventory.mjs": 170,
  "src/local/worker-health.mjs": 280,
  "src/local/worker-deployment.mjs": 220,
  "src/local/browser-bridge.mjs": 850,
  "src/local/browser-extension-protocol.mjs": 120,
  "src/local/browser-pairing-store.mjs": 120,
  "src/local/worker-secret-file.mjs": 180,
  "src/local/service-environment.mjs": 140,
  "src/local/windows-service.mjs": 250,
  "src/local/monotonic-deadline.mjs": 60,
  "src/worker/mcp-session.ts": 120,
  "src/worker/tool-timeout.ts": 80,
  "src/worker/pending-calls.ts": 180,
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
for (const module of ["pending-calls", "policy", "errors", "http", "oauth-state", "observability", "mcp-session", "tool-timeout"]) {
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
  const jobsIndex = source.search(/^jobs:/m);
  const permissionsIndex = source.search(/^permissions:/m);
  if (permissionsIndex === -1 || jobsIndex === -1 || permissionsIndex > jobsIndex) {
    throw new Error(`GitHub workflow ${name} lacks explicit top-level permissions before jobs`);
  }
  if (/^\s*pull_request_target:/m.test(source)) throw new Error(`privileged pull_request_target trigger is prohibited in ${name}`);
  if (/^permissions:\s*write-all\s*$/m.test(source)) throw new Error(`write-all workflow permissions are prohibited in ${name}`);
  for (const match of source.matchAll(/\buses:\s*([^@\s]+)@([^\s#]+)/g)) {
    if (!/^[0-9a-f]{40}$/.test(match[2])) throw new Error(`GitHub Action ${match[1]} in ${name} is not pinned to an immutable commit SHA`);
  }
}
for (const requiredWorkflow of ["ci.yml", "governance.yml", "codeql.yml", "dependency-review.yml", "scorecard.yml"]) {
  if (!workflowFiles.includes(`.github/workflows/${requiredWorkflow}`)) throw new Error(`required workflow is missing: ${requiredWorkflow}`);
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
const workerHttpSource = readFileSync(join(root, "src", "worker", "http.ts"), "utf8");
const oauthBrowserNavigationSource = readFileSync(join(root, "tests", "oauth-browser-navigation-test.mjs"), "utf8");
const workerToolTimeoutSource = readFileSync(join(root, "src", "worker", "tool-timeout.ts"), "utf8");

if (!workerToolTimeoutSource.includes('"browser_manage_tabs", "browser_wait", "browser_get_source"') || !workerToolTimeoutSource.includes('"browser_screenshot", "browser_upload_files"')) {
  throw new Error("Worker timeout classification omits browser_upload_files");
}
for (const origin of ["https://chatgpt.com", "https://chat.openai.com", "https://grok.com", "https://x.com"]) {
  if (!workerHttpSource.includes(`"${origin}"`)) throw new Error(`Worker built-in browser origins omit ${origin}`);
}
if (!workerHttpSource.includes("BUILT_IN_BROWSER_ORIGIN_SET.has(origin)") || !workerHttpSource.includes("allowed.includes(origin)")) {
  throw new Error("Worker CORS validation no longer combines built-in and configured exact origins");
}
if (workerSource.includes("validateOrigin(request") || workerSource.includes('error: "origin_not_allowed"')) {
  throw new Error("Worker actual requests are again being rejected solely by the Origin header");
}
if (!workerSource.includes('request.method === "OPTIONS"') || !workerSource.includes("corsPreflight(request, base, extraOrigins)")) {
  throw new Error("Worker no longer gates browser CORS preflight through the exact-origin policy");
}
if (!workerHttpSource.includes("authorizationFormActionSources(formActionOrigin)") || !workerHttpSource.includes("const sources = [url.origin]") || !workerHttpSource.includes("form-action ${formAction}")) {
  throw new Error("authorization HTML no longer constrains form navigation to normalized validated origins");
}
if (!workerHttpSource.includes('url.hostname === "consent.azure-apim.net"')
  || !workerHttpSource.includes('url.hostname.endsWith(".consent.azure-apim.net")')
  || !workerHttpSource.includes('sources.push("https://*.consent.azure-apim.net", "https://copilotstudio.microsoft.com")')) {
  throw new Error("authorization HTML no longer permits only validated Microsoft consent callbacks to use the complete Power Platform callback chain");
}
if (!workerSource.includes("new URL(authorization.redirectUri).origin") || !workerSource.includes("status, redirectOrigin")) {
  throw new Error("authorization pages no longer bind CSP form navigation to the validated redirect origin");
}
if (!oauthBrowserNavigationSource.includes("negative control reached the first callback")
  || !oauthBrowserNavigationSource.includes("first-hop-only policy unexpectedly followed the regional redirect")
  || !oauthBrowserNavigationSource.includes("regional-only policy unexpectedly followed the final Copilot Studio redirect")
  || !oauthBrowserNavigationSource.includes("authorization callback omitted code")
  || !oauthBrowserNavigationSource.includes("authorization state was not preserved")) {
  throw new Error("real-browser OAuth callback regression lost its first-hop, regional-hop, final-hop, or callback assertions");
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
for (const [name, source] of [["src/worker/index.ts", workerSource], ["browser-extension/service-worker.js", serviceWorkerSource]]) {
  if (/catch\s*(?:\([^)]*\))?\s*\{\s*\}/.test(source)) throw new Error(`${name} contains an unexplained empty catch`);
}
if (!workerSource.includes("function sendWebSocketQuietly") || !workerSource.includes("function closeWebSocketQuietly")) {
  throw new Error("Worker WebSocket best-effort cleanup is not centralized");
}
if (!serviceWorkerSource.includes("function closeSocketQuietly") || !serviceWorkerSource.includes("function sendSocketQuietly") || !serviceWorkerSource.includes("function ignoreBrowserApiCall")) {
  throw new Error("browser extension best-effort cleanup is not centralized");
}
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
for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
  for (const [name, version] of Object.entries(packageJson[field] || {})) {
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(String(version))) {
      throw new Error(`${field} must pin ${name} to one exact semantic version, received ${version}`);
    }
  }
}
if (packageJson.scripts?.["browser-service-worker:test"] !== "node tests/browser-service-worker-test.mjs") throw new Error("browser service-worker behavior test is missing");
if (packageJson.scripts?.["service-platform:test"] !== "node tests/service-platform-test.mjs") throw new Error("cross-platform service quoting test is missing");
if (packageJson.scripts?.["coverage:test"] !== "node scripts/coverage-check.mjs") throw new Error("critical-module coverage gate is missing");
if (packageJson.scripts?.["worker-deployment:test"] !== "node tests/worker-deployment-test.mjs") throw new Error("Worker deployment idempotency/proxy regression test is missing");
if (packageJson.scripts?.["policy-docs:check"] !== "node scripts/generate-policy-reference.mjs --check") throw new Error("generated policy documentation gate is missing");
if (packageJson.scripts?.["markdown:test"] !== "node tests/markdown-test.mjs") throw new Error("shared Markdown helper test is missing");
if (packageJson.scripts?.["project-metadata:test"] !== "node tests/project-metadata-test.mjs") throw new Error("project metadata helper test is missing");
if (packageJson.scripts?.["numbers:test"] !== "node tests/numbers-test.mjs") throw new Error("integer normalization helper test is missing");
if (packageJson.scripts?.["deadline:test"] !== "node tests/monotonic-deadline-test.mjs") throw new Error("monotonic deadline regression test is missing");
if (packageJson.scripts?.["oauth-browser:test"] !== "node tests/oauth-browser-navigation-test.mjs") throw new Error("real-browser OAuth navigation regression test is missing");
if (packageJson.scripts?.["records:test"] !== "node tests/records-test.mjs") throw new Error("plain-record helper test is missing");
if (packageJson.scripts?.["state-inventory:test"] !== "node tests/state-inventory-test.mjs") throw new Error("state inventory regression test is missing");
if (!existsSync(join(root, "scripts", "generate-worker-types.mjs"))) throw new Error("cross-platform Worker type generator is missing");
if (packageJson.scripts?.["worker:types"] !== "node scripts/generate-worker-types.mjs") throw new Error("generated Worker types are not isolated behind the cross-platform generator");
if (packageJson.scripts?.["tool-docs:check"] !== "node scripts/generate-tool-reference.mjs --check") throw new Error("generated MCP tool documentation gate is missing");
if (packageJson.scripts?.["commit-message:test"] !== "node tests/commit-message-test.mjs") throw new Error("commit-message policy regression test is missing");
if (packageJson.scripts?.["logging-structure:test"] !== "node tests/logging-structure-test.mjs") throw new Error("structured logging regression test is missing");
if (packageJson.scripts?.["sarif-security:test"] !== "node tests/sarif-security-gate-test.mjs") throw new Error("SARIF security gate regression test is missing");
if (packageJson.scripts?.["security-properties:test"] !== "node tests/security-properties-test.js") throw new Error("security property test suite is missing");
if (packageJson.scripts?.["shell:test"] !== "node tests/shell-test.mjs") throw new Error("Wrangler executable boundary regression test is missing");
if (packageJson.scripts?.["runtime-handlers:test"] !== "node tests/runtime-handler-matrix-test.mjs") throw new Error("runtime handler matrix test is missing");
if (packageJson.scripts?.["cli-entrypoint:test"] !== "node tests/cli-entrypoint-test.mjs") throw new Error("CLI entrypoint regression test is missing");
const stateSource = readFileSync(join(root, "src", "local", "state.mjs"), "utf8");
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
if (packageJson.scripts?.lint !== "eslint eslint.config.mjs bin src/local scripts tests browser-extension") {
  throw new Error("production/test undefined-identifier lint gate is missing or drifted");
}
if (packageJson.scripts?.["lint:test"] !== "node tests/lint-gate-test.mjs") {
  throw new Error("semantic lint configuration regression test is missing");
}
if (!String(packageJson.scripts?.check || "").includes("npm run shell:test") || !String(packageJson.scripts?.check || "").includes("npm run lint:test") || !String(packageJson.scripts?.check || "").includes("npm run lint") || !String(packageJson.scripts?.check || "").includes("npm run deadline:test") || !String(packageJson.scripts?.check || "").includes("npm run install:test") || !String(packageJson.scripts?.check || "").includes("npm run oauth-browser:test")) {
  throw new Error("complete check no longer includes static undefined-identifier and installed-default-startup gates");
}
if (packageJson.scripts?.["privacy:history"] !== "node scripts/privacy-check.mjs --history") {
  throw new Error("package privacy history check is missing or drifted");
}
const ciSource = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
if (!ciSource.includes("npm run privacy:history")) throw new Error("CI package audit no longer scans reachable Git history");
if ((ciSource.match(/node scripts\/prepare-pinned-npm\.mjs/g) || []).length !== 2 || ciSource.includes("npm install --global npm@")) {
  throw new Error("CI no longer bootstraps the npm baseline from an integrity-verified immutable tarball");
}
const npmBootstrapSource = readFileSync(join(root, "scripts", "prepare-pinned-npm.mjs"), "utf8");
if (!npmBootstrapSource.includes("npm-12.0.1.tgz") || !npmBootstrapSource.includes("sha512-L5T9i/YAQWQWqTS/") || !npmBootstrapSource.includes('redirect: "error"') || !npmBootstrapSource.includes("readBoundedBody(response, MAX_TARBALL_BYTES)")) {
  throw new Error("pinned npm bootstrap lost its exact version, bounded download, SHA-512 integrity, or redirect boundary");
}
const sourceWrapper = readFileSync(join(root, "mbm"), "utf8");
if (!sourceWrapper.includes("npm ci") || /npm install(?:\s|$)/.test(sourceWrapper)) throw new Error("source wrapper no longer installs from the committed lockfile");
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
const scorecardAccepted = JSON.parse(readFileSync(join(root, ".github", "scorecard-accepted-findings.json"), "utf8"));
const acceptedScorecardRules = new Set((scorecardAccepted.accepted || []).map((item) => item.ruleId));
for (const rule of ["CodeReviewID", "MaintainedID", "CIIBestPracticesID", "SASTID"]) {
  if (!acceptedScorecardRules.has(rule)) throw new Error(`Scorecard governance exception is missing: ${rule}`);
}
for (const rule of ["PinnedDependenciesID", "FuzzingID"]) {
  if (acceptedScorecardRules.has(rule)) throw new Error(`remediable Scorecard finding was incorrectly accepted: ${rule}`);
}
const codeqlAccepted = JSON.parse(readFileSync(join(root, ".github", "codeql-accepted-findings.json"), "utf8"));
const acceptedCodeql = codeqlAccepted.accepted || [];
if (acceptedCodeql.length !== 1
    || acceptedCodeql[0].ruleId !== "js/shell-command-injection-from-environment"
    || acceptedCodeql[0].path !== "src/local/process-execution.mjs") {
  throw new Error("CodeQL exception inventory must contain only the reviewed non-shell process boundary");
}
const processExecutionSource = readFileSync(join(root, "src", "local", "process-execution.mjs"), "utf8");
if (!processExecutionSource.includes('import { spawn } from "node:child_process";')
    || !processExecutionSource.includes("function spawnDirectProcess")
    || !processExecutionSource.includes("return spawn(command, args, {")
    || !processExecutionSource.includes("shell: false,")
    || processExecutionSource.includes("...options")) {
  throw new Error("direct process execution lost its fixed-option non-shell child_process boundary");
}
if (packageJson.devDependencies?.["fast-check"] !== "4.9.0" || !readFileSync(join(root, "tests", "security-properties-test.js"), "utf8").includes('from "fast-check"')) {
  throw new Error("recognized JavaScript property-based fuzzing coverage is missing");
}
const releaseSource = readFileSync(join(root, "scripts", "github-release.mjs"), "utf8");
if (!releaseSource.includes('import { requireSuccessfulWorkflowRun } from "./release-ci.mjs";')
    || (releaseSource.match(/assertSuccessfulCi\(head\);/g) || []).length !== 2
    || !releaseSource.includes(".github/workflows/codeql.yml")
    || !releaseSource.includes(".github/workflows/scorecard.yml")
    || !releaseSource.includes(".github/workflows/governance.yml")) {
  throw new Error("GitHub release orchestration no longer requires all exact-commit security and governance workflows");
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
  if (!normalized.includes(installCommand)) throw new Error(`global install/activation guidance drifted in ${relative(root, file)}`);
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

const engineering = readFileSync(join(root, "docs", "ENGINEERING.md"), "utf8");
if (!engineering.includes("default profile is intentionally `full`") || !engineering.includes("`.project-local/`")) {
  throw new Error("engineering invariants omitted the owner-required full default or local-knowledge boundary");
}

for (const file of [join(root, "docs", "ENGINEERING.md"), join(root, "CONTRIBUTING.md")]) {
  const releaseContract = readFileSync(file, "utf8").replace(/\s+/g, " ");
  if (!releaseContract.includes("source release") || !releaseContract.includes("annotated version tag") || !releaseContract.includes("npm")) {
    throw new Error(`release ownership contract drifted in ${relative(root, file)}`);
  }
  if (/automation must not[^.]{0,200}(?:create tags|GitHub Releases)/i.test(releaseContract)) {
    throw new Error(`release ownership still contradicts AGENTS.md in ${relative(root, file)}`);
  }
}
const projectStandards = readFileSync(join(root, "docs", "PROJECT_STANDARDS.md"), "utf8");
for (const required of ["GitHub Flow", "Conventional Commits", "MCP tool catalog", "An 80% aggregate coverage target", "Unhandled process-level exceptions", "npm trusted publishing", "High cohesion and low coupling", "KISS", "DRY", "ChatGPT GitHub plugin", "`gh api`", "Completion ownership", "annotated `v<version>` tag", "repeated per-task authorization is not required", "If Machine Bridge or the local authenticated CLI is unavailable", "browser-side GitHub integration"]) {
  if (!projectStandards.includes(required)) throw new Error(`project standards omitted required policy: ${required}`);
}
const toolReference = readFileSync(join(root, "docs", "TOOL_REFERENCE.md"), "utf8");
const sharedToolCatalog = JSON.parse(readFileSync(join(root, "src", "shared", "tool-catalog.json"), "utf8"));
if (!toolReference.includes("Generated from `src/shared/tool-catalog.json`") || !toolReference.includes(`Tool count: **${sharedToolCatalog.length}**`)) {
  throw new Error("generated MCP tool reference is missing or malformed");
}
const agentContract = readFileSync(join(root, "AGENTS.md"), "utf8");
for (const required of ["GitHub control plane", "hosted GitHub connector", "ChatGPT GitHub plugin", "`gh api`", "Do not mix local `gh`/`git` writes with connector writes", "standing authorization for repository source completion", "squash-merge its pull request", "run `npm run release:publish`", "Before any GitHub read or mutation", "If the local Machine Bridge control plane is unavailable"]) {
  if (!agentContract.includes(required)) throw new Error(`repository automation contract omitted GitHub control-plane rule: ${required}`);
}
if (existsSync(join(root, "src", "worker", "worker-configuration.d.ts"))) {
  throw new Error("generated Worker type declarations returned to the package source tree");
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
