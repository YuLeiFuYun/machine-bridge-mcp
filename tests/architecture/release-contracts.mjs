import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FAST_CHECK_TASKS, FULL_CHECK_TASKS, PLATFORM_CHECK_TASKS } from "../../scripts/check-plan.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cliSource = readFileSync(join(root, "src", "local", "cli.mjs"), "utf8");
if (/not found\|does not exist\|could not find/i.test(cliSource) || !cliSource.includes("if (result.code === 0)")) {
  throw new Error("Worker deletion regained stderr-text-based success classification");
}
const cliActivateSource = readFileSync(join(root, "src", "local", "cli-activate.mjs"), "utf8");
const runtimeActivationSource = readFileSync(join(root, "src", "local", "runtime-activation.mjs"), "utf8");
for (const required of [
  "recovery?.candidateServiceStarted && candidateRelayVerified && recoverablePostReadySettlement(error)",
  "RECOVERABLE_POST_READY_CODES",
  "activationRecovered: true",
  "recoveryReason: activationRecoveryReason(error)",
  "recoveryDetail: activationRecoveryDetail(error)",
  "if (settlement?.ok === true) return settlement",
]) {
  if (!runtimeActivationSource.includes(required)) throw new Error(`runtime activation lost verified recovered-success boundary: ${required}`);
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
if (Object.hasOwn(packageJson.dependencies || {}, "wrangler") || packageJson.devDependencies?.wrangler !== "4.115.0") {
  throw new Error("Wrangler must remain outside the published production dependency graph and exact in development");
}
if (packageJson.engines?.node !== ">=26.0.0" || packageJson.devEngines?.runtime?.version !== ">=26.0.0"
    || packageJson.devEngines?.runtime?.onFail !== "warn") {
  throw new Error("Node 26 runtime enforcement or metadata-only Dependabot compatibility drifted");
}
const toolchainManifest = JSON.parse(readFileSync(join(root, "src", "local", "wrangler-toolchain", "package.json"), "utf8"));
const toolchainLock = JSON.parse(readFileSync(join(root, "src", "local", "wrangler-toolchain", "package-lock.json"), "utf8"));
if (toolchainManifest.private !== true || toolchainManifest.dependencies?.wrangler !== "4.115.0"
    || toolchainManifest.overrides?.undici !== "7.29.0" || toolchainManifest.overrides?.sharp !== "0.35.3"
    || toolchainLock.packages?.["node_modules/wrangler"]?.version !== "4.115.0"
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
if (packageJson.scripts?.["release-publication-guard:test"] !== "node tests/release-publication-guard-test.mjs") throw new Error("GitHub publication ownership test is missing");
if (packageJson.scripts?.["worker-oauth-controller:test"] !== "node tests/worker-oauth-controller-test.mjs") throw new Error("Worker OAuth controller state-machine test is missing");
if (packageJson.scripts?.["cli-entrypoint:test"] !== "node tests/cli-entrypoint-test.mjs") throw new Error("CLI entrypoint regression test is missing");
if (packageJson.scripts?.["cli-service:test"] !== "node tests/cli-service-test.mjs") throw new Error("CLI service adapter regression test is missing");
if (packageJson.scripts?.["service-restart:test"] !== "node tests/service-restart-handoff-test.mjs") throw new Error("service restart/status boundary regression test is missing");
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
if (packageJson.scripts?.lint !== "eslint eslint.config.mjs bin src/local scripts tests browser-extension .github/scripts") {
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
  "device-key-id-compatibility:test": "node tests/device-key-id-compatibility-test.mjs",
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
if (packageJson.scripts?.["release:candidate"] !== "npm run check && node scripts/local-release-acceptance.mjs --prepare") throw new Error("release candidate command is missing or bypasses the complete suite");
if (packageJson.scripts?.["release:candidate:start"] !== "node scripts/start-release-candidate.mjs") throw new Error("isolated candidate startup command is missing");
const coverageRunnerSource = readFileSync(join(root, "scripts", "coverage-check.mjs"), "utf8");
if (!coverageRunnerSource.includes("maxRetries") || !coverageRunnerSource.includes("retryDelay")) {
  throw new Error("coverage temporary-directory cleanup lost its concurrent-writer retry boundary");
}
for (const fixture of ["tests/secure-file-test.mjs", "tests/worker-secret-file-test.mjs", "tests/atomic-fs-test.mjs"]) {
  if (!coverageRunnerSource.includes(fixture)) throw new Error(`critical filesystem coverage lost direct fault fixture: ${fixture}`);
}
const checkRunnerSource = readFileSync(join(root, "scripts", "check-runner.mjs"), "utf8");
const checkEntrypointSource = readFileSync(join(root, "scripts", "run-checks.mjs"), "utf8");
if (!checkEntrypointSource.includes("runVerificationPlan")
    || !checkRunnerSource.includes("process.execPath")
    || !checkRunnerSource.includes("npmCli")
    || checkRunnerSource.includes("npm.cmd")) {
  throw new Error("cross-platform check runner no longer invokes the pinned npm CLI through Node");
}
const localAcceptanceSource = readFileSync(join(root, "scripts", "local-release-acceptance.mjs"), "utf8");
for (const required of ["GIT_INDEX_FILE", "resolveTrustedGitExecutable", "createHardenedNpmSession", "runWithHardenedNpm", "packProject(root, candidateDirectory, { npmCli", "verifyCurrentReleaseAcceptance(root, { npmCli", 'git, ["read-tree", "HEAD"]', 'git, ["add", "--all"', "--print-digest", "package_content_sha256"]) {
  if (!localAcceptanceSource.includes(required)) throw new Error(`local acceptance recorder lost portable digest boundary: ${required}`);
}
const workerDeploymentSource = readFileSync(join(root, "src", "local", "worker-deployment.mjs"), "utf8");
const workerFingerprintSource = readFileSync(join(root, "src", "local", "worker-deployment-fingerprint.mjs"), "utf8");
if (!workerDeploymentSource.includes('export { workerDeploymentFingerprint } from "./worker-deployment-fingerprint.mjs"')) {
  throw new Error("Worker deployment state machine lost its dedicated fingerprint boundary");
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
if (packageJson.scripts?.["release:publish"] !== packageJson.scripts?.release) throw new Error("legacy release:publish alias drifted from npm run release");
if (packageJson.scripts?.["release:accept"] !== "node scripts/local-release-acceptance.mjs --record") throw new Error("interactive acceptance command is missing");
if (packageJson.scripts?.["release:acceptance:verify"] !== "node scripts/local-release-acceptance.mjs --verify") throw new Error("release acceptance verification command is missing");
if (packageJson.scripts?.["github:push"] !== "node scripts/github-push.mjs") throw new Error("guarded GitHub push command is missing");
const githubReleaseSource = readFileSync(join(root, "scripts", "github-release.mjs"), "utf8");
const githubPublicationGuardSource = readFileSync(join(root, "scripts", "release-publication-guard.mjs"), "utf8");
for (const required of ["assertOwnerTerminalPublication", "withGithubPublicationLock", "--owner-terminal-confirm"]) {
  if (!githubReleaseSource.includes(required)) throw new Error(`GitHub release helper lost owner-publication boundary: ${required}`);
}
for (const required of [
  "stageAcceptedCandidateTarball", "candidate.path", "artifactSha256",
  "createHardenedNpmSession", "runNpmScript", "nestedNpmEnvironment",
  "githubReleaseByTagEndpoint", "waitForGithubReleaseAsset", 'gh, ["api"',
  "GitHub release bytes were verified", "mutationError", "remote-state reconciliation",
  "waitForPublishedReleaseState", "defaultReleaseStateWait", "404 Not Found",
  "GitHub REST release metadata is invalid",
]) {
  if (!githubReleaseSource.includes(required)) throw new Error(`GitHub release helper lost exact accepted-asset boundary: ${required}`);
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
const githubCandidateStage = githubReleaseSource.indexOf("stageAcceptedCandidateTarball(root, acceptance)");
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
for (const required of ["interactive owner terminal", "withOwnerStateLock", "--git-common-dir", "github-publication", "github-publication.lock"]) {
  if (!githubPublicationGuardSource.includes(required)) throw new Error(`GitHub publication guard lost required boundary: ${required}`);
}
const publicationGuardCall = githubReleaseSource.lastIndexOf("assertOwnerTerminalPublication()");
const publicationLockCall = githubReleaseSource.lastIndexOf("await withGithubPublicationLock");
const prereleasePublishCall = githubReleaseSource.lastIndexOf("publishCurrent({ prereleaseMode: true })");
if (publicationGuardCall < 0 || publicationLockCall < 0 || prereleasePublishCall < 0
    || publicationGuardCall > publicationLockCall || publicationLockCall > prereleasePublishCall) {
  throw new Error("GitHub publication no longer verifies owner terminal presence and acquires its lock before remote mutation");
}
const githubBacklogPushSource = readFileSync(join(root, "scripts", "github-push.mjs"), "utf8");
if (!githubBacklogPushSource.includes("assertGitHubBacklogReady") || !githubBacklogPushSource.includes('runNetwork(git, ["fetch", "origin", "main", "--prune"]')) {
  throw new Error("guarded GitHub push lost the issue/PR backlog boundary");
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
for (const required of ["verifyTarball", ".release-candidate", "resolveNpmGlobalPrefix", "createHardenedNpmSession", "nestedNpmEnvironment", "--dry-run=false", "--workspaces=false", "--global", "--prefix", "--omit=optional", "--allow-scripts=esbuild,workerd,sharp,fsevents", "--allow-worker-deploy", "--activate-service", "createCandidateRuntimePrefix", "pruneInactiveCandidateRuntimes", "writePrereleaseActivation", "validateActivationRecoveryPayload", "activation_recovery_detail", "temporary runtime was removed", '"activate"', 'stdio: "inherit"']) {
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
if (!candidateStartSource.includes("persistentActivationSpawnOptions")
    || (candidateStartSource.match(/killSignal: "SIGKILL"/g) || []).length !== 1) {
  throw new Error("candidate startup must hard-bound npm installation without externally killing the activation transaction");
}
const candidateBaselineRead = candidateStartSource.indexOf("const previousInstallation = persistentActivation");
const candidateNpmDispose = candidateStartSource.indexOf("disposeNpmSession();");
const candidateActivationCall = candidateStartSource.indexOf("activatePersistentCandidate({");
const candidateRuntimePrune = candidateStartSource.indexOf("removedRuntimes = pruneInactiveCandidateRuntimes");
const candidateActivationRecord = candidateStartSource.indexOf("recordPath = writePrereleaseActivation");
if ([candidateBaselineRead, candidateNpmDispose, candidateActivationCall, candidateRuntimePrune, candidateActivationRecord].some((value) => value < 0)
    || candidateBaselineRead > candidateNpmDispose
    || candidateNpmDispose > candidateActivationCall
    || candidateRuntimePrune > candidateActivationRecord) {
  throw new Error("candidate activation no longer reads rollback evidence before hardened npm disposal or completes blocking runtime cleanup before writing activation evidence");
}
const npmPublishSource = readFileSync(join(root, "scripts", "publish-npm.mjs"), "utf8");
for (const required of [
  "verifyCurrentReleaseAcceptance", "stageAcceptedCandidateTarball", "prepublishOnly",
  "candidate.path", "--ignore-scripts=true", "--if-present=false", '"--tag", parsed.npmTag', "validateNpmPublishDryRun",
  '"--dry-run=true"', "disposePublicationResources", "readPublishedNpmPrereleaseIfPresent",
  "waitForPublishedCandidate", "alreadyPublished", "publication outcome is ambiguous",
]) {
  if (!npmPublishSource.includes(required)) throw new Error(`npm publication lost exact accepted-tarball boundary: ${required}`);
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
  "accepted candidate staging failed and temporary cleanup was incomplete",
]) {
  if (!acceptedCandidateSource.includes(required)) throw new Error(`accepted candidate staging lost required boundary: ${required}`);
}
const publishedPrereleaseInstallSource = readFileSync(join(root, "scripts", "install-published-prerelease.mjs"), "utf8");
for (const required of ["createHardenedNpmSession", "resolveNpmGlobalPrefix", "readGithubPrerelease", "expectedArtifactSha256: acceptance.artifactSha256", "nestedNpmEnvironment", "--dry-run=false", "--workspaces=false", "--include=prod", "validateActivationRecoveryPayload", "globalInstallAttempted", "globalInstallCompleted", "may have changed the installed package"]) {
  if (!publishedPrereleaseInstallSource.includes(required)) throw new Error(`published prerelease installation lost hardened activation boundary: ${required}`);
}
const publishedAcceptanceCheck = publishedPrereleaseInstallSource.indexOf("verifyCurrentReleaseAcceptance(root");
const publishedDigestCheck = publishedPrereleaseInstallSource.indexOf("computePromotionContentDigest(root");
const publishedGithubAssetCheck = publishedPrereleaseInstallSource.indexOf("readGithubPrerelease(prerelease.raw");
const publishedHardenedNpm = publishedPrereleaseInstallSource.indexOf("npmSession = await createHardenedNpmSession()");
const publishedRegistryRead = publishedPrereleaseInstallSource.indexOf("readPublishedNpmPrerelease(");
const publishedInstallAttempted = publishedPrereleaseInstallSource.indexOf("globalInstallAttempted = true");
const publishedInstallCall = publishedPrereleaseInstallSource.indexOf('"install", "--dry-run=false"');
const publishedInstallCompleted = publishedPrereleaseInstallSource.indexOf("globalInstallCompleted = true");
if ([publishedInstallAttempted, publishedInstallCall, publishedInstallCompleted].some((value) => value < 0)
    || publishedInstallAttempted > publishedInstallCall || publishedInstallCall > publishedInstallCompleted) {
  throw new Error("published prerelease installation no longer marks ambiguous global mutation before and after npm install");
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
for (const required of ["ACTIVATION_SCHEMA_VERSION = 2", "LEGACY_ACTIVATION_SCHEMA_VERSION = 1", "global_package_rollback_baseline", "rollback baseline is ambiguous"]) {
  if (!prereleaseActivationSource.includes(required)) throw new Error(`prerelease activation schema lost explicit rollback-baseline semantics: ${required}`);
}
for (const [label, source] of [["candidate", candidateStartSource], ["published prerelease", publishedPrereleaseInstallSource]]) {
  for (const required of ["ACTIVATION_SCHEMA_VERSION", "global_package_rollback_baseline", "activation_recovery_detail"]) {
    if (!source.includes(required)) throw new Error(`${label} activation writer lost the current explicit rollback-baseline contract: ${required}`);
  }
  if (source.includes("{ previous:") || source.includes("{ previous }")) {
    throw new Error(`${label} activation writer restored the ambiguous legacy previous field`);
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
for (const required of ["release-channels", "runtimes", "withFileTypes", "entry.isDirectory()", "RUNTIME_DIRECTORY_PATTERN", "active candidate runtime is outside", "must be a real directory", "requireSameDirectory"]) {
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
if (!readFileSync(join(root, "scripts", "syntax-check.mjs"), "utf8").includes('".github/scripts"')
    || !packageJson.scripts?.lint?.includes(".github/scripts")
    || !readFileSync(join(root, "eslint.config.mjs"), "utf8").includes('".github/scripts/**/*.{js,mjs}"')) {
  throw new Error("GitHub workflow control scripts are missing from syntax or lint gates");
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
  ["legacy approval state", "src/local/operation-authorization.mjs"],
]) {
  const source = readFileSync(join(root, file), "utf8");
  if (!source.includes("inspectPathIfPresentSync")) throw new Error(`${label} lost fail-closed path inspection`);
  if (/existsSync/.test(source) && file !== "src/local/state.mjs") throw new Error(`${label} regained existsSync absence classification`);
}
const managedJobSource = readFileSync(join(root, "src", "local", "managed-jobs.mjs"), "utf8");
const managedJobRunnerSource = readFileSync(join(root, "src", "local", "job-runner.mjs"), "utf8");
const managedJobClaimSource = readFileSync(join(root, "src", "local", "managed-job-runner-claim.mjs"), "utf8");
const managedJobCancellationSource = readFileSync(join(root, "src", "local", "managed-job-cancellation.mjs"), "utf8");
const managedJobDirectorySource = readFileSync(join(root, "src", "local", "managed-job-directory.mjs"), "utf8");
for (const required of ["writeManagedJobCancellation", "resolveManagedJobDirectory", "resolveManagedJobRootIfPresent"]) {
  if (!managedJobSource.includes(required)) throw new Error(`managed job manager lost secure boundary: ${required}`);
}
if (managedJobRunnerSource.includes("existsSync(cancelFile)")
    || !managedJobRunnerSource.includes("managedJobCancellationRequested(cancelFile)")) {
  throw new Error("managed job runner again treats cancellation inspection failure as absence");
}
if (managedJobClaimSource.includes("existsSync") || !managedJobClaimSource.includes("inspectPathIfPresentSync")) {
  throw new Error("managed job runner claim again treats inspection failure as absence");
}
for (const required of ["replaceFileAtomicallySync", "verifyPathIdentity: true", "rejectMultipleLinks: true", "managed job cancellation marker is invalid"]) {
  if (!managedJobCancellationSource.includes(required)) throw new Error(`managed job cancellation boundary lost: ${required}`);
}
for (const required of ["MANAGED_JOB_ID", "requireContained", "identity changed during inspection", "openSync", "fstatSync", "O_NOFOLLOW", "O_DIRECTORY", "bigint: true"]) {
  if (!managedJobDirectorySource.includes(required)) throw new Error(`managed job directory boundary lost: ${required}`);
}
if (packageJson.scripts?.["managed-job-boundary:test"] !== "node tests/managed-job-boundary-test.mjs"
    || !FAST_CHECK_TASKS.includes("managed-job-boundary:test")) {
  throw new Error("managed job filesystem fault injection is missing from the fast gate");
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
const portableAcceptanceCommand = "npm pack --ignore-scripts --silent --dry-run --json | node .github/scripts/verify-release-acceptance.mjs";
if ((ciSource.split(portableAcceptanceCommand).length - 1) !== 2) throw new Error("CI no longer verifies portable interactive candidate acceptance in both package paths");
const portableAcceptanceSource = readFileSync(join(root, ".github", "scripts", "verify-release-acceptance.mjs"), "utf8");
for (const required of ["canonicalPackageDigest", "package_content_sha256", "promotion_content_sha256", "computePromotionContentDigest", "resolveTrustedGitExecutable", "ls-files", "--stage", "cat-file", "machine-bridge-mcp-package-content-v1"]) {
  if (!portableAcceptanceSource.includes(required)) throw new Error(`portable release acceptance verifier lost required content: ${required}`);
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
const hardenedNpmVerificationSource = readFileSync(join(root, "src", "local", "hardened-npm-verification.mjs"), "utf8");
if (!npmBootstrapSource.includes("prepareHardenedNpm")
    || !hardenedNpmSource.includes("npm-12.0.1.tgz") || !hardenedNpmSource.includes("sha512-L5T9i/YAQWQWqTS/")
    || !hardenedNpmSource.includes("undici-6.28.0.tgz") || !hardenedNpmSource.includes("brace-expansion-5.0.9.tgz")
    || !hardenedNpmDownloadSource.includes("proxyAgentForHttp") || !hardenedNpmDownloadSource.includes("status !== 200")
    || !hardenedNpmDownloadSource.includes("downloadHardenedNpmArtifact")
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
  "js/insufficient-password-hash\0src/local/account-admin.mjs",
]);
if (acceptedCodeql.size !== expectedCodeql.size || [...expectedCodeql].some((item) => !acceptedCodeql.has(item))) {
  throw new Error("CodeQL exception inventory contains an unreviewed or missing exact finding");
}
const processExecutionSource = readFileSync(join(root, "src", "local", "process-execution.mjs"), "utf8");
if (!processExecutionSource.includes('import { spawn } from "node:child_process";')
    || !processExecutionSource.includes("function spawnDirectProcess")
    || !processExecutionSource.includes("return spawn(command, args, {")
    || !processExecutionSource.includes("shell: false,")
    || processExecutionSource.includes("...options")) {
  throw new Error("direct process execution lost its fixed-option non-shell child_process boundary");
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
  for (const required of [
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

const engineering = readFileSync(join(root, "docs", "ENGINEERING.md"), "utf8");
if (!engineering.includes("default profile is intentionally `full`") || !engineering.includes("`.project-local/`") || !engineering.includes("`Object.hasOwn`")) {
  throw new Error("engineering invariants omitted the owner-required full default or local-knowledge boundary");
}
if (!engineering.includes("Documented read-only discovery may conservatively omit unavailable or unsupported optional metadata")) {
  throw new Error("engineering read-failure invariant does not distinguish optional discovery from security/persistence evidence");
}
const architectureGuide = readFileSync(join(root, "docs", "ARCHITECTURE.md"), "utf8");
if (architectureGuide.includes("All bridge mutations are serialized in one runtime queue.")
    || !architectureGuide.includes("Operations touching the same canonical path serialize; independent paths may proceed concurrently")) {
  throw new Error("architecture mutation model drifted from canonical-path reservation semantics");
}
const upgradingGuide = readFileSync(join(root, "docs", "UPGRADING.md"), "utf8");
if (!upgradingGuide.includes("historical migration records, not a declaration of the current candidate")
    || upgradingGuide.includes("`3.0.0-beta.7` retains the portable P-256 root by default and is the next supported candidate path")) {
  throw new Error("upgrade history regained stale present-tense candidate guidance");
}

for (const file of [join(root, "docs", "ENGINEERING.md"), join(root, "CONTRIBUTING.md")]) {
  const releaseContract = readFileSync(file, "utf8").replace(/\s+/g, " ");
  if (!releaseContract.includes("prerelease") || !releaseContract.includes("soak") || !releaseContract.includes("npm")) {
    throw new Error(`release ownership contract drifted in ${relative(root, file)}`);
  }
  for (const required of ["--owner-terminal-confirm", "interactive", "owner"]) {
    if (!releaseContract.includes(required)) throw new Error(`GitHub publication ownership drifted in ${relative(root, file)}: ${required}`);
  }
}
const projectStandards = readFileSync(join(root, "docs", "PROJECT_STANDARDS.md"), "utf8");
for (const required of ["GitHub Flow", "Conventional Commits", "MCP tool catalog", "An 80% aggregate coverage target", "Unhandled process-level exceptions", "npm trusted publishing", "High cohesion and low coupling", "KISS", "DRY", "ChatGPT GitHub plugin", "`gh api`", "Completion ownership, prerelease activation, and soak", "npm run release:candidate", "npm run release:candidate:activate -- --allow-worker-deploy", "npm run prerelease:release -- --owner-terminal-confirm", "npm run prerelease:publish", "npm run prerelease:install -- --allow-worker-deploy", "promotion-content digest", "seven days", "npm run stable:publish", "npm run github:push", "real interactive terminal", "observed live verification", "If Machine Bridge or the local authenticated CLI is unavailable", "browser-side GitHub integration"]) {
  if (!projectStandards.includes(required)) throw new Error(`project standards omitted required policy: ${required}`);
}
const releasingGuide = readFileSync(join(root, "docs", "RELEASING.md"), "utf8");
for (const required of ["npm run prerelease:release -- --owner-terminal-confirm", "npm run release:backfill -- --owner-terminal-confirm", "npm run release -- --owner-terminal-confirm", "real interactive terminal"]) {
  if (!releasingGuide.includes(required)) throw new Error(`release guide omitted owner-terminal publication contract: ${required}`);
}
const toolReference = readFileSync(join(root, "docs", "TOOL_REFERENCE.md"), "utf8");
const sharedToolCatalog = JSON.parse(readFileSync(join(root, "src", "shared", "tool-catalog.json"), "utf8"));
if (!toolReference.includes("Generated from `src/shared/tool-catalog.json`") || !toolReference.includes(`Tool count: **${sharedToolCatalog.length}**`)) {
  throw new Error("generated MCP tool reference is missing or malformed");
}
const agentContract = readFileSync(join(root, "AGENTS.md"), "utf8");
for (const required of ["Tool-selection hard gate", "Do not call, discover, list, load, or invoke a hosted GitHub connector", "This gate applies before connector/tool discovery", "Availability of a hosted connector is not a fallback", "A violation must be treated as a process defect", "GitHub control plane", "hosted GitHub connector", "ChatGPT GitHub plugin", "`gh api`", "Do not mix local `gh`/`git` writes with connector writes", "Mandatory prerelease and soak invariant", "npm run release:candidate", "npm run release:candidate:activate -- --allow-worker-deploy", "npm run release:accept", "npm run github:push", "npm run prerelease:release -- --owner-terminal-confirm", "npm run prerelease:publish", "npm run prerelease:install -- --allow-worker-deploy", "npm run release:soak:verify", "npm run stable:publish", "Before any GitHub read or mutation", "If the local Machine Bridge control plane is unavailable"]) {
  if (!agentContract.includes(required)) throw new Error(`repository automation contract omitted GitHub control-plane rule: ${required}`);
}
if (existsSync(join(root, "src", "worker", "worker-configuration.d.ts"))) {
  throw new Error("generated Worker type declarations returned to the package source tree");
}
if (!readFileSync(join(root, ".gitignore"), "utf8").split(/\r?\n/).includes(".project-local/")) {
  throw new Error("machine-specific project notes are not ignored");
}

console.log("architecture release/documentation contracts ok");
