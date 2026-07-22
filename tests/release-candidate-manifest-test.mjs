import { validateCandidateManifest } from "../scripts/release-candidate-manifest.mjs";
const value = {
  schema_version: 1,
  result: "pending",
  package_name: "machine-bridge-mcp",
  package_version: "3.0.0-beta.1",
  filename: "machine-bridge-mcp-3.0.0-beta.1.tgz",
  shasum: "a".repeat(40),
  integrity: `sha512-${Buffer.alloc(64, 4).toString("base64")}`,
  promotion_content_sha256: "b".repeat(64),
  prepared_at: "2026-07-21T12:00:00.000Z",
};
const normalized = validateCandidateManifest(value, { packageName: value.package_name, packageVersion: value.package_version });
assert(Object.keys(normalized).length === 9, "candidate manifest normalization retained extra data");
expectThrow(() => validateCandidateManifest({ ...value, local_path: "/Users/example/private" }), "unsupported fields");
expectThrow(() => validateCandidateManifest({ ...value, filename: "other.tgz" }), "filename is invalid");
expectThrow(() => validateCandidateManifest({ ...value, package_version: "3.0.0-preview.1" }), "unsupported prerelease channel");
expectThrow(() => validateCandidateManifest({ ...value, promotion_content_sha256: "" }), "promotion digest");
console.log("release candidate manifest schema test ok");
function expectThrow(callback, expected) { try { callback(); } catch (error) { if (String(error?.message || error).includes(expected)) return; throw error; } throw new Error(`expected throw containing: ${expected}`); }
function assert(condition, message) { if (!condition) throw new Error(message); }
