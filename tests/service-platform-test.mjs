import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { installAutostart, runServiceCommand, stopLaunchdService, stopSystemdService } from "../src/local/service.mjs";
import { LAUNCHD_MISSING_SERVICE_CODE, launchdStatusSummary } from "../src/local/service-status.mjs";
import { removeServiceDefinitionIfCurrent, snapshotServiceDefinition } from "../src/local/service-definition.mjs";
import { beginServiceOwnerUpdate, loadCommittedServiceOwner, loadServiceOwner, removeServiceOwner, serviceOwnerPath } from "../src/local/service-owner.mjs";
import { convergeOwnedServiceRuntime, restartOwnedServiceRuntime, startOwnedServiceRuntime, waitForOwnedServiceDaemon } from "../src/local/service-runtime.mjs";
import { waitForInactiveStatus } from "../src/local/service-convergence.mjs";
import { systemdRemovalDecision } from "../src/local/systemd-removal.mjs";
import { boundedPositiveInteger, stableWindowsStatus, waitForWindowsStatus, windowsStatusWaitOptions } from "../src/local/windows-service-convergence.mjs";
import {
  installWindowsTask,
  startWindowsTask,
  statusWindowsTask,
  stopWindowsTask,
  uninstallWindowsTask,
  windowsBatchArgument,
  windowsCommandLineArgument,
  windowsLauncherContent,
  writeWindowsLauncher,
  windowsTaskAction,
} from "../src/local/windows-service.mjs";

assert.equal(windowsCommandLineArgument("plain"), '"plain"');
assert.equal(windowsCommandLineArgument("C:\\"), '"C:\\\\"');
assert.equal(windowsCommandLineArgument('a\\"b'), '"a\\\\\\"b"');
assert.equal(windowsCommandLineArgument(""), '""');
assert.throws(() => windowsCommandLineArgument("bad\0value"), /NUL byte/);
assert.throws(() => windowsCommandLineArgument("bad\nvalue"), /line break/);
assert.equal(windowsBatchArgument("C:\\100%\\node.exe"), '"C:\\100%%\\node.exe"');

const representativeSpec = {
  node: "C:\\Program Files\\nodejs\\node.exe",
  daemonArgs: [
    "C:\\Users\\Example User\\AppData\\Roaming\\npm\\node_modules\\machine-bridge-mcp\\bin\\machine-mcp.mjs",
    "start",
    "--daemon-only",
    "--workspace", "D:\\A representative workspace with a long directory name\\project",
    "--state-dir", "C:\\Users\\Example User\\AppData\\Roaming\\machine-bridge-mcp",
    "--log-level", "warn",
    "--log-format", "json",
  ],
  stateRoot: "C:\\Users\\Example User\\AppData\\Roaming\\machine-bridge-mcp",
  stdout: "C:\\Users\\Example User\\AppData\\Roaming\\machine-bridge-mcp\\logs\\daemon.out.log",
  stderr: "C:\\Users\\Example User\\AppData\\Roaming\\machine-bridge-mcp\\logs\\daemon.err.log",
};
const oldInlineAction = [representativeSpec.node, ...representativeSpec.daemonArgs].map(windowsCommandLineArgument).join(" ");
assert(oldInlineAction.length > 262, "regression fixture no longer reproduces the Task Scheduler /TR length overflow");
const shortAction = windowsTaskAction("C:\\Users\\Example User\\AppData\\Roaming\\machine-bridge-mcp\\service-launcher.cmd");
assert(shortAction.length <= 262, "launcher-based Task Scheduler action still exceeds the platform limit");
assert.throws(() => windowsTaskAction("C:\\Users\\100%\\service-launcher.cmd"), /percent sign/);
const launcherContent = windowsLauncherContent(representativeSpec);
assert(launcherContent.includes(":restart"), "Windows launcher lost restart-on-failure behavior");
assert(launcherContent.includes("--daemon-only"), "Windows launcher lost daemon-only startup arguments");
assert(launcherContent.includes("1>>") && launcherContent.includes("2>>"), "Windows launcher lost bounded service log routing");
assert(launcherContent.includes('if "%mbm_exit%"=="0" exit /b 0'), "Windows launcher restarts successful exits");

const serviceInvocation = await runServiceCommand("synthetic-service", ["status"], async (command, args, options) => ({ command, args, options }));
assert.equal(serviceInvocation.command, "synthetic-service");
assert.equal(serviceInvocation.args[0], "status");
assert.equal(serviceInvocation.options.capture, true);
assert.equal(serviceInvocation.options.allowFailure, true);
assert.equal(serviceInvocation.options.timeoutMs, 30_000);
assert.equal(serviceInvocation.options.maxOutputBytes, 64 * 1024);

if (process.platform === "win32") windowsLauncherLiveTest();
await serviceDefinitionIdentityTest();
await serviceOwnerTransactionTest();
await serviceInstallOwnerCommitTest();
await ownedServiceRuntimeTest();
await windowsConvergenceBoundaryTest();
await windowsInstallTest();
await windowsStatusTest();
await windowsStartTest();
await windowsCompletedStartTest();
await windowsTransientStartTest();
await windowsUnknownStatusTest();
await windowsStopTest();
await windowsUninstallTest();
await windowsLauncherRemovalTest();
await windowsLauncherReplacementRemovalTest();
await systemdRemovalDecisionTest();
await systemdStopContractTest();
await launchdStatusContractTest();
await launchdStopContractTest();
await delayedLaunchdStopTest();
await stuckLaunchdStopTest();
console.log("service platform lifecycle test ok");

