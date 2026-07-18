import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runExecutable } from "../src/local/shell.mjs";
import { acquireDaemonLockWithTakeover, inspectWorkspaceDaemon, stopWorkspaceServiceDaemon } from "../src/local/daemon-process.mjs";
import { isIdempotentDaemonOnlyStart, isSupportedNodeVersion, isSupportedNpmVersion, npmVersionCommand, parseArgs, resolvePolicy, validateCommandOptions, validateLoggingOptions, validatePositionals, workerHealthUserReason } from "../src/local/cli.mjs";
import { runtimeSelfTest } from "./runtime-self-test.mjs";
import { classifyOperationalError, formatFields, sanitizeLogText } from "../src/local/log.mjs";
import { ManagedJobManager } from "../src/local/managed-jobs.mjs";
import { knownProfileStates, knownWorkerNames } from "../src/local/state-inventory.mjs";
import { daemonArgs, launchdPlist, launchdServiceTarget, normalizeServiceCommandResult, serviceEnvironmentPath, stableNodeExecutable, systemdQuote, systemdUnit, trimAutostartLogs } from "../src/local/service.mjs";
import { allToolNames, assertCanonicalFullPolicy, MCP_PROTOCOL_VERSION, toolsForPolicy } from "../src/local/tools.mjs";
import { acquireDaemonLock, acquireStartupLock, defaultFirstRunWorkspace, ensureWorkerSecrets, ensureWorkspaceDirectory, loadGlobalConfig, loadState, previewSecret, redactState, removeStateRoot, resolveWorkspace, saveState, selectedWorkspace, setSelectedWorkspace, validateStateRootForRemoval } from "../src/local/state.mjs";

await runtimeSelfTest();
await stateSelfTest();
await daemonTakeoverSelfTest();
await activeDaemonPolicyMutationSelfTest();
await clientConfigDefaultSelfTest();
await resourceCliSelfTest();
await cliSelfTest();
await logSelfTest();
await serviceSelfTest();
await ciBootstrapSelfTest();
await shellSelfTest();
await workerSourceSelfTest();
console.log("local daemon/state/cli/log/service/worker self-test ok");

