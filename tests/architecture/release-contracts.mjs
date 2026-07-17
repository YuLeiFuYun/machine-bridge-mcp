import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cliSource = readFileSync(join(root, "src", "local", "cli.mjs"), "utf8");

const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
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
if (packageJson.scripts?.["worker-oauth-controller:test"] !== "node tests/worker-oauth-controller-test.mjs") throw new Error("Worker OAuth controller state-machine test is missing");
if (packageJson.scripts?.["cli-entrypoint:test"] !== "node tests/cli-entrypoint-test.mjs") throw new Error("CLI entrypoint regression test is missing");
if (packageJson.scripts?.["cli-service:test"] !== "node tests/cli-service-test.mjs") throw new Error("CLI service adapter regression test is missing");
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
if (!String(packageJson.scripts?.check || "").includes("npm run runtime-boundaries:test")
    || !String(packageJson.scripts?.check || "").includes("npm run worker-oauth-controller:test")
    || !String(packageJson.scripts?.check || "").includes("npm run shell:test") || !String(packageJson.scripts?.check || "").includes("npm run lint:test") || !String(packageJson.scripts?.check || "").includes("npm run lint") || !String(packageJson.scripts?.check || "").includes("npm run deadline:test") || !String(packageJson.scripts?.check || "").includes("npm run install:test") || !String(packageJson.scripts?.check || "").includes("npm run oauth-browser:test")) {
  throw new Error("complete check no longer includes static undefined-identifier and installed-default-startup gates");
}
if (packageJson.scripts?.["release:acceptance:test"] !== "node tests/release-acceptance-test.mjs") throw new Error("local release acceptance regression test is missing");
if (packageJson.scripts?.["release:candidate"] !== "npm run check && node scripts/local-release-acceptance.mjs --prepare") throw new Error("release candidate command is missing or bypasses the complete suite");
if (packageJson.scripts?.["release:accept"] !== "node scripts/local-release-acceptance.mjs --record") throw new Error("owner acceptance command is missing");
if (packageJson.scripts?.["release:acceptance:verify"] !== "node scripts/local-release-acceptance.mjs --verify") throw new Error("release acceptance verification command is missing");
if (packageJson.scripts?.["github:push"] !== "node scripts/github-push.mjs") throw new Error("guarded GitHub push command is missing");
if (!String(packageJson.scripts?.check || "").includes("npm run release:acceptance:test")) throw new Error("complete check omits local release acceptance regression coverage");
if (packageJson.scripts?.["privacy:history"] !== "node scripts/privacy-check.mjs --history") {
  throw new Error("package privacy history check is missing or drifted");
}
const ciSource = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
if (!ciSource.includes("npm run privacy:history")) throw new Error("CI package audit no longer scans reachable Git history");
const portableAcceptanceCommand = "npm pack --ignore-scripts --silent --dry-run --json | node .github/scripts/verify-release-acceptance.mjs";
if ((ciSource.split(portableAcceptanceCommand).length - 1) !== 2) throw new Error("CI no longer verifies portable repository-owner package acceptance in both package paths");
const portableAcceptanceSource = readFileSync(join(root, ".github", "scripts", "verify-release-acceptance.mjs"), "utf8");
for (const required of ["canonicalPackageDigest", "package_content_sha256", "git", "ls-files", "--stage", "machine-bridge-mcp-package-content-v1"]) {
  if (!portableAcceptanceSource.includes(required)) throw new Error(`portable release acceptance verifier lost required content: ${required}`);
}
if ((ciSource.match(/node scripts\/prepare-pinned-npm\.mjs/g) || []).length !== 2 || ciSource.includes("npm install --global npm@")) {
  throw new Error("CI no longer bootstraps the npm baseline from an integrity-verified immutable tarball");
}
const npmBootstrapSource = readFileSync(join(root, "scripts", "prepare-pinned-npm.mjs"), "utf8");
if (!npmBootstrapSource.includes("npm-12.0.1.tgz") || !npmBootstrapSource.includes("sha512-L5T9i/YAQWQWqTS/") || !npmBootstrapSource.includes('redirect: "error"') || !npmBootstrapSource.includes("readBoundedBody(response, MAX_TARBALL_BYTES)")) {
  throw new Error("pinned npm bootstrap lost its exact version, bounded download, SHA-512 integrity, or redirect boundary");
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
    || !releaseSource.includes('import { verifyCurrentReleaseAcceptance } from "./release-acceptance.mjs";')
    || (releaseSource.match(/assertSuccessfulCi\(head\);/g) || []).length !== 2
    || !releaseSource.includes(".github/workflows/codeql.yml")
    || !releaseSource.includes(".github/workflows/scorecard.yml")
    || !releaseSource.includes(".github/workflows/governance.yml")
    || releaseSource.includes('["push", "origin", "HEAD:main"]')
    || !releaseSource.includes("HEAD does not match origin/main; local acceptance must be committed")) {
  throw new Error("GitHub release orchestration lost owner acceptance, exact-commit gates, or the no-main-push boundary");
}
const githubPushSource = readFileSync(join(root, "scripts", "github-push.mjs"), "utf8");
for (const required of ["verifyCurrentReleaseAcceptance", "working tree is not clean", "direct pushes to main are prohibited", "--set-upstream", "release-acceptance/v"]) {
  if (!githubPushSource.includes(required)) throw new Error(`guarded GitHub push lost required boundary: ${required}`);
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
]) {
  if (!localTypeConfig.include?.includes(required)) throw new Error(`local type contract omits ${required}`);
  if (!readFileSync(join(root, required), "utf8").startsWith("// @ts-check")) throw new Error(`${required} is not opt-in strict checked JavaScript`);
}


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
if (!engineering.includes("default profile is intentionally `full`") || !engineering.includes("`.project-local/`") || !engineering.includes("`Object.hasOwn`")) {
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
for (const required of ["GitHub Flow", "Conventional Commits", "MCP tool catalog", "An 80% aggregate coverage target", "Unhandled process-level exceptions", "npm trusted publishing", "High cohesion and low coupling", "KISS", "DRY", "ChatGPT GitHub plugin", "`gh api`", "Completion ownership and local acceptance", "annotated `v<version>` tag", "npm run release:candidate", "npm run github:push", "Automation must not create that assertion", "If Machine Bridge or the local authenticated CLI is unavailable", "browser-side GitHub integration"]) {
  if (!projectStandards.includes(required)) throw new Error(`project standards omitted required policy: ${required}`);
}
const toolReference = readFileSync(join(root, "docs", "TOOL_REFERENCE.md"), "utf8");
const sharedToolCatalog = JSON.parse(readFileSync(join(root, "src", "shared", "tool-catalog.json"), "utf8"));
if (!toolReference.includes("Generated from `src/shared/tool-catalog.json`") || !toolReference.includes(`Tool count: **${sharedToolCatalog.length}**`)) {
  throw new Error("generated MCP tool reference is missing or malformed");
}
const agentContract = readFileSync(join(root, "AGENTS.md"), "utf8");
for (const required of ["GitHub control plane", "hosted GitHub connector", "ChatGPT GitHub plugin", "`gh api`", "Do not mix local `gh`/`git` writes with connector writes", "standing authorization for repository implementation and local validation", "npm run release:candidate", "npm run release:accept", "npm run github:push", "must stop before the first GitHub push", "run `npm run release:publish`", "Before any GitHub read or mutation", "If the local Machine Bridge control plane is unavailable"]) {
  if (!agentContract.includes(required)) throw new Error(`repository automation contract omitted GitHub control-plane rule: ${required}`);
}
if (existsSync(join(root, "src", "worker", "worker-configuration.d.ts"))) {
  throw new Error("generated Worker type declarations returned to the package source tree");
}
if (!readFileSync(join(root, ".gitignore"), "utf8").split(/\r?\n/).includes(".project-local/")) {
  throw new Error("machine-specific project notes are not ignored");
}

console.log("architecture release/documentation contracts ok");
