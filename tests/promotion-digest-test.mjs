import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { computePromotionContentDigest } from "../scripts/promotion-digest.mjs";

const root = mkdtempSync(join(tmpdir(), "mbm-promotion-digest-"));
try {
  writeVersion("3.0.0-beta.1");
  write("src/worker/index.ts", 'const SERVER_VERSION = "3.0.0-beta.1";\nexport const behavior = 1;\n');
  write("browser-extension/manifest.json", JSON.stringify({ manifest_version: 3, version: "3.0.0", version_name: "3.0.0-beta.1", name: "Fixture" }, null, 2) + "\n");
  write("CHANGELOG.md", "# Changelog\n\n## 3.0.0-beta.1 - 2026-07-21\n\n- Security architecture.\n");
  write("src/code.mjs", "export const value = 1;\n");
  const files = ["CHANGELOG.md", "browser-extension/manifest.json", "package-lock.json", "package.json", "src/code.mjs", "src/worker/index.ts"];
  const packRecord = { files: files.map((path) => ({ path, mode: 0o644 })) };
  const beta = computePromotionContentDigest(root, { packRecord });

  writeVersion("3.0.0");
  write("src/worker/index.ts", 'const SERVER_VERSION = "3.0.0";\nexport const behavior = 1;\n');
  write("browser-extension/manifest.json", JSON.stringify({ manifest_version: 3, version: "3.0.0", version_name: "3.0.0", name: "Fixture" }, null, 2) + "\n");
  write("CHANGELOG.md", "# Changelog\n\n## 3.0.0 - 2026-07-21\n\n- Security architecture.\n");
  const stable = computePromotionContentDigest(root, { packRecord });
  assert(beta === stable, "release-only metadata changed the promotion digest");

  write("src/code.mjs", "export const value = 2;\n");
  assert(computePromotionContentDigest(root, { packRecord }) !== stable, "runtime source change did not change the promotion digest");
  write("src/code.mjs", "export const value = 1;\n");
  const pkg = JSON.parse(read("package.json"));
  pkg.scripts = { unsafe: "node changed.mjs" };
  write("package.json", JSON.stringify(pkg, null, 2) + "\n");
  assert(computePromotionContentDigest(root, { packRecord }) !== stable, "non-version package metadata change did not change the promotion digest");
  write("package.json", JSON.stringify({ name: "promotion-fixture", version: "3.0.0", type: "module", files: ["src", "browser-extension", "CHANGELOG.md"] }, null, 2) + "\n");
  const executableRecord = { files: packRecord.files.map((entry) => entry.path === "src/code.mjs" ? { ...entry, mode: 0o755 } : entry) };
  assert(computePromotionContentDigest(root, { packRecord: executableRecord }) !== stable, "package file mode change did not change the promotion digest");

  console.log("stable promotion content digest test ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}

function writeVersion(version) {
  write("package.json", JSON.stringify({ name: "promotion-fixture", version, type: "module", files: ["src", "browser-extension", "CHANGELOG.md"] }, null, 2) + "\n");
  write("package-lock.json", JSON.stringify({ name: "promotion-fixture", version, lockfileVersion: 3, packages: { "": { name: "promotion-fixture", version } } }, null, 2) + "\n");
}
function write(path, content) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); }
function read(path) { return requireRead(join(root, path)); }
function requireRead(path) { return globalThis.process.getBuiltinModule("node:fs").readFileSync(path, "utf8"); }
function assert(condition, message) { if (!condition) throw new Error(message); }
