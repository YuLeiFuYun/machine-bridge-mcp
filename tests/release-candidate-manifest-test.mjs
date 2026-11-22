import assert from "node:assert/strict";
import test from "node:test";
import { assertCandidateMatchesCurrentSource, validateCandidateManifest } from "../scripts/release-candidate-manifest.mjs";

test("release candidate manifest schema rejects coerced types, extra fields, and identity drift", () => {
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
  assert.equal(Object.keys(normalized).length, 9, "candidate manifest normalization retained extra data");
  for (const field of ["package_name", "package_version", "filename", "shasum", "integrity", "promotion_content_sha256", "prepared_at"]) {
    assert.throws(
      () => validateCandidateManifest({ ...value, [field]: [value[field]] }),
      new RegExp(`${field} must be a string`),
    );
  }
  assert.throws(() => validateCandidateManifest({ ...value, local_path: "/Users/example/private" }), /unsupported fields/);
  assert.throws(() => validateCandidateManifest({ ...value, filename: "other.tgz" }), /filename is invalid/);
  assert.throws(() => validateCandidateManifest({ ...value, package_version: "3.0.0-preview.1" }), /unsupported prerelease channel/);
  assert.throws(() => validateCandidateManifest({ ...value, promotion_content_sha256: "" }), /promotion digest/);
  assertCandidateMatchesCurrentSource(normalized, {
    packageName: value.package_name, packageVersion: value.package_version, promotionDigest: value.promotion_content_sha256,
  });
  assert.throws(() => assertCandidateMatchesCurrentSource(normalized, {
    packageName: value.package_name, packageVersion: "3.0.0-beta.2", promotionDigest: value.promotion_content_sha256,
  }), /package identity/);
  assert.throws(() => assertCandidateMatchesCurrentSource(normalized, {
    packageName: value.package_name, packageVersion: value.package_version, promotionDigest: "c".repeat(64),
  }), /promotion content digest/);
});
