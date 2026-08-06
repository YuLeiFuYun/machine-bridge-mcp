import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACTIVATION_SCHEMA_VERSION, prereleaseActivationPath, readPrereleaseActivation, validatePrereleaseActivation, writePrereleaseActivation } from "../scripts/prerelease-activation.mjs";
import { discoverForegroundDaemonRecovery, foregroundPid } from "../scripts/foreground-daemon-recovery.mjs";
import { persistentActivationSpawnOptions, persistentCandidateFailureMessage, validateActivationRecoveryPayload } from "../scripts/persistent-activation-process.mjs";
import { inspectGlobalPackageInstallation } from "../scripts/global-package-installation.mjs";

const root = mkdtempSync(join(tmpdir(), "mbm-prerelease-activation-"));
try {
  const globalRoot = join(root, "global-root");
  const installedRoot = join(globalRoot, "machine-bridge-mcp");
  mkdirSync(join(installedRoot, "bin"), { recursive: true });
  writeFileSync(join(installedRoot, "package.json"), JSON.stringify({ name: "machine-bridge-mcp", version: "3.0.0-beta.0" }));
  writeFileSync(join(installedRoot, "bin", "machine-mcp.mjs"), "export {};\n");
  const inspectedGlobal = inspectGlobalPackageInstallation(globalRoot, "machine-bridge-mcp");
  assert(inspectedGlobal.version === "3.0.0-beta.0" && existsSync(inspectedGlobal.entry),
    "global package rollback baseline inspection failed");
  assert(inspectGlobalPackageInstallation(globalRoot, "missing-package") === null,
    "missing global package did not normalize to null");
  assert(inspectGlobalPackageInstallation(join(root, "missing-global-root"), "machine-bridge-mcp") === null,
    "missing global npm root did not normalize to an absent package");
  writeFileSync(join(installedRoot, "package.json"), "not-json");
  expectThrow(() => inspectGlobalPackageInstallation(globalRoot, "machine-bridge-mcp"), "not valid JSON");
  writeFileSync(join(installedRoot, "package.json"), JSON.stringify({ name: "machine-bridge-mcp", version: "3.0.0-beta.0" }));
  const externalRoot = join(root, "external-package");
  mkdirSync(externalRoot);
  const linkedRoot = join(globalRoot, "linked-package");
  symlinkSync(externalRoot, linkedRoot, "dir");
  expectThrow(() => inspectGlobalPackageInstallation(globalRoot, "linked-package"), "real directory");

  const globalPackageRollbackBaseline = {
    version: "3.0.0-beta.0",
    entry: "/opt/example/lib/node_modules/machine-bridge-mcp/bin/machine-mcp.mjs",
  };
  const base = {
    schema_version: ACTIVATION_SCHEMA_VERSION,
    package_name: "machine-bridge-mcp",
    package_version: "3.0.0-beta.1",
    source: "local-candidate",
    shasum: "a".repeat(40),
    integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
    promotion_content_sha256: "b".repeat(64),
    activated_at: "2026-07-21T12:00:00.000Z",
    workspace_hash: "c".repeat(24),
    global_package_rollback_baseline: globalPackageRollbackBaseline,
  };
  const file = writePrereleaseActivation(base, root);
  assert(file.endsWith("v3.0.0-beta.1.json"), "activation path did not include the exact version");
  const written = JSON.parse(readFileSync(file, "utf8"));
  assert(written.schema_version === ACTIVATION_SCHEMA_VERSION
    && !Object.hasOwn(written, "previous")
    && written.global_package_rollback_baseline?.version === "3.0.0-beta.0",
  "current activation writer did not persist the explicit global package rollback baseline");
  const current = readPrereleaseActivation("3.0.0-beta.1", root);
  assert(current.workspace_hash === "c".repeat(24)
    && current.global_package_rollback_baseline?.entry === globalPackageRollbackBaseline.entry,
  "activation record did not round-trip");
  expectThrow(() => readPrereleaseActivation("3.0.0-beta.1", root, {
    readBoundedRegularFileSync() {
      throw Object.assign(new Error("synthetic permission failure"), { code: "EACCES" });
    },
  }), "record is unavailable");
  expectThrow(() => readPrereleaseActivation("3.0.0-beta.99", root), "record is missing");
  const recoveredRecord = validatePrereleaseActivation({
    ...base,
    package_version: "3.0.0-beta.3",
    activation_recovered: true,
    activation_recovery_reason: "relay_authentication_failed",
    activation_recovery_detail: "remote relay rejected the foreground candidate after readiness",
  });
  assert(recoveredRecord.activation_recovered === true
    && recoveredRecord.activation_recovery_reason === "relay_authentication_failed",
  "recovered activation metadata did not normalize");
  expectThrow(() => validatePrereleaseActivation({
    ...base,
    activation_recovery_reason: "relay_authentication_failed",
  }), "requires a recovered activation");
  expectThrow(() => validatePrereleaseActivation({
    ...base,
    activation_recovered: true,
    activation_recovery_reason: "bad-reason",
    activation_recovery_detail: "detail",
  }), "reason is invalid");
  assert(validateActivationRecoveryPayload({
    activation_recovered: false,
    activation_recovery_reason: null,
    activation_recovery_detail: null,
  }).recovered === false, "ordinary activation recovery payload did not normalize");
  assert(validateActivationRecoveryPayload({
    activation_recovered: true,
    activation_recovery_reason: "autostart_start_failed",
    activation_recovery_detail: "autostart did not persist",
  }).reason === "autostart_start_failed", "recovered activation payload did not normalize");
  expectThrow(() => validateActivationRecoveryPayload({
    activation_recovered: false,
    activation_recovery_reason: "unexpected",
    activation_recovery_detail: null,
  }), "inconsistent");

  const legacyVersion = "3.0.0-beta.2";
  const legacyFile = prereleaseActivationPath(legacyVersion, root);
  writeFileSync(legacyFile, `${JSON.stringify({
    ...base,
    schema_version: 1,
    package_version: legacyVersion,
    previous: globalPackageRollbackBaseline,
    global_package_rollback_baseline: undefined,
  }, null, 2)}\n`, { mode: 0o600 });
  const migratedLegacy = readPrereleaseActivation(legacyVersion, root);
  assert(migratedLegacy.schema_version === ACTIVATION_SCHEMA_VERSION
    && migratedLegacy.global_package_rollback_baseline?.version === globalPackageRollbackBaseline.version
    && !Object.hasOwn(migratedLegacy, "previous"),
  "legacy activation record was not normalized to the current explicit baseline field");
  expectThrow(() => validatePrereleaseActivation({ ...base, schema_version: 1 }), "legacy prerelease activation");
  expectThrow(() => validatePrereleaseActivation({ ...base, previous: globalPackageRollbackBaseline }), "ambiguous");
  expectThrow(() => validatePrereleaseActivation({
    ...base,
    global_package_rollback_baseline: undefined,
    previous: globalPackageRollbackBaseline,
  }), "current prerelease activation");
  expectThrow(() => validatePrereleaseActivation({
    ...base,
    global_package_rollback_baseline: { ...globalPackageRollbackBaseline, entry: "relative/bin/machine-mcp.mjs" },
  }), "global package rollback baseline");
  validatePrereleaseActivation({
    ...base,
    source: "npm-prerelease",
    npm_dist_tag: "beta",
    published_at: "2026-07-21T11:00:00.000Z",
  });
  validatePrereleaseActivation({
    ...base,
    schema_version: 1,
    global_package_rollback_baseline: undefined,
  });
  expectThrow(() => validatePrereleaseActivation({ ...base, schema_version: "2" }), "unsupported prerelease activation schema");
  expectThrow(() => validatePrereleaseActivation({ ...base, package_version: "3.0.0-dev.1" }), "beta or rc");
  expectThrow(() => validatePrereleaseActivation({ ...base, source: "npm-prerelease", npm_dist_tag: "latest", published_at: "2026-07-21T11:00:00.000Z" }), "dist-tag");
  expectThrow(() => validatePrereleaseActivation({ ...base, integrity: "bad" }), "integrity");
  const subprocess = persistentActivationSpawnOptions({ cwd: root, env: { PATH: "/bin" } });
  assert(subprocess.cwd === root && subprocess.env.PATH === "/bin", "persistent activation subprocess lost cwd or environment");
  assert(!Object.hasOwn(subprocess, "timeout") && !Object.hasOwn(subprocess, "killSignal"),
    "persistent activation subprocess retained an outer hard timeout that can bypass cleanup");
  expectThrow(() => persistentActivationSpawnOptions({ cwd: "" }), "requires cwd");
  const recoveryRoot = join(root, "recovery-runtime");
  const workspace = join(recoveryRoot, "workspace");
  const stateRoot = join(recoveryRoot, "state");
  const packageRoot = join(recoveryRoot, "package");
  const entry = join(packageRoot, "bin", "machine-mcp.mjs");
  for (const directory of [workspace, stateRoot, join(packageRoot, "bin")]) mkdirSync(directory, { recursive: true });
  writeFileSync(entry, "export {};\n", { mode: 0o600 });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "machine-bridge-mcp", version: "3.0.0-beta.23" }));
  const owner = {
    pid: 77, purpose: "daemon", mode: "foreground", version: "3.0.0-beta.23",
    workspace: realpathSync(workspace), entryScript: realpathSync(entry),
  };
  const output = "Error: a foreground daemon is active (pid 77); stop it explicitly before activation";
  const dependencies = {
    selectedWorkspace: () => workspace, resolveWorkspace: value => realpathSync(value),
    loadState: () => ({ workspace: { path: realpathSync(workspace) } }),
    readDaemonOwner: () => owner, daemonLockPathForState: () => "synthetic-lock",
    inspectProcessInstance: () => ({ current: true }),
    processCommandLine: () => `${JSON.stringify(process.execPath)} ${JSON.stringify(entry)} start --workspace ${JSON.stringify(workspace)} --state-dir ${JSON.stringify(stateRoot)} --force-worker`,
  };
  const previousRuntime = discoverForegroundDaemonRecovery({ output, stateRoot, dependencies });
  assert(previousRuntime?.pid === 77 && previousRuntime.cli === realpathSync(entry)
    && previousRuntime.version === "3.0.0-beta.23",
  "trusted foreground runtime was not resolved to its exact installed CLI");
  assert(foregroundPid(output) === 77 && foregroundPid("pid unavailable") === 0,
    "foreground PID parser accepted malformed evidence");
  assert(discoverForegroundDaemonRecovery({ output: output.replace("77", "78"), stateRoot, dependencies }) === null,
    "foreground recovery accepted a PID that did not match the daemon lock");
  assert(discoverForegroundDaemonRecovery({ output, stateRoot, dependencies: {
    ...dependencies, processCommandLine: () => `${process.execPath} ${entry} start --daemon-only --workspace ${workspace} --state-dir ${stateRoot}`,
  } }) === null, "foreground recovery accepted a daemon-only or mismatched command");
  assert(discoverForegroundDaemonRecovery({ output, stateRoot, dependencies: {
    ...dependencies, readDaemonOwner: () => ({ ...owner, version: "3.0.0-beta.22" }),
  } }) === null, "foreground recovery accepted package/lock version drift");

  const foregroundGuidance = persistentCandidateFailureMessage(output, {
    cli: "/private/candidate/bin/machine-mcp.mjs", stateRoot, previousRuntime,
  });
  assert(foregroundGuidance.includes("No Worker deployment or service replacement was started")
    && foregroundGuidance.includes("Verified foreground runtime: 3.0.0-beta.23 (pid 77)")
    && foregroundGuidance.includes(`node ${JSON.stringify(realpathSync(entry))} service start`)
    && !foregroundGuidance.includes(`node ${JSON.stringify("/private/candidate/bin/machine-mcp.mjs")} service start`)
    && foregroundGuidance.includes("service status --workspace"),
  "foreground refusal did not preserve the exact old-runtime restoration sequence");
  const unresolvedGuidance = persistentCandidateFailureMessage(output, {
    cli: "/private/candidate/bin/machine-mcp.mjs", stateRoot, previousRuntime: null,
  });
  assert(unresolvedGuidance.includes("Keep it running") && !unresolvedGuidance.includes(" service start"),
    "unverified foreground runtime produced an executable recovery command");
  console.log("prerelease activation state test ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}
function expectThrow(callback, expected) { try { callback(); } catch (error) { if (String(error?.message || error).includes(expected)) return; throw error; } throw new Error(`expected throw containing: ${expected}`); }
function assert(condition, message) { if (!condition) throw new Error(message); }
