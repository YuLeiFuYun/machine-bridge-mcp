import { lstatSync } from "node:fs";
import path from "node:path";
import { replaceFileAtomicallySync } from "./exclusive-file.mjs";
import { validateInstalledWranglerToolchainTree } from "./wrangler-toolchain-installed-tree.mjs";
import {
  isPrivateToolchainIntegrityError,
  privateToolchainIntegrityError,
  throwOperationalOrIntegrity,
} from "./private-toolchain-integrity.mjs";
import { ensureOwnerOnlyDirectorySync, readBoundedRegularFileSync } from "./secure-file.mjs";

const TOOLCHAIN_SCHEMA_VERSION = 4;
const TOOLCHAIN_MARKER = ".machine-bridge-mcp-toolchain.json";
const MAX_TEMPLATE_BYTES = 2 * 1024 * 1024;

export async function verifyWranglerToolchain(descriptor, execute, required = false) {
  try {
    let info;
    try { info = lstatSync(descriptor.root); }
    catch (error) { throwOperationalOrIntegrity(error, "Wrangler toolchain directory is missing or structurally invalid"); }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw privateToolchainIntegrityError("Wrangler toolchain path is not a real directory");
    }
    ensureOwnerOnlyDirectorySync(descriptor.root);
    requireExactFile(path.join(descriptor.root, "package.json"), descriptor.packageBytes, "Wrangler toolchain package manifest");
    requireExactFile(path.join(descriptor.root, "package-lock.json"), descriptor.lockBytes, "Wrangler toolchain lockfile");
    const versionResult = await execute(["--version"]);
    const npmVersion = String(versionResult.stdout || "").trim();
    if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(npmVersion)
        || npmVersion.split(".").some((part) => !Number.isSafeInteger(Number(part)))
        || Number(npmVersion.split(".")[0]) < 12) {
      throw new Error("Wrangler toolchain requires a valid npm 12 or newer version");
    }
    const treeResult = await execute(
      ["ls", "cf", "wrangler", "undici", "sharp", "esbuild", "workerd", "--workspaces=false", "--all", "--json"],
      true,
    );
    if (treeResult.code === 124) {
      const timeout = new Error("Wrangler toolchain npm ls timed out");
      timeout.code = "ETIMEDOUT";
      throw timeout;
    }
    let tree;
    try { tree = JSON.parse(treeResult.stdout); }
    catch {
      throw new Error("Wrangler toolchain npm ls returned invalid JSON; inspect the private install separately");
    }
    validateInstalledWranglerToolchainTree(tree, descriptor.versions);
    if (treeResult.code !== 0) throw new Error(`Wrangler toolchain npm ls exited ${treeResult.code} without dependency problems`);
    return true;
  } catch (error) {
    if (required || !isPrivateToolchainIntegrityError(error)) throw error;
    return false;
  }
}

export function readWranglerToolchainMarker(root) {
  let bytes;
  try {
    bytes = readBoundedRegularFileSync(
      path.join(root, TOOLCHAIN_MARKER), 16 * 1024, "Wrangler toolchain marker",
      { verifyPathIdentity: true, rejectMultipleLinks: true },
    );
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throwOperationalOrIntegrity(error, "Wrangler toolchain marker is structurally invalid");
  }
  try { return parseJsonObject(bytes, "Wrangler toolchain marker"); }
  catch (error) { throw privateToolchainIntegrityError(error.message, error); }
}

export function wranglerToolchainMarkerMatches(marker, descriptor) {
  return Boolean(marker)
    && marker.schema_version === TOOLCHAIN_SCHEMA_VERSION
    && marker.digest === descriptor.digest
    && marker.cf === descriptor.versions.cf
    && marker.wrangler === descriptor.versions.wrangler
    && marker.undici === descriptor.versions.undici
    && marker.sharp === descriptor.versions.sharp
    && marker.esbuild === descriptor.versions.esbuild
    && marker.workerd === descriptor.versions.workerd
    && typeof marker.audited_at === "string"
    && Number.isFinite(Date.parse(marker.audited_at));
}

export function writeWranglerToolchainMarker(descriptor, nowMs) {
  const auditedAt = new Date(Number(nowMs)).toISOString();
  if (!Number.isFinite(Date.parse(auditedAt))) throw new Error("Wrangler toolchain audit timestamp is invalid");
  replaceFileAtomicallySync(path.join(descriptor.root, TOOLCHAIN_MARKER), `${JSON.stringify({
    schema_version: TOOLCHAIN_SCHEMA_VERSION,
    digest: descriptor.digest,
    cf: descriptor.versions.cf,
    wrangler: descriptor.versions.wrangler,
    undici: descriptor.versions.undici,
    sharp: descriptor.versions.sharp,
    esbuild: descriptor.versions.esbuild,
    workerd: descriptor.versions.workerd,
    audited_at: auditedAt,
  }, null, 2)}\n`, { mode: 0o600 });
}

function requireExactFile(file, expected, label) {
  let actual;
  try {
    actual = readBoundedRegularFileSync(file, MAX_TEMPLATE_BYTES, label, {
      verifyPathIdentity: true,
      rejectMultipleLinks: true,
    });
  } catch (error) {
    throwOperationalOrIntegrity(error, `${label} is missing or structurally invalid`);
  }
  if (!actual.equals(expected)) throw privateToolchainIntegrityError(`${label} does not match the packaged template`);
}

function parseJsonObject(bytes, label) {
  let value;
  try { value = JSON.parse(Buffer.from(bytes).toString("utf8")); }
  catch { throw new Error(`${label} is not valid JSON`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}
