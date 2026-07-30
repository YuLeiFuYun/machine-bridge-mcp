import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BrowserBridgeManager } from "../src/local/browser-bridge.mjs";
import { createExclusiveFileSync, replaceFileAtomicallySync } from "../src/local/exclusive-file.mjs";
import { ManagedJobManager } from "../src/local/managed-jobs.mjs";
import { inspectProcessInstance } from "../src/local/process-identity.mjs";
import { acquireMachineServiceLock, acquireMachineServiceLockWithWait, acquireMaintenanceLock, acquireStartupLock, acquireStartupLockWithWait, defaultFirstRunWorkspace, defaultStateRoot, loadGlobalConfig, loadState, machineServiceControlRoot, machineServiceLockPath } from "../src/local/state.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const MAINTENANCE_HOLDER_READY_MS = 30_000;
const EXCLUSIVE_CONTENDER_COUNT = 4;

function spawnFixtureNode(args, options = {}) {
  const environment = { ...process.env, NODE_V8_COVERAGE: "" };
  return spawn(process.execPath, args, { ...options, env: environment });
}
const temp = await mkdtemp(join(tmpdir(), "mbm-process-lock-test-"));
try {
  await atomicExclusiveCreateTest();
  await atomicReplacementTest();
  processIdentityTest();
  assert(defaultFirstRunWorkspace({ platform: "darwin", cwd: temp }) === resolve(temp),
    "default first-run workspace did not use the supplied POSIX cwd");
  stateRootSeparationTest();
  await daemonReadinessLockTest();
  await startupWaitTest();
  await startupWaitIgnoresWallClockRollbackTest();
  await maintenanceLockTest();
  await machineServiceLockTest();
  await malformedAndReusedPidLockTest();
  await symbolicLinkLockTest();
  console.log("process identity/lock test ok");
} finally {
  await rm(temp, { recursive: true, force: true });
}

function stateRootSeparationTest() {
  const posixHome = join(temp, "posix-home");
  const posixState = defaultStateRoot({ platform: "darwin", home: posixHome, environment: {} });
  const posixControl = machineServiceControlRoot({ platform: "darwin", home: posixHome, environment: {} });
  assert(posixState === join(posixHome, ".local", "state", "machine-bridge-mcp"),
    "POSIX default state root drifted from the profile-state directory");
  assert(posixControl === join(posixHome, ".local", "state", "machine-bridge-mcp-control") && posixControl !== posixState,
    "POSIX machine-service control root collided with the profile-state root");

  const xdgState = defaultStateRoot({
    platform: "linux", home: posixHome, environment: { XDG_STATE_HOME: "~/xdg-state" },
  });
  assert(xdgState === join(posixHome, "xdg-state", "machine-bridge-mcp"),
    "XDG state root did not preserve the application profile directory");

  const appData = join(temp, "windows-appdata");
  const windowsHome = join(temp, "windows-home");
  const windowsState = defaultStateRoot({ platform: "win32", home: windowsHome, environment: { APPDATA: appData } });
  const windowsControl = machineServiceControlRoot({ platform: "win32", home: windowsHome, environment: { APPDATA: appData } });
  assert(windowsState === join(appData, "machine-bridge-mcp")
    && windowsControl === join(appData, "machine-bridge-mcp-control")
    && windowsState !== windowsControl,
  "Windows profile and machine-service control roots are not separated");
}

