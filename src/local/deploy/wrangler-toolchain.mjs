import { privateToolchainIntegrityError, isPrivateToolchainIntegrityError, throwOperationalOrIntegrity, verifyCfNetworkArtifact, CF_NETWORK_ARTIFACT } from "./cf-network-integrity.mjs";
import { lstatSync, existsSync, rmSync, writeFileSync } from "node:fs";
import path, { resolve } from "node:path";
import { replaceFileAtomicallySync } from "../core/exclusive-file.mjs";
import { ensureOwnerOnlyDirectorySync, readBoundedRegularFileSync } from "../core/secure-file.mjs";
import { createHash } from "node:crypto";
import { filesystemIdentity, sameFilesystemIdentity } from "../core/filesystem-identity.mjs";
import { withOwnerStateLock } from "../state/state-locks.mjs";
import { assertStateMaintenanceAvailable, expandHome, machineServiceControlRoot, defaultStateRoot } from "../state/state.mjs";
import { ensureHardenedNpm, withHardenedNpmLauncher } from "./hardened-npm.mjs";
import { nestedNpmEnvironment, validateNpmAudit, resolveNpmCli } from "./npm.mjs";
import { positiveInteger } from "../../shared/numbers.mjs";
import { packageRoot as defaultPackageRoot } from "../core/timing.mjs";

const MAX_TREE_NODES = 20_000;

export function validateInstalledWranglerToolchainTree(tree, versions, lockedPackages) {
  if (!tree || typeof tree !== "object" || Array.isArray(tree)) {
    throw privateToolchainIntegrityError("Wrangler toolchain dependency tree is invalid");
  }
  if (tree.problems !== undefined && (!Array.isArray(tree.problems) || tree.problems.length)) {
    throw privateToolchainIntegrityError("Wrangler toolchain dependency tree contains invalid edges");
  }
  if (lockedPackages !== undefined
      && (!lockedPackages || typeof lockedPackages !== "object" || Array.isArray(lockedPackages))) {
    throw privateToolchainIntegrityError("Wrangler toolchain lock package map is invalid");
  }
  const found = new Set();
  visitDependencyTree(tree.dependencies, versions, found, { value: 0 }, 0, lockedPackages, "");
  for (const name of Object.keys(versions)) {
    if (!found.has(name)) throw privateToolchainIntegrityError(`Wrangler toolchain ${name} dependency is missing`);
  }
}

function visitDependencyTree(dependencies, versions, found, counter, depth, lockedPackages, parentLocation) {
  if (dependencies === undefined) return;
  if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) {
    throw privateToolchainIntegrityError("Wrangler toolchain dependency tree contains an invalid dependency map");
  }
  if (depth > 64) throw privateToolchainIntegrityError("Wrangler toolchain dependency tree exceeds the depth limit");
  for (const name in dependencies) {
    if (!Object.hasOwn(dependencies, name)) continue;
    if (++counter.value > MAX_TREE_NODES) throw privateToolchainIntegrityError("Wrangler toolchain dependency tree exceeds the node limit");
    const value = dependencies[name];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw privateToolchainIntegrityError("Wrangler toolchain dependency tree contains an invalid dependency node");
    }
    const pinned = Object.hasOwn(versions, name);
    if (pinned && typeof value.version !== "string") {
      throw privateToolchainIntegrityError(`Wrangler toolchain ${name} version must be a string`);
    }
    const location = lockedPackages === undefined ? "" : resolveLockedDependency(lockedPackages, parentLocation, name);
    const expected = lockedPackages === undefined ? versions[name] : lockedPackages[location]?.version;
    if ((pinned || lockedPackages !== undefined)
        && (typeof expected !== "string" || value.version !== expected)) {
      throw privateToolchainIntegrityError(pinned
        ? `Wrangler toolchain ${name} version does not match the pinned version`
        : "Wrangler toolchain dependency version does not match its locked location");
    }
    // Nested pins may differ. They cannot substitute for the required root pins.
    if (pinned && (lockedPackages === undefined || location === `node_modules/${name}`)) {
      if (value.version !== versions[name]) {
        throw privateToolchainIntegrityError(`Wrangler toolchain ${name} version does not match the pinned version`);
      }
      found.add(name);
    }
    visitDependencyTree(value.dependencies, versions, found, counter, depth + 1, lockedPackages, location);
  }
}

