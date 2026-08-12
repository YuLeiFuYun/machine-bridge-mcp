import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureCoverageGeneration } from "../scripts/coverage-generation.mjs";

const root = mkdtempSync(join(tmpdir(), "mbm-coverage-generation-"));
try {
  mkdirSync(join(root, "src"));
  const source = join(root, "src", "module.mjs");
  writeFileSync(source, "export const value = 1;\n", { mode: 0o644 });
  const options = { roots: ["src"], files: [] };
  const baseline = captureCoverageGeneration(root, options);
  assert.equal(captureCoverageGeneration(root, options), baseline, "stable generation hash changed without filesystem drift");

  writeFileSync(source, "export const value = 2;\n", { mode: 0o644 });
  const contentChanged = captureCoverageGeneration(root, options);
  assert.notEqual(contentChanged, baseline, "content drift was absent from coverage generation identity");

  writeFileSync(source, "export const value = 1;\n", { mode: 0o644 });
  chmodSync(source, 0o600);
  const modeChanged = captureCoverageGeneration(root, options);
  assert.notEqual(modeChanged, baseline, "POSIX mode drift was absent from coverage generation identity");

  chmodSync(source, 0o644);
  symlinkSync("module.mjs", join(root, "src", "alias.mjs"));
  assert.notEqual(captureCoverageGeneration(root, options), baseline, "symlink topology was absent from coverage generation identity");
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("coverage generation test ok");
