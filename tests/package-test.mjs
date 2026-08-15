import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nestedNpmEnvironment } from "../src/local/npm-environment.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
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
  const sensitive = record.files
    .map((item) => String(item.path || ""))
    .filter((path) => /(?:^|\/)(?:\.env|\.npmrc|\.dev\.vars|\.privacy-denylist|\.project-local|\.wrangler|node_modules)(?:\/|$)|\.(?:pem|key|sqlite|log)$/.test(path));
  if (sensitive.length) throw new Error(`npm package contains sensitive local artifacts: ${sensitive.join(", ")}`);
  if (!record.files.some((item) => item.path === "docs/PRIVACY.md")) throw new Error("npm package omitted privacy guidance");
  if (!record.files.some((item) => item.path === "docs/ENGINEERING.md")) throw new Error("npm package omitted engineering invariants");
  if (!record.files.some((item) => item.path === "docs/AUDIT.md")) throw new Error("npm package omitted the engineering/security audit record");
  if (!record.files.some((item) => item.path === "src/local/relay-connection.mjs")) throw new Error("npm package omitted the relay lifecycle module");
  for (const file of [
    "src/local/hardened-npm.mjs",
    "src/local/hardened-npm-download.mjs",
    "src/local/hardened-npm-download-timeout.mjs",
    "src/local/hardened-npm-extract.mjs",
    "src/local/hardened-npm-verification.mjs",
    "src/local/npm-environment.mjs",
    "src/local/private-toolchain-integrity.mjs",
    "src/local/wrangler-toolchain.mjs",
    "src/local/wrangler-toolchain-verification.mjs",
    "src/local/wrangler-toolchain/package.json",
    "src/local/wrangler-toolchain/package-lock.json",
    "scripts/accepted-candidate-tarball.mjs",
    "scripts/consumer-package-security.mjs",
    "scripts/global-package-installation.mjs",
    "scripts/hardened-npm-session.mjs",
    "scripts/npm-global-prefix.mjs",
    "scripts/release-diagnostic.mjs",
  ]) {
    if (!record.files.some((item) => item.path === file)) throw new Error(`npm package omitted ${file}`);
  }
  if (Object.hasOwn(packageJson.dependencies || {}, "wrangler") || packageJson.devDependencies?.wrangler !== "4.120.0") {
    throw new Error("Wrangler must remain a development dependency backed by the packaged private toolchain lock");
  }
  if (!record.files.some((item) => item.path === "src/local/runtime.mjs")) throw new Error("npm package omitted the local runtime module");
  for (const module of [
    "runtime-reporting.mjs", "runtime-info-projection.mjs", "runtime-diagnostics.mjs", "runtime-capabilities.mjs", "execution-routing.mjs",
    "runtime-tool-handlers.mjs", "runtime-relay.mjs", "runtime-paths.mjs", "runtime-resource-service.mjs",
    "file-mutation-coordinator.mjs", "filesystem-identity.mjs", "workspace-file-transaction.mjs", "relay-connection-classification.mjs",
  ]) {
    if (!record.files.some((item) => item.path === `src/local/${module}`)) throw new Error(`npm package omitted extracted runtime boundary ${module}`);
  }
  if (!record.files.some((item) => item.path === "src/local/agent-context.mjs")) throw new Error("npm package omitted the agent-context module");
  for (const module of ["agent-context-projection.mjs", "agent-skill-discovery.mjs", "agent-text-file.mjs"]) {
    if (!record.files.some((item) => item.path === `src/local/${module}`)) throw new Error(`npm package omitted extracted Agent boundary ${module}`);
  }
  if (!record.files.some((item) => item.path === "src/local/agent-contract.mjs")) throw new Error("npm package omitted the agent contract module");
  if (!record.files.some((item) => item.path === "src/local/default-instructions.mjs")) throw new Error("npm package omitted the default-instructions module");
  if (!record.files.some((item) => item.path === "src/local/daemon-process.mjs")) throw new Error("npm package omitted the daemon-process module");
  if (!record.files.some((item) => item.path === "src/local/process-identity.mjs")) throw new Error("npm package omitted the process-identity module");
  if (!record.files.some((item) => item.path === "src/local/exclusive-file.mjs")) throw new Error("npm package omitted the atomic exclusive-file module");
  if (!record.files.some((item) => item.path === "src/local/service-lifecycle.mjs")) throw new Error("npm package omitted the service-lifecycle module");
  if (!record.files.some((item) => item.path === "src/local/app-automation.mjs")) throw new Error("npm package omitted the application-automation module");
  if (!record.files.some((item) => item.path === "src/local/browser-bridge.mjs")) throw new Error("npm package omitted the browser-bridge module");
  for (const module of [
    "browser-request-registry.mjs", "browser-bridge-http.mjs", "browser-broker-routes.mjs", "browser-broker-server.mjs", "windows-launcher.mjs",
    "managed-job-lock.mjs", "managed-job-projection.mjs", "managed-job-storage.mjs", "managed-job-runner.mjs",
    "managed-job-cancellation.mjs", "managed-job-directory.mjs",
  ]) {
    if (!record.files.some((item) => item.path === `src/local/${module}`)) throw new Error(`npm package omitted extracted local boundary ${module}`);
  }
  if (!record.files.some((item) => item.path === "src/local/browser-operation-service.mjs")) throw new Error("npm package omitted browser operation semantics");
  if (!record.files.some((item) => item.path === "src/worker/index.ts")) throw new Error("npm package omitted the worker entrypoint");
  for (const module of [
    "mcp-jsonrpc.ts", "websocket-protocol.ts", "mcp-http-contract.ts", "mcp-controller.ts",
    "mcp-response-proxy.ts", "mcp-response-stream.ts", "mcp-http-accept.ts", "mcp-stream-proxy-contract.ts", "mcp-removed-protocol.ts",
    "mcp-tool-call-input.ts", "worker-mcp-config.ts", "worker-runtime-config.ts", "server-info.ts", "daemon-status.ts",
  ]) {
    if (!record.files.some((item) => item.path === `src/worker/${module}`)) throw new Error(`npm package omitted extracted Worker protocol ${module}`);
  }
  for (const module of [
    "mcp-protocol.mjs", "mcp-protocol.d.mts",
    "tool-argument-validation.mjs", "tool-argument-validation.d.mts",
  ]) {
    if (!record.files.some((item) => item.path === `src/shared/${module}`)) throw new Error(`npm package omitted shared MCP contract ${module}`);
  }
  if (!record.files.some((item) => item.path === "src/shared/activation-recovery.mjs")) {
    throw new Error("npm package omitted shared activation recovery evidence contract");
  }
  if (!record.files.some((item) => item.path === "src/worker/pending-calls.ts")) throw new Error("npm package omitted the worker pending calls module");
  if (!record.files.some((item) => item.path === "src/worker/daemon-liveness.ts")) throw new Error("npm package omitted the worker daemon liveness module");
  if (!record.files.some((item) => item.path === "src/worker/policy.ts")) throw new Error("npm package omitted the worker policy module");
  if (!record.files.some((item) => item.path === "src/worker/errors.ts")) throw new Error("npm package omitted the worker errors module");
  if (!record.files.some((item) => item.path === "src/worker/oauth-state.ts")) throw new Error("npm package omitted the worker oauth state module");
  if (!record.files.some((item) => item.path === "src/worker/oauth-controller.ts")) throw new Error("npm package omitted the Worker OAuth controller");
  if (!record.files.some((item) => item.path === "src/worker/oauth-authorization-page.ts")) throw new Error("npm package omitted the Worker OAuth authorization page module");
  if (!record.files.some((item) => item.path === "src/worker/observability.ts")) throw new Error("npm package omitted the worker observability module");
  if (!record.files.some((item) => item.path === "src/worker/http.ts")) throw new Error("npm package omitted the worker http module");
  if (record.files.some((item) => item.path.endsWith("worker-configuration.d.ts"))) throw new Error("npm package contains generated Worker type declarations");
  if (!record.files.some((item) => item.path === "browser-extension/manifest.json")) throw new Error("npm package omitted the browser extension manifest");
  if (!record.files.some((item) => item.path === "browser-extension/service-worker.js")) throw new Error("npm package omitted the browser extension service worker");
  if (!record.files.some((item) => item.path === "browser-extension/broker-auth.js")) throw new Error("npm package omitted the browser extension broker authentication module");
  if (!record.files.some((item) => item.path === "browser-extension/pairing-bootstrap.js")) throw new Error("npm package omitted the browser extension pairing bootstrap module");
  if (!record.files.some((item) => item.path === "browser-extension/pairing.js")) throw new Error("npm package omitted the browser extension pairing content script");
  if (!record.files.some((item) => item.path === "browser-extension/page-automation.js")) throw new Error("npm package omitted the browser page automation module");
  if (!record.files.some((item) => item.path === "docs/LOCAL_AUTOMATION.md")) throw new Error("npm package omitted local-automation guidance");
  if (!record.files.some((item) => item.path === "src/local/secure-file.mjs")) throw new Error("npm package omitted the shared secure-file primitive");
  if (!record.files.some((item) => item.path === "src/local/service-definition.mjs")) throw new Error("npm package omitted identity-bound service-definition cleanup");
  if (record.files.some((item) => item.path === "src/local/daemon.mjs")) throw new Error("npm package retained the obsolete local daemon module name");
  if (!record.files.some((item) => item.path === "scripts/privacy-check.mjs")) throw new Error("npm package omitted the privacy checker");
  if (!record.files.some((item) => item.path === "scripts/sbom-check.mjs")) throw new Error("npm package omitted the SBOM validator");
  if (!record.files.some((item) => item.path === "scripts/release-impact-check.mjs")) throw new Error("npm package omitted the release-impact checker");
  if (!record.files.some((item) => item.path === "scripts/start-release-candidate.mjs")) throw new Error("npm package omitted the isolated candidate startup helper");
  if (!record.files.some((item) => item.path === "scripts/network-retry.mjs")) throw new Error("npm package omitted the network retry helper");
  if (!record.files.some((item) => item.path === "scripts/syntax-check.mjs")) throw new Error("npm package omitted the dynamic syntax checker");
  if (!record.files.some((item) => item.path === "scripts/github-release.mjs")) throw new Error("npm package omitted the release helper referenced by package scripts");
  if (!record.files.some((item) => item.path === "scripts/release-publication-guard.mjs")) throw new Error("npm package omitted the GitHub publication ownership guard");
  for (const helper of ["release-acceptance.mjs", "local-release-acceptance.mjs", "github-push.mjs", "release-channel.mjs", "release-candidate-manifest.mjs", "promotion-digest.mjs", "prerelease-activation.mjs", "release-soak.mjs", "published-release.mjs", "npm-publication-policy.mjs", "publish-npm.mjs", "install-published-prerelease.mjs", "candidate-runtime-store.mjs"]) {
    if (!record.files.some((item) => item.path === `scripts/${helper}`)) throw new Error(`npm package omitted release gate helper ${helper}`);
  }
  if (record.files.some((item) => item.path.startsWith("release-acceptance/") || item.path.startsWith("release-soak/") || item.path.startsWith(".release-candidate/"))) throw new Error("npm package contains local release or soak evidence");
  if (!record.files.some((item) => item.path === "src/local/runtime-activation.mjs")) throw new Error("npm package omitted persistent runtime activation orchestration");
  if (!record.files.some((item) => item.path === "CONTRIBUTING.md")) throw new Error("npm package omitted contribution/release discipline");
  for (const file of ["CODE_OF_CONDUCT.md", "SUPPORT.md", "GOVERNANCE.md", "docs/UPGRADING.md", "tsconfig.local.json"]) {
    if (!record.files.some((item) => item.path === file)) throw new Error(`npm package omitted ${file}`);
  }
  const badModes = record.files.filter((item) => ![0o644, 0o755].includes(Number(item.mode))).map((item) => `${item.path}:${item.mode}`);
  if (badModes.length) throw new Error(`npm package contains unexpected file modes: ${badModes.join(", ")}`);
  console.log(`npm package manifest test ok (${record.files.length} files)`);
} finally {
  rmSync(output, { recursive: true, force: true });
}

function normalizePackRecord(value) {
  if (Array.isArray(value)) return value[0] || null;
  if (!value || typeof value !== "object") return null;
  const preferred = value["machine-bridge-mcp"];
  if (preferred && typeof preferred === "object") return preferred;
  return Object.values(value).find((item) => item && typeof item === "object") || null;
}
