import { parseReleaseVersion } from "./release-channel.mjs";

export const CANDIDATE_MANIFEST_SCHEMA_VERSION = 1;
const FIELDS = new Set([
  "schema_version", "result", "package_name", "package_version", "filename", "shasum", "integrity",
  "promotion_content_sha256", "prepared_at",
]);

export function validateCandidateManifest(value, expected = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("release candidate manifest must be an object");
  const unknown = Object.keys(value).filter((key) => !FIELDS.has(key));
  if (unknown.length) throw new Error(`release candidate manifest contains unsupported fields: ${unknown.join(", ")}`);
  if (value.schema_version !== CANDIDATE_MANIFEST_SCHEMA_VERSION || value.result !== "pending") {
    throw new Error("release candidate manifest is not pending current-schema state");
  }
  const version = parseReleaseVersion(value.package_version).raw;
  const packageName = String(value.package_name || "");
  if (packageName !== "machine-bridge-mcp") throw new Error("release candidate manifest package is invalid");
  if (expected.packageName && packageName !== expected.packageName) throw new Error("release candidate manifest package does not match the current package");
  if (expected.packageVersion && version !== expected.packageVersion) throw new Error("release candidate manifest version does not match the current package");
  const filename = String(value.filename || "");
  const expectedFilename = `${packageName}-${version}.tgz`;
  if (filename !== expectedFilename) throw new Error(`release candidate manifest filename is invalid; expected ${expectedFilename}`);
  if (!/^[0-9a-f]{40}$/.test(String(value.shasum || ""))) throw new Error("release candidate manifest SHA-1 is invalid");
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(String(value.integrity || ""))) throw new Error("release candidate manifest integrity is invalid");
  if (!/^[0-9a-f]{64}$/.test(String(value.promotion_content_sha256 || ""))) throw new Error("release candidate promotion digest is invalid");
  const preparedAt = Date.parse(String(value.prepared_at || ""));
  if (!Number.isFinite(preparedAt)) throw new Error("release candidate preparation timestamp is invalid");
  return Object.freeze({
    schema_version: CANDIDATE_MANIFEST_SCHEMA_VERSION,
    result: "pending",
    package_name: packageName,
    package_version: version,
    filename,
    shasum: String(value.shasum),
    integrity: String(value.integrity),
    promotion_content_sha256: String(value.promotion_content_sha256),
    prepared_at: new Date(preparedAt).toISOString(),
  });
}

export function assertCandidateMatchesCurrentSource(manifest, current) {
  const packageName = String(current?.packageName || "");
  const packageVersion = String(current?.packageVersion || "");
  const promotionDigest = String(current?.promotionDigest || "");
  if (manifest.package_name !== packageName || manifest.package_version !== packageVersion) {
    throw new Error("release candidate is stale: package identity no longer matches the current source");
  }
  if (!/^[0-9a-f]{64}$/.test(promotionDigest) || manifest.promotion_content_sha256 !== promotionDigest) {
    throw new Error("release candidate is stale: promotion content digest no longer matches the current source");
  }
}