async function atomicExclusiveCreateTest() {
  const directory = join(temp, "exclusive");
  await mkdir(directory, { recursive: true });
  const target = join(directory, "winner.json");
  const barrier = join(directory, "go");
  const helper = join(directory, "contender.mjs");
  const moduleUrl = pathToFileURL(join(root, "src", "local", "exclusive-file.mjs")).href;
  await writeFile(helper, `import { existsSync } from "node:fs";\nimport { createExclusiveFileSync } from ${JSON.stringify(moduleUrl)};\nconst [target, barrier, id] = process.argv.slice(2);\nif (process.env.NODE_V8_COVERAGE) throw new Error("process-lock helper inherited NODE_V8_COVERAGE");\nwhile (!existsSync(barrier)) await new Promise((r) => { setTimeout(r, 2); });\ntry { createExclusiveFileSync(target, JSON.stringify({ id, payload: "x".repeat(8192) }) + "\\n"); process.exit(0); }\ncatch (error) { if (error?.code === "EEXIST") process.exit(3); throw error; }\n`, "utf8");
  const children = Array.from({ length: EXCLUSIVE_CONTENDER_COUNT }, (_, index) => spawnFixtureNode([helper, target, barrier, String(index)], {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  }));
  await new Promise((resolvePromise) => { setTimeout(resolvePromise, 30); });
  await writeFile(barrier, "go\n", "utf8");
  const results = await Promise.all(children.map(waitForChild));
  const winners = results.filter((result) => result.code === 0);
  assert(winners.length === 1, `exclusive create produced ${winners.length} winners`);
  assert(results.every((result) => result.code === 0 || result.code === 3), `exclusive create contender failed unexpectedly: ${JSON.stringify(results)}`);
  const parsed = JSON.parse(await readFile(target, "utf8"));
  assert(typeof parsed.id === "string" && parsed.payload.length === 8192, "exclusive file was partial or invalid");
  const leftovers = (await import("node:fs/promises")).readdir(directory).then((names) => names.filter((name) => name.includes("winner.json.") && name.endsWith(".tmp")));
  assert((await leftovers).length === 0, "exclusive create left temporary files");

  const direct = join(directory, "direct.txt");
  createExclusiveFileSync(direct, "complete\n");
  let duplicate = null;
  try { createExclusiveFileSync(direct, "other\n"); } catch (error) { duplicate = error; }
  assert(duplicate?.code === "EEXIST", "exclusive create did not preserve existing target");
  assert(await readFile(direct, "utf8") === "complete\n", "duplicate exclusive create changed the target");
}

async function atomicReplacementTest() {
  const directory = join(temp, "replacement");
  await mkdir(directory, { recursive: true });
  const target = join(directory, "state.json");
  replaceFileAtomicallySync(target, `${JSON.stringify({ revision: 0, payload: "x".repeat(8192) })}\n`);
  const helper = join(directory, "replace-loop.mjs");
  const moduleUrl = pathToFileURL(join(root, "src", "local", "exclusive-file.mjs")).href;
  await writeFile(helper, `import { replaceFileAtomicallySync } from ${JSON.stringify(moduleUrl)};\nconst target = process.argv[2];\nfor (let revision = 1; revision <= 250; revision += 1) replaceFileAtomicallySync(target, JSON.stringify({ revision, payload: 'x'.repeat(8192) }) + '\\n');\n`, "utf8");
  const child = spawnFixtureNode([helper, target], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  const childResult = waitForChild(child);
  while (child.exitCode === null) {
    const parsed = JSON.parse(await readFile(target, "utf8"));
    assert(Number.isInteger(parsed.revision) && parsed.payload.length === 8192, "atomic replacement exposed partial content");
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 1); });
  }
  const result = await childResult;
  assert(result.code === 0, `atomic replacement fixture failed: ${result.stderr}`);
  const final = JSON.parse(await readFile(target, "utf8"));
  assert(final.revision === 250, "atomic replacement lost the final update");
}

function processIdentityTest() {
  const now = Date.now();
  const owner = {
    pid: 42,
    startedAt: new Date(now - 1000).toISOString(),
    processStartedAt: new Date(now - 2000).toISOString(),
  };
  const current = inspectProcessInstance(owner, {
    now,
    isAlive: () => true,
    getProcessStartTime: () => now - 2000,
    maxAgeMs: 60_000,
  });
  assert(current.current && current.reason === "current_process", "current process identity was rejected");

  const reused = inspectProcessInstance(owner, {
    now,
    isAlive: () => true,
    getProcessStartTime: () => now - 60_000,
    maxAgeMs: 60_000,
  });
  assert(!reused.current && reused.reason === "pid_reused", "PID reuse was not detected");

  const expired = inspectProcessInstance({ ...owner, startedAt: new Date(now - 120_000).toISOString(), processStartedAt: new Date(now - 121_000).toISOString() }, {
    now,
    isAlive: () => true,
    getProcessStartTime: () => now - 121_000,
    maxAgeMs: 60_000,
  });
  assert(!expired.current && expired.reason === "lock_expired" && expired.reclaimable === false, "old live process lock was not retained fail-closed");

  const future = inspectProcessInstance({ ...owner, startedAt: new Date(now + 60_000).toISOString() }, {
    now,
    isAlive: () => true,
    getProcessStartTime: () => now,
  });
  assert(!future.current && future.reason === "future_lock_timestamp" && future.reclaimable === false, "future lock timestamp was not retained fail-closed");
}

