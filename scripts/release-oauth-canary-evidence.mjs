import { join } from "node:path";
import { replaceFileAtomicallySync } from "../src/local/exclusive-file.mjs";
import { readBoundedRegularFileSync } from "../src/local/secure-file.mjs";

export const RELEASE_OAUTH_CANARY_SCHEMA_VERSION = 1;
const MAX_EVIDENCE_BYTES = 16 * 1024;
const EVIDENCE_FILENAME = "oauth-canary.json";
const FIELDS = new Set([
  "schema_version", "result", "package_name", "package_version", "shasum", "integrity",
  "promotion_content_sha256", "worker_version", "authorization_code_exchange",
  "authenticated_mcp", "refresh_rotation", "refreshed_mcp", "cleanup_completed", "completed_at",
]);

export function releaseOAuthCanaryPath(root) {
  return join(root, ".release-candidate", EVIDENCE_FILENAME);
}

export function writeReleaseOAuthCanaryEvidence(root, value) {
  const normalized = validateReleaseOAuthCanaryEvidence(value);
  const path = releaseOAuthCanaryPath(root);
  replaceFileAtomicallySync(path, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  return path;
}

export function readReleaseOAuthCanaryEvidence(root, expected = {}) {
  const path = releaseOAuthCanaryPath(root);
  let bytes;
  try {
    bytes = readBoundedRegularFileSync(path, MAX_EVIDENCE_BYTES, "release OAuth canary evidence", {
      verifyPathIdentity: true,
      rejectMultipleLinks: true,
    });
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error("release OAuth canary evidence is missing; run the deployed OAuth canary before acceptance", { cause: error });
    throw new Error("release OAuth canary evidence is unavailable", { cause: error });
  }
  let parsed;
  try { parsed = JSON.parse(bytes.toString("utf8")); }
  catch (error) { throw new Error("release OAuth canary evidence is invalid JSON", { cause: error }); }
  const evidence = validateReleaseOAuthCanaryEvidence(parsed);
  for (const [field, value] of Object.entries(expected)) {
    if (value !== undefined && evidence[field] !== value) {
      throw new Error(`release OAuth canary evidence does not match the candidate: ${field}`);
    }
  }
  return evidence;
}

export function validateReleaseOAuthCanaryEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("release OAuth canary evidence must be an object");
  }
  const unknown = Object.keys(value).filter((key) => !FIELDS.has(key));
  if (unknown.length) throw new Error(`release OAuth canary evidence contains unsupported fields: ${unknown.join(", ")}`);
  if (value.schema_version !== RELEASE_OAUTH_CANARY_SCHEMA_VERSION || value.result !== "passed") {
    throw new Error("release OAuth canary evidence is not passed current-schema state");
  }
  if (value.package_name !== "machine-bridge-mcp") throw new Error("release OAuth canary package name is invalid");
  const packageVersion = boundedString(value.package_version, 128, "package version");
  const workerVersion = boundedString(value.worker_version, 128, "Worker version");
  if (workerVersion !== packageVersion) throw new Error("release OAuth canary Worker version does not match the package");
  if (!/^[0-9a-f]{40}$/.test(String(value.shasum || ""))) throw new Error("release OAuth canary SHA-1 is invalid");
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(String(value.integrity || ""))) {
    throw new Error("release OAuth canary integrity is invalid");
  }
  if (!/^[0-9a-f]{64}$/.test(String(value.promotion_content_sha256 || ""))) {
    throw new Error("release OAuth canary promotion digest is invalid");
  }
  for (const field of [
    "authorization_code_exchange", "authenticated_mcp", "refresh_rotation", "refreshed_mcp", "cleanup_completed",
  ]) {
    if (value[field] !== true) throw new Error(`release OAuth canary required check did not pass: ${field}`);
  }
  const completedAt = Date.parse(String(value.completed_at || ""));
  if (!Number.isFinite(completedAt)) throw new Error("release OAuth canary completion timestamp is invalid");
  return Object.freeze({
    schema_version: RELEASE_OAUTH_CANARY_SCHEMA_VERSION,
    result: "passed",
    package_name: value.package_name,
    package_version: packageVersion,
    shasum: String(value.shasum),
    integrity: String(value.integrity),
    promotion_content_sha256: String(value.promotion_content_sha256),
    worker_version: workerVersion,
    authorization_code_exchange: true,
    authenticated_mcp: true,
    refresh_rotation: true,
    refreshed_mcp: true,
    cleanup_completed: true,
    completed_at: new Date(completedAt).toISOString(),
  });
}

function boundedString(value, maximum, label) {
  const text = String(value || "");
  if (!text || text.length > maximum || /[\r\n\t\u0000-\u001f\u007f]/.test(text)) {
    throw new Error(`release OAuth canary ${label} is invalid`);
  }
  return text;
}
