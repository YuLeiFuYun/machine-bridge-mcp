import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const script = join(projectRoot, "scripts", "npm-publication-policy.mjs");
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
  console.log("npm publication dist-tag policy test ok");
} finally { rmSync(root, { recursive: true, force: true }); }
function write(version) { writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version })); }
function expect(status, tag) {
  const result = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8", env: { ...process.env, npm_config_tag: tag }, windowsHide: true });
  if (result.status !== status) throw new Error(`expected ${status} for ${tag}, got ${result.status}: ${result.stderr || result.stdout}`);
}
