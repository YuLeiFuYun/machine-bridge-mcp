import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./shell.mjs";
import { parseArgs, validateCommandOptions, validatePositionals } from "./cli.mjs";
import { daemonSelfTest } from "./daemon.mjs";
import { formatFields, redactSecret, sanitizeLogText } from "./log.mjs";
import { systemdQuote, trimAutostartLogs } from "./service.mjs";
import { acquireDaemonLock, acquireStartupLock, ensureWorkerSecrets, loadState, previewSecret, redactState, removeStateRoot, saveState, selectedWorkspace, setSelectedWorkspace, validateStateRootForRemoval } from "./state.mjs";

await daemonSelfTest();
await stateSelfTest();
await cliSelfTest();
await logSelfTest();
await serviceSelfTest();
await shellSelfTest();
await workerSourceSelfTest();
console.log("local daemon/state/cli/log/service/worker self-test ok");

async function stateSelfTest() {
  const stateRoot = await mkdtemp(join(tmpdir(), "mbm-state-test-"));
  const workspace = await mkdtemp(join(tmpdir(), "mbm-state-workspace-"));
  try {
    setSelectedWorkspace(workspace, stateRoot);
    if (selectedWorkspace(stateRoot) !== workspace) throw new Error("selected workspace was not persisted");
    const state = loadState(workspace, { stateDir: stateRoot });
    if (state.schemaVersion !== 2) throw new Error("unexpected state schema version");
    ensureWorkerSecrets(state, { rotateSecrets: true });
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
    if (redacted.worker.oauthPassword !== "<redacted>") throw new Error("oauthPassword was not fully redacted");
    if (redacted.worker.daemonSecret !== "<redacted>") throw new Error("daemonSecret was not fully redacted");
    if (redacted.worker.oauthTokenVersion !== "<redacted>") throw new Error("oauthTokenVersion was not fully redacted");
    if (previewSecret(state.worker.oauthPassword) !== "<redacted>") throw new Error("previewSecret did not fully redact secret");
    if (redactSecret(state.worker.daemonSecret) !== "<redacted>") throw new Error("redactSecret did not fully redact secret");

    state.localApi = {
      apiKey: "old-local-api-key",
      upstreamUrl: "https://api.example.test/v1",
      upstreamKey: "old-upstream-key",
      upstreamModel: "old-upstream-model",
    };
    saveState(state);
    const profileEntries = await readdir(state.paths.profileDir);
    if (profileEntries.some(name => name.endsWith(".tmp"))) throw new Error("atomic state write left a temporary file");
    const migrated = loadState(workspace, { stateDir: stateRoot });
    if ("localApi" in migrated) throw new Error("legacy local API state was not removed");

    await writeFile(state.paths.statePath, "{not-json", "utf8");
    const recovered = loadState(workspace, { stateDir: stateRoot });
    if (recovered.workspace.path !== workspace) throw new Error("corrupt state recovery failed");
    const backups = (await readdir(state.paths.profileDir)).filter(name => name.startsWith("state.json.corrupt-"));
    if (backups.length !== 1) throw new Error("corrupt state backup was not retained exactly once");
    const safeRemoval = validateStateRootForRemoval(stateRoot);
    if (!safeRemoval.exists || safeRemoval.root !== state.paths.stateRoot) throw new Error("safe state root validation failed");

    const legacyStateRoot = await mkdtemp(join(tmpdir(), "mbm-legacy-state-"));
    try {
      await writeFile(join(legacyStateRoot, ".machine-bridge-mcp-state"), "machine-bridge-mcp state root\n", "utf8");
      const legacyState = loadState(workspace, { stateDir: legacyStateRoot });
      const marker = JSON.parse(await readFile(join(legacyState.paths.stateRoot, ".machine-bridge-mcp-state"), "utf8"));
      if (marker.app !== "machine-bridge-mcp" || marker.schema !== 1) throw new Error("legacy state marker was not migrated");
      removeStateRoot(legacyStateRoot);
    } finally {
      await rm(legacyStateRoot, { recursive: true, force: true }).catch(() => {});
    }

    const lookalike = await mkdtemp(join(tmpdir(), "mbm-lookalike-state-"));
    try {
      await import("node:fs/promises").then(({ mkdir }) => mkdir(join(lookalike, "profiles")));
      expectThrow(() => loadState(workspace, { stateDir: lookalike }), "does not contain recognizable");
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

function cliSelfTest() {
  const parsed = parseArgs(["--no-write", "/tmp/example", "--unrestricted-paths=false", "--worker-name", "mbm-test"]);
  if (parsed.noWrite !== true || parsed._[0] !== "/tmp/example") throw new Error("boolean option consumed positional workspace");
  if (parsed.unrestrictedPaths !== false || parsed.workerName !== "mbm-test") throw new Error("CLI option parsing failed");
  expectThrow(() => parseArgs(["--unknown-option"]), "Unknown option");
  expectThrow(() => parseArgs(["--workspace"]), "requires a value");
  expectThrow(() => parseArgs(["--quiet", "--quiet"]), "Duplicate option");
  expectThrow(() => parseArgs(["--quiet=maybe"]), "expects true or false");
  expectThrow(() => validatePositionals("start", { _: ["one", "two"] }), "at most one positional");
  expectThrow(() => validatePositionals("start", { _: ["one"], workspace: "two" }), "both positionally");
  expectThrow(() => validatePositionals("uninstall", { _: ["unexpected"] }), "does not accept positional");
  expectThrow(() => validateCommandOptions("uninstall", { _: [], workspace: "/tmp/project" }), "not valid for uninstall");
  expectThrow(() => validateCommandOptions("doctor", { _: [], fullEnv: true }), "not valid for doctor");
  validateCommandOptions("start", { _: [], unrestrictedPaths: true, noExec: true });
  validatePositionals("workspace", { _: ["set", "/tmp/project"] });
  validatePositionals("service", { _: ["install", "/tmp/project"] });
}

function logSelfTest() {
  const rendered = formatFields({
    token: "mcp_at_should-not-appear",
    nested: { password: "secret", message: "mcp_password_abcdef\nforged" },
    authorization: "Bearer abcdefghijklmnopqrstuvwxyz",
  });
  if (rendered.includes("should-not-appear") || rendered.includes("password_abcdef") || rendered.includes("Bearer abcdef")) {
    throw new Error("structured log secret redaction failed");
  }
  if (rendered.includes("\nforged")) throw new Error("structured log newline injection was not escaped");
  if (sanitizeLogText("ok\n[error] forged").includes("\n[error]")) throw new Error("log message newline injection was not escaped");
}

async function serviceSelfTest() {
  const stateRoot = await mkdtemp(join(tmpdir(), "mbm-service-test-"));
  try {
    const logs = join(stateRoot, "logs");
    await writeFile(join(stateRoot, "placeholder"), "", "utf8");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(logs, { recursive: true }));
    const file = join(logs, "daemon.err.log");
    await writeFile(file, "x".repeat(4096), "utf8");
    trimAutostartLogs(stateRoot, { maxBytes: 2048, keepBytes: 1024 });
    if ((await stat(file)).size > 1024) throw new Error("autostart log trimming failed");
    const quoted = systemdQuote("path with space/%value'\n");
    if (!quoted.startsWith('"') || !quoted.includes("%%") || !quoted.includes("\\n")) throw new Error("systemd argument quoting failed");
  } finally {
    await rm(stateRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function shellSelfTest() {
  const result = await run(process.execPath, ["-e", "process.stdout.write('x'.repeat(4096)); process.stderr.write('y'.repeat(4096));"], {
    capture: true,
    maxOutputBytes: 1024,
  });
  if (result.code !== 0 || !result.stdout.includes("[truncated") || !result.stderr.includes("[truncated")) {
    throw new Error("bounded shell capture failed");
  }
  const timedOut = await run(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
    capture: true,
    allowFailure: true,
    timeoutMs: 50,
  });
  if (timedOut.code !== 124 || !timedOut.stderr.includes("timed out")) throw new Error("shell timeout handling failed");
}

async function workerSourceSelfTest() {
  const source = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
  const unawaitedAsyncRoutes = [
    "return this.registerClient(request);",
    "return this.authorizeSubmit(request, base);",
    "return this.exchangeToken(request, base);",
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
    "pending.socket !== ws",
    "isJsonRpcId(candidate.id)",
    "pruneRecordByExpiry(store.tokens, MAX_OAUTH_TOKENS)",
    "A valid PKCE S256 challenge is required.",
  ]) {
    if (!source.includes(required)) throw new Error(`Worker hardening guard missing: ${required}`);
  }
  for (const removed of ["/api/mcp/sampling", "/api/daemon/status", "sampling/createMessage"]) {
    if (source.includes(removed)) throw new Error(`obsolete or public-sensitive Worker route remains: ${removed}`);
  }
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
