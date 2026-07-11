import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = mkdtempSync(join(tmpdir(), "mbm-package-test-"));
try {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npm, ["pack", "--silent", "--dry-run", "--json", "--pack-destination", output], {
    cwd: root,
    encoding: "utf8",
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
    .filter((path) => /(?:^|\/)(?:\.env|\.npmrc|\.dev\.vars|\.privacy-denylist|\.wrangler|node_modules)(?:\/|$)|\.(?:pem|key|sqlite|log)$/.test(path));
  if (sensitive.length) throw new Error(`npm package contains sensitive local artifacts: ${sensitive.join(", ")}`);
  if (!record.files.some((item) => item.path === "docs/PRIVACY.md")) throw new Error("npm package omitted privacy guidance");
  if (!record.files.some((item) => item.path === "scripts/privacy-check.mjs")) throw new Error("npm package omitted the privacy checker");
  if (!record.files.some((item) => item.path === "scripts/release-impact-check.mjs")) throw new Error("npm package omitted the release-impact checker");
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