function resolveLockedDependency(packages, parentLocation, name) {
  let parent = parentLocation;
  for (;;) {
    const location = parent ? `${parent}/node_modules/${name}` : `node_modules/${name}`;
    if (Object.hasOwn(packages, location)) return location;
    if (!parent) break;
    const boundary = parent.lastIndexOf("/node_modules/");
    parent = boundary < 0 ? "" : parent.slice(0, boundary);
  }
  throw privateToolchainIntegrityError("Wrangler toolchain dependency is absent from its locked resolution path");
}
const TOOLCHAIN_SCHEMA_VERSION = 4;

const TOOLCHAIN_MARKER = ".machine-bridge-mcp-toolchain.json";

const VERIFICATION_TEMPLATE_MAX_BYTES = 2 * 1024 * 1024;

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
    validateInstalledWranglerToolchainTree(tree, descriptor.versions, descriptor.lockedPackages);
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
    actual = readBoundedRegularFileSync(file, VERIFICATION_TEMPLATE_MAX_BYTES, label, {
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
const LOCK_PURPOSE = "toolchain-operation";

export function withToolchainOperationLock(stateRoot, callback, options = {}) {
  if (typeof callback !== "function") throw new TypeError("toolchain operation lock requires a callback");
  const root = resolve(expandHome(stateRoot));
  assertStateMaintenanceAvailable(root);
  const generation = stateGeneration(root);
  const key = process.platform === "win32" ? root.toLowerCase() : root;
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return withOwnerStateLock(machineServiceControlRoot(options), async () => {
    assertStateMaintenanceAvailable(root);
    const current = stateGeneration(root);
    if (!sameFilesystemIdentity(generation, current)) {
      throw new Error("state root changed while waiting for private-toolchain ownership; retry from current state");
    }
    return callback();
  }, {
    purpose: LOCK_PURPOSE,
    fileName: `toolchain-operation-${digest}.lock`,
    label: "private toolchain operation",
    timeoutMs: options.timeoutMs ?? 30_000,
  });
}

function stateGeneration(root) {
  let info;
  try { info = lstatSync(root, { bigint: true }); }
  catch (error) {
    if (error?.code === "ENOENT") throw new Error("state root must exist before a persistent private-toolchain operation", { cause: error });
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("state root must be a real directory before a persistent private-toolchain operation");
  return filesystemIdentity(info, "private-toolchain state root");
}
const TOOLCHAIN_DIRECTORY = "toolchains";

const TOOLCHAIN_LOCK = "wrangler-toolchain.lock";

const DEFAULT_AUDIT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

const AUDIT_TIMEOUT_MS = 2 * 60 * 1000;

const MAX_TEMPLATE_BYTES = 2 * 1024 * 1024, MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;

export async function ensureWranglerToolchain(options = {}) {
  const runCommand = options.runCommand;
  if (typeof runCommand !== "function") throw new TypeError("Wrangler toolchain requires an executable runner");
  const descriptor = wranglerToolchainDescriptor(options);
  const explicitNpmCli = options.npmCli
    ? resolveNpmCli(options)
    : (options.hardenedNpm ? "" : (process.env.npm_execpath || ""));
  const now = typeof options.now === "function" ? options.now : Date.now;
  const auditMaxAgeMs = positiveInteger(options.auditMaxAgeMs, DEFAULT_AUDIT_MAX_AGE_MS);
  const parent = path.join(descriptor.stateRoot, TOOLCHAIN_DIRECTORY);

  return withToolchainOperationLock(descriptor.stateRoot, async () => {
    ensureOwnerOnlyDirectorySync(parent);
    return withOwnerStateLock(parent, async () => {
      const npmCli = explicitNpmCli || (await ensureHardenedNpm(parent, options.hardenedNpm || {})).cli;
      return withHardenedNpmLauncher(parent, npmCli, async (bin) => {
        const npmOptions = { ...options, env: nestedNpmEnvironment(options.env || process.env, { bin }) };
        let marker = null;
        let installed = false;
        try {
          marker = readWranglerToolchainMarker(descriptor.root);
          installed = await verifyWranglerToolchain(descriptor, (args, allowFailure = false) => runNpm(npmCli, args, descriptor.root, runCommand, npmOptions, AUDIT_TIMEOUT_MS, allowFailure));
        } catch (error) {
          if (!isPrivateToolchainIntegrityError(error)) throw error;
        }
        if (!installed) {
          installToolchain(descriptor);
          await runNpm(npmCli, [
            "ci",
            "--dry-run=false",
            "--workspaces=false",
            "--ignore-scripts=false",
            "--package-lock=true",
            "--package-lock-only=false",
            "--omit=dev",
            "--no-fund",
            "--audit=false",
          ], descriptor.root, runCommand, npmOptions, INSTALL_TIMEOUT_MS);
          await verifyWranglerToolchain(descriptor, (args, allowFailure = false) => runNpm(npmCli, args, descriptor.root, runCommand, npmOptions, AUDIT_TIMEOUT_MS, allowFailure), true);
          verifyCfNetworkArtifact(descriptor.root);
          await auditToolchain(descriptor, npmCli, runCommand, npmOptions);
          writeWranglerToolchainMarker(descriptor, now());
          return descriptor.root;
        }

        verifyCfNetworkArtifact(descriptor.root);
        const checkedAt = now();
        const auditAgeMs = checkedAt - Date.parse(String(marker?.audited_at || ""));
        if (!wranglerToolchainMarkerMatches(marker, descriptor) || auditAgeMs < -MAX_CLOCK_SKEW_MS || auditAgeMs >= auditMaxAgeMs) {
          await auditToolchain(descriptor, npmCli, runCommand, npmOptions);
          writeWranglerToolchainMarker(descriptor, checkedAt);
        }
        return descriptor.root;
      });
    }, {
      purpose: "wrangler-toolchain",
      fileName: TOOLCHAIN_LOCK,
      label: "Wrangler toolchain",
      timeoutMs: options.lockTimeoutMs,
    });
  }, {
    controlRoot: options.controlRoot,
    timeoutMs: options.operationLockTimeoutMs,
  });
}

export { ensureWranglerToolchain as ensureCloudflareToolchain };

export function wranglerToolchainDescriptor(options = {}) {
  const packageRoot = path.resolve(String(options.packageRoot || defaultPackageRoot));
  const stateRoot = path.resolve(String(options.stateRoot || defaultStateRoot()));
  const templateRoot = path.join(packageRoot, "src", "local", "wrangler-toolchain");
  const packageBytes = readBoundedRegularFileSync(
    path.join(templateRoot, "package.json"), MAX_TEMPLATE_BYTES, "Wrangler toolchain package manifest",
    { verifyPathIdentity: true, rejectMultipleLinks: true },
  );
  const lockBytes = readBoundedRegularFileSync(
    path.join(templateRoot, "package-lock.json"), MAX_TEMPLATE_BYTES, "Wrangler toolchain lockfile",
    { verifyPathIdentity: true, rejectMultipleLinks: true },
  );
  const manifest = parseJsonObject(packageBytes, "Wrangler toolchain package manifest");
  const lock = parseJsonObject(lockBytes, "Wrangler toolchain lockfile");
  validateTemplate(manifest, lock);
  const digest = createHash("sha256").update(packageBytes).update("\0").update(lockBytes).update("\0").update(CF_NETWORK_ARTIFACT.sha256).digest("hex");
  const root = path.join(stateRoot, TOOLCHAIN_DIRECTORY, `wrangler-${manifest.dependencies.wrangler}-${digest.slice(0, 16)}`);
  return Object.freeze({
    packageRoot,
    stateRoot,
    templateRoot,
    root,
    digest,
    packageBytes,
    lockBytes,
    lockedPackages: lock.packages,
    versions: Object.freeze({
      cf: String(manifest.dependencies.cf),
      wrangler: String(manifest.dependencies.wrangler),
      undici: String(lock.packages?.["node_modules/undici"]?.version || ""),
      sharp: String(manifest.overrides.sharp),
      esbuild: String(lock.packages?.["node_modules/esbuild"]?.version || ""),
      workerd: String(lock.packages?.["node_modules/workerd"]?.version || ""),
    }),
  });
}

function installToolchain(descriptor) {
  const parent = path.dirname(descriptor.root);
  ensureOwnerOnlyDirectorySync(parent);
  if (existsSync(descriptor.root)) rmSync(descriptor.root, { recursive: true, force: true });
  ensureOwnerOnlyDirectorySync(descriptor.root);
  writeFileSync(path.join(descriptor.root, "package.json"), descriptor.packageBytes, { mode: 0o600 });
  writeFileSync(path.join(descriptor.root, "package-lock.json"), descriptor.lockBytes, { mode: 0o600 });
}

async function auditToolchain(descriptor, npmCli, runCommand, options) {
  const audit = await runNpm(npmCli, ["audit", "--workspaces=false", "--omit=dev", "--audit-level=low", "--json"], descriptor.root, runCommand, options, AUDIT_TIMEOUT_MS, true);
  let report;
  try { report = JSON.parse(audit.stdout); } catch { throw new Error("Wrangler toolchain npm audit did not return valid JSON"); }
  validateNpmAudit(report, audit.code, "Wrangler toolchain");
  await runNpm(npmCli, ["audit", "signatures", "--workspaces=false"], descriptor.root, runCommand, options, AUDIT_TIMEOUT_MS);
}

async function runNpm(npmCli, args, cwd, runCommand, options, timeoutMs, allowFailure = false) {
  return runCommand(process.execPath, [npmCli, ...args], {
    cwd,
    env: nestedNpmEnvironment(options.env || process.env),
    capture: true,
    allowFailure,
    timeoutMs,
    maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
  });
}

const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function validateTemplate(manifest, lock) {
  const deps = manifest.dependencies && typeof manifest.dependencies === "object" ? manifest.dependencies : {};
  const depNames = Object.keys(deps).sort();
  if (manifest.private !== true
      || JSON.stringify(depNames) !== JSON.stringify(["cf", "wrangler"])
      || deps.cf !== CF_NETWORK_ARTIFACT.version
      || !EXACT_SEMVER.test(String(deps.wrangler || ""))) {
    throw new Error("Cloudflare toolchain manifest lost its exact private dependencies");
  }
  const overrides = manifest.overrides && typeof manifest.overrides === "object" ? manifest.overrides : {};
  for (const required of ["sharp", "miniflare", "undici", "zod", "ws"]) {
    if (!EXACT_SEMVER.test(String(overrides[required] || ""))) {
      throw new Error("Cloudflare toolchain manifest lost its security and deduplication overrides");
    }
  }
  const allowScripts = manifest.allowScripts && typeof manifest.allowScripts === "object" ? manifest.allowScripts : {};
  if (allowScripts.fsevents !== false || allowScripts[`sharp@${overrides.sharp}`] !== true) {
    throw new Error("Cloudflare toolchain manifest lost its exact install-script policy");
  }
  if (lock.lockfileVersion !== 3) throw new Error("Cloudflare toolchain requires lockfile version 3");
  for (const [name, version] of Object.entries(deps)) {
    if (lock.packages?.[`node_modules/${name}`]?.version !== version) {
      throw new Error("Cloudflare toolchain lockfile does not match the exact security contract");
    }
  }
  for (const [name, version] of Object.entries(overrides)) {
    if (lock.packages?.[`node_modules/${name}`]?.version !== version) {
      throw new Error("Cloudflare toolchain lockfile lost a security or deduplication override");
    }
  }
  const lockedWorkerd = [...new Set(Object.entries(lock.packages || {})
    .filter(([pkgPath]) => pkgPath === "node_modules/workerd" || pkgPath.endsWith("/workerd"))
    .map(([, pkg]) => `workerd@${pkg?.version || ""}`))].sort();
  if (!lockedWorkerd.length || lockedWorkerd.some((entry) => allowScripts[entry] !== true)) {
    throw new Error("Cloudflare toolchain manifest lost workerd allowScripts parity with lockfile");
  }
  for (const [entry, allowed] of Object.entries(allowScripts)) {
    if (entry === "fsevents") {
      if (allowed !== false) throw new Error("Cloudflare toolchain manifest must block fsevents scripts");
      continue;
    }
    const at = entry.lastIndexOf("@");
    const pkgName = at > 0 ? entry.slice(0, at) : "";
    const pkgVersion = at > 0 ? entry.slice(at + 1) : "";
    const suffix = `node_modules/${pkgName}`;
    const inLock = allowed === true && pkgName && EXACT_SEMVER.test(pkgVersion)
      && Object.entries(lock.packages || {}).some(([k, v]) => (k === suffix || k.endsWith(`/${suffix}`)) && v?.version === pkgVersion);
    if (!inLock) throw new Error("Cloudflare toolchain manifest allowScripts entry does not match lockfile");
  }
  for (const required of ["undici", "esbuild", "workerd"]) {
    if (!EXACT_SEMVER.test(String(lock.packages?.[`node_modules/${required}`]?.version || ""))) {
      throw new Error("Cloudflare toolchain lockfile lost an installed dependency pin");
    }
  }
}