async function daemonReadinessLockTest() {
  const workspace = join(temp, "daemon-readiness-workspace");
  const stateRoot = join(temp, "daemon-readiness-state");
  await mkdir(workspace, { recursive: true });
  const state = loadState(workspace, { stateDir: stateRoot });
  const lock = acquireStartupLock(state, { operation: "readiness-fixture" });
  assert(lock.acquired, "readiness fixture could not acquire startup lock");
  lock.release();
  const { acquireDaemonLock, daemonLockPathForState, readDaemonLockOwner } = await import("../src/local/state.mjs");
  const daemon = acquireDaemonLock(state, { mode: "service", version: "3.0.0-test" });
  assert(daemon.acquired && daemon.owner.startupReady === false && daemon.owner.startupReadyAt === null,
    "daemon lock did not begin with unverified startup readiness");
  const readyAt = new Date().toISOString();
  const updated = daemon.update({ startupReady: true, startupReadyAt: readyAt });
  assert(updated.startupReady === true && updated.startupReadyAt === readyAt,
    "daemon lock readiness update was not returned");
  const persisted = readDaemonLockOwner(daemonLockPathForState(state));
  assert(persisted.startupReady === true && persisted.pid === process.pid && persisted.token === daemon.owner.token,
    "daemon readiness update changed identity or was not persisted");
  expectThrow(() => daemon.update({ startupReady: true, startupReadyAt: readyAt }), "already published");
  expectThrow(() => daemon.update({ startupReady: false, startupReadyAt: null }), "only be published as true");
  expectThrow(() => daemon.update({ startupReady: true, startupReadyAt: readyAt, pid: 1 }), "immutable");
  daemon.release();
  assert(readDaemonLockOwner(daemonLockPathForState(state)) === null,
    "updated daemon lock could not be released by its original token");
}

