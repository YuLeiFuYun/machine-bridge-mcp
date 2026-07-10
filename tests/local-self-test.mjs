import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../src/local/shell.mjs";
import { parseArgs, resolvePolicy, validateCommandOptions, validateLoggingOptions, validatePositionals } from "../src/local/cli.mjs";
import { daemonSelfTest } from "./daemon-self-test.mjs";
import { formatFields, sanitizeLogText } from "../src/local/log.mjs";
import { daemonArgs, systemdQuote, trimAutostartLogs } from "../src/local/service.mjs";
import { MCP_PROTOCOL_VERSION, toolsForPolicy } from "../src/local/tools.mjs";
import { acquireDaemonLock, acquireStartupLock, ensureWorkerSecrets, loadState, previewSecret, redactState, removeStateRoot, saveState, selectedWorkspace, setSelectedWorkspace, validateStateRootForRemoval } from "../src/local/state.mjs";

await daemonSelfTest();
await stateSelfTest();
await activeDaemonPolicyMutationSelfTest();
await clientConfigDefaultSelfTest();
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
    if (state.schemaVersion !== 4) throw new Error("unexpected state schema version");
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
    if (redacted.worker.oauthPassword !== "<redacted>") throw new Error("oauthPassword was not fully redacted");
    if (redacted.worker.daemonSecret !== "<redacted>") throw new Error("daemonSecret was not fully redacted");
    if (redacted.worker.oauthTokenVersion !== "<redacted>") throw new Error("oauthTokenVersion was not fully redacted");
    if (previewSecret(state.worker.oauthPassword) !== "<redacted>") throw new Error("previewSecret did not fully redact secret");

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
    migrated.policy = { profile: "custom", allowWrite: true, execMode: "shell", unrestrictedPaths: false, minimalEnv: true, exposeAbsolutePaths: false };
    saveState(migrated);
    const policyReload = loadState(workspace, { stateDir: stateRoot });
    policyReload.policy = resolvePolicy({}, policyReload.policy);
    saveState(policyReload);
    const policyPersisted = loadState(workspace, { stateDir: stateRoot });
    if (policyPersisted.policy.profile !== "full" || policyPersisted.policy.origin !== "migrated" || policyPersisted.policy.revision !== 2) {
      throw new Error("migrated policy origin/revision was not persisted");
    }

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
      if (output.mcp?.connection_password !== "<redacted>" || child.stdout.includes("mcp_password_")) {
        throw new Error("JSON start exposed connection credentials without an explicit print flag");
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
  validateCommandOptions("start", { _: [], unrestrictedPaths: true, noExec: true, logLevel: "warn" });
  validateLoggingOptions({ logLevel: "warn" });
  expectThrow(() => validateLoggingOptions({ logLevel: "trace" }), "log level must be");
  expectThrow(() => validateLoggingOptions({ quiet: true, verbose: true }), "cannot be used together");
  expectThrow(() => validateLoggingOptions({ logLevel: "warn", verbose: true }), "cannot be combined");
  validateCommandOptions("stdio", { _: [], profile: "agent", execMode: "direct" });
  validateCommandOptions("client-config", { _: [], client: "cursor", profile: "review" });
  validatePositionals("workspace", { _: ["set", "/tmp/project"] });
  validatePositionals("service", { _: ["install", "/tmp/project"] });
  validatePositionals("stdio", { _: ["/tmp/project"] });
  validatePositionals("client-config", { _: ["codex"] });

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
  const review = resolvePolicy({ profile: "review" }, {});
  const legacy = resolvePolicy({}, { profile: "custom", allowWrite: true, allowExec: true, execMode: "shell", unrestrictedPaths: false, minimalEnv: true, exposeAbsolutePaths: false });
  if (legacy.profile !== "full" || legacy.origin !== "migrated" || !legacy.unrestrictedPaths || legacy.minimalEnv || !legacy.exposeAbsolutePaths) {
    throw new Error("legacy implicit default policy was not migrated to full");
  }
  const staleDefault = resolvePolicy({}, { profile: "review", origin: "default", revision: 1, allowWrite: false, execMode: "off", unrestrictedPaths: false, minimalEnv: true, exposeAbsolutePaths: false });
  if (staleDefault.profile !== "full" || staleDefault.origin !== "default" || staleDefault.revision !== 2) {
    throw new Error("outdated default-origin policy did not follow the current policy revision");
  }
  const staleExplicit = resolvePolicy({}, { profile: "review", origin: "explicit", revision: 1, allowWrite: false, execMode: "off", unrestrictedPaths: false, minimalEnv: true, exposeAbsolutePaths: false });
  if (staleExplicit.profile !== "review" || staleExplicit.origin !== "explicit") {
    throw new Error("explicit policy was overwritten by a default revision upgrade");
  }
  const legacyReview = resolvePolicy({}, { profile: "review", allowWrite: false, execMode: "off", unrestrictedPaths: false, minimalEnv: true, exposeAbsolutePaths: false });
  if (legacyReview.profile !== "review" || legacyReview.origin !== "legacy-preserved" || legacyReview.allowWrite) {
    throw new Error("legacy explicit restrictive policy was not preserved");
  }
  const agent = resolvePolicy({ profile: "agent" }, {});
  if (!agent.allowWrite || agent.execMode !== "direct") throw new Error("agent profile is incorrect");
  const restrictedAgent = resolvePolicy({ profile: "agent", noExec: true, absolutePaths: true }, {});
  if (restrictedAgent.profile !== "custom" || restrictedAgent.execMode !== "off" || restrictedAgent.exposeAbsolutePaths !== true) throw new Error("policy overrides are incorrect");
  expectThrow(() => resolvePolicy({ profile: "unsafe" }, {}), "--profile must be one of");
  expectThrow(() => resolvePolicy({ execMode: "maybe" }, {}), "--exec-mode must be");

  const defaultNames = new Set(toolsForPolicy(defaultPolicy).map((tool) => tool.name));
  if (!defaultNames.has("write_file") || !defaultNames.has("run_process") || !defaultNames.has("exec_command")) throw new Error("default full profile omits maximum tool capabilities");
  const reviewNames = new Set(toolsForPolicy(review).map((tool) => tool.name));
  if (reviewNames.has("write_file") || reviewNames.has("run_process") || reviewNames.has("exec_command")) throw new Error("review profile exposes mutation tools");
  const agentNames = new Set(toolsForPolicy(agent).map((tool) => tool.name));
  if (!agentNames.has("apply_patch") || !agentNames.has("run_process") || agentNames.has("exec_command")) throw new Error("agent profile tool inventory is incorrect");
  if (MCP_PROTOCOL_VERSION !== "2025-11-25") throw new Error("MCP protocol version drifted");
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
  if (sanitizeLogText("x".repeat(10_000)).length > 2048) throw new Error("log message length was not bounded");
  const hostileFields = {};
  Object.defineProperty(hostileFields, "broken", { enumerable: true, get() { throw new Error("getter failed"); } });
  if (!formatFields(hostileFields).includes("fields_unavailable")) throw new Error("logging failed closed on hostile structured fields");
  const unprintable = { toString() { throw new Error("toString failed"); } };
  if (sanitizeLogText(unprintable) !== "<unprintable>") throw new Error("logging failed on an unprintable message");
  const oversizedFields = formatFields(Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`field_${i}`, "x".repeat(20_000)])));
  if (oversizedFields.length > 4500 || !oversizedFields.includes("fields_truncated")) throw new Error("structured log fields were not bounded");
}

