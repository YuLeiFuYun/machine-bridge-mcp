import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = mkdtempSync(join(tmpdir(), "mbm-package-test-"));
try {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("package test must run through an npm lifecycle so npm_execpath is available");
  const result = spawnSync(process.execPath, [npmCli, "pack", "--silent", "--dry-run", "--json", "--pack-destination", output], {
    cwd: root,
    encoding: "utf8",
    env: process.env,
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
  if (!record.files.some((item) => item.path === "src/local/relay-connection.mjs")) throw new Error("npm package omitted the relay lifecycle module");
  if (!record.files.some((item) => item.path === "src/local/runtime.mjs")) throw new Error("npm package omitted the local runtime module");
  if (!record.files.some((item) => item.path === "src/local/agent-context.mjs")) throw new Error("npm package omitted the agent-context module");
  if (!record.files.some((item) => item.path === "src/local/default-instructions.mjs")) throw new Error("npm package omitted the default-instructions module");
  if (!record.files.some((item) => item.path === "src/local/daemon-process.mjs")) throw new Error("npm package omitted the daemon-process module");
  if (!record.files.some((item) => item.path === "src/local/app-automation.mjs")) throw new Error("npm package omitted the application-automation module");
  if (!record.files.some((item) => item.path === "src/local/browser-bridge.mjs")) throw new Error("npm package omitted the browser-bridge module");
  if (!record.files.some((item) => item.path === "browser-extension/manifest.json")) throw new Error("npm package omitted the browser extension manifest");
  if (!record.files.some((item) => item.path === "browser-extension/service-worker.js")) throw new Error("npm package omitted the browser extension service worker");
  if (!record.files.some((item) => item.path === "browser-extension/page-automation.js")) throw new Error("npm package omitted the browser page automation module");
  if (!record.files.some((item) => item.path === "docs/LOCAL_AUTOMATION.md")) throw new Error("npm package omitted local-automation guidance");
  if (!record.files.some((item) => item.path === "src/local/secure-file.mjs")) throw new Error("npm package omitted the shared secure-file primitive");
  if (record.files.some((item) => item.path === "src/local/daemon.mjs")) throw new Error("npm package retained the obsolete local daemon module name");
  if (!record.files.some((item) => item.path === "scripts/privacy-check.mjs")) throw new Error("npm package omitted the privacy checker");
  if (!record.files.some((item) => item.path === "scripts/release-impact-check.mjs")) throw new Error("npm package omitted the release-impact checker");
  if (!record.files.some((item) => item.path === "scripts/network-retry.mjs")) throw new Error("npm package omitted the network retry helper");
  if (!record.files.some((item) => item.path === "CONTRIBUTING.md")) throw new Error("npm package omitted contribution/release discipline");
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