async function serviceDefinitionIdentityTest() {
  const root = mkdtempSync(path.join(os.tmpdir(), "mbm-service-definition-"));
  try {
    const file = path.join(root, "definition.service");
    const missing = path.join(root, "missing.service");
    assert.equal(snapshotServiceDefinition(missing, "missing service definition"), null,
      "missing service definition snapshot was not classified as absent");
    writeFileSync(file, "original\n", { mode: 0o600 });
    const identity = snapshotServiceDefinition(file, "test service definition");
    rmSync(file, { force: true });
    writeFileSync(file, "replacement\n", { mode: 0o600 });
    assert.equal(removeServiceDefinitionIfCurrent(file, identity, "test service definition"), false,
      "service definition removal deleted a replacement path");
    assert.equal(readFileSync(file, "utf8"), "replacement\n");
    rmSync(file, { force: true });
    assert.equal(removeServiceDefinitionIfCurrent(file, null, "test service definition"), true,
      "already-absent service definition did not settle idempotently");
    writeFileSync(file, "appeared-late\n", { mode: 0o600 });
    assert.equal(removeServiceDefinitionIfCurrent(file, null, "test service definition"), false,
      "service definition absent at snapshot time deleted a newly appeared path");
    if (process.platform !== "win32") {
      const alias = path.join(root, "definition-alias.service");
      linkSync(file, alias);
      assert.throws(() => snapshotServiceDefinition(file, "multiply linked service definition"), /multiple hard links/,
        "service definition snapshot accepted multiply-linked control evidence");
    }
  } finally { removeTestTree(root); }
}

