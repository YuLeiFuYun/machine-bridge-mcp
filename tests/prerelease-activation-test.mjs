import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPrereleaseActivation, validatePrereleaseActivation, writePrereleaseActivation } from "../scripts/prerelease-activation.mjs";

const root = mkdtempSync(join(tmpdir(), "mbm-prerelease-activation-"));
try {
  const base = {
    schema_version: 1,
    package_name: "machine-bridge-mcp",
    package_version: "3.0.0-beta.1",
    source: "local-candidate",
    shasum: "a".repeat(40),
    integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
    promotion_content_sha256: "b".repeat(64),
    activated_at: "2026-07-21T12:00:00.000Z",
    workspace_hash: "c".repeat(24),
  };
  const file = writePrereleaseActivation(base, root);
  assert(file.endsWith("v3.0.0-beta.1.json"), "activation path did not include the exact version");
  assert(readPrereleaseActivation("3.0.0-beta.1", root).workspace_hash === "c".repeat(24), "activation record did not round-trip");
  validatePrereleaseActivation({
    ...base,
    source: "npm-prerelease",
    npm_dist_tag: "beta",
    published_at: "2026-07-21T11:00:00.000Z",
  });
  expectThrow(() => validatePrereleaseActivation({ ...base, package_version: "3.0.0-dev.1" }), "beta or rc");
  expectThrow(() => validatePrereleaseActivation({ ...base, source: "npm-prerelease", npm_dist_tag: "latest", published_at: "2026-07-21T11:00:00.000Z" }), "dist-tag");
  expectThrow(() => validatePrereleaseActivation({ ...base, integrity: "bad" }), "integrity");
  console.log("prerelease activation state test ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}
function expectThrow(callback, expected) { try { callback(); } catch (error) { if (String(error?.message || error).includes(expected)) return; throw error; } throw new Error(`expected throw containing: ${expected}`); }
function assert(condition, message) { if (!condition) throw new Error(message); }