async function stateSelfTest() {
  const defaultWorkspaceHome = await mkdtemp(join(tmpdir(), "mbm-default-workspace-home-"));
  try {
    const windowsDefault = defaultFirstRunWorkspace({ platform: "win32", home: defaultWorkspaceHome, cwd: join(defaultWorkspaceHome, "ignored-cwd") });
    if (windowsDefault !== join(defaultWorkspaceHome, "MachineBridge")) throw new Error("Windows first-run workspace did not use the dedicated home directory");
    const created = ensureWorkspaceDirectory(windowsDefault);
    if (created !== await realpath(windowsDefault)) throw new Error("Windows first-run workspace was not created and canonicalized");
    const posixCwd = join(defaultWorkspaceHome, "posix-cwd");
    await mkdir(posixCwd);
    if (defaultFirstRunWorkspace({ platform: "linux", home: defaultWorkspaceHome, cwd: posixCwd }) !== posixCwd) {
      throw new Error("non-Windows first-run workspace no longer preserves the current-directory default");
    }
  } finally {
    await rm(defaultWorkspaceHome, { recursive: true, force: true });
  }

  const unsafeCombinedRoot = await mkdtemp(join(tmpdir(), "mbm-state-workspace-collision-"));
  try {
    expectThrow(() => loadState(unsafeCombinedRoot, { stateDir: unsafeCombinedRoot }), "must be separate");
    if ((await readdir(unsafeCombinedRoot)).length !== 0) throw new Error("unsafe state/workspace collision created state before rejection");
  } finally {
    await rm(unsafeCombinedRoot, { recursive: true, force: true });
  }
  const nestedWorkspace = await mkdtemp(join(tmpdir(), "mbm-state-nested-workspace-"));
  try {
    const nestedState = join(nestedWorkspace, ".machine-state");
    expectThrow(() => loadState(nestedWorkspace, { stateDir: nestedState }), "must be separate");
    if (await existsForSelfTest(nestedState)) throw new Error("state directory was created inside the workspace before rejection");
  } finally {
    await rm(nestedWorkspace, { recursive: true, force: true });
  }
  const containingStateRoot = await mkdtemp(join(tmpdir(), "mbm-state-containing-root-"));
  try {
    const containedWorkspace = join(containingStateRoot, "workspace");
    await mkdir(containedWorkspace, { recursive: true });
    expectThrow(() => loadState(containedWorkspace, { stateDir: containingStateRoot }), "must be separate");
  } finally {
    await rm(containingStateRoot, { recursive: true, force: true });
  }
  const stateRoot = await mkdtemp(join(tmpdir(), "mbm-state-test-"));
  const workspace = await mkdtemp(join(tmpdir(), "mbm-state-workspace-"));
  try {
    const canonicalWorkspace = resolveWorkspace(workspace);
    setSelectedWorkspace(workspace, stateRoot);
    if (selectedWorkspace(stateRoot) !== canonicalWorkspace) throw new Error("selected workspace was not persisted canonically");
    const state = loadState(workspace, { stateDir: stateRoot });
    if (state.schemaVersion !== 6) throw new Error("unexpected state schema version");
    ensureWorkerSecrets(state, { rotateSecrets: true });
    state.oversized = "x".repeat(2 * 1024 * 1024 + 1);
    expectThrow(() => saveState(state), "state JSON exceeds");
    delete state.oversized;
    const lock = acquireDaemonLock(state);
    if (!lock.acquired) throw new Error("first daemon lock acquisition failed");
    try {
      const duplicate = acquireDaemonLock(state);
      if (duplicate.acquired) throw new Error("duplicate daemon lock acquisition should fail");
      if (duplicate.owner?.pid !== process.pid) throw new Error("duplicate daemon lock owner was not reported");
    } finally {
      lock.release();
    }
    const relock = acquireDaemonLock(state);
    if (!relock.acquired) throw new Error("daemon lock was not released");
    relock.release();

    const startup = acquireStartupLock(state);
    if (!startup.acquired) throw new Error("startup lock acquisition failed");
    const duplicateStartup = acquireStartupLock(state);
    if (duplicateStartup.acquired) throw new Error("duplicate startup lock acquisition should fail");
    startup.release();
    const startupAgain = acquireStartupLock(state);
    if (!startupAgain.acquired) throw new Error("startup lock was not released");
    startupAgain.release();

    const redacted = redactState(state);
    if (redacted.worker.accountAdminSecret !== "<redacted>") throw new Error("accountAdminSecret was not fully redacted");
    if (redacted.worker.daemonSecret !== "<redacted>") throw new Error("daemonSecret was not fully redacted");
    if (redacted.worker.oauthTokenVersion !== "<redacted>") throw new Error("oauthTokenVersion was not fully redacted");
    if (previewSecret(state.worker.accountAdminSecret) !== "<redacted>") throw new Error("previewSecret did not fully redact secret");
    state.resources = { "private-key": { kind: "file", path: join(workspace, "private-key"), size: 10, mode: "0600" } };
    const resourceRedacted = redactState(state);
    if (resourceRedacted.resources["private-key"].path !== "<local-resource-path>") throw new Error("redacted state exposed a local resource path");

    state.policy = resolvePolicy({ profile: "full" }, {});
    saveState(state);
    const profileEntries = await readdir(state.paths.profileDir);
    if (profileEntries.some(name => name.endsWith(".tmp"))) throw new Error("atomic state write left a temporary file");
    const policyPersisted = loadState(workspace, { stateDir: stateRoot });
    if (policyPersisted.policy.profile !== "full" || policyPersisted.policy.origin !== "explicit" || policyPersisted.policy.revision !== 5) {
      throw new Error("current policy origin/revision was not persisted");
    }

    const backupsBefore = (await readdir(state.paths.profileDir)).filter(name => name.startsWith("state.json.corrupt-"));
    await writeFile(state.paths.statePath, "{not-json", "utf8");
    const recovered = loadState(workspace, { stateDir: stateRoot });
    if (recovered.workspace.path !== canonicalWorkspace) throw new Error("corrupt state recovery failed");
    const backups = (await readdir(state.paths.profileDir)).filter(name => name.startsWith("state.json.corrupt-"));
    if (backups.length !== backupsBefore.length + 1) throw new Error("corrupt state recovery did not create exactly one new backup");
    const newestBackup = backups.find(name => !backupsBefore.includes(name));
    if (!newestBackup || await readFile(join(state.paths.profileDir, newestBackup), "utf8") !== "{not-json") {
      throw new Error("corrupt state backup did not preserve the original bytes");
    }
    await writeFile(join(stateRoot, "config.json"), "{invalid-config", { mode: 0o600 });
    const recoveredConfig = loadGlobalConfig(stateRoot);
    if (recoveredConfig.schemaVersion !== 1) throw new Error("corrupt global config did not recover to the current schema");
    const configBackups = (await readdir(stateRoot)).filter(name => /^config\.json\.corrupt-/.test(name));
    if (configBackups.length !== 1) throw new Error("corrupt global config did not create one bounded backup");


    const corruptWorkerRoot = await mkdtemp(join(tmpdir(), "mbm-worker-name-corrupt-"));
    const corruptWorkerWorkspace = await mkdtemp(join(tmpdir(), "mbm-worker-name-workspace-"));
    try {
      const corruptWorkerState = loadState(corruptWorkerWorkspace, { stateDir: corruptWorkerRoot });
      await writeFile(corruptWorkerState.paths.statePath, "not-json\n", { mode: 0o600 });
      await writeFile(join(corruptWorkerState.paths.profileDir, "daemon.lock"), `${JSON.stringify({
        pid: process.pid,
        token: "synthetic-daemon-lock-token",
        purpose: "daemon",
        workspace: corruptWorkerWorkspace,
        startedAt: new Date().toISOString(),
        processStartedAt: new Date().toISOString(),
        entryScript: "machine-mcp",
      })}\n`, { mode: 0o600 });
      const profileStates = knownProfileStates(corruptWorkerRoot);
      if (profileStates.length !== 1 || profileStates[0].workspace.path !== await realpath(corruptWorkerWorkspace)) {
        throw new Error("daemon-lock workspace recovery did not produce a non-mutating uninstall state");
      }
      if (await readFile(corruptWorkerState.paths.statePath, "utf8") !== "not-json\n") {
        throw new Error("profile discovery mutated corrupt state before Worker-name inspection");
      }
      expectThrow(() => knownWorkerNames(corruptWorkerRoot), "cannot determine deployed Worker");
      if (!await existsForSelfTest(corruptWorkerState.paths.statePath)) throw new Error("worker-name discovery removed unreadable state");
    } finally {
      await rm(corruptWorkerRoot, { recursive: true, force: true });
      await rm(corruptWorkerWorkspace, { recursive: true, force: true });
    }

    const readFailureRoot = await mkdtemp(join(tmpdir(), "mbm-state-read-failure-"));
    const readFailureWorkspace = await mkdtemp(join(tmpdir(), "mbm-state-read-workspace-"));
    try {
      const readFailureState = loadState(readFailureWorkspace, { stateDir: readFailureRoot });
      await writeFile(readFailureState.paths.statePath, "x".repeat(2 * 1024 * 1024 + 1), { mode: 0o600 });
      expectThrow(() => loadState(readFailureWorkspace, { stateDir: readFailureRoot }), "exceeds");
      const oversizedEntries = await readdir(readFailureState.paths.profileDir);
      if (oversizedEntries.some((name) => name.startsWith("state.json.corrupt-"))) throw new Error("oversized state was incorrectly classified as corrupt JSON");
      await writeFile(readFailureState.paths.statePath, Buffer.from([0xc3, 0x28]), { mode: 0o600 });
      expectThrow(() => loadState(readFailureWorkspace, { stateDir: readFailureRoot }), "not valid UTF-8");
      const encodingEntries = await readdir(readFailureState.paths.profileDir);
      if (encodingEntries.some((name) => name.startsWith("state.json.corrupt-"))) throw new Error("invalid UTF-8 state was incorrectly classified as corrupt JSON");
      if (process.platform !== "win32") {
        const outside = join(readFailureRoot, "outside-state.json");
        await writeFile(outside, "{}\n", { mode: 0o600 });
        await rm(readFailureState.paths.statePath, { force: true });
        await symlink(outside, readFailureState.paths.statePath);
        expectThrow(() => loadState(readFailureWorkspace, { stateDir: readFailureRoot }), "must not be a symbolic link");
        if (await readFile(outside, "utf8") !== "{}\n") throw new Error("state symlink read failure modified the target");
      }
    } finally {
      await rm(readFailureRoot, { recursive: true, force: true });
      await rm(readFailureWorkspace, { recursive: true, force: true });
    }
    const removalReadFailureRoot = await mkdtemp(join(tmpdir(), "mbm-removal-read-failure-"));
    const removalReadFailureWorkspace = await mkdtemp(join(tmpdir(), "mbm-removal-read-workspace-"));
    try {
      loadState(removalReadFailureWorkspace, { stateDir: removalReadFailureRoot });
      await writeFile(join(removalReadFailureRoot, "config.json"), "x".repeat(2 * 1024 * 1024 + 1), { mode: 0o600 });
      expectThrow(() => validateStateRootForRemoval(removalReadFailureRoot), "could not be verified before state removal");
      if (!(await stat(join(removalReadFailureRoot, ".machine-bridge-mcp-state"))).isFile()) {
        throw new Error("failed state-root validation modified the state root");
      }
    } finally {
      await rm(removalReadFailureRoot, { recursive: true, force: true });
      await rm(removalReadFailureWorkspace, { recursive: true, force: true });
    }

    await writeFile(join(stateRoot, "browser-bridge.json"), `${JSON.stringify({ token: "synthetic-browser-token-1234567890123456", port: 39393 })}\n`, { mode: 0o600 });
    await writeFile(join(stateRoot, "service-environment.json"), `${JSON.stringify({ schemaVersion: 1, environment: {} })}\n`, { mode: 0o600 });
    await writeFile(join(stateRoot, "service-launcher.cmd"), "@echo off\r\nexit /b 0\r\n", { mode: 0o600 });
    const safeRemoval = validateStateRootForRemoval(stateRoot);
    if (!safeRemoval.exists || safeRemoval.root !== state.paths.stateRoot) throw new Error("safe state root validation failed after corrupt config recovery");

    const obsoleteMarkerRoot = await mkdtemp(join(tmpdir(), "mbm-obsolete-marker-"));
    try {
      await writeFile(join(obsoleteMarkerRoot, ".machine-bridge-mcp-state"), `${JSON.stringify({ app: "machine-bridge-mcp", schema: 1 })}\n`, { mode: 0o600 });
      expectThrow(() => loadState(workspace, { stateDir: obsoleteMarkerRoot }), "schema is obsolete");
    } finally {
      await rm(obsoleteMarkerRoot, { recursive: true, force: true });
    }

    const obsoleteProfileRoot = await mkdtemp(join(tmpdir(), "mbm-obsolete-profile-"));
    const obsoleteProfileWorkspace = await mkdtemp(join(tmpdir(), "mbm-obsolete-profile-workspace-"));
    try {
      const obsoleteState = loadState(obsoleteProfileWorkspace, { stateDir: obsoleteProfileRoot });
      await writeFile(obsoleteState.paths.statePath, `${JSON.stringify({
        schemaVersion: 5,
        workspace: obsoleteState.workspace,
        worker: {},
        policy: {},
        resources: {},
      }, null, 2)}\n`, { mode: 0o600 });
      expectThrow(() => loadState(obsoleteProfileWorkspace, { stateDir: obsoleteProfileRoot }), "schema is obsolete");
    } finally {
      await rm(obsoleteProfileRoot, { recursive: true, force: true });
      await rm(obsoleteProfileWorkspace, { recursive: true, force: true });
    }

    const lookalike = await mkdtemp(join(tmpdir(), "mbm-lookalike-state-"));
    try {
      await import("node:fs/promises").then(({ mkdir }) => mkdir(join(lookalike, "profiles")));
      expectThrow(() => loadState(workspace, { stateDir: lookalike }), "must be empty");
    } finally {
      await rm(lookalike, { recursive: true, force: true }).catch(() => {});
    }

    const unrelated = await mkdtemp(join(tmpdir(), "mbm-unrelated-test-"));
    try {
      await writeFile(join(unrelated, "keep.txt"), "do not delete", "utf8");
      expectThrow(() => validateStateRootForRemoval(unrelated), "unrelated entries");
      if (!(await stat(join(unrelated, "keep.txt"))).isFile()) throw new Error("unsafe state root validation modified unrelated data");
    } finally {
      await rm(unrelated, { recursive: true, force: true }).catch(() => {});
    }
  } finally {
    try { removeStateRoot(stateRoot); } catch { await rm(stateRoot, { recursive: true, force: true }).catch(() => {}); }
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}


async function daemonTakeoverSelfTest() {
  const stateRoot = await mkdtemp(join(tmpdir(), "mbm-takeover-state-"));
  const workspace = await mkdtemp(join(tmpdir(), "mbm-takeover-workspace-"));
  const fixture = join(workspace, "daemon-fixture.mjs");
  const stateModuleUrl = new URL("../src/local/state.mjs", import.meta.url).href;
  await writeFile(fixture, `import { acquireDaemonLock, loadState } from ${JSON.stringify(stateModuleUrl)};
const args = process.argv.slice(2);
const value = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : ""; };
const workspace = value("--workspace") || process.env.MBM_FIXTURE_WORKSPACE;
const stateRoot = value("--state-dir") || process.env.MBM_FIXTURE_STATE_ROOT;
const metadata = { mode: args.includes("--foreground-lock") ? "foreground" : "service", version: "0.18.0" };
const state = loadState(workspace, { stateDir: stateRoot });
const lock = acquireDaemonLock(state, metadata);
if (!lock.acquired) process.exit(3);
process.stdout.write("ready\\n");
process.on("SIGTERM", () => {
  if (args.includes("--ignore-term")) return;
  lock.release();
  process.exit(0);
});
process.on("exit", () => lock.release());
setInterval(() => {}, 2 ** 31 - 1);
`, "utf8");

  let child = null;
  try {
    const state = loadState(workspace, { stateDir: stateRoot });
    child = await startDaemonFixture(fixture, workspace, stateRoot, ["--daemon-only"]);
    const serviceDaemon = inspectWorkspaceDaemon(state);
    if (!serviceDaemon.alive || !serviceDaemon.verified_service_daemon || serviceDaemon.mode !== "service") {
      throw new Error("service daemon was not identified from current lock metadata");
    }

    const immediate = await acquireDaemonLockWithTakeover(state, {
      takeOverServiceOwner: false,
      ownerMetadata: { mode: "foreground", version: "0.11.1" },
    });
    if (immediate.acquired) throw new Error("non-takeover lock attempt replaced a live service daemon");

    const messages = [];
    const foregroundLock = await acquireDaemonLockWithTakeover(state, {
      takeOverServiceOwner: true,
      timeoutMs: 5_000,
      pollMs: 10,
      ownerMetadata: { mode: "foreground", version: "0.11.1" },
      logger: { info(message) { messages.push(message); }, warn(message) { messages.push(message); } },
    });
    await waitForChildExit(child);
    child = null;
    if (!foregroundLock.acquired) throw new Error("foreground takeover did not acquire the service daemon lock");
    if (!messages.some((message) => message.includes("stopping detached background daemon"))
      || !messages.some((message) => message.includes("foreground startup is taking over"))) {
      throw new Error("foreground takeover did not report orphan termination and successful takeover");
    }
    const duplicate = acquireDaemonLock(state);
    if (duplicate.acquired || duplicate.owner?.mode !== "foreground" || duplicate.owner?.version !== "0.11.1") {
      throw new Error("foreground takeover lock metadata was not persisted");
    }
    foregroundLock.release();

    child = await startDaemonFixture(fixture, workspace, stateRoot, ["--daemon-only"], { implicitIdentity: true });
    const implicitService = inspectWorkspaceDaemon(state);
    if (!implicitService.alive || !implicitService.verified_service_daemon || implicitService.identity_reason !== "implicit_service_command") {
      throw new Error("implicit daemon-only recovery process could not be verified for safe takeover");
    }
    const implicitStop = await stopWorkspaceServiceDaemon(state, { timeoutMs: 5_000, pollMs: 10 });
    if (!implicitStop.ok || implicitStop.reason !== "stopped" || !implicitStop.verified_service_daemon) {
      throw new Error("implicit daemon-only recovery process could not be stopped safely");
    }
    await waitForChildExit(child);
    child = null;

    child = await startDaemonFixture(fixture, workspace, stateRoot, ["--daemon-only", "--workspace", workspace], { implicitIdentity: true });
    const partialIdentity = inspectWorkspaceDaemon(state);
    if (!partialIdentity.alive || partialIdentity.verified_service_daemon || partialIdentity.identity_reason !== "command_mismatch") {
      throw new Error("daemon with only one explicit identity argument was accepted for takeover");
    }
    child.kill("SIGTERM");
    await waitForChildExit(child);
    child = null;

    child = await startDaemonFixture(fixture, workspace, stateRoot, ["--foreground-lock"]);
    const foreground = inspectWorkspaceDaemon(state);
    if (!foreground.alive || foreground.verified_service_daemon || foreground.identity_reason !== "foreground_daemon") {
      throw new Error("foreground daemon was misclassified as a service daemon");
    }
    const protectedLock = await acquireDaemonLockWithTakeover(state, {
      takeOverServiceOwner: true,
      timeoutMs: 100,
      pollMs: 5,
      ownerMetadata: { mode: "foreground", version: "0.11.1" },
    });
    if (protectedLock.acquired || !isProcessAlive(child.pid)) throw new Error("foreground daemon was terminated during service takeover");
    child.kill("SIGTERM");
    await waitForChildExit(child);
    child = null;

    child = await startDaemonFixture(fixture, workspace, stateRoot, ["--daemon-only", "--ignore-term"]);
    const stopMessages = [];
    const stopResult = await stopWorkspaceServiceDaemon(state, {
      timeoutMs: 5_000,
      forceAfterMs: 20,
      pollMs: 5,
      logger: { info(message) { stopMessages.push(message); }, warn(message) { stopMessages.push(message); } },
    });
    if (!stopResult.ok || stopResult.reason !== "stopped" || !stopResult.verified_service_daemon || isProcessAlive(child.pid)) {
      throw new Error("verified unresponsive service daemon was not forcibly reclaimed after identity revalidation");
    }
    if (process.platform !== "win32" && (!stopResult.forced || !stopMessages.some((message) => message.includes("forcing process")))) {
      throw new Error("POSIX forced daemon reclamation was not reported or recorded");
    }
    await waitForChildExit(child);
    child = null;
    const stale = acquireDaemonLock(state, { mode: "foreground", version: "0.11.1" });
    if (!stale.acquired) throw new Error("dead service daemon lock was not reclaimable");
    stale.release();
  } finally {
    if (child && isProcessAlive(child.pid)) child.kill("SIGKILL");
    if (child) await waitForChildExit(child).catch(() => {});
    await rm(stateRoot, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}

async function startDaemonFixture(fixture, workspace, stateRoot, extraArgs = [], options = {}) {
  const fixtureEnv = { ...process.env };
  // The fixture models daemon ownership, not coverage. Inheriting V8 coverage
  // delays process teardown and makes the lock-handoff assertion platform-timing dependent.
  delete fixtureEnv.NODE_V8_COVERAGE;
  if (options.implicitIdentity) {
    fixtureEnv.MBM_FIXTURE_WORKSPACE = workspace;
    fixtureEnv.MBM_FIXTURE_STATE_ROOT = stateRoot;
  }
  const child = spawn(process.execPath, [
    fixture,
    "start",
    ...extraArgs,
    ...(options.implicitIdentity ? [] : ["--workspace", workspace, "--state-dir", stateRoot]),
  ], {
    cwd: workspace,
    env: fixtureEnv,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4096); });
  await new Promise((resolvePromise, rejectPromise) => {
    let stdout = "";
    const timeout = setTimeout(() => rejectPromise(new Error(`daemon fixture did not become ready: ${stderr}`)), 5000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("ready\n")) {
        clearTimeout(timeout);
        resolvePromise();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      rejectPromise(new Error(`daemon fixture exited before readiness (${code}): ${stderr}`));
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
  });
  return child;
}

function waitForChildExit(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolvePromise) => { child.once("exit", resolvePromise); });
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function activeDaemonPolicyMutationSelfTest() {
  const stateRoot = await mkdtemp(join(tmpdir(), "mbm-policy-lock-test-"));
  const workspaceRaw = await mkdtemp(join(tmpdir(), "mbm-policy-lock-workspace-"));
  const workspace = await realpath(workspaceRaw);
  try {
    const state = loadState(workspace, { stateDir: stateRoot });
    state.policy = resolvePolicy({ profile: "review" }, {});
    ensureWorkerSecrets(state, { rotateSecrets: true });
    saveState(state);
    const daemonLock = acquireDaemonLock(state);
    if (!daemonLock.acquired) throw new Error("policy mutation test could not acquire daemon lock");
    try {
      const entry = fileURLToPath(new URL("../bin/machine-mcp.mjs", import.meta.url));
      const idempotentServiceStart = spawnSync(process.execPath, [
        entry,
        "start",
        "--daemon-only",
        "--workspace", workspace,
        "--state-dir", stateRoot,
        "--log-level", "warn",
      ], {
        cwd: workspace,
        encoding: "utf8",
        timeout: 10_000,
      });
      if (idempotentServiceStart.error) throw idempotentServiceStart.error;
      if (idempotentServiceStart.status !== 0 || idempotentServiceStart.stdout !== "" || idempotentServiceStart.stderr !== "") {
        throw new Error(`idempotent daemon-only lock conflict was noisy or unsuccessful: ${idempotentServiceStart.stderr || idempotentServiceStart.stdout}`);
      }

      const child = spawnSync(process.execPath, [
        entry,
        "start",
        "--daemon-only",
        "--workspace", workspace,
        "--state-dir", stateRoot,
        "--profile", "full",
        "--json",
      ], {
        cwd: workspace,
        encoding: "utf8",
        timeout: 10_000,
      });
      if (child.error) throw child.error;
      if (child.status !== 0) throw new Error(`locked start failed unexpectedly: ${child.stderr || child.stdout}`);
      const output = JSON.parse(child.stdout.trim());
      if (output.requested_changes_applied !== false || !String(output.notice || "").includes("not applied")) {
        throw new Error("locked JSON start did not report that policy changes were rejected");
      }
      if (Object.prototype.hasOwnProperty.call(output.mcp || {}, "connection_password") || child.stdout.includes("account_admin_")) {
        throw new Error("JSON start exposed account administration credentials");
      }
      const unchanged = loadState(workspace, { stateDir: stateRoot });
      if (unchanged.policy.profile !== "review" || unchanged.policy.allowWrite || unchanged.policy.execMode !== "off") {
        throw new Error("active daemon lock allowed persisted policy mutation");
      }
    } finally {
      daemonLock.release();
    }
  } finally {
    await rm(stateRoot, { recursive: true, force: true }).catch(() => {});
    await rm(workspaceRaw, { recursive: true, force: true }).catch(() => {});
  }
}

async function clientConfigDefaultSelfTest() {
  const stateRoot = await mkdtemp(join(tmpdir(), "mbm-client-config-test-"));
  const workspaceRaw = await mkdtemp(join(tmpdir(), "mbm-client-config-workspace-"));
  const workspace = await realpath(workspaceRaw);
  try {
    const entry = fileURLToPath(new URL("../bin/machine-mcp.mjs", import.meta.url));
    const child = spawnSync(process.execPath, [
      entry,
      "client-config",
      "--client", "all",
      "--workspace", workspace,
      "--state-dir", stateRoot,
      "--json",
    ], {
      cwd: workspace,
      encoding: "utf8",
      timeout: 10_000,
    });
    if (child.error) throw child.error;
    if (child.status !== 0) throw new Error(`client-config failed: ${child.stderr || child.stdout}`);
    const output = JSON.parse(child.stdout.trim());
    if (output.profile !== "full") throw new Error("client-config did not default to full profile");
    const args = output.claude?.mcpServers?.["machine-bridge"]?.args || [];
    const profileIndex = args.indexOf("--profile");
    if (profileIndex < 0 || args[profileIndex + 1] !== "full") throw new Error("generated client config did not persist full profile");
  } finally {
    await rm(stateRoot, { recursive: true, force: true }).catch(() => {});
    await rm(workspaceRaw, { recursive: true, force: true }).catch(() => {});
  }
}

async function resourceCliSelfTest() {
  const stateRoot = await mkdtemp(join(tmpdir(), "mbm-resource-cli-state-"));
  const workspaceRaw = await mkdtemp(join(tmpdir(), "mbm-resource-cli-workspace-"));
  const workspace = await realpath(workspaceRaw);
  const resourceFile = join(workspace, "credential-file.txt");
  await writeFile(resourceFile, "local-value-not-returned", { mode: 0o600 });
  if (process.platform !== "win32") await chmod(resourceFile, 0o600);
  const entry = fileURLToPath(new URL("../bin/machine-mcp.mjs", import.meta.url));
  try {
    const added = spawnSync(process.execPath, [entry, "resource", "add", "test-key", resourceFile, "--workspace", workspace, "--state-dir", stateRoot, "--json"], {
      encoding: "utf8", timeout: 10_000,
    });
    if (added.error) throw added.error;
    if (added.status !== 0) throw new Error(`resource add failed: ${added.stderr || added.stdout}`);
    const addedJson = JSON.parse(added.stdout);
    if (addedJson.contents_exposed !== false || addedJson.paths_exposed !== false || "path" in addedJson || "pathAliases" in addedJson || added.stdout.includes(resourceFile) || added.stdout.includes("local-value-not-returned")) {
      throw new Error("resource add exposed file contents or local path by default");
    }

    const status = spawnSync(process.execPath, [entry, "status", "--workspace", workspace, "--state-dir", stateRoot], {
      encoding: "utf8", timeout: 10_000,
    });
    if (status.error) throw status.error;
    if (status.status !== 0) throw new Error(`status after resource add failed: ${status.stderr || status.stdout}`);
    if (status.stdout.includes(resourceFile) || status.stdout.includes("pathAliases")) {
      throw new Error("status exposed a resource path alias");
    }

    const generatedKeyPath = join(workspace, "generated-operator-key");
    const generated = spawnSync(process.execPath, [entry, "resource", "generate-ssh-key", "generated-key", generatedKeyPath, "--workspace", workspace, "--state-dir", stateRoot, "--json"], {
      encoding: "utf8", timeout: 30_000,
    });
    if (generated.error) throw generated.error;
    if (generated.status !== 0) throw new Error(`SSH key resource generation failed: ${generated.stderr || generated.stdout}`);
    const generatedJson = JSON.parse(generated.stdout);
    if (!generatedJson.created || !generatedJson.registered || generatedJson.private_key_content_exposed !== false || !generatedJson.fingerprint || generatedJson.paths_exposed !== false || "private_key_path" in generatedJson || generated.stdout.includes(generatedKeyPath)) {
      throw new Error("SSH key generation result is incomplete or exposed private content/path by default");
    }
    if (!(await stat(generatedKeyPath)).isFile() || !(await stat(`${generatedKeyPath}.pub`)).isFile()) throw new Error("SSH key pair was not created");
    if (process.platform !== "win32" && ((await stat(generatedKeyPath)).mode & 0o777) !== 0o600) throw new Error("generated private key mode is not 0600");
    const generatedAgain = spawnSync(process.execPath, [entry, "resource", "generate-ssh-key", "generated-key", generatedKeyPath, "--workspace", workspace, "--state-dir", stateRoot, "--json"], {
      encoding: "utf8", timeout: 30_000,
    });
    if (generatedAgain.status !== 0 || JSON.parse(generatedAgain.stdout).created !== false) throw new Error("SSH key resource generation is not idempotent");

    const state = loadState(workspace, { stateDir: stateRoot });
    if (state.resources["test-key"]?.path !== resourceFile) throw new Error("resource add did not persist the canonical path");
    const manager = new ManagedJobManager({
      jobRoot: join(state.paths.profileDir, "jobs"),
      workspace,
      policy: { allowWrite: true, execMode: "direct", minimalEnv: false, unrestrictedPaths: true },
      resourceStatePath: state.paths.statePath,
    });
    if (manager.listResources().count !== 2) throw new Error("daemon-style resource reload did not read updated state");

    const listed = spawnSync(process.execPath, [entry, "resource", "list", "--workspace", workspace, "--state-dir", stateRoot, "--json"], {
      encoding: "utf8", timeout: 10_000,
    });
    if (listed.status !== 0) throw new Error(`resource list failed: ${listed.stderr || listed.stdout}`);
    const listedJson = JSON.parse(listed.stdout);
    if (!listedJson.resources?.["test-key"] || !listedJson.resources?.["generated-key"] || listedJson.paths_exposed !== false || listedJson.workspace !== "<local-workspace>" || "path" in listedJson.resources["test-key"] || listed.stdout.includes(resourceFile) || listed.stdout.includes(generatedKeyPath) || listed.stdout.includes("local-value-not-returned")) {
      throw new Error("resource list omitted an alias or exposed contents/paths by default");
    }
    const listedWithPaths = spawnSync(process.execPath, [entry, "resource", "list", "--show-paths", "--workspace", workspace, "--state-dir", stateRoot, "--json"], {
      encoding: "utf8", timeout: 10_000,
    });
    const listedWithPathsJson = JSON.parse(listedWithPaths.stdout);
    if (listedWithPaths.status !== 0 || listedWithPathsJson.paths_exposed !== true || listedWithPathsJson.resources?.["test-key"]?.path !== resourceFile) {
      throw new Error("resource list did not honor explicit --show-paths");
    }

    const checked = spawnSync(process.execPath, [entry, "resource", "check", "test-key", "--workspace", workspace, "--state-dir", stateRoot, "--json"], {
      encoding: "utf8", timeout: 10_000,
    });
    const checkedJson = JSON.parse(checked.stdout);
    if (checked.status !== 0 || checkedJson.contents_exposed !== false || checkedJson.paths_exposed !== false || "path" in checkedJson || checked.stdout.includes(resourceFile)) {
      throw new Error("resource check failed or exposed contents/path by default");
    }

    const jobs = spawnSync(process.execPath, [entry, "job", "list", "--workspace", workspace, "--state-dir", stateRoot, "--json"], {
      encoding: "utf8", timeout: 10_000,
    });
    if (jobs.status !== 0 || !Array.isArray(JSON.parse(jobs.stdout).jobs)) throw new Error("local job list fallback failed");

    const approvedMarker = join(workspace, "approved-by-cli.txt");
    const stagedForCli = manager.stage({
      name: "CLI approval",
      steps: [{ argv: [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1],'cli-approved')", approvedMarker], env_resources: { MBM_REVIEW_ONLY: "test-key" }, timeout_seconds: 10 }],
    });
    const inspectedPlan = spawnSync(process.execPath, [entry, "job", "inspect", stagedForCli.job_id, "--workspace", workspace, "--state-dir", stateRoot, "--json"], {
      encoding: "utf8", timeout: 10_000,
    });
    if (inspectedPlan.status !== 0) throw new Error(`local job inspect failed: ${inspectedPlan.stderr || inspectedPlan.stdout}`);
    const inspectionJson = JSON.parse(inspectedPlan.stdout);
    const reviewedResource = inspectionJson.review_plan?.resources?.["test-key"];
    if (!inspectionJson.review_plan || !reviewedResource || "path" in reviewedResource || "sha256" in reviewedResource || JSON.stringify(inspectionJson).includes(resourceFile)) {
      throw new Error("local plan inspection omitted the plan or exposed a resource source path/hash");
    }
    const cliApproved = spawnSync(process.execPath, [entry, "job", "approve", stagedForCli.job_id, "--workspace", workspace, "--state-dir", stateRoot, "--json", "--yes"], {
      encoding: "utf8", timeout: 10_000,
    });
    if (cliApproved.status !== 0 || JSON.parse(cliApproved.stdout).approval !== "local-operator") throw new Error(`local job approve failed: ${cliApproved.stderr || cliApproved.stdout}`);
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (await existsForSelfTest(approvedMarker)) break;
      await new Promise((resolvePromise) => { setTimeout(resolvePromise, 25); });
    }
    if (await readFile(approvedMarker, "utf8") !== "cli-approved") throw new Error("local job approve did not execute the staged job");

    const submittedMarker = join(workspace, "submitted-by-cli.txt");
    const planFile = join(workspace, "managed-plan.json");
    await writeFile(planFile, JSON.stringify({
      name: "local CLI fallback",
      steps: [{ argv: [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1],'submitted')", submittedMarker], timeout_seconds: 10 }],
    }), "utf8");
    if (process.platform !== "win32") {
      const linkedPlan = join(workspace, "linked-plan.json");
      await symlink(planFile, linkedPlan);
      const linked = spawnSync(process.execPath, [entry, "job", "submit", linkedPlan, "--workspace", workspace, "--state-dir", stateRoot, "--json"], {
        encoding: "utf8", timeout: 10_000,
      });
      if (linked.status === 0 || !String(linked.stderr).includes("must not be a symbolic link")) {
        throw new Error("local job submit accepted a symbolic-link plan file");
      }
    }
    const submitted = spawnSync(process.execPath, [entry, "job", "submit", planFile, "--workspace", workspace, "--state-dir", stateRoot, "--json"], {
      encoding: "utf8", timeout: 10_000,
    });
    if (submitted.status !== 0) throw new Error(`local job submit failed: ${submitted.stderr || submitted.stdout}`);
    const submittedId = JSON.parse(submitted.stdout).job_id;
    let submittedStatus = "";
    const submittedTerminal = new Set(["succeeded", "failed", "cancelled", "runner_failed", "runner_launch_failed", "recovery_failed", "recovery_exhausted", "succeeded_cleanup_failed", "failed_cleanup_failed", "cancelled_cleanup_failed"]);
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const read = spawnSync(process.execPath, [entry, "job", "read", submittedId, "--workspace", workspace, "--state-dir", stateRoot, "--json"], {
        encoding: "utf8", timeout: 10_000,
      });
      if (read.status !== 0) throw new Error(`local job read failed: ${read.stderr || read.stdout}`);
      submittedStatus = JSON.parse(read.stdout).status;
      if (submittedTerminal.has(submittedStatus)) break;
      await new Promise((resolvePromise) => { setTimeout(resolvePromise, 25); });
    }
    if (submittedStatus !== "succeeded" || await readFile(submittedMarker, "utf8").catch(() => "") !== "submitted") {
      const currentState = loadState(workspace, { stateDir: stateRoot });
      const jobDir = join(currentState.paths.profileDir, "jobs", submittedId);
      const diagnostics = {};
      for (const name of ["status.json", "result.json", "runner.out.log", "runner.err.log"]) {
        try { diagnostics[name] = await readFile(join(jobDir, name), "utf8"); } catch {}
      }
      throw new Error(`local CLI fallback job did not complete: ${submittedStatus}; diagnostics=${JSON.stringify(diagnostics)}`);
    }

    const activeJob = manager.start({
      name: "block uninstall while active",
      steps: [{ argv: [process.execPath, "-e", "setTimeout(()=>{},30000)"], timeout_seconds: 60 }],
    });
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const value = manager.read({ job_id: activeJob.job_id });
      if (value.status === "running") break;
      await new Promise((resolvePromise) => { setTimeout(resolvePromise, 25); });
    }
    const uninstallBlocked = spawnSync(process.execPath, [entry, "uninstall", "--state-dir", stateRoot, "--keep-worker", "--yes"], {
      encoding: "utf8", timeout: 10_000,
    });
    if (uninstallBlocked.status === 0 || !String(uninstallBlocked.stderr).includes("managed jobs are active")) {
      throw new Error(`uninstall did not refuse an active managed job: ${uninstallBlocked.stderr || uninstallBlocked.stdout}`);
    }
    manager.cancel({ job_id: activeJob.job_id });
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const value = manager.read({ job_id: activeJob.job_id });
      if (!["queued", "running", "cleaning", "interrupted"].includes(value.status)) break;
      await new Promise((resolvePromise) => { setTimeout(resolvePromise, 25); });
    }

    const removed = spawnSync(process.execPath, [entry, "resource", "remove", "test-key", "--workspace", workspace, "--state-dir", stateRoot, "--json"], {
      encoding: "utf8", timeout: 10_000,
    });
    if (removed.status !== 0 || JSON.parse(removed.stdout).removed !== true) throw new Error("resource remove failed");
    const resourcesAfterRemoval = manager.listResources();
    if (resourcesAfterRemoval.count !== 1 || resourcesAfterRemoval.resources[0]?.name !== "generated-key") {
      throw new Error("resource removal affected the wrong alias or was not visible without restart");
    }
  } finally {
    await rm(stateRoot, { recursive: true, force: true }).catch(() => {});
    await rm(workspaceRaw, { recursive: true, force: true }).catch(() => {});
  }
}