async function startupWaitTest() {
  const workspace = join(temp, "wait-workspace");
  const stateRoot = join(temp, "wait-state");
  await mkdir(workspace, { recursive: true });
  const helper = join(workspace, "hold-lock.mjs");
  const stateUrl = pathToFileURL(join(root, "src", "local", "state.mjs")).href;
  await writeFile(helper, `import { acquireStartupLock, loadState } from ${JSON.stringify(stateUrl)};\nconst [workspace, stateRoot] = process.argv.slice(2);\nconst state = loadState(workspace, { stateDir: stateRoot });\nconst lock = acquireStartupLock(state, { operation: "fixture" });\nif (!lock.acquired) process.exit(4);\nprocess.stdout.write("locked\\n");\nsetTimeout(() => { lock.release(); process.exit(0); }, 1000);\n`, "utf8");
  const child = spawnFixtureNode([helper, workspace, stateRoot], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const childResult = waitForChild(child);
  await waitForOutput(child, "locked", 5000);
  const state = loadState(workspace, { stateDir: stateRoot });
  const messages = [];
  const started = Date.now();
  const lock = await acquireStartupLockWithWait(state, {
    operation: "parent",
    timeoutMs: 3000,
    pollMs: 20,
    logger: { info(message) { messages.push(message); } },
  });
  assert(lock.acquired, "startup wait did not acquire the released lock");
  assert(Date.now() - started >= 100, "startup wait returned before the competing operation released its lock");
  assert(messages.some((message) => message.includes("waiting for")) && messages.some((message) => message.includes("continuing")), "startup wait progress messages are incomplete");
  lock.release();
  const result = await childResult;
  assert(result.code === 0, `startup lock fixture failed: ${result.stderr}`);
}

async function startupWaitIgnoresWallClockRollbackTest() {
  const workspace = join(temp, "wall-clock-workspace");
  const stateRoot = join(temp, "wall-clock-state");
  await mkdir(workspace, { recursive: true });
  const state = loadState(workspace, { stateDir: stateRoot });
  const held = acquireStartupLock(state, { operation: "wall-clock-fixture" });
  assert(held.acquired, "wall-clock fixture could not acquire its competing lock");
  const originalDateNow = Date.now;
  const wallClockBeforeRollback = originalDateNow();
  const watchdog = setTimeout(() => { Date.now = originalDateNow; }, 1000);
  const started = performance.now();
  try {
    Date.now = () => wallClockBeforeRollback - 60 * 60 * 1000;
    let error = null;
    try {
      await acquireStartupLockWithWait(state, { operation: "wall-clock-parent", timeoutMs: 50, pollMs: 5 });
    } catch (caught) {
      error = caught;
    }
    const elapsed = performance.now() - started;
    assert(String(error?.message || "").includes("did not finish within"), "startup wait did not reach its bounded timeout under a wall-clock rollback");
    assert(elapsed < 500, `wall-clock rollback extended the 50 ms startup deadline to ${elapsed} ms`);
  } finally {
    Date.now = originalDateNow;
    clearTimeout(watchdog);
    held.release();
  }
}

async function maintenanceLockTest() {
  const workspace = join(temp, "maintenance-workspace");
  const stateRoot = join(temp, "maintenance-state");
  await mkdir(workspace, { recursive: true });
  const state = loadState(workspace, { stateDir: stateRoot });
  const maintenance = acquireMaintenanceLock(stateRoot, { operation: "fixture" });
  assert(maintenance.acquired, "maintenance lock was not acquired");
  const duplicate = acquireMaintenanceLock(stateRoot, { operation: "duplicate" });
  assert(!duplicate.acquired && duplicate.owner?.pid === process.pid, "duplicate maintenance lock did not preserve owner identity");
  const ownState = loadState(workspace, { stateDir: stateRoot });
  const ownStartup = acquireStartupLock(ownState, { operation: "same-process" });
  assert(ownStartup.acquired, "maintenance owner could not inspect or lock its own profile");
  ownStartup.release();

  const helper = join(workspace, "maintenance-load.mjs");
  const stateUrl = pathToFileURL(join(root, "src", "local", "state.mjs")).href;
  await writeFile(helper, `import { loadState } from ${JSON.stringify(stateUrl)};
const [workspace, stateRoot] = process.argv.slice(2);
try { loadState(workspace, { stateDir: stateRoot }); process.exit(0); } catch (error) { process.stderr.write(String(error?.message || error)); process.exit(7); }
`, "utf8");
  const blocked = await waitForChild(spawnFixtureNode([helper, workspace, stateRoot], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true }));
  assert(blocked.code === 7 && blocked.stderr.includes("state maintenance is active"), "foreign state load was not blocked by maintenance");
  maintenance.release();
  const allowed = await waitForChild(spawnFixtureNode([helper, workspace, stateRoot], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true }));
  assert(allowed.code === 0, `state load remained blocked after maintenance release: ${allowed.stderr}`);

  const existingJobs = new ManagedJobManager({
    jobRoot: join(state.paths.profileDir, "jobs"),
    workspace,
    stateRoot,
    policy: { allowWrite: true, execMode: "direct", minimalEnv: true, unrestrictedPaths: false },
    resources: {},
    recover: false,
  });
  const existingBrowser = new BrowserBridgeManager({
    policy: { profile: "full", execMode: "shell", unrestrictedPaths: true },
    stateRoot,
    runProcess: async () => ({ code: 0, stdout: "", stderr: "" }),
    readResourceText: async () => "",
    readResourceBinary: () => ({ buffer: Buffer.alloc(0), path: "", size: 0 }),
  });
  const holder = join(workspace, "hold-maintenance.mjs");
  await writeFile(holder, `import { acquireMaintenanceLock, loadState } from ${JSON.stringify(stateUrl)};
const [workspace, stateRoot] = process.argv.slice(2);
loadState(workspace, { stateDir: stateRoot });
const lock = acquireMaintenanceLock(stateRoot, { operation: "foreign-holder" });
if (!lock.acquired) process.exit(5);
let settled = false;
function finish(code) {
  if (settled) return;
  settled = true;
  lock.release();
  process.exit(code);
}
process.stdout.write("locked\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (value) => { if (String(value).includes("release")) finish(0); });
process.stdin.on("end", () => finish(0));
process.stdin.resume();
`, "utf8");
  const holderProcess = spawnFixtureNode([holder, workspace, stateRoot], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const holderResult = waitForChild(holderProcess);
  await waitForOutput(holderProcess, "locked", MAINTENANCE_HOLDER_READY_MS);
  let completedHolder;
  try {
    expectThrow(() => loadGlobalConfig(stateRoot), "state maintenance is active");
    expectThrow(() => existingJobs.start({ steps: [{ argv: [process.execPath, "-e", ""] }] }), "state maintenance is active");
    await expectReject(existingBrowser.status(), "state maintenance is active");
  } finally {
    holderProcess.stdin.end("release\n");
    completedHolder = await holderResult;
  }
  assert(completedHolder.code === 0, `maintenance holder failed: ${completedHolder.stderr}`);
  assert(existingJobs.list().jobs.length === 0, "blocked managed-job start created persistent state");
  const browserStatus = await existingBrowser.status();
  assert(browserStatus.running !== false, "browser manager did not recover after maintenance release");
  existingBrowser.stop();
}

