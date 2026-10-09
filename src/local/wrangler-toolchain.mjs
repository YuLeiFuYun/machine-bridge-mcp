import { createHash } from "node:crypto";
import {
  existsSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { verifyCfNetworkArtifact, CF_NETWORK_ARTIFACT } from "./cf-network-integrity.mjs";
import { ensureHardenedNpm } from "./hardened-npm.mjs";
import { withOwnerStateLock } from "./owner-state-lock.mjs";
import { nestedNpmEnvironment } from "./npm-environment.mjs";
import { validateNpmAudit } from "./npm-audit-report.mjs";
import { withHardenedNpmLauncher } from "./hardened-npm-launcher.mjs";
import { resolveNpmCli } from "./npm-cli.mjs";
import { isPrivateToolchainIntegrityError } from "./private-toolchain-integrity.mjs";
import {
  readWranglerToolchainMarker,
  verifyWranglerToolchain,
  wranglerToolchainMarkerMatches,
  writeWranglerToolchainMarker,
} from "./wrangler-toolchain-verification.mjs";
import { ensureOwnerOnlyDirectorySync, readBoundedRegularFileSync } from "./secure-file.mjs";
import { defaultStateRoot } from "./state.mjs";
import { withToolchainOperationLock } from "./toolchain-operation-lock.mjs";
import { packageRoot as defaultPackageRoot } from "./package-identity.mjs";

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
  const explicitNpmCli = options.npmCli ? resolveNpmCli(options) : "";
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

function validateTemplate(manifest, lock) {
  if (manifest.private !== true || manifest.dependencies?.wrangler !== "4.149.0"
      || manifest.dependencies?.cf !== CF_NETWORK_ARTIFACT.version
      || Object.keys(manifest.dependencies).length !== 2) {
    throw new Error("Cloudflare toolchain manifest lost its exact private dependencies");
  }
  if (manifest.overrides?.sharp !== "0.35.5"
      || manifest.overrides?.miniflare !== "5.20261006.1-alpha"
      || manifest.overrides?.ws !== "8.22.0"
      || Object.keys(manifest.overrides).length !== 3) {
    throw new Error("Cloudflare toolchain manifest lost its security and deduplication overrides");
  }
  const expectedScripts = { "esbuild@0.28.2": true, fsevents: false, "sharp@0.35.5": true, "workerd@1.20261006.1": true };
  if (JSON.stringify(manifest.allowScripts) !== JSON.stringify(expectedScripts)) {
    throw new Error("Cloudflare toolchain manifest lost its exact install-script policy");
  }
  if (lock.lockfileVersion !== 3) throw new Error("Cloudflare toolchain requires lockfile version 3");
  for (const [name, version] of Object.entries(manifest.dependencies)) {
    if (lock.packages?.[`node_modules/${name}`]?.version !== version) {
      throw new Error("Cloudflare toolchain lockfile does not match the exact security contract");
    }
  }
  for (const [name, version] of Object.entries(manifest.overrides)) {
    if (lock.packages?.[`node_modules/${name}`]?.version !== version) {
      throw new Error("Cloudflare toolchain lockfile lost a security or deduplication override");
    }
  }
  if (lock.packages?.["node_modules/undici"]?.version !== "7.29.1"
      || lock.packages?.["node_modules/esbuild"]?.version !== "0.28.2"
      || lock.packages?.["node_modules/workerd"]?.version !== "1.20261006.1") {
    throw new Error("Cloudflare toolchain lockfile lost an installed dependency pin");
  }
}
function parseJsonObject(bytes, label) {
  let value;
  try { value = JSON.parse(Buffer.from(bytes).toString("utf8")); } catch { throw new Error(`${label} is not valid JSON`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}