function cliSelfTest() {
  const parsed = parseArgs(["--no-write", "/tmp/example", "--unrestricted-paths=false", "--worker-name", "mbm-test"]);
  if (parsed.noWrite !== true || parsed._[0] !== "/tmp/example") throw new Error("boolean option consumed positional workspace");
  if (parsed.unrestrictedPaths !== false || parsed.workerName !== "mbm-test") throw new Error("CLI option parsing failed");
  expectThrow(() => parseArgs(["--unknown-option"]), "Unknown option");
  expectThrow(() => parseArgs(["--api"]), "Unknown option");
  expectThrow(() => parseArgs(["--workspace"]), "requires a value");
  expectThrow(() => parseArgs(["--quiet", "--quiet"]), "Duplicate option");
  expectThrow(() => parseArgs(["--quiet=maybe"]), "expects true or false");
  expectThrow(() => validatePositionals("start", { _: ["one", "two"] }), "at most one positional");
  expectThrow(() => validatePositionals("start", { _: ["one"], workspace: "two" }), "both positionally");
  expectThrow(() => validatePositionals("uninstall", { _: ["unexpected"] }), "does not accept positional");
  expectThrow(() => validateCommandOptions("uninstall", { _: [], workspace: "/tmp/project" }), "not valid for uninstall");
  expectThrow(() => validateCommandOptions("doctor", { _: [], fullEnv: true }), "not valid for doctor");
  validateCommandOptions("full-test", { _: [], workspace: "/tmp/project", json: true });
  validateCommandOptions("start", { _: [], unrestrictedPaths: true, noExec: true, logLevel: "warn" });
  validateLoggingOptions({ logLevel: "warn" });
  expectThrow(() => validateLoggingOptions({ logLevel: "trace" }), "log level must be");
  expectThrow(() => validateLoggingOptions({ quiet: true, verbose: true }), "cannot be used together");
  expectThrow(() => validateLoggingOptions({ logLevel: "warn", verbose: true }), "cannot be combined");
  validateCommandOptions("stdio", { _: [], profile: "agent", execMode: "direct" });
  validateCommandOptions("client-config", { _: [], client: "cursor", profile: "review" });
  validateCommandOptions("resource", { _: ["add", "key", "/tmp/key"], allowInsecurePermissions: true, showPaths: true, json: true });
  validateCommandOptions("job", { _: ["read", "job_abcdefghijklmnopqrstuvwxyz"], json: true });
  expectThrow(() => validateCommandOptions("rotate-secrets", { _: [], workerName: "mbm-test" }), "not valid for rotate-secrets");
  validatePositionals("workspace", { _: ["set", "/tmp/project"] });
  validatePositionals("service", { _: ["install", "/tmp/project"] });
  validatePositionals("stdio", { _: ["/tmp/project"] });
  validatePositionals("client-config", { _: ["codex"] });
  validatePositionals("resource", { _: ["add", "test-key", "/tmp/key"] });
  validatePositionals("resource", { _: ["generate-ssh-key", "test-key", "/tmp/key"] });
  validatePositionals("full-test", { _: ["/tmp/project"] });
  validatePositionals("job", { _: ["read", "job_abcdefghijklmnopqrstuvwxyz"] });
  validatePositionals("job", { _: ["submit", "/tmp/plan.json"] });
  validatePositionals("job", { _: ["approve", "job_abcdefghijklmnopqrstuvwxyz"] });
  validatePositionals("job", { _: ["inspect", "job_abcdefghijklmnopqrstuvwxyz"] });
  expectThrow(() => validatePositionals("resource", { _: ["add", "name", "path", "extra"] }), "too many positional");

  if (isSupportedNodeVersion("25.9.0") || !isSupportedNodeVersion("26.0.0") || !isSupportedNodeVersion("v27.1.0") || isSupportedNodeVersion("invalid") || isSupportedNodeVersion("")) {
    throw new Error("Node runtime baseline predicate is incorrect");
  }
  if (isSupportedNpmVersion("11.9.9") || !isSupportedNpmVersion("12.0.0") || !isSupportedNpmVersion("v13.1.0") || isSupportedNpmVersion("invalid") || isSupportedNpmVersion("")) {
    throw new Error("npm runtime baseline predicate is incorrect");
  }
  if (!isIdempotentDaemonOnlyStart({ daemonOnly: true })
      || isIdempotentDaemonOnlyStart({ daemonOnly: false })
      || isIdempotentDaemonOnlyStart({ daemonOnly: true, forceWorker: true })
      || isIdempotentDaemonOnlyStart({ daemonOnly: true, workerName: "mbm-test" })) {
    throw new Error("daemon-only idempotency predicate is incorrect");
  }
  const windowsNpm = npmVersionCommand("win32", "C:\\Windows\\System32\\cmd.exe");
  const windowsDefaultNpm = npmVersionCommand("win32", "");
  const posixNpm = npmVersionCommand("linux");
  if (windowsNpm.file !== "C:\\Windows\\System32\\cmd.exe" || windowsNpm.args.join("|") !== "/d|/s|/c|npm --version"
      || windowsDefaultNpm.file !== "cmd.exe" || windowsDefaultNpm.args.join("|") !== "/d|/s|/c|npm --version"
      || posixNpm.file !== "npm" || posixNpm.args.join("|") !== "--version") {
    throw new Error("npm version command is not cross-platform safe");
  }
  if (workerHealthUserReason("version_mismatch:0.1.0!=0.2.0") !== "deployed version does not match the local package" || workerHealthUserReason("network_error") !== "network request failed") {
    throw new Error("Worker health user-facing reason mapping is incorrect");
  }

  const defaultPolicy = resolvePolicy({}, {});
  if (
    defaultPolicy.profile !== "full" ||
    !defaultPolicy.allowWrite ||
    defaultPolicy.execMode !== "shell" ||
    !defaultPolicy.unrestrictedPaths ||
    defaultPolicy.minimalEnv ||
    !defaultPolicy.exposeAbsolutePaths ||
    defaultPolicy.origin !== "default"
  ) {
    throw new Error("new-workspace default policy is not maximum-permission full mode");
  }
  assertCanonicalFullPolicy(defaultPolicy);
  if (toolsForPolicy(defaultPolicy).length !== allToolNames().length) throw new Error("canonical full policy does not expose every tool");
  const review = resolvePolicy({ profile: "review" }, {});
  expectThrow(() => resolvePolicy({}, {
    profile: "full", origin: "explicit", revision: 4, allowWrite: true, execMode: "shell",
    unrestrictedPaths: true, minimalEnv: false, exposeAbsolutePaths: true,
  }), "schema is obsolete");
  expectThrow(() => resolvePolicy({}, {
    profile: "review", allowWrite: false, execMode: "off",
    unrestrictedPaths: false, minimalEnv: true, exposeAbsolutePaths: false,
  }), "schema is obsolete");
  const persistedReview = resolvePolicy({}, {
    profile: "review", origin: "explicit", revision: 5, allowWrite: false, execMode: "off",
    unrestrictedPaths: false, minimalEnv: true, exposeAbsolutePaths: false,
  });
  if (persistedReview.profile !== "review" || persistedReview.origin !== "explicit" || persistedReview.allowWrite) {
    throw new Error("current explicit policy was not preserved");
  }
  const agent = resolvePolicy({ profile: "agent" }, {});
  if (!agent.allowWrite || agent.execMode !== "direct") throw new Error("agent profile is incorrect");
  const restrictedAgent = resolvePolicy({ profile: "agent", noExec: true, absolutePaths: true }, {});
  if (restrictedAgent.profile !== "custom" || restrictedAgent.execMode !== "off" || restrictedAgent.exposeAbsolutePaths !== true) throw new Error("policy overrides are incorrect");
  expectThrow(() => resolvePolicy({ profile: "unsafe" }, {}), "--profile must be one of");
  expectThrow(() => resolvePolicy({ execMode: "maybe" }, {}), "--exec-mode must be");

  const defaultNames = new Set(toolsForPolicy(defaultPolicy).map((tool) => tool.name));
  if (!defaultNames.has("write_file") || !defaultNames.has("run_process") || !defaultNames.has("exec_command") || !defaultNames.has("stage_job") || !defaultNames.has("start_job") || !defaultNames.has("diagnose_runtime")) throw new Error("default full profile omits maximum tool capabilities");
  const reviewNames = new Set(toolsForPolicy(review).map((tool) => tool.name));
  if (reviewNames.has("write_file") || reviewNames.has("run_process") || reviewNames.has("exec_command")) throw new Error("review profile exposes mutation tools");
  const agentNames = new Set(toolsForPolicy(agent).map((tool) => tool.name));
  if (!agentNames.has("apply_patch") || !agentNames.has("run_process") || !agentNames.has("start_job") || agentNames.has("exec_command")) throw new Error("agent profile tool inventory is incorrect");
  if (MCP_PROTOCOL_VERSION !== "2025-11-25") throw new Error("MCP protocol version drifted");
}

