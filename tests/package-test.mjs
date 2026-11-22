import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nestedNpmEnvironment } from "../src/local/deploy/npm.mjs";
import { publishedPackageJsonText, publishedPackageManifest } from "../src/shared/published-package.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const packageLock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
if (packageLock.version !== packageJson.version || packageLock.packages?.[""]?.version !== packageJson.version) {
  throw new Error("package.json and package-lock.json root versions must match");
}
const output = mkdtempSync(join(tmpdir(), "mbm-package-test-"));
try {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("package test must run through an npm lifecycle so npm_execpath is available");
  const result = spawnSync(process.execPath, [npmCli, "pack", "--workspaces=false", "--global=false", "--prefix", root, "--silent", "--dry-run", "--json", "--pack-destination", output], {
    cwd: root,
    encoding: "utf8",
    env: nestedNpmEnvironment(process.env),
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm pack failed: ${result.stderr || result.stdout}`);
  let records;
  try { records = JSON.parse(result.stdout); } catch {
    throw new Error(`npm pack stdout was not clean JSON: ${result.stdout.slice(0, 500)}`);
  }
  const record = normalizePackRecord(records);
  if (!record || !Array.isArray(record.files)) throw new Error("npm pack metadata omitted the file list");
  if ((packageJson.files || []).includes("docs") || (packageJson.files || []).includes("scripts")) {
    throw new Error("package.json files must use explicit docs/scripts whitelists rather than broad directories");
  }
  validatePackagedMarkdownLinks(record.files);
  const sensitive = record.files
    .map((item) => String(item.path || ""))
    .filter((path) => /(?:^|\/)(?:\.env|\.npmrc|\.dev\.vars|\.privacy-denylist|\.project-local|\.wrangler|\.cloudflare|node_modules)(?:\/|$)|\.(?:pem|key|sqlite|log)$/.test(path));
  if (sensitive.length) throw new Error(`npm package contains sensitive local artifacts: ${sensitive.join(", ")}`);
  for (const file of ["docs/PRIVACY.md", "docs/AUDIT.md", "docs/UPGRADING.md", "docs/OPERATIONS.md", "docs/TOOL_REFERENCE.md", "docs/POLICY_REFERENCE.md"]) {
    if (!record.files.some((item) => item.path === file)) throw new Error(`npm package omitted current consumer guidance ${file}`);
  }
  const auditEntry = record.files.find((item) => item.path === "docs/AUDIT.md");
  if (Number(auditEntry?.size || 0) > 32 * 1024) throw new Error("npm package audit summary regained historical bulk");
  for (const repositoryOnly of [
    "mbm", "mbm.cmd",
    "CONTRIBUTING.md", "CODE_OF_CONDUCT.md", "GOVERNANCE.md",
    "native/macos/MachineBridgeBackgroundInputSmokeFixture.swift",
    "tests/fixtures/native/MachineBridgeBackgroundInputSmokeFixture.swift",
    "tests/fixtures/tool-output-contract.json",
    "docs/ARCHITECTURE.md", "docs/ENGINEERING.md", "docs/RELEASING.md", "docs/TESTING.md",
  ]) {
    if (record.files.some((item) => item.path === repositoryOnly)) throw new Error(`npm package retained repository-only maintenance material ${repositoryOnly}`);
  }
  if (!record.files.some((item) => item.path === "src/local/transport/relay-connection.mjs")) throw new Error("npm package omitted the relay lifecycle module");
  for (const file of [
    "src/local/deploy/hardened-npm.mjs",
    "src/local/deploy/npm.mjs",
    "src/local/deploy/cf-network-integrity.mjs",
    "src/local/deploy/wrangler-toolchain.mjs",
    "src/local/wrangler-toolchain/package.json",
    "src/local/wrangler-toolchain/package-lock.json",
    "src/local/deploy/cf-project.mjs",
    "cloudflare.config.ts",
    "wrangler.config.ts",
    "scripts/release-diagnostic.mjs",
    "scripts/test-entry.mjs",
    "src/shared/published-package.mjs",
  ]) {
    if (!record.files.some((item) => item.path === file)) throw new Error(`npm package omitted ${file}`);
  }
  if (packageJson.scripts?.test !== "node scripts/test-entry.mjs") {
    throw new Error("published npm test must use the shipped source/packaged test entrypoint");
  }
  const publishedManifest = publishedPackageManifest(packageJson);
  const publishedScriptNames = Object.keys(publishedManifest.scripts || {});
  if (publishedScriptNames.join(",") !== "test,start,doctor") {
    throw new Error(`published package exposed repository-only scripts: ${publishedScriptNames.join(", ")}`);
  }
  if ((packageJson.scripts && Object.keys(packageJson.scripts).length) <= publishedScriptNames.length) {
    throw new Error("source package.json no longer carries repository-only scripts");
  }
  for (const [name, command] of Object.entries(publishedManifest.scripts)) {
    const match = /^node ([A-Za-z0-9_./@+-]+)(?: [A-Za-z0-9_./@+-]+)*$/.exec(command);
    if (!match) throw new Error(`published script ${name} is not a direct shipped Node entrypoint: ${command}`);
    if (!record.files.some((item) => item.path === match[1])) {
      throw new Error(`published script ${name} references a file omitted from the tarball: ${match[1]}`);
    }
  }
  const publishedText = publishedPackageJsonText(packageJson);
  if (!publishedText.endsWith("\n")) throw new Error("published package manifest must end with a newline");
  const reparsed = JSON.parse(publishedText);
  if (reparsed.version !== packageJson.version || Object.keys(reparsed.scripts || {}).join(",") !== "test,start,doctor") {
    throw new Error("published package manifest changed package identity or script scope");
  }
  if (Object.keys(packageJson.scripts || {}).length <= 3) {
    throw new Error("source package.json was mutated while building the published manifest");
  }
  const privateManifest = JSON.parse(readFileSync(join(root, "src/local/wrangler-toolchain/package.json"), "utf8"));
  const privateLock = JSON.parse(readFileSync(join(root, "src/local/wrangler-toolchain/package-lock.json"), "utf8"));
  for (const tool of ["cf", "wrangler", "undici", "miniflare", "workerd"]) {
    if (Object.hasOwn(packageJson.dependencies || {}, tool)) throw new Error(`Consumer dependencies must exclude the private deployment tool ${tool}`);
  }
  for (const tool of ["cf", "wrangler"]) {
    const version = String(packageJson.devDependencies?.[tool] || "");
    if (!version || privateManifest.dependencies?.[tool] !== version
        || privateLock.packages?.[""]?.dependencies?.[tool] !== version
        || privateLock.packages?.[`node_modules/${tool}`]?.version !== version) {
      throw new Error(`The packaged private ${tool} toolchain must retain its exact source development and lockfile pin`);
    }
  }
  if (Object.hasOwn(privateManifest.dependencies, "undici")
      || privateLock.packages["node_modules/undici"]?.version !== privateManifest.overrides?.undici
      || privateLock.packages["node_modules/zod"]?.version !== privateManifest.overrides?.zod) {
    throw new Error("The private toolchain must verify transitive Undici/Zod without a redundant direct dependency");
  }
  if (!record.files.some((item) => item.path === "src/local/runtime/runtime.mjs")) throw new Error("npm package omitted the local runtime module");
  for (const module of [
    "runtime/runtime-services.mjs", "runtime/runtime-projections.mjs", "runtime/runtime-diagnostics.mjs", "automation/app-macos-jxa.mjs", "runtime/call-registry.mjs", "runtime/runtime-relay.mjs",
    "core/filesystem-identity.mjs", "files/workspace-transaction.mjs", "transport/relay-classification.mjs",
  ]) {
    if (!record.files.some((item) => item.path === `src/local/${module}`)) throw new Error(`npm package omitted extracted runtime boundary ${module}`);
  }
  if (!record.files.some((item) => item.path === "src/local/agent/agent-context.mjs")) throw new Error("npm package omitted the agent-context module");
  for (const module of ["agent/agent-contract.mjs", "agent/agent-skill-discovery.mjs"]) {
    if (!record.files.some((item) => item.path === `src/local/${module}`)) throw new Error(`npm package omitted extracted Agent boundary ${module}`);
  }
  if (!record.files.some((item) => item.path === "src/local/agent/agent-contract.mjs")) throw new Error("npm package omitted the agent contract module");
  if (!record.files.some((item) => item.path === "src/local/agent/default-instructions.mjs")) throw new Error("npm package omitted the default-instructions module");
  if (!record.files.some((item) => item.path === "src/local/transport/daemon-process.mjs")) throw new Error("npm package omitted the daemon-process module");
  if (!record.files.some((item) => item.path === "src/local/process/identity.mjs")) throw new Error("npm package omitted the process-identity module");
  if (!record.files.some((item) => item.path === "src/local/core/exclusive-file.mjs")) throw new Error("npm package omitted the atomic exclusive-file module");
  if (!record.files.some((item) => item.path === "src/local/deploy/service-support.mjs")) throw new Error("npm package omitted the service-lifecycle module");
  if (!record.files.some((item) => item.path === "src/local/automation/app-automation.mjs")) throw new Error("npm package omitted the application-automation module");
  if (!record.files.some((item) => item.path === "src/local/automation/browser-bridge.mjs")) throw new Error("npm package omitted the browser-bridge module");
  for (const module of [
    "automation/browser-broker-routes.mjs", "automation/browser-broker.mjs", "deploy/service-platforms.mjs",
    "jobs/directory.mjs", "jobs/projection.mjs", "jobs/runner-lifecycle.mjs", "jobs/listing.mjs",
    "process/resource-admission-policy.mjs",
    "transport/relay-heartbeat.mjs",
    "transport/relay-recovery.mjs",
    "transport/relay-classification.mjs",
    "transport/daemon-http-relay-protocol.mjs",
    "process/session-helpers.mjs",
  ]) {
    if (!record.files.some((item) => item.path === `src/local/${module}`)) throw new Error(`npm package omitted extracted local boundary ${module}`);
  }
  if (!record.files.some((item) => item.path === "src/local/automation/browser-operation-service.mjs")) throw new Error("npm package omitted browser operation semantics");
  if (!record.files.some((item) => item.path === "src/worker/index.ts")) throw new Error("npm package omitted the worker entrypoint");
  for (const module of ["mcp/jsonrpc.ts", "room/websocket-protocol.ts", "mcp/http-contract.ts", "mcp/controller.ts", "mcp/tasks.ts", "mcp/prompts.ts", "mcp/task-store.ts", "mcp/response-stream.ts", "mcp/tool-call-dispatch.ts", "mcp/response-proxy.ts", "room/server-info.ts", "room/entry.ts", "daemon/registry.ts"]) {
    if (!record.files.some((item) => item.path === `src/worker/${module}`)) throw new Error(`npm package omitted extracted Worker protocol ${module}`);
  }
  for (const module of [
    "mcp-protocol.mjs", "mcp-protocol.d.mts",
    "mcp-task-contract.mjs", "mcp-task-contract.d.mts",
    "tool-argument-validation.mjs", "tool-argument-validation.d.mts",
    "trusted-origin.mjs", "trusted-origin.d.mts",
    "path-containment.mjs", "path-containment.d.mts",
    "help-resources-content.json",
  ]) {
    if (!record.files.some((item) => item.path === `src/shared/${module}`)) throw new Error(`npm package omitted shared MCP contract ${module}`);
  }
  if (!record.files.some((item) => item.path === "src/shared/activation-recovery.mjs")) {
    throw new Error("npm package omitted shared activation recovery evidence contract");
  }
  if (!record.files.some((item) => item.path === "src/worker/room/pending-calls.ts")) throw new Error("npm package omitted the worker pending calls module");
  if (!record.files.some((item) => item.path === "src/worker/daemon/liveness.ts")) throw new Error("npm package omitted the worker daemon liveness module");
  if (!record.files.some((item) => item.path === "src/worker/room/policy.ts")) throw new Error("npm package omitted the worker policy module");
  if (!record.files.some((item) => item.path === "src/worker/room/errors.ts")) throw new Error("npm package omitted the worker errors module");
  if (!record.files.some((item) => item.path === "src/worker/oauth/state.ts")) throw new Error("npm package omitted the worker oauth state module");
  if (!record.files.some((item) => item.path === "src/worker/oauth/controller.ts")) throw new Error("npm package omitted the Worker OAuth controller");
  if (!record.files.some((item) => item.path === "src/worker/oauth/authorization-page.ts")) throw new Error("npm package omitted the Worker OAuth authorization page module");
  if (!record.files.some((item) => item.path === "src/worker/room/observability.ts")) throw new Error("npm package omitted the worker observability module");
  if (!record.files.some((item) => item.path === "src/worker/room/http.ts")) throw new Error("npm package omitted the worker http module");
  if (record.files.some((item) => item.path.endsWith("worker-configuration.d.ts"))) throw new Error("npm package contains generated Worker type declarations");
  if (record.files.some((item) => item.path === "toolchain/worker-runtime-types-seed.b64")) throw new Error("npm package contains the development-only Worker runtime type seed");
  if (!record.files.some((item) => item.path === "browser-extension/manifest.json")) throw new Error("npm package omitted the browser extension manifest");
  if (!record.files.some((item) => item.path === "browser-extension/service-worker.js")) throw new Error("npm package omitted the browser extension service worker");
  if (!record.files.some((item) => item.path === "browser-extension/broker-auth.js")) throw new Error("npm package omitted the browser extension broker authentication module");
  if (!record.files.some((item) => item.path === "browser-extension/pairing-bootstrap.js")) throw new Error("npm package omitted the browser extension pairing bootstrap module");
  if (!record.files.some((item) => item.path === "browser-extension/pairing.js")) throw new Error("npm package omitted the browser extension pairing content script");
  if (!record.files.some((item) => item.path === "browser-extension/page-automation.js")) throw new Error("npm package omitted the browser page automation module");
  if (!record.files.some((item) => item.path === "docs/LOCAL_AUTOMATION.md")) throw new Error("npm package omitted local-automation guidance");
  if (!record.files.some((item) => item.path === "src/local/core/secure-file.mjs")) throw new Error("npm package omitted the shared secure-file primitive");
  if (!record.files.some((item) => item.path === "src/local/deploy/service-support.mjs")) throw new Error("npm package omitted identity-bound service-definition cleanup");
  if (record.files.some((item) => item.path === "src/local/daemon.mjs")) throw new Error("npm package retained the obsolete local daemon module name");
  for (const helper of [
    "prerelease-activation.mjs", "promotion-digest.mjs", "release-acceptance.mjs",
    "release-candidate-manifest.mjs", "release-channel.mjs", "release-diagnostic.mjs",
    "release-oauth-canary-core.mjs", "release-oauth-canary-evidence.mjs", "release-oauth-canary.mjs",
  ]) {
    if (!record.files.some((item) => item.path === `scripts/${helper}`)) throw new Error(`npm package omitted runtime canary helper ${helper}`);
  }
  for (const repositoryOnlyScript of [
    "accepted-candidate-tarball.mjs", "assert-publishable-manifest.mjs", "candidate-runtime-store.mjs",
    "check-changed.mjs", "check-plan.mjs", "check-runner.mjs",
    "commit-message-check.mjs", "consumer-package-security.mjs", "coverage-check.mjs",
    "foreground-daemon-recovery.mjs", "generate-components-doc.mjs", "generate-help-resources.mjs",
    "generate-policy-reference.mjs", "generate-tool-output-schemas.mjs",
    "generate-tool-reference.mjs", "generate-worker-types.mjs", "github-backlog.mjs", "github-push.mjs",
    "github-release-asset.mjs", "github-release.mjs", "global-package-installation.mjs",
    "install-published-prerelease.mjs", "lib/git-version.mjs", "lib/npm.mjs", "lib/release.mjs",
    "lib/trusted-github-cli.mjs", "lib/verification.mjs",
    "local-release-acceptance.mjs", "macos-background-input-smoke.mjs",
    "network-retry.mjs", "npm-publication-policy.mjs",
    "official-mcp-conformance.mjs", "persistent-activation-process.mjs", "prepare-pinned-npm.mjs",
    "privacy-check.mjs", "publish-npm.mjs", "published-release.mjs", "release-browser-extension-store.mjs",
    "release-ci.mjs", "release-impact-check.mjs", "release-publication-guard.mjs", "release-soak.mjs",
    "resolve-versioned-worktree.mjs", "run-checks.mjs", "run-worker-dry-run.mjs", "sarif-security-gate.mjs",
    "sbom-check.mjs", "start-release-candidate.mjs", "syntax-check.mjs",
    "sync-worker-version.mjs", "verification-state.mjs", "wrangler-command-lifecycle.mjs",
  ]) {
    if (record.files.some((item) => item.path === `scripts/${repositoryOnlyScript}`)) {
      throw new Error(`npm package retained repository-only development script ${repositoryOnlyScript}`);
    }
  }
  if (record.files.some((item) => item.path.startsWith("release-acceptance/") || item.path.startsWith("release-soak/") || item.path.startsWith(".release-candidate/"))) throw new Error("npm package contains local release or soak evidence");
  if (!record.files.some((item) => item.path === "src/local/runtime/runtime-activation.mjs")) throw new Error("npm package omitted persistent runtime activation orchestration");
  for (const file of ["SUPPORT.md", "docs/UPGRADING.md", "tsconfig.local.json"]) {
    if (!record.files.some((item) => item.path === file)) throw new Error(`npm package omitted ${file}`);
  }
  const badModes = record.files.filter((item) => ![0o644, 0o755].includes(Number(item.mode))).map((item) => `${item.path}:${item.mode}`);
  if (badModes.length) throw new Error(`npm package contains unexpected file modes: ${badModes.join(", ")}`);
  console.log(`npm package manifest test ok (${record.files.length} files)`);
} finally {
  rmSync(output, { recursive: true, force: true });
}

function validatePackagedMarkdownLinks(files) {
  const packaged = new Set(files.map((item) => String(item.path || "")));
  for (const item of files) {
    const packagePath = String(item.path || "");
    if (!packagePath.endsWith(".md")) continue;
    const file = join(root, packagePath);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const raw = match[1].trim();
      if (!raw || raw.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
      const targetPath = raw.split("#", 1)[0];
      if (!targetPath) continue;
      const target = relative(root, resolve(dirname(file), decodeURIComponent(targetPath))).replaceAll("\\", "/");
      if (!target || target === "." || target === ".." || target.startsWith("../")) {
        throw new Error(`npm package markdown link escapes package root in ${packagePath}: ${raw}`);
      }
      if (!packaged.has(target)) throw new Error(`npm package markdown link targets an omitted file in ${packagePath}: ${raw}`);
    }
  }
}

function normalizePackRecord(value) {
  if (Array.isArray(value)) return value[0] || null;
  if (!value || typeof value !== "object") return null;
  const preferred = value["machine-bridge-mcp"];
  if (preferred && typeof preferred === "object") return preferred;
  return Object.values(value).find((item) => item && typeof item === "object") || null;
}