async function serviceOwnerTransactionTest() {
  const root = mkdtempSync(path.join(os.tmpdir(), "mbm-service-owner-"));
  const controlRoot = path.join(root, "control");
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  const entryScript = path.join(root, "machine-mcp.mjs");
  try {
    for (const directory of [workspace, stateRoot]) mkdirSync(directory, { recursive: true });
    writeFileSync(entryScript, "export {};\n", { mode: 0o600 });
    const first = beginServiceOwnerUpdate({ workspace, stateRoot, entryScript, version: "3.0.0-test.1" }, { controlRoot });
    assert.equal(loadOwnerFailure({ controlRoot }), "machine service owner transition is incomplete; reinstall the service before starting it");
    const committed = first.commit();
    assert.equal(committed.status, "committed");
    assert.throws(() => first.commit(), /already closed/);
    assert.equal(first.rollback(), false);
    const storedOwner = loadCommittedServiceOwner({ controlRoot });
    const canonical = (value) => realpathSync.native ? realpathSync.native(value) : realpathSync(value);
    assert.equal(storedOwner.workspace, canonical(workspace));
    assert.equal(storedOwner.stateRoot, canonical(stateRoot));
    assert.equal(storedOwner.entryScript, canonical(entryScript));

    const secondWorkspace = path.join(root, "workspace-2");
    mkdirSync(secondWorkspace, { recursive: true });
    const second = beginServiceOwnerUpdate({ workspace: secondWorkspace, stateRoot, entryScript, version: "3.0.0-test.2" }, { controlRoot });
    second.rollback();
    assert.equal(loadCommittedServiceOwner({ controlRoot }).version, "3.0.0-test.1", "owner rollback did not restore the prior committed record");
    assert.equal(removeServiceOwner({ controlRoot }), true);
    assert.equal(loadCommittedServiceOwner({ controlRoot }), null);
    assert.equal(removeServiceOwner({ controlRoot }), false);
    assert.equal(serviceOwnerPath({ controlRoot }), path.join(controlRoot, "service-owner.json"));

    const emptyRollback = beginServiceOwnerUpdate({ workspace, stateRoot, entryScript, version: "3.0.0-test.3" }, { controlRoot });
    assert.equal(emptyRollback.rollback(), true);
    assert.equal(emptyRollback.rollback(), false);
    assert.equal(loadServiceOwner({ controlRoot }), null);

    const ownerFile = serviceOwnerPath({ controlRoot });
    const valid = { ...committed };
    writeFileSync(ownerFile, "{not-json\n", { mode: 0o600 });
    assert.match(loadOwnerFailure({ controlRoot }), /not valid JSON/);
    assert.equal(removeServiceOwner({ controlRoot }), true,
      "corrupt but securely opened owner metadata blocked provider cleanup");
    assert.equal(loadServiceOwner({ controlRoot }), null);
    writeFileSync(ownerFile, `${JSON.stringify(valid)}\n`, { mode: 0o600 });
    for (const [value, expected] of [
      [[], "must be an object"],
      [{ ...valid, schemaVersion: 99 }, "schema is unsupported"],
      [{ ...valid, status: "unknown" }, "status is invalid"],
      [{ ...valid, transactionId: "bad" }, "transaction id is invalid"],
      [{ ...valid, version: "bad version!" }, "version is invalid"],
      [{ ...valid, workspace: "relative" }, "workspace must be absolute"],
      [{ ...valid, workspace: path.join(root, "missing-workspace") }, "workspace is unavailable"],
      [{ ...valid, stateRoot: entryScript }, "state root is not a directory"],
      [{ ...valid, entryScript: stateRoot }, "entry script is not a file"],
      [{ ...valid, createdAt: "not-a-date" }, "createdAt is invalid"],
      [{ ...valid, committedAt: "not-a-date" }, "committedAt is invalid"],
    ]) {
      writeFileSync(ownerFile, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      assert.match(loadOwnerFailure({ controlRoot }), new RegExp(expected));
    }
    writeFileSync(ownerFile, `${JSON.stringify(valid)}\n`, { mode: 0o600 });
    if (process.platform !== "win32") {
      const ownerAlias = `${ownerFile}.alias`;
      try {
        linkSync(ownerFile, ownerAlias);
        assert.throws(() => removeServiceOwner({ controlRoot }), /multiple hard links/,
          "service-owner cleanup accepted multiply-linked ownership evidence");
        assert.equal(existsSync(ownerFile), true);
        assert.equal(existsSync(ownerAlias), true);
      } finally { rmSync(ownerAlias, { force: true }); }
    }
    const ownerStorageFailure = {
      controlRoot,
      inspectPathIfPresentSync() {
        throw Object.assign(new Error("synthetic service owner storage failure"), { code: "EIO" });
      },
    };
    assert.throws(() => loadServiceOwner(ownerStorageFailure), /synthetic service owner storage failure/);
    assert.throws(() => beginServiceOwnerUpdate({ workspace, stateRoot, entryScript, version: "3.0.0-test.failure" }, ownerStorageFailure), /synthetic service owner storage failure/);

    const stale = beginServiceOwnerUpdate({ workspace, stateRoot, entryScript, version: "3.0.0-test.4" }, { controlRoot });
    const replacement = beginServiceOwnerUpdate({ workspace, stateRoot, entryScript, version: "3.0.0-test.5" }, { controlRoot });
    assert.throws(() => stale.commit(), /transaction changed/);
    replacement.rollback();
  } finally {
    removeTestTree(root);
  }
}

function removeTestTree(root) {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

function loadOwnerFailure(options) {
  try { loadCommittedServiceOwner(options); } catch (error) { return String(error?.message || error); }
  return "";
}

async function serviceInstallOwnerCommitTest() {
  const root = mkdtempSync(path.join(os.tmpdir(), "mbm-service-install-owner-"));
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  const entryScript = path.join(root, "machine-mcp.mjs");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(stateRoot, { recursive: true });
  writeFileSync(entryScript, "export {};\n", { mode: 0o600 });
  const spec = { workspace, stateRoot, entryScript, version: "3.0.0-test" };
  const events = [];
  try {
    const successful = await installAutostart({
      ...spec,
      installProvider: async () => { events.push("provider:ok"); return { ok: true, provider: "test" }; },
      beginOwnerUpdate: () => ({
        commit() { events.push("owner:commit"); return { status: "committed", version: spec.version }; },
        rollback() { events.push("owner:rollback"); },
      }),
    });
    assert.equal(successful.ok, true);
    assert.deepEqual(events, ["provider:ok", "owner:commit"]);
    assert.equal(existsSync(path.join(stateRoot, "service-environment.json")), true,
      "service install did not persist its environment inside the isolated state root");

    events.length = 0;
    const pendingOwner = {
      status: "pending", version: spec.version, workspace, stateRoot, entryScript,
    };
    const deferred = await installAutostart({
      ...spec,
      deferOwnerCommit: true,
      installProvider: async () => { events.push("provider:deferred"); return { ok: true, provider: "test" }; },
      beginOwnerUpdate: () => ({
        owner: pendingOwner,
        commit() { events.push("owner:deferred-commit"); return { ...pendingOwner, status: "committed" }; },
        rollback() { events.push("owner:deferred-rollback"); return true; },
      }),
    });
    assert.equal(deferred.service_owner.status, "pending");
    assert.equal(deferred.serviceOwnerTransaction.owner, pendingOwner);
    assert.deepEqual(events, ["provider:deferred"],
      "deferred service install committed ownership before provider activation/readiness verification");
    assert.equal(Object.keys(deferred).includes("serviceOwnerTransaction"), false,
      "internal deferred owner transaction leaked into enumerable service output");
    assert.equal(deferred.serviceOwnerTransaction.commit().status, "committed");
    assert.deepEqual(events, ["provider:deferred", "owner:deferred-commit"]);

    events.length = 0;
    await assert.rejects(() => installAutostart({
      ...spec,
      writeEnvironment: () => { events.push("environment:failed"); throw new Error("environment denied"); },
      installProvider: async () => { events.push("provider:must-not-run"); return { ok: true }; },
      beginOwnerUpdate: () => ({
        commit() { throw new Error("must not commit"); },
        rollback() { events.push("owner:rollback"); },
      }),
    }), /environment denied/);
    assert.deepEqual(events, ["environment:failed", "owner:rollback"],
      "service environment failure reached provider mutation or failed to restore the previous owner");

    events.length = 0;
    const failed = await installAutostart({
      ...spec,
      installProvider: async () => { events.push("provider:failed"); return { ok: false, provider: "test" }; },
      beginOwnerUpdate: () => ({ commit() { throw new Error("must not commit"); }, rollback() { events.push("owner:rollback"); } }),
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.service_owner.status, "pending");
    assert.deepEqual(events, ["provider:failed"],
      "partial provider failure rolled the owner back to a potentially mismatched previous definition");

    events.length = 0;
    await assert.rejects(() => installAutostart({
      ...spec,
      installProvider: async () => { throw new Error("provider threw"); },
      beginOwnerUpdate: () => ({ commit() { throw new Error("must not commit"); }, rollback() { events.push("owner:rollback"); } }),
    }), /owner became pending/);
    assert.deepEqual(events, [], "provider exception rolled back an owner after side effects became ambiguous");

    events.length = 0;
    await assert.rejects(() => installAutostart({
      ...spec,
      installProvider: async () => ({ ok: true, provider: "test" }),
      beginOwnerUpdate: () => ({
        commit() { events.push("owner:commit-failed"); throw new Error("disk full"); },
        rollback() { events.push("owner:rollback"); },
      }),
    }), /pending owner was retained/);
    assert.deepEqual(events, ["owner:commit-failed"],
      "provider commit failure rolled the owner back to a definition that no longer matches the installed service");
  } finally {
    removeTestTree(root);
  }
}

async function ownedServiceRuntimeTest() {
  const owner = { status: "committed", workspace: "/workspace", stateRoot: "/state", entryScript: "/entry", version: "3.0.0-test" };
  let checks = 0;
  let stopped = 0;
  let providerStarted = false;
  const ready = await convergeOwnedServiceRuntime({
    owner,
    loadState: () => ({ workspace: { path: "/workspace" } }),
    inspectDaemon: () => {
      if (!providerStarted) return { alive: false, verified_service_daemon: false, startup_readiness_verified: false };
      checks += 1;
      return checks < 3
        ? { alive: true, verified_service_daemon: true, mode: "service", startup_readiness_verified: false }
        : { alive: true, verified_service_daemon: true, mode: "service", startup_readiness_verified: true, pid: 44 };
    },
    readProvider: async () => ({ active: false, provider: "test" }),
    mutateProvider: async () => { providerStarted = true; return { ok: true, active: true, provider: "test" }; },
    stopProvider: async () => { stopped += 1; return { ok: true, active: false }; },
    attempts: 4, sleep: async () => {},
  });
  assert.equal(ready.ok, true);
  assert.equal(ready.daemon.pid, 44);
  assert.equal(stopped, 0);

  let failedChecks = 0;
  const failed = await convergeOwnedServiceRuntime({
    owner, loadState: () => ({}),
    inspectDaemon: () => { failedChecks += 1; return { alive: false, verified_service_daemon: false }; },
    readProvider: async () => ({ active: false, provider: "test" }),
    mutateProvider: async () => ({ ok: true, active: true, provider: "test" }),
    stopProvider: async () => { stopped += 1; return { ok: true, active: false, provider: "test" }; },
    attempts: 2, sleep: async () => {},
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, "daemon_not_running");
  assert.equal(stopped, 1, "failed owned service convergence did not stop the provider");
  assert.equal(failedChecks, 3);

  const cleanupUnverified = await convergeOwnedServiceRuntime({
    owner, loadState: () => ({}), inspectDaemon: () => ({ alive: false }),
    readProvider: async () => ({ active: false, provider: "test" }),
    mutateProvider: async () => ({ ok: true, active: true, provider: "test" }),
    stopProvider: async () => ({ ok: false, active: true, provider: "test" }),
    attempts: 1, sleep: async () => {},
  });
  assert.equal(cleanupUnverified.active, true);
  assert.match(cleanupUnverified.reason, /provider_stop_unverified/);
  await assert.rejects(() => convergeOwnedServiceRuntime({
    owner, loadState: () => ({}), inspectDaemon: () => ({ alive: false }),
    readProvider: async () => ({ active: null }), mutateProvider: async () => ({}), stopProvider: async () => ({}),
  }), /activity could not be verified/);

  const mismatch = await waitForOwnedServiceDaemon({
    inspectDaemon: () => ({ alive: true, verified_service_daemon: false, identity_reason: "entrypoint_mismatch" }),
    attempts: 3, sleep: async () => {},
  });
  assert.equal(mismatch.reason, "daemon_identity_entrypoint_mismatch");
  await assert.rejects(() => waitForOwnedServiceDaemon({ attempts: 0, inspectDaemon: () => ({}) }), /between 1 and 1800/);
  await assert.rejects(() => waitForOwnedServiceDaemon({ inspectDaemon: null }), /requires inspectDaemon/);

  const readyDaemon = { alive: true, verified_service_daemon: true, mode: "service", startup_readiness_verified: true, pid: 55 };
  const already = await startOwnedServiceRuntime({
    owner, loadState: () => ({}), inspectDaemon: () => readyDaemon,
    readProvider: async () => ({ active: true, provider: "test" }),
    mutateProvider: async () => { throw new Error("already-ready provider was mutated"); },
  });
  assert.equal(already.already_running, true);

  let restartMutations = 0;
  const restartDaemons = [readyDaemon, readyDaemon, { ...readyDaemon, pid: 56 }];
  const restarted = await restartOwnedServiceRuntime({
    owner, loadState: () => ({}), inspectDaemon: () => restartDaemons.shift() || { ...readyDaemon, pid: 56 },
    readProvider: async () => ({ active: true, provider: "test" }),
    mutateProvider: async () => { restartMutations += 1; return { ok: true, active: true, provider: "test", restarted: true }; },
    stopProvider: async () => { throw new Error("verified restart unexpectedly stopped the provider"); },
    attempts: 3, sleep: async () => {},
  });
  assert.equal(restartMutations, 1, "ready owned service restart skipped its provider mutation");
  assert.equal(restarted.ok, true);
  assert.equal(restarted.daemon.pid, 56);
  assert.equal(restarted.readiness_attempts, 2, "restart accepted the pre-restart daemon identity");

  const noRestartEvidence = await restartOwnedServiceRuntime({
    owner, loadState: () => ({}), inspectDaemon: () => readyDaemon,
    readProvider: async () => ({ active: true, provider: "test" }),
    mutateProvider: async () => ({ ok: true, active: true, provider: "test", restarted: false }),
  });
  assert.equal(noRestartEvidence.ok, false);
  assert.equal(noRestartEvidence.reason, "restart_not_verified");

  const replacementMissing = await waitForOwnedServiceDaemon({
    inspectDaemon: () => readyDaemon, replacementPid: 55, attempts: 2, sleep: async () => {},
  });
  assert.equal(replacementMissing.ok, false);
  assert.equal(replacementMissing.reason, "daemon_replacement_not_observed");

  const restartFailed = await restartOwnedServiceRuntime({
    owner, loadState: () => ({}), inspectDaemon: () => ({ alive: false }),
    readProvider: async () => ({ active: false, provider: "test" }),
    mutateProvider: async () => ({ ok: false, active: false, provider: "test", reason: "synthetic" }),
  });
  assert.equal(restartFailed.ok, false);
  await assert.rejects(() => convergeOwnedServiceRuntime({
    loadOwner: () => null, loadState: () => ({}), inspectDaemon: () => ({}),
    readProvider: async () => ({}), mutateProvider: async () => ({}), stopProvider: async () => ({}),
  }), /owner is unavailable/);
  await assert.rejects(() => convergeOwnedServiceRuntime({
    owner, loadState: () => ({}), inspectDaemon: () => ({ alive: true, verified_service_daemon: false, mode: "service", identity_reason: "command_mismatch" }),
    readProvider: async () => ({ active: true }), mutateProvider: async () => ({}), stopProvider: async () => ({}),
  }), /command_mismatch daemon/);
  await assert.rejects(() => convergeOwnedServiceRuntime({
    owner, loadState: () => ({}), inspectDaemon: () => ({ alive: true, verified_service_daemon: true, mode: "service", startup_readiness_verified: false }),
    readProvider: async () => ({ active: false }), mutateProvider: async () => ({}), stopProvider: async () => ({}),
  }), /orphaned service daemon/);
  await assert.rejects(() => convergeOwnedServiceRuntime({ owner, mutateProvider: null }), /requires mutateProvider/);

  const unready = await waitForOwnedServiceDaemon({
    inspectDaemon: () => ({ alive: true, verified_service_daemon: true, mode: "service", startup_readiness_verified: false }),
    attempts: 2, delayMs: 1,
  });
  assert.equal(unready.reason, "daemon_readiness_not_verified");
}

async function windowsConvergenceBoundaryTest() {
  await assert.rejects(() => stableWindowsStatus(null), /reader is required/);
  await assert.rejects(() => waitForWindowsStatus(null, () => true), /reader is required/);
  await assert.rejects(() => waitForWindowsStatus(async () => ({}), null), /predicate is required/);
  let reads = 0;
  const waited = await waitForWindowsStatus(
    async () => ({ active: ++reads >= 2 }), status => status.active === true,
    { statusAttempts: 3, statusDelayMs: 1 },
  );
  assert.equal(waited.active, true);
  assert.equal(windowsStatusWaitOptions({}).sleep, undefined);
  assert.equal(boundedPositiveInteger(0, 7), 7);
  assert.equal(boundedPositiveInteger(2.9, 7), 2);
}

function windowsLauncherLiveTest() {
  const root = mkdtempSync(path.join(os.tmpdir(), "mbm windows & launcher "));
  try {
    const fixture = path.join(root, "fixture.mjs");
    const marker = path.join(root, "marker-100%.txt");
    writeFileSync(fixture, 'import { writeFileSync } from "node:fs"; writeFileSync(process.argv[2], "ok");\n');
    const launcher = writeWindowsLauncher({
      node: process.execPath,
      daemonArgs: [fixture, marker],
      stateRoot: root,
      stdout: path.join(root, "daemon.out.log"),
      stderr: path.join(root, "daemon.err.log"),
    });
    execFileSync(
      process.env.ComSpec || "cmd.exe",
      ["/d", "/c", `call "${launcher.path}"`],
      { windowsHide: true, windowsVerbatimArguments: true },
    );
    assert.equal(existsSync(marker), true, "real cmd.exe did not execute the generated launcher with quoted special-character paths");
  } finally {
    removeTestTree(root);
  }
}

async function windowsInstallTest() {
  const root = mkdtempSync(path.join(os.tmpdir(), "mbm-windows-service-"));
  try {
    const calls = [];
    const spec = {
      ...representativeSpec,
      stateRoot: root,
      stdout: path.join(root, "daemon.out.log"),
      stderr: path.join(root, "daemon.err.log"),
    };
    const result = await installWindowsTask(spec, quietLogger(), {
      run: async (command, args) => {
        calls.push({ command, args });
        if (command === "schtasks") return { code: 0, stdout: "created", stderr: "" };
        return scheduledTaskResult("Ready");
      },
    });
    assert.equal(result.ok, true);
    const create = calls.find(call => call.command === "schtasks");
    assert(create, "Windows task creation was not attempted");
    assert(create.args.includes("/RL") && create.args.includes("LIMITED"), "Windows task was not constrained to least privilege");
    const action = create.args[create.args.indexOf("/TR") + 1];
    assert(action.length <= 262, "installed Windows task action exceeded the platform limit");
    const launcher = readFileSync(result.launcher, "utf8");
    assert(launcher.includes("--daemon-only"), "installed launcher omitted daemon startup arguments");
  } finally {
    removeTestTree(root);
  }
}

async function windowsStatusTest() {
  const ready = await statusWindowsTask({ run: async () => scheduledTaskResult("Ready") });
  assert.deepEqual({ installed: ready.installed, active: ready.active, state: ready.state }, { installed: true, active: false, state: "ready" });
  const running = await statusWindowsTask({ run: async () => scheduledTaskResult("Running") });
  assert.equal(running.active, true);
  const missing = await statusWindowsTask({ run: async () => ({ code: 3, stdout: "", stderr: "localized missing task message" }) });
  assert.equal(missing.installed, false, "missing task depended on localized output parsing");
}

async function windowsStartTest() {
  let queries = 0;
  const result = await startWindowsTask(quietLogger(), {
    sleep: async () => {},
    run: async (command) => {
      if (command === "schtasks") return { code: 1, stdout: "", stderr: "localized output" };
      queries += 1;
      return scheduledTaskResult(queries >= 2 ? "Running" : "Ready", queries >= 2 ? "2026-07-16T00:00:01.0000000Z" : "2026-07-16T00:00:00.0000000Z");
    },
  });
  assert.equal(result.ok, true, "Windows start trusted localized schtasks output over observed task state");
  assert.equal(result.status.active, true);
  assert.equal(result.active_before, false);
  assert.equal(result.active, true);
}

async function windowsCompletedStartTest() {
  let queries = 0;
  const result = await startWindowsTask(quietLogger(), {
    sleep: async () => {},
    run: async (command) => {
      if (command === "schtasks") return { code: 0, stdout: "", stderr: "" };
      queries += 1;
      return scheduledTaskResult(
        "Ready",
        queries >= 2 ? "2026-07-16T00:00:01.0000000Z" : "2026-07-16T00:00:00.0000000Z",
        0,
      );
    },
  });
  assert.equal(result.ok, false, "a completed Windows task was accepted as a persistent service start");
  assert.equal(result.reason, "completed_without_persistence");
  assert.equal(result.active, false, "completed Windows task was misreported as a persistent active service");
}

async function windowsTransientStartTest() {
  let queries = 0;
  const result = await startWindowsTask(quietLogger(), {
    sleep: async () => {},
    stableSamples: 3,
    statusAttempts: 5,
    run: async (command) => {
      if (command === "schtasks") return { code: 0, stdout: "", stderr: "" };
      queries += 1;
      if (queries === 1) return scheduledTaskResult("Ready", "2026-07-16T00:00:00.0000000Z");
      if (queries === 2) return scheduledTaskResult("Running", "2026-07-16T00:00:01.0000000Z");
      return scheduledTaskResult("Ready", "2026-07-16T00:00:01.0000000Z", 0);
    },
  });
  assert.equal(result.ok, false, "a transient Windows Running sample was accepted as persistent service evidence");
  assert.equal(result.active, false);
  assert.equal(result.reason, "completed_without_persistence");
}

async function windowsUnknownStatusTest() {
  const unavailable = async () => ({ code: 1, stdout: "", stderr: "query failed" });
  const started = await startWindowsTask(quietLogger(), { run: unavailable });
  assert.equal(started.ok, false);
  assert.equal(started.reason, "task_status_unavailable");
  const stopped = await stopWindowsTask(quietLogger(), { run: unavailable });
  assert.equal(stopped.ok, false);
  assert.equal(stopped.reason, "task_status_unavailable");
}

async function windowsStopTest() {
  let queries = 0;
  const result = await stopWindowsTask(quietLogger(), {
    sleep: async () => {},
    run: async (command) => {
      if (command === "schtasks") return { code: 1, stdout: "", stderr: "non-English output" };
      queries += 1;
      return scheduledTaskResult(queries >= 2 ? "Ready" : "Running");
    },
  });
  assert.equal(result.ok, true, "Windows stop trusted a localized schtasks exit message over observed task state");
  assert.equal(result.active, false);
  assert.equal(result.restore_required, true);
}

async function windowsUninstallTest() {
  let deleted = false;
  const result = await uninstallWindowsTask(quietLogger(), {
    sleep: async () => {},
    run: async (command, args) => {
      if (command === "schtasks" && args[0] === "/Delete") {
        deleted = true;
        return { code: 1, stdout: "", stderr: "localized output" };
      }
      if (command === "powershell.exe") {
        return deleted
          ? { code: 3, stdout: "", stderr: "" }
          : scheduledTaskResult("Ready");
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(result.ok, true, "Windows removal depended on localized schtasks output");
  assert.equal(result.status.installed, false);
}

async function windowsLauncherRemovalTest() {
  const root = mkdtempSync(path.join(os.tmpdir(), "mbm-windows-launcher-remove-"));
  const launcher = path.join(root, "service-launcher.cmd");
  try {
    writeFileSync(launcher, "original launcher\n", { mode: 0o600 });
    let deleted = false;
    const removed = await uninstallWindowsTask(quietLogger(), {
      stateRoot: root,
      sleep: async () => {},
      run: async (command, args) => {
        if (command === "schtasks" && args[0] === "/Delete") { deleted = true; return { code: 0, stdout: "", stderr: "" }; }
        if (command === "powershell.exe") return deleted ? { code: 3, stdout: "", stderr: "" } : scheduledTaskResult("Ready");
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    assert.equal(removed.ok, true, "Windows task removal did not settle after deleting its launcher");
    assert.equal(existsSync(launcher), false, "Windows service uninstall retained its unchanged launcher");
  } finally { removeTestTree(root); }
}

async function windowsLauncherReplacementRemovalTest() {
  const root = mkdtempSync(path.join(os.tmpdir(), "mbm-windows-launcher-replace-"));
  const launcher = path.join(root, "service-launcher.cmd");
  try {
    writeFileSync(launcher, "second launcher\n", { mode: 0o600 });
    let deleted = false;
    const replaced = await uninstallWindowsTask(quietLogger(), {
      stateRoot: root,
      sleep: async () => {},
      run: async (command, args) => {
        if (command === "schtasks" && args[0] === "/Delete") {
          deleted = true;
          rmSync(launcher, { force: true });
          writeFileSync(launcher, "replacement launcher\n", { mode: 0o600 });
          return { code: 0, stdout: "", stderr: "" };
        }
        if (command === "powershell.exe") return deleted ? { code: 3, stdout: "", stderr: "" } : scheduledTaskResult("Ready");
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    assert.equal(replaced.ok, false, "Windows uninstall accepted a replaced launcher as removed");
    assert.equal(replaced.reason, "launcher_changed");
    assert.equal(readFileSync(launcher, "utf8"), "replacement launcher\n",
      "Windows uninstall deleted a replacement launcher");
  } finally { removeTestTree(root); }
}

async function systemdRemovalDecisionTest() {
  const inactive = { installed: true, active: false, state: "inactive" };
  assert.deepEqual(systemdRemovalDecision({ definitionPresent: true, disableCode: 0, status: inactive }),
    { removable: true, alreadyAbsent: false, reason: "disabled" });
  assert.equal(systemdRemovalDecision({ definitionPresent: true, disableCode: 1, status: inactive }).reason, "disable_failed",
    "nonzero systemd disable became removable for an installed definition");
  assert.equal(systemdRemovalDecision({ definitionPresent: true, disableCode: 1, status: { ...inactive, stderr: "not found" } }).removable, false,
    "systemd removal trusted stderr prose over command/status evidence");
  assert.deepEqual(systemdRemovalDecision({ definitionPresent: false, disableCode: 1, status: { installed: false, active: false, state: "unknown" } }),
    { removable: true, alreadyAbsent: true, reason: "already_absent" });
  for (const state of ["active", "activating", "deactivating", "reloading", "maintenance"]) {
    const decision = systemdRemovalDecision({ definitionPresent: true, disableCode: 0, status: { installed: true, active: state === "active", state } });
    assert.equal(decision.removable, false, `systemd ${state} state was treated as removable`);
  }
}

async function systemdStopContractTest() {
  const calls = [];
  const statuses = [
    { installed: true, active: true, state: "active" },
    { installed: true, active: false, state: "inactive" },
  ];
  const stopped = await stopSystemdService(quietLogger(), {
    readStatus: async () => statuses.shift(),
    run: async (command, args) => {
      calls.push([command, ...args].join(" "));
      return { code: 1, stdout: "", stderr: "localized output" };
    },
    waitForInactive: async readStatus => readStatus(),
  });
  assert.equal(stopped.ok, true, "systemd stop trusted command output over observed inactive state");
  assert.equal(stopped.active_before, true);
  assert.equal(stopped.active, false);
  assert.equal(stopped.restore_required, true, "systemd stop omitted provider restoration evidence");
  assert.equal(calls.length, 1);

  const missingButActiveStatuses = [
    { installed: false, active: true, state: "active" },
    { installed: false, active: false, state: "unknown" },
  ];
  let missingButActiveStops = 0;
  const missingButActive = await stopSystemdService(quietLogger(), {
    readStatus: async () => missingButActiveStatuses.shift(),
    run: async () => { missingButActiveStops += 1; return { code: 0, stdout: "", stderr: "" }; },
    waitForInactive: async readStatus => readStatus(),
  });
  assert.equal(missingButActive.ok, true);
  assert.equal(missingButActiveStops, 1, "missing systemd definition incorrectly implied the loaded service was inactive");

  const transitioningStatuses = [
    { installed: true, active: false, state: "activating" },
    { installed: true, active: false, state: "inactive" },
  ];
  const transitioning = await stopSystemdService(quietLogger(), {
    readStatus: async () => transitioningStatuses.shift(),
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    waitForInactive: async readStatus => readStatus(),
  });
  assert.equal(transitioning.ok, true);
  assert.equal(transitioning.active_before, false);
  assert.equal(transitioning.restore_required, true,
    "systemd activating state lost the evidence needed to restore provider ownership");

  let inactiveCommands = 0;
  const inactive = await stopSystemdService(quietLogger(), {
    readStatus: async () => ({ installed: true, active: false, state: "failed" }),
    run: async () => { inactiveCommands += 1; return { code: 0 }; },
  });
  assert.equal(inactive.ok, true);
  assert.equal(inactive.restore_required, false);
  assert.equal(inactiveCommands, 0, "inactive systemd service was mutated unnecessarily");

  let unknownCommands = 0;
  const unknown = await stopSystemdService(quietLogger(), {
    readStatus: async () => ({ installed: true, active: false, state: "unknown" }),
    run: async () => { unknownCommands += 1; return { code: 0 }; },
  });
  assert.equal(unknown.ok, false, "unknown systemd state was treated as safely stopped");
  assert.equal(unknown.reason, "status_unavailable");
  assert.equal(unknownCommands, 0, "ambiguous systemd state was mutated before diagnosis");

  let maintenanceCommands = 0;
  const maintenance = await stopSystemdService(quietLogger(), {
    readStatus: async () => ({ installed: true, active: false, state: "maintenance" }),
    run: async () => { maintenanceCommands += 1; return { code: 0 }; },
  });
  assert.equal(maintenance.ok, false, "systemd maintenance state was treated as safely stoppable");
  assert.equal(maintenance.reason, "status_unavailable");
  assert.equal(maintenanceCommands, 0, "systemd maintenance state was mutated before diagnosis");
}

async function launchdStatusContractTest() {
  const missing = launchdStatusSummary({
    installed: true, definition: "dev.machine-bridge-mcp.daemon",
    result: { code: LAUNCHD_MISSING_SERVICE_CODE, stdout: "", stderr: "localized not-found output" },
  });
  assert.equal(missing.loaded, false);
  assert.equal(missing.active, false);
  assert.equal(missing.state, "inactive");
  assert.equal(missing.status_available, true);
  assert.equal(missing.status_query_code, LAUNCHD_MISSING_SERVICE_CODE);

  const unavailable = launchdStatusSummary({
    installed: true, definition: "dev.machine-bridge-mcp.daemon",
    result: { code: 5, stdout: "state = running\npid = 123\nruns = 9\n", stderr: "permission or provider failure" },
  });
  assert.equal(unavailable.loaded, false, "failed launchctl print output was treated as loaded state");
  assert.equal(unavailable.active, null);
  assert.equal(unavailable.state, "unknown");
  assert.equal(unavailable.status_available, false, "arbitrary launchctl failure was treated as safe absence");
  assert.equal(unavailable.pid, null, "untrusted failed-query stdout leaked into launchd status evidence");

  const running = launchdStatusSummary({
    installed: true, definition: "dev.machine-bridge-mcp.daemon",
    result: { code: 0, stdout: "state = running\npid = 123\nruns = 9\n", stderr: "" },
  });
  assert.equal(running.loaded, true);
  assert.equal(running.active, true);
  assert.equal(running.status_available, true);
  assert.equal(running.pid, 123);
}

async function launchdStopContractTest() {
  let unavailableCommands = 0;
  const unavailable = await stopLaunchdService(quietLogger(), {
    uid: "not-needed-before-mutation",
    readStatus: async () => ({ installed: true, loaded: false, active: false, state: "unknown", status_available: false, status_query_code: 5 }),
    run: async () => { unavailableCommands += 1; return { code: 0, stdout: "", stderr: "" }; },
  });
  assert.equal(unavailable.ok, false, "ambiguous launchd status was treated as safely stopped");
  assert.equal(unavailable.reason, "status_unavailable");
  assert.equal(unavailableCommands, 0, "ambiguous launchd status mutated the provider before diagnosis");

  const absent = await stopLaunchdService(quietLogger(), {
    uid: "not-needed-before-mutation",
    readStatus: async () => ({ installed: true, loaded: false, active: false, state: "inactive", status_available: true, status_query_code: LAUNCHD_MISSING_SERVICE_CODE }),
  });
  assert.equal(absent.ok, true);
  assert.equal(absent.already_stopped, true);
  assert.equal(absent.restore_required, false);

  const stoppedStatuses = [
    { installed: true, loaded: true, active: true, state: "running", status_available: true, status_query_code: 0 },
    { installed: true, loaded: false, active: false, state: "inactive", status_available: true, status_query_code: LAUNCHD_MISSING_SERVICE_CODE },
  ];
  const stopCommands = [];
  const stopped = await stopLaunchdService(quietLogger(), {
    uid: 501,
    readStatus: async () => stoppedStatuses.shift(),
    run: async (command, args) => { stopCommands.push([command, ...args].join(" ")); return { code: 0, stdout: "", stderr: "" }; },
    waitForUnloaded: async readStatus => readStatus(),
  });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.loaded, false);
  assert.equal(stopped.active, false);
  assert.equal(stopped.restore_required, true);
  assert.equal(stopCommands.length, 1);
  assert.equal(stopCommands[0], "launchctl bootout gui/501/dev.machine-bridge-mcp.daemon");

  const stillLoadedStatuses = [
    { installed: true, loaded: true, active: true, state: "running", status_available: true, status_query_code: 0 },
    { installed: true, loaded: true, active: false, state: "exited", status_available: true, status_query_code: 0 },
  ];
  const stillLoaded = await stopLaunchdService(quietLogger(), {
    uid: 501,
    readStatus: async () => stillLoadedStatuses.shift(),
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    waitForUnloaded: async readStatus => readStatus(),
  });
  assert.equal(stillLoaded.ok, false, "inactive but still-loaded launchd service was accepted as stopped");
  assert.equal(stillLoaded.reason, "stop_not_observed");
  assert.equal(stillLoaded.loaded, true);
  assert.equal(stillLoaded.restore_required, true,
    "ambiguous launchd bootout lost rollback obligation for an initially active service");
  assert.equal(stillLoaded.mutation_attempted, true);

  const lostStatus = await stopLaunchdService(quietLogger(), {
    uid: 501,
    readStatus: async () => ({ installed: true, loaded: true, active: true, state: "running", status_available: true, status_query_code: 0 }),
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    waitForUnloaded: async () => ({ installed: true, loaded: false, active: false, state: "unknown", status_available: false, status_query_code: 5 }),
  });
  assert.equal(lostStatus.ok, false, "post-bootout launchd status failure was treated as verified stop");
  assert.equal(lostStatus.reason, "stop_not_observed");
  assert.equal(lostStatus.restore_required, true,
    "post-bootout status loss forgot that the previous active service may still disappear");
}

async function delayedLaunchdStopTest() {
  const statuses = [{ active: true }, { active: true }, { active: false }];
  const sleeps = [];
  const result = await waitForInactiveStatus(
    async () => statuses.shift(),
    { attempts: 5, delayMs: 25, sleep: async milliseconds => sleeps.push(milliseconds) },
  );
  assert.equal(result.active, false);
  assert.equal(sleeps.join(","), "25,25");
}

async function stuckLaunchdStopTest() {
  let reads = 0;
  const result = await waitForInactiveStatus(
    async () => { reads += 1; return { active: true }; },
    { attempts: 3, delayMs: 1, sleep: async () => {} },
  );
  assert.equal(result.active, true);
  assert.equal(reads, 3);
}

function scheduledTaskResult(state, lastRunTime = "2026-07-16T00:00:00.0000000Z", lastResult = 0) {
  return {
    code: 0,
    stdout: JSON.stringify({ state, last_result: lastResult, last_run_time: lastRunTime }),
    stderr: "",
  };
}

function quietLogger() {
  return { info() {}, warn() {} };
}