function logSelfTest() {
  const rendered = formatFields({
    token: "mcp_at_should-not-appear",
    nested: { password: "secret", message: "account_password_abcdef\nforged" },
    authorization: "Bearer abcdefghijklmnopqrstuvwxyz",
  });
  if (rendered.includes("should-not-appear") || rendered.includes("password_abcdef") || rendered.includes("Bearer abcdef")) {
    throw new Error("structured log secret redaction failed");
  }
  if (rendered.includes("\nforged")) throw new Error("structured log newline injection was not escaped");
  if (sanitizeLogText("ok\n[error] forged").includes("\n[error]")) throw new Error("log message newline injection was not escaped");
  if (sanitizeLogText("x".repeat(10_000)).length > 2048) throw new Error("log message length was not bounded");
  const privateHome = process.env.HOME || process.env.USERPROFILE || "/home/test-user";
  const privateFields = formatFields({ workspace: `${privateHome}/private-workspace`, cwd: `${privateHome}/private-workspace/subdir`, ordinary: "visible" });
  if (privateFields.includes(privateHome) || !privateFields.includes("<local-path>") || !privateFields.includes("visible")) {
    throw new Error("structured log local-path redaction failed");
  }
  const syntheticAwsKey = `AK${"IA"}${"A".repeat(16)}`;
  const syntheticNpmToken = ["npm", "A".repeat(36)].join("_");
  const syntheticSlackToken = ["xoxb", "1234567890", "ABCDEFGHIJK"].join("-");
  const syntheticGoogleKey = ["AI", "za", "A".repeat(35)].join("");
  const syntheticJwt = ["eyJ" + "A".repeat(12), "B".repeat(12), "C".repeat(12)].join(".");
  const syntheticCredentialUrl = ["https://operator", "private-value@host.example/path"].join(":");
  if (classifyOperationalError(new Error("Unexpected server response: 401")) !== "execution_failed") {
    throw new Error("untyped operational errors were classified from message text");
  }
  const sensitiveText = sanitizeLogText(`contact person@example.com at ${privateHome}/project ${syntheticAwsKey} ${syntheticNpmToken} ${syntheticSlackToken} ${syntheticGoogleKey} ${syntheticJwt} ${syntheticCredentialUrl} abc\u202Etxt`);
  for (const secret of ["person@example.com", privateHome, syntheticAwsKey, syntheticNpmToken, syntheticSlackToken, syntheticGoogleKey, syntheticJwt, syntheticCredentialUrl, "\u202E"]) {
    if (sensitiveText.includes(secret)) throw new Error("free-form log privacy redaction failed");
  }
  const hostileFields = {};
  Object.defineProperty(hostileFields, "broken", { enumerable: true, get() { throw new Error("getter failed"); } });
  if (!formatFields(hostileFields).includes("fields_unavailable")) throw new Error("logging failed closed on hostile structured fields");
  const unprintable = { toString() { throw new Error("toString failed"); } };
  if (sanitizeLogText(unprintable) !== "<unprintable>") throw new Error("logging failed on an unprintable message");
  const oversizedFields = formatFields(Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`field_${i}`, "x".repeat(20_000)])));
  if (oversizedFields.length > 4500 || !oversizedFields.includes("fields_truncated")) throw new Error("structured log fields were not bounded");
}

