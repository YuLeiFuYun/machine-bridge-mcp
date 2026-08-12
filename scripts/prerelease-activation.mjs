import { dirname, isAbsolute, join, resolve } from "node:path";
import { defaultStateRoot, expandHome } from "../src/local/state.mjs";
import { replaceFileAtomicallySync } from "../src/local/exclusive-file.mjs";
import { ensureOwnerOnlyDirectorySync, readBoundedRegularFileSync } from "../src/local/secure-file.mjs";
import { assertSoakEligiblePrerelease } from "./release-channel.mjs";

export const ACTIVATION_SCHEMA_VERSION = 2;
const MAX_ACTIVATION_BYTES = 64 * 1024;
const SOURCES = new Set(["local-candidate", "npm-prerelease"]);
const ACTIVATION_FIELDS = new Set([
  "schema_version", "package_name", "package_version", "source", "shasum", "integrity",
  "promotion_content_sha256", "activated_at", "npm_dist_tag", "published_at", "workspace_hash",
  "runtime_entry", "activation_recovered", "activation_recovery_reason", "activation_recovery_detail",
  "global_package_rollback_baseline",
]);

export function prereleaseActivationPath(version, stateRoot = defaultStateRoot()) {
  const parsed = assertSoakEligiblePrerelease(version);
  return join(resolve(expandHome(stateRoot)), "release-channels", "activations", `v${parsed.raw}.json`);
}

export function writePrereleaseActivation(record, stateRoot = defaultStateRoot()) {
  const normalized = validatePrereleaseActivation(record);
  const file = prereleaseActivationPath(normalized.package_version, stateRoot);
  ensureOwnerOnlyDirectorySync(dirname(file));
  replaceFileAtomicallySync(file, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  return file;
}

export function readPrereleaseActivation(version, stateRoot = defaultStateRoot(), options = {}) {
  const file = prereleaseActivationPath(version, stateRoot);
  const readRecord = options.readBoundedRegularFileSync || readBoundedRegularFileSync;
  let bytes;
  try {
    bytes = readRecord(file, MAX_ACTIVATION_BYTES, "prerelease activation record", {
      verifyPathIdentity: true,
      rejectMultipleLinks: true,
    });
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`prerelease activation record is missing: ${file}`, { cause: error });
    throw new Error("prerelease activation record is unavailable", { cause: error });
  }
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch (error) { throw new Error("prerelease activation record is invalid", { cause: error }); }
  return validatePrereleaseActivation(value);
}

export function validatePrereleaseActivation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("prerelease activation record must be an object");
  const unknown = Object.keys(value).filter((key) => !ACTIVATION_FIELDS.has(key));
  if (unknown.length) throw new Error(`prerelease activation record contains unsupported fields: ${unknown.join(", ")}`);
  const schemaVersion = value.schema_version;
  if (schemaVersion !== ACTIVATION_SCHEMA_VERSION) {
    throw new Error("unsupported prerelease activation schema");
  }
  const parsed = assertSoakEligiblePrerelease(value.package_version);
  if (value.package_name !== "machine-bridge-mcp") throw new Error("prerelease activation package name is invalid");
  if (!SOURCES.has(value.source)) throw new Error("prerelease activation source is invalid");
  if (!/^[0-9a-f]{40}$/.test(String(value.shasum || ""))) throw new Error("prerelease activation SHA-1 is invalid");
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(String(value.integrity || ""))) throw new Error("prerelease activation integrity is invalid");
  if (!/^[0-9a-f]{64}$/.test(String(value.promotion_content_sha256 || ""))) throw new Error("prerelease activation promotion digest is invalid");
  const activatedAt = Date.parse(String(value.activated_at || ""));
  if (!Number.isFinite(activatedAt)) throw new Error("prerelease activation timestamp is invalid");
  if (value.source === "npm-prerelease") {
    if (value.npm_dist_tag !== parsed.npmTag) throw new Error("prerelease activation npm dist-tag is invalid");
    const publishedAt = Date.parse(String(value.published_at || ""));
    if (!Number.isFinite(publishedAt) || publishedAt > activatedAt + 5 * 60 * 1000) throw new Error("prerelease activation publication timestamp is invalid");
  }
  const workspaceHash = String(value.workspace_hash || "");
  if (workspaceHash && !/^[0-9a-f]{24}$/.test(workspaceHash)) throw new Error("prerelease activation workspace hash is invalid");
  const runtimeEntry = String(value.runtime_entry || "");
  if (runtimeEntry && !isAbsolute(runtimeEntry)) throw new Error("prerelease activation runtime entry must be absolute");
  const activationRecovery = normalizeActivationRecovery(value);
  const globalPackageRollbackBaseline = value.global_package_rollback_baseline === undefined
    ? undefined
    : validateGlobalPackageRollbackBaseline(value.global_package_rollback_baseline);
  return Object.freeze({
    schema_version: ACTIVATION_SCHEMA_VERSION,
    package_name: value.package_name,
    package_version: parsed.raw,
    source: value.source,
    shasum: value.shasum,
    integrity: value.integrity,
    promotion_content_sha256: value.promotion_content_sha256,
    activated_at: new Date(activatedAt).toISOString(),
    ...(value.source === "npm-prerelease" ? {
      npm_dist_tag: value.npm_dist_tag,
      published_at: new Date(Date.parse(value.published_at)).toISOString(),
    } : {}),
    ...(workspaceHash ? { workspace_hash: workspaceHash } : {}),
    ...(runtimeEntry ? { runtime_entry: runtimeEntry } : {}),
    ...activationRecovery,
    ...(globalPackageRollbackBaseline ? { global_package_rollback_baseline: globalPackageRollbackBaseline } : {}),
  });
}

function normalizeActivationRecovery(value) {
  const recovered = value.activation_recovered === true;
  if (value.activation_recovered !== undefined && typeof value.activation_recovered !== "boolean") {
    throw new Error("prerelease activation recovery flag is invalid");
  }
  const reason = String(value.activation_recovery_reason || "");
  const detail = String(value.activation_recovery_detail || "");
  if (!recovered) {
    if (reason || detail) throw new Error("prerelease activation recovery metadata requires a recovered activation");
    return Object.freeze({});
  }
  if (!/^[a-z0-9_]{1,80}$/.test(reason)) {
    throw new Error("prerelease activation recovery reason is invalid");
  }
  if (!detail || detail.length > 600 || /[\r\n\t]/.test(detail)) {
    throw new Error("prerelease activation recovery detail is invalid");
  }
  return Object.freeze({
    activation_recovered: true,
    activation_recovery_reason: reason,
    activation_recovery_detail: detail,
  });
}

function validateGlobalPackageRollbackBaseline(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("prerelease activation global package rollback baseline is invalid");
  }
  const version = String(value.version || "");
  const entry = String(value.entry || "");
  if (!version || !entry || !isAbsolute(entry)) {
    throw new Error("prerelease activation global package rollback baseline is invalid");
  }
  return Object.freeze({ version, entry });
}
