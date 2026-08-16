import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACTIVATION_SCHEMA_VERSION, assertPrereleaseActivationRuntimeRoot, prereleaseActivationPath, readPrereleaseActivation, validatePrereleaseActivation, writePrereleaseActivation } from "../scripts/prerelease-activation.mjs";
import { discoverForegroundDaemonRecovery, foregroundPid } from "../scripts/foreground-daemon-recovery.mjs";
import { assertPersistentActivationExecutionSurface, persistentActivationSpawnOptions, persistentCandidateFailureMessage, validateActivationRecoveryPayload } from "../scripts/persistent-activation-process.mjs";
import { inspectGlobalPackageInstallation } from "../scripts/global-package-installation.mjs";
import { canonicalActivationRecoveryDetail, normalizeActivationRecovery } from "../src/shared/activation-recovery.mjs";
import { EXECUTION_SURFACE } from "../src/local/execution-surface.mjs";

const root = mkdtempSync(join(tmpdir(), "mbm-prerelease-activation-"));
try {
  assert(canonicalActivationRecoveryDetail("relay_authentication_failed") === "candidate relay authentication failed after readiness",
    "activation recovery detail mapping drifted");
  expectThrow(() => canonicalActivationRecoveryDetail("unknown_recovery"), "reason is invalid");
  expectThrow(() => canonicalActivationRecoveryDetail(7), "reason is invalid");
  expectThrow(() => normalizeActivationRecovery({ recovered: "false", reason: null, detail: null }), "flag is invalid");
  expectThrow(() => normalizeActivationRecovery({ recovered: true, reason: "relay_authentication_failed", detail: "" }), "detail is invalid");
  expectThrow(() => normalizeActivationRecovery({ recovered: true, reason: "relay_authentication_failed", detail: "bad\nline" }), "detail is invalid");

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
  const runtimeBound = validatePrereleaseActivation({
    ...base,
    package_version: "3.0.0-beta.2",
    runtime_entry: join(installedRoot, "bin", "machine-mcp.mjs"),
  });
  assert(assertPrereleaseActivationRuntimeRoot(runtimeBound, installedRoot) === realpathSync(installedRoot),
    "prerelease canary runtime provenance did not match the activation package root");
  expectThrow(() => assertPrereleaseActivationRuntimeRoot(validatePrereleaseActivation(base), installedRoot), "runtime entry is missing");
  expectThrow(() => assertPrereleaseActivationRuntimeRoot(runtimeBound, externalRoot), "does not match the executing canary");
  expectThrow(() => assertPrereleaseActivationRuntimeRoot(runtimeBound, "relative-runtime"), "runtime root is invalid");
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
    activation_recovery_detail: "remote relay rejected /private/tmp/operator-secret at https://private.example.invalid/token",
  });
  assert(recoveredRecord.activation_recovered === true
    && recoveredRecord.activation_recovery_reason === "relay_authentication_failed"
    && recoveredRecord.activation_recovery_detail === "candidate relay authentication failed after readiness"
    && !JSON.stringify(recoveredRecord).includes("/private/tmp/operator-secret")
    && !JSON.stringify(recoveredRecord).includes("private.example.invalid"),
  "recovered activation metadata did not normalize to privacy-safe synthetic evidence");
  const privacySafeFile = writePrereleaseActivation({
    ...base,
    package_version: "3.0.0-beta.4",
    activation_recovered: true,
    activation_recovery_reason: "relay_authentication_failed",
    activation_recovery_detail: "lower-layer detail /private/tmp/operator-secret credential=operator-secret-value",
  }, root);
  const privacySafeBytes = readFileSync(privacySafeFile, "utf8");
  assert(privacySafeBytes.includes("candidate relay authentication failed after readiness")
    && !privacySafeBytes.includes("/private/tmp/operator-secret")
    && !privacySafeBytes.includes("operator-secret-value"),
  "activation writer persisted lower-layer recovery detail instead of canonical evidence");
  const historicalSchema2Version = "3.0.0-beta.5";
  const historicalSchema2File = prereleaseActivationPath(historicalSchema2Version, root);
  writeFileSync(historicalSchema2File, `${JSON.stringify({
    ...base,
    package_version: historicalSchema2Version,
    activation_recovered: true,
    activation_recovery_reason: "autostart_install_failed",
    activation_recovery_detail: "historical lower-layer detail /private/tmp/operator-secret",
  }, null, 2)}\n`, { mode: 0o600 });
  const normalizedHistoricalSchema2 = readPrereleaseActivation(historicalSchema2Version, root);
  assert(normalizedHistoricalSchema2.activation_recovery_detail === "candidate autostart installation failed after readiness"
    && !JSON.stringify(normalizedHistoricalSchema2).includes("/private/tmp/operator-secret"),
  "historical schema-2 activation detail was not normalized at the disk-read boundary");
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
  expectThrow(() => validatePrereleaseActivation({
    ...base,
    activation_recovered: true,
    activation_recovery_reason: "relay_authentication_failed",
    activation_recovery_detail: 7,
  }), "detail is invalid");
  expectThrow(() => validateActivationRecoveryPayload({
    activation_recovered: true,
    activation_recovery_reason: { value: "relay_authentication_failed" },
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
    activation_recovery_detail: "autostart did not persist at D:\\tmp\\operator-secret",
  }).detail === "candidate autostart start failed after readiness", "recovered activation payload did not normalize to canonical detail");
  expectThrow(() => validateActivationRecoveryPayload({
    activation_recovered: false,
    activation_recovery_reason: "unexpected",
    activation_recovery_detail: null,
  }), "inconsistent");

  expectThrow(() => validatePrereleaseActivation({ ...base, schema_version: 1 }), "unsupported prerelease activation schema");
  expectThrow(() => validatePrereleaseActivation({ ...base, previous: globalPackageRollbackBaseline }), "unsupported fields: previous");
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
  expectThrow(() => validatePrereleaseActivation({ ...base, schema_version: "2" }), "unsupported prerelease activation schema");
  expectThrow(() => validatePrereleaseActivation({ ...base, package_version: "3.0.0-dev.1" }), "beta or rc");
  expectThrow(() => validatePrereleaseActivation({ ...base, source: "npm-prerelease", npm_dist_tag: "latest", published_at: "2026-07-21T11:00:00.000Z" }), "dist-tag");
  expectThrow(() => validatePrereleaseActivation({ ...base, integrity: "bad" }), "integrity");
  const subprocess = persistentActivationSpawnOptions({ cwd: root, env: { PATH: "/bin" } });
  assert(subprocess.cwd === root && subprocess.env.PATH === "/bin", "persistent activation subprocess lost cwd or environment");
  assert(!Object.hasOwn(subprocess, "timeout") && !Object.hasOwn(subprocess, "killSignal"),
    "persistent activation subprocess retained an outer hard timeout that can bypass cleanup");
  expectThrow(() => persistentActivationSpawnOptions({ cwd: "" }), "requires cwd");
  assert(assertPersistentActivationExecutionSurface({}) === "local",
    "ordinary local activation was not accepted as an independent execution surface");
  assert(assertPersistentActivationExecutionSurface({ MBM_EXECUTION_SURFACE: EXECUTION_SURFACE.managedJob }) === EXECUTION_SURFACE.managedJob,
    "durable managed-job activation was rejected");
  for (const surface of [EXECUTION_SURFACE.foregroundProcess, EXECUTION_SURFACE.processSession]) {
    let rejected;
    try { assertPersistentActivationExecutionSurface({ MBM_EXECUTION_SURFACE: surface }); }
    catch (error) { rejected = error; }
    assert(rejected?.code === "unsafe_activation_execution_surface"
      && rejected?.sideEffectsStarted === false
      && rejected.message.includes("durable managed job"),
    `unsafe ${surface} activation did not fail closed before live mutation`);
  }
  expectThrow(
    () => assertPersistentActivationExecutionSurface({ MBM_EXECUTION_SURFACE: "synthetic_unknown_surface" }),
    "cannot run from unknown",
  );
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