async function machineServiceLockTest() {
  const controlRoot = join(temp, "machine-service-control");
  const first = acquireMachineServiceLock({ operation: "activation" }, { controlRoot });
  assert(first.acquired, "machine-service lock was not acquired");
  assert(first.path === machineServiceLockPath({ controlRoot }), "machine-service lock path drifted from the fixed control root");
  const competingState = loadState(join(temp, "wait-workspace"), { stateDir: join(temp, "wait-state") });
  assert(competingState.workspace.path, "machine-service fixture lost its unrelated workspace state");
  const duplicate = acquireMachineServiceLock({ operation: "service-start" }, { controlRoot });
  assert(!duplicate.acquired && duplicate.owner?.operation === "activation",
    "machine-service lock did not serialize operations independently of workspace");
  const waiter = acquireMachineServiceLockWithWait({
    operation: "service-start", controlRoot, timeoutMs: 500, pollMs: 5, logger: { info() {} },
  });
  setTimeout(() => first.release(), 25);
  const second = await waiter;
  assert(second.acquired && second.owner?.operation === "service-start",
    "machine-service lock waiter did not acquire after token-aware release");
  second.release();
  const final = acquireMachineServiceLock({ operation: "service-stop" }, { controlRoot });
  assert(final.acquired, "released machine-service lock remained unavailable");
  final.release();
}

async function malformedAndReusedPidLockTest() {
  const workspace = join(temp, "stale-workspace");
  const stateRoot = join(temp, "stale-state");
  await mkdir(workspace, { recursive: true });
  const state = loadState(workspace, { stateDir: stateRoot });
  const file = join(state.paths.profileDir, "startup.lock");

  await writeFile(file, "{partial", { mode: 0o600 });
  const recent = acquireStartupLock(state);
  assert(!recent.acquired && recent.reason === "recent_invalid_lock" && existsSync(file), "recent malformed lock was removed unsafely");
  const old = new Date(Date.now() - 120_000);
  await utimes(file, old, old);
  const reclaimed = acquireStartupLock(state, { operation: "reclaim-malformed" });
  assert(reclaimed.acquired, "old malformed lock was not reclaimed");
  reclaimed.release();

  await writeFile(file, `${JSON.stringify({
    pid: process.pid,
    token: "fixture-token",
    purpose: "startup",
    workspace: state.workspace.path,
    startedAt: new Date().toISOString(),
    processStartedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    entryScript: "fixture",
  })}\n`, { mode: 0o600 });
  const reused = acquireStartupLock(state, { operation: "reclaim-reused-pid" });
  assert(reused.acquired, "PID-reused lock was not reclaimed");
  reused.release();
}

async function symbolicLinkLockTest() {
  if (process.platform === "win32") return;
  const workspace = join(temp, "symlink-workspace");
  const stateRoot = join(temp, "symlink-state");
  await mkdir(workspace, { recursive: true });
  const state = loadState(workspace, { stateDir: stateRoot });
  const outside = join(temp, "outside-lock");
  const file = join(state.paths.profileDir, "startup.lock");
  await writeFile(outside, "outside\n", "utf8");
  await symlink(outside, file);
  let error = null;
  try { acquireStartupLock(state); } catch (caught) { error = caught; }
  assert(String(error?.message || "").includes("symbolic link"), "symbolic-link process lock was not rejected");
  assert(await readFile(outside, "utf8") === "outside\n", "symbolic-link process lock modified its target");
  await rm(file, { force: true });
  const owned = acquireStartupLock(state, { operation: "release-race" });
  assert(owned.acquired, "release-race lock was not acquired");
  await rm(file, { force: true });
  await symlink(outside, file);
  owned.release();
  assert(await readFile(outside, "utf8") === "outside\n", "lock release followed a replacement symbolic link");
}

function waitForChild(child) {
  return new Promise((resolvePromise, rejectPromise) => {
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => resolvePromise({ code, signal, stderr }));
  });
}

function waitForOutput(child, expected, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    let text = "";
    let stderr = "";
    const timeout = setTimeout(() => rejectPromise(new Error(`timed out waiting for child output: ${text}; stderr=${stderr}`)), timeoutMs);
    child.stdout.on("data", (chunk) => {
      text += String(chunk);
      if (!text.includes(expected)) return;
      clearTimeout(timeout);
      resolvePromise();
    });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => { clearTimeout(timeout); rejectPromise(error); });
    child.once("exit", (code) => {
      if (text.includes(expected)) return;
      clearTimeout(timeout);
      rejectPromise(new Error(`child exited ${code} before output '${expected}'; stderr=${stderr}`));
    });
  });
}

function expectThrow(callback, pattern) {
  try { callback(); } catch (error) {
    if (String(error?.message || error).includes(pattern)) return;
    throw error;
  }
  throw new Error(`expected throw containing: ${pattern}`);
}

async function expectReject(promise, pattern) {
  try { await promise; } catch (error) {
    if (String(error?.message || error).includes(pattern)) return;
    throw error;
  }
  throw new Error(`expected rejection containing: ${pattern}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
