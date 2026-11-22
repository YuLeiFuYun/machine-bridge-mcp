import assert from "node:assert/strict";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { computePromotionContentDigest } from "../scripts/promotion-digest.mjs";

test("promotion content digest is invariant to release-only metadata and sensitive to shipped bytes and modes", () => {
  const root = mkdtempSync(join(tmpdir(), "mbm-promotion-digest-"));
  const write = (path, content) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };
  const writeVersion = (version) => {
    write("package.json", JSON.stringify({ name: "promotion-fixture", version, type: "module", files: ["src", "browser-extension", "CHANGELOG.md"] }, null, 2) + "\n");
    write("package-lock.json", JSON.stringify({ name: "promotion-fixture", version, lockfileVersion: 3, packages: { "": { name: "promotion-fixture", version } } }, null, 2) + "\n");
  };
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
    assert.equal(beta, stable, "release-only metadata changed the promotion digest");

    write("src/code.mjs", "export const value = 2;\n");
    assert.notEqual(computePromotionContentDigest(root, { packRecord }), stable, "runtime source change did not change the promotion digest");
    write("src/code.mjs", "export const value = 1;\n");
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    pkg.scripts = { unsafe: "node changed.mjs" };
    write("package.json", JSON.stringify(pkg, null, 2) + "\n");
    assert.equal(computePromotionContentDigest(root, { packRecord }), stable,
      "repository-only package scripts changed the published promotion digest");
    pkg.description = "published metadata changed";
    write("package.json", JSON.stringify(pkg, null, 2) + "\n");
    assert.notEqual(computePromotionContentDigest(root, { packRecord }), stable, "published package metadata change did not change the promotion digest");
    write("package.json", JSON.stringify({ name: "promotion-fixture", version: "3.0.0", type: "module", files: ["src", "browser-extension", "CHANGELOG.md"] }, null, 2) + "\n");
    const executableRecord = { files: packRecord.files.map((entry) => entry.path === "src/code.mjs" ? { ...entry, mode: 0o755 } : entry) };
    assert.notEqual(computePromotionContentDigest(root, { packRecord: executableRecord }), stable, "package file mode change did not change the promotion digest");
    assert.throws(() => computePromotionContentDigest(root, { packRecord: { files: [{ path: ["src/code.mjs"], mode: 0o644 }] } }),
      /non-string package path/, "promotion digest accepted a coercible package path");
    assert.throws(() => computePromotionContentDigest(root, { packRecord: { files: [{ path: "src/code.mjs", mode: String(0o644) }] } }),
      /invalid file mode/, "promotion digest accepted a coercible package mode");
    if (process.platform !== "win32") {
      const alias = join(root, "src", "code-alias.mjs");
      linkSync(join(root, "src", "code.mjs"), alias);
      assert.throws(() => computePromotionContentDigest(root, { packRecord }), /multiple hard links/,
        "promotion digest accepted a package file with an alternate hard-link mutation path");
      unlinkSync(alias);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
