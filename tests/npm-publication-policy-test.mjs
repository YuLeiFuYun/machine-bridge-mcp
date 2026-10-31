import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const script = join(projectRoot, "scripts", "npm-publication-policy.mjs");
const manifestGuard = join(projectRoot, "scripts", "assert-publishable-manifest.mjs");
const root = mkdtempSync(join(tmpdir(), "mbm-npm-channel-"));
try {
  write("3.0.0-beta.1");
  expect(0, "beta");
  expect(1, "latest");
  write("3.0.0-rc.1");
  expect(0, "next");
  write("3.0.0");
  expect(0, "latest");
  expect(1, "beta");
  // A source-checkout manifest declares scripts whose files are not in the tarball, so a
  // direct `npm publish` must be refused before npm packs it.
  writeManifest({ test: "node scripts/test-entry.mjs", start: "node bin/machine-mcp.mjs start", doctor: "node bin/machine-mcp.mjs doctor", "check:fast": "node scripts/run-checks.mjs fast" });
  expectGuard(1);
  writeManifest({ test: "node scripts/test-entry.mjs", start: "node bin/machine-mcp.mjs start", doctor: "node bin/machine-mcp.mjs doctor" });
  expectGuard(0);
  console.log("npm publication dist-tag policy test ok");
} finally { rmSync(root, { recursive: true, force: true }); }
function write(version) { writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version })); }
function writeManifest(scripts) { writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", scripts })); }
function expectGuard(status) {
  const result = spawnSync(process.execPath, [manifestGuard], { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.status !== status) throw new Error(`publishable-manifest guard expected ${status}, got ${result.status}: ${result.stderr || result.stdout}`);
}
function expect(status, tag) {
  const result = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8", env: { ...process.env, npm_config_tag: tag }, windowsHide: true });
  if (result.status !== status) throw new Error(`expected ${status} for ${tag}, got ${result.status}: ${result.stderr || result.stdout}`);
}