async function serviceSelfTest() {
  const stateRoot = await mkdtemp(join(tmpdir(), "mbm-service-test-"));
  try {
    const logs = join(stateRoot, "logs");
    await writeFile(join(stateRoot, "placeholder"), "", "utf8");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(logs, { recursive: true }));
    const file = join(logs, "daemon.err.log");
    await writeFile(file, `${"discarded-line\n".repeat(300)}kept-unicode-日志\nlast-line\n`, "utf8");
    trimAutostartLogs(stateRoot, { maxBytes: 2048, keepBytes: 1024 });
    const trimmed = await readFile(file, "utf8");
    if ((await stat(file)).size > 1024 || trimmed.startsWith("�") || !trimmed.endsWith("last-line\n")) {
      throw new Error("autostart log tail trimming was not line/UTF-8 safe");
    }
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
  const source = await readFile(new URL("../src/worker/index.ts", import.meta.url), "utf8");
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
    "hmac-sha256:",
    "DAEMON_HELLO_TIMEOUT_MS",
    "async alarm()",
    "storage.setAlarm",
    'role: "candidate"',
    'role: "expired"',
    "daemon_hello_timeout",
    "replaced by authenticated daemon",
    "serverMetadata.protocolVersion",
    "notifications/cancelled",
    "structuredContent",
    "../shared/tool-catalog.json",
  ]) {
    if (!source.includes(required)) throw new Error(`Worker hardening guard missing: ${required}`);
  }
  for (const removed of [
    "/api/mcp/sampling",
    "/api/daemon/status",
    "sampling/createMessage",
    'request.headers.get("User-Agent")',
  ]) {
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
