import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { captureCoverageGeneration } from "./coverage-generation.mjs";
import { replaceFileAtomicallySync } from "../src/local/exclusive-file.mjs";
import { readBoundedRegularFileWithInfoSync } from "../src/local/secure-file.mjs";

const RECEIPT_SCHEMA_VERSION = 1;
const RECEIPT_MAX_BYTES = 16 * 1024;
export const FULL_VERIFICATION_RECEIPT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

const VERIFICATION_RUN_GENERATION_OPTIONS = {
  roots: ["src", "scripts", "tests", "browser-extension", ".github", "docs", "bin", "native", "release-acceptance", ".release-candidate"],
  files: [
    "package.json", "package-lock.json", "tsconfig.json", "tsconfig.local.json", "wrangler.jsonc", "eslint.config.mjs",
    ".npmrc", ".node-version", ".nvmrc", ".gitattributes", ".gitignore", ".privacy-denylist", ".privacy-denylist.example",
    "mbm", "mbm.cmd", "README.md", "CHANGELOG.md", "CONTRIBUTING.md", "SECURITY.md", "LICENSE",
    "CODE_OF_CONDUCT.md", "GOVERNANCE.md", "SUPPORT.md", "AGENTS.md",
  ],
};

const VERIFIED_SOURCE_GENERATION_OPTIONS = {
  ...VERIFICATION_RUN_GENERATION_OPTIONS,
  roots: VERIFICATION_RUN_GENERATION_OPTIONS.roots.filter((name) => name !== ".release-candidate"),
};

export function captureVerificationRunGeneration(root) {
  return captureCoverageGeneration(root, VERIFICATION_RUN_GENERATION_OPTIONS);
}

export function captureVerifiedSourceGeneration(root) {
  return captureCoverageGeneration(root, VERIFIED_SOURCE_GENERATION_OPTIONS);
}

export function fullVerificationReceiptPath(root) {
  return join(root, ".project-local", "full-verification.json");
}

export function clearFullVerificationReceipt(root) {
  rmSync(fullVerificationReceiptPath(root), { force: true });
}

export function writeFullVerificationReceipt(root, generation, options = {}) {
  if (!/^[0-9a-f]{64}$/.test(String(generation || ""))) throw new TypeError("full verification generation must be a SHA-256 digest");
  const pkg = readPackage(root);
  const verifiedAtMs = Number(options.now ?? Date.now());
  if (!Number.isFinite(verifiedAtMs)) throw new TypeError("full verification receipt timestamp must be finite");
  const receipt = {
    schema_version: RECEIPT_SCHEMA_VERSION,
    mode: "full",
    generation_sha256: generation,
    package_name: pkg.name,
    package_version: pkg.version,
    node_version: process.version,
    platform: process.platform,
    arch: process.arch,
    verified_at: new Date(verifiedAtMs).toISOString(),
  };
  const path = fullVerificationReceiptPath(root);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  replaceFileAtomicallySync(path, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  return receipt;
}

export function assertFreshFullVerificationReceipt(root, options = {}) {
  const path = fullVerificationReceiptPath(root);
  let receipt;
  try {
    const snapshot = readBoundedRegularFileWithInfoSync(path, RECEIPT_MAX_BYTES, "full verification receipt", {
      verifyPathIdentity: true,
      rejectMultipleLinks: true,
    });
    receipt = JSON.parse(snapshot.buffer.toString("utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw staleReceiptError("full verification receipt is missing");
    throw staleReceiptError(`full verification receipt is unreadable or invalid: ${error.message}`);
  }
  const pkg = readPackage(root);
  const generation = (options.captureGeneration || captureVerifiedSourceGeneration)(root);
  const now = Number(options.now ?? Date.now());
  const verifiedAt = Date.parse(String(receipt?.verified_at || ""));
  const maximumAgeMs = Number(options.maximumAgeMs ?? FULL_VERIFICATION_RECEIPT_MAX_AGE_MS);
  const valid = receipt?.schema_version === RECEIPT_SCHEMA_VERSION
    && receipt?.mode === "full"
    && receipt?.generation_sha256 === generation
    && receipt?.package_name === pkg.name
    && receipt?.package_version === pkg.version
    && receipt?.node_version === process.version
    && receipt?.platform === process.platform
    && receipt?.arch === process.arch
    && Number.isFinite(verifiedAt)
    && Number.isFinite(now)
    && Number.isFinite(maximumAgeMs)
    && maximumAgeMs >= 0
    && now >= verifiedAt
    && now - verifiedAt <= maximumAgeMs;
  if (!valid) throw staleReceiptError("full verification receipt does not match the current source, runtime, or freshness window");
  return receipt;
}

function readPackage(root) {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
}

function staleReceiptError(reason) {
  const error = new Error(`${reason}; run npm run check:full on the frozen tree before release:candidate`);
  error.code = "MBM_FULL_VERIFICATION_REQUIRED";
  return error;
}