async function serviceSelfTest() {
  const normalizedFailure = normalizeServiceCommandResult("systemd", { code: 5, stdout: "", stderr: "permission denied" });
  if (normalizedFailure.ok !== false || normalizedFailure.provider !== "systemd") throw new Error("service command failure normalization is incorrect");
  const normalizedInactive = normalizeServiceCommandResult("systemd", { code: 5, stdout: "inactive", stderr: "" }, { allowAlreadyStopped: true });
  if (normalizedInactive.ok !== true || normalizedInactive.already_stopped !== true) throw new Error("idempotent service stop normalization is incorrect");
  if (launchdServiceTarget(501) !== "gui/501/dev.machine-bridge-mcp.daemon") {
    throw new Error("launchd service target did not use the loaded label form");
  }
  expectThrow(() => launchdServiceTarget("invalid"), "numeric user id");
  const stateRoot = await mkdtemp(join(tmpdir(), "mbm-service-test-"));
  try {
    const logs = join(stateRoot, "logs");
    await writeFile(join(stateRoot, "placeholder"), "", "utf8");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(logs, { recursive: true }));
    const file = join(logs, "daemon.err.log");
    await writeFile(join(logs, ".log-schema"), "3\n", "utf8");
    await writeFile(file, `${"discarded-line\n".repeat(300)}kept-unicode-日志\nlast-line\n`, "utf8");
    trimAutostartLogs(stateRoot, { maxBytes: 2048, keepBytes: 1024 });
    const trimmed = await readFile(file, "utf8");
    if ((await stat(file)).size > 1024 || trimmed.startsWith("�") || !trimmed.endsWith("last-line\n")) {
      throw new Error("autostart log tail trimming was not line/UTF-8 safe");
    }
    if (process.platform !== "win32") {
      const outsideTarget = join(stateRoot, "outside-log-target");
      const linkedLog = join(logs, "daemon.out.log");
      await writeFile(outsideTarget, "must-remain-unchanged", "utf8");
      try {
        await symlink(outsideTarget, linkedLog);
        trimAutostartLogs(stateRoot, { maxBytes: 1024, keepBytes: 1024 });
        if (await readFile(outsideTarget, "utf8") !== "must-remain-unchanged") {
          throw new Error("autostart log trimming followed a symbolic link");
        }
      } catch (error) {
        if (error?.code !== "EPERM" && error?.code !== "EACCES") throw error;
      }
    }
    const obsoleteLogRoot = await mkdtemp(join(tmpdir(), "mbm-obsolete-log-schema-"));
    try {
      const obsoleteLogs = join(obsoleteLogRoot, "logs");
      await mkdir(obsoleteLogs, { recursive: true });
      const currentLog = join(obsoleteLogs, "daemon.err.log");
      await writeFile(join(obsoleteLogs, ".log-schema"), "1\n", "utf8");
      await writeFile(currentLog, "obsolete-format-line\n", "utf8");
      trimAutostartLogs(obsoleteLogRoot, { maxBytes: 2048, keepBytes: 1024 });
      if (await readFile(currentLog, "utf8") !== "") throw new Error("obsolete active log was not cleared");
      if ((await readFile(join(obsoleteLogs, ".log-schema"), "utf8")).trim() !== "3") {
        throw new Error("current autostart log schema marker was not written");
      }
      await writeFile(currentLog, "current-format-line\n", "utf8");
      trimAutostartLogs(obsoleteLogRoot, { maxBytes: 2048, keepBytes: 1024 });
      if (await readFile(currentLog, "utf8") !== "current-format-line\n") {
        throw new Error("current-format log was reset unexpectedly");
      }
    } finally {
      await rm(obsoleteLogRoot, { recursive: true, force: true });
    }

    const nodeBin = join(stateRoot, "node-bin");
    await mkdir(nodeBin, { recursive: true });
    const nodeTarget = join(nodeBin, process.platform === "win32" ? "node-target.exe" : "node-target");
    const nodeAlias = join(nodeBin, process.platform === "win32" ? "node.exe" : "node");
    await writeFile(nodeTarget, "node-fixture", "utf8");
    if (process.platform !== "win32") {
      await chmod(nodeTarget, 0o755);
      await symlink(nodeTarget, nodeAlias);
      if (stableNodeExecutable({ execPath: nodeTarget, pathEnv: nodeBin }) !== nodeAlias) {
        throw new Error("autostart did not prefer a stable PATH alias for the active Node binary");
      }
    } else if (stableNodeExecutable({ execPath: nodeTarget, pathEnv: nodeBin }) !== nodeTarget) {
      throw new Error("autostart Node fallback changed the active Windows executable");
    }

    const customBin = join(stateRoot, "custom-bin");
    const entryScript = join(stateRoot, "package", "bin", "machine-mcp.mjs");
    const servicePath = serviceEnvironmentPath({
      node: process.platform === "win32" ? nodeTarget : nodeAlias,
      entryScript,
      pathEnv: [nodeBin, "relative-bin", customBin, nodeBin].join(delimiter),
    });
    const servicePathEntries = servicePath.split(delimiter);
    if (!servicePathEntries.includes(nodeBin) || !servicePathEntries.includes(customBin) || servicePathEntries.includes("relative-bin")) {
      throw new Error("autostart service PATH did not retain absolute command directories or reject relative entries");
    }
    if (servicePathEntries.filter((entry) => entry === nodeBin).length !== 1) throw new Error("autostart service PATH retained duplicates");
    const plist = launchdPlist({ args: [nodeAlias, entryScript], pathEnv: servicePath, stdout: "/tmp/out", stderr: "/tmp/err" });
    if (!plist.includes("<key>EnvironmentVariables</key>") || !plist.includes(`<key>PATH</key><string>${servicePath}</string>`)) {
      throw new Error("launchd definition omitted the explicit service PATH");
    }
    const unit = systemdUnit({ node: nodeAlias, entryScript, workspace: "/workspace", stateRoot: "/state", pathEnv: servicePath, stdout: "/tmp/out", stderr: "/tmp/err" });
    if (!unit.includes(`Environment=${systemdQuote(`PATH=${servicePath}`)}`)) throw new Error("systemd definition omitted the explicit service PATH");

    const quoted = systemdQuote("path with space/%value'\n");
    if (!quoted.startsWith('"') || !quoted.includes("%%") || !quoted.includes("\\n")) throw new Error("systemd argument quoting failed");
    const args = daemonArgs({ entryScript: "/package/bin/machine-mcp.mjs", workspace: "/workspace", stateRoot: "/state" });
    if (args.some((value) => ["--profile", "--exec-mode", "--no-write", "--full-env", "--unrestricted-paths", "--absolute-paths"].includes(value))) {
      throw new Error("autostart duplicated policy outside owner-only state");
    }
    const logLevelIndex = args.indexOf("--log-level");
    if (logLevelIndex < 0 || args[logLevelIndex + 1] !== "warn" || args.includes("--quiet")) {
      throw new Error("autostart did not retain warning/error logs without normal chatter");
    }
  } finally {
    await rm(stateRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function ciBootstrapSelfTest() {
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const lines = workflow.split("\n");
  const setupNodePattern = /^\s*-\s+uses:\s+actions\/setup-node@(820762786026740c76f36085b0efc47a31fe5020)\s+#\s+v7\.0\.0\s*$/;
  const setupIndexes = lines.flatMap((line, index) => setupNodePattern.test(line) ? [index] : []);
  if (setupIndexes.length < 2) throw new Error("CI must use immutable setup-node v7.0.0 in every npm execution job");
  for (const index of setupIndexes) {
    const setupWindow = lines.slice(index, index + 6).join("\n");
    if (!setupWindow.includes("package-manager-cache: false")) {
      throw new Error("setup-node automatic package-manager cache must stay disabled until npm 12 is installed");
    }
  }
  const pinnedBootstrapCount = lines.filter((line) => line.includes("node scripts/prepare-pinned-npm.mjs")).length;
  const versionCheckCount = lines.filter((line) => line.trim() === "- run: npm --version").length;
  if (pinnedBootstrapCount !== setupIndexes.length || versionCheckCount !== setupIndexes.length || workflow.includes("npm install --global npm@")) {
    throw new Error("every CI npm execution job must prepare and verify integrity-pinned npm 12 without a mutable global install");
  }
  const bootstrap = await readFile(new URL("../scripts/prepare-pinned-npm.mjs", import.meta.url), "utf8");
  if (!bootstrap.includes("npm-12.0.1.tgz") || !bootstrap.includes("sha512-L5T9i/YAQWQWqTS/") || !bootstrap.includes('redirect: "error"') || !bootstrap.includes("readBoundedBody(response, MAX_TARBALL_BYTES)")) {
    throw new Error("CI npm bootstrap lost its exact tarball, bounded download, SHA-512 integrity, or redirect rejection");
  }
  if (workflow.includes("> sbom.json") || !workflow.includes('> "$RUNNER_TEMP/sbom.json"')) {
    throw new Error("CI SBOM output must stay outside the repository publication surface");
  }
  const installSmokeCount = lines.filter((line) => line.includes("npm run install:test")).length;
  if (installSmokeCount !== 2) {
    throw new Error("CI must exercise the documented global installation in package-audit and the cross-platform job");
  }
  const packageTest = await readFile(new URL("./package-test.mjs", import.meta.url), "utf8");
  if (!packageTest.includes("process.env.npm_execpath") || packageTest.includes('spawnSync(npm')) {
    throw new Error("package manifest test must execute the npm CLI through Node for Windows portability");
  }
}

async function shellSelfTest() {
  const result = await runExecutable(process.execPath, ["-e", "process.stdout.write('x'.repeat(4096)); process.stderr.write('y'.repeat(4096));"], {
    capture: true,
    maxOutputBytes: 1024,
  });
  if (result.code !== 0 || !result.stdout.includes("[truncated") || !result.stderr.includes("[truncated")) {
    throw new Error("bounded shell capture failed");
  }
  const timedOut = await runExecutable(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
    capture: true,
    allowFailure: true,
    timeoutMs: 50,
  });
  if (timedOut.code !== 124 || !timedOut.stderr.includes("timed out")) throw new Error("shell timeout handling failed");

  const treeRoot = await mkdtemp(join(tmpdir(), "mbm-shell-tree-test-"));
  try {
    const childPidFile = join(treeRoot, "child.pid");
    const treeScript = `const { spawn } = require('node:child_process'); const { writeFileSync } = require('node:fs'); const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); setInterval(() => {}, 1000)"], { stdio: 'ignore' }); writeFileSync(process.argv[1], String(child.pid)); setInterval(() => {}, 1000);`;
    const treeResult = await runExecutable(process.execPath, ["-e", treeScript, childPidFile], {
      capture: true,
      allowFailure: true,
      timeoutMs: 200,
    });
    if (treeResult.code !== 124) throw new Error("shell process-tree timeout did not report timeout");
    const descendantPid = Number((await readFile(childPidFile, "utf8")).trim());
    const exited = await waitForPidExit(descendantPid, 5000);
    if (!exited) throw new Error("shell timeout left a descendant process running");
  } finally {
    await rm(treeRoot, { recursive: true, force: true });
  }
}

async function workerSourceSelfTest() {
  const source = await readFile(new URL("../src/worker/index.ts", import.meta.url), "utf8");
  const workerModules = await Promise.all([
    "pending-calls.ts", "policy.ts", "errors.ts", "http.ts", "oauth-state.ts", "oauth-tokens.ts",
    "oauth-controller.ts", "oauth-authorization-page.ts", "observability.ts", "mcp-session.ts", "tool-timeout.ts", "daemon-liveness.ts",
    "daemon-sockets.ts", "mcp-jsonrpc.ts", "websocket-protocol.ts",
  ].map((name) => readFile(new URL(`../src/worker/${name}`, import.meta.url), "utf8")));
  const combinedSource = [source, ...workerModules].join("\n");
  for (const module of ["mcp-jsonrpc", "websocket-protocol"]) {
    if (!source.includes(`./${module}.ts`)) throw new Error(`Worker index lost protocol boundary module: ${module}`);
  }
  const unawaitedAsyncRoutes = [
    "return this.oauth.registerClient(request);",
    "return this.oauth.authorizeSubmit(request, base);",
    "return this.oauth.exchangeToken(request, base);",
    "return this.acceptDaemonWebSocket(request);",
    "return this.handleMcp(request, base);",
  ].filter(snippet => source.includes(snippet));
  if (unawaitedAsyncRoutes.length) {
    throw new Error(`Worker async routes must be awaited so HttpError is caught: ${unawaitedAsyncRoutes.join(", ")}`);
  }
  for (const required of [
    "MAX_PENDING_CALLS",
    "MAX_DAEMON_MESSAGE_BYTES",
    "withOAuthLock",
    "oauthQueue",
    "AUTH_FAILURE_LIMIT",
    "OAUTH_BODY_LIMIT_BYTES",
    "PendingCallRegistry",
    "isJsonRpcId(candidate.id)",
    "pruneRecordByExpiry(oauthStore.tokens, MAX_ACCESS_TOKENS)",
    "pruneRecordByExpiry(refreshStore.tokens, MAX_REFRESH_TOKENS)",
    "A valid PKCE S256 challenge is required.",
    "hmac-sha256:",
    "DAEMON_HELLO_TIMEOUT_MS",
    "DAEMON_LIVENESS_TIMEOUT_MS",
    "DAEMON_READY_TIMEOUT_MS",
    "lastSeenAt",
    "daemon_liveness_timeout",
    "reclaimStaleDaemonSockets",
    "async alarm()",
    "storage.setAlarm",
    'role: "candidate"',
    'role: "probing"',
    'role: "daemon"',
    'role: "expired"',
    "relay_probe_result",
    "daemon_hello_timeout",
    "daemon_ready_timeout",
    "replaced by verified daemon",
    "serverMetadata.protocolVersion",
    "notifications/cancelled",
    "structuredContent",
    "../shared/tool-catalog.json",
  ]) {
    if (!combinedSource.includes(required)) throw new Error(`Worker hardening guard missing: ${required}`);
  }
  for (const removed of [
    "/api/mcp/sampling",
    "/api/daemon/status",
    "sampling/createMessage",
    'request.headers.get("User-Agent")',
  ]) {
    if (combinedSource.includes(removed)) throw new Error(`obsolete or public-sensitive Worker route remains: ${removed}`);
  }
}

async function waitForPidExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch (error) { if (error?.code === "ESRCH") return true; }
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 25); });
  }
  try { process.kill(pid, 0); return false; } catch { return true; }
}

async function existsForSelfTest(file) {
  try { await stat(file); return true; } catch { return false; }
}

function expectThrow(callback, pattern) {
  try {
    callback();
  } catch (error) {
    if (String(error?.message || error).includes(pattern)) return;
    throw error;
  }
  throw new Error(`expected throw containing: ${pattern}`);
}
