import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import path, { resolve } from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { LocalDaemon } from "./daemon.mjs";
import { createLogger, sanitizeLogText } from "./log.mjs";
import { runWrangler } from "./shell.mjs";
import {
  acquireDaemonLock,
  acquireStartupLock,
  appName,
  daemonLockPathForState,
  defaultStateRoot,
  ensureOwnerOnlyDir,
  ensureWorkerSecrets,
  expandHome,
  loadGlobalConfig,
  loadState,
  ownerOnlyFile,
  packageRoot,
  previewSecret,
  readDaemonLockOwner,
  redactState,
  removeStateRoot,
  validateStateRootForRemoval,
  resolveWorkspace,
  saveGlobalConfig,
  saveState,
  selectedWorkspace,
  setSelectedWorkspace,
} from "./state.mjs";

const BOOLEAN_OPTIONS = new Set([
  "help", "version", "quiet", "json", "verbose", "rotateSecrets", "forceWorker",
  "daemonOnly", "noAutostart", "noPrintCredentials", "printMcpCredentials",
  "printCredentials", "noWrite", "noExec", "fullEnv", "unrestrictedPaths",
  "yes", "keepWorker", "noApi", "api", "rotateApiKey",
]);
const VALUE_OPTIONS = new Set([
  "workspace", "stateDir", "workerName", "apiPort", "apiHost", "apiKey", "apiModel", "port",
]);

export async function main(argv = process.argv.slice(2)) {
  const [command, rest] = normalizeCommand(argv);
  const args = parseArgs(rest);
  if (args.help || command === "help") return usage();
  if (args.version || command === "version") return version();
  if (command === "api") throw removedLocalApiError();
  validateCommandOptions(command, args);
  validatePositionals(command, args);

  switch (command) {
    case "start": return startCommand(args);
    case "status": return statusCommand(args);
    case "doctor": return doctorCommand(args);
    case "workspace": return workspaceCommand(args);
    case "service":
    case "autostart": return serviceCommand(args);
    case "rotate-secrets": return rotateSecretsCommand(args);
    case "uninstall": return uninstallCommand(args);
    default:
      console.error(`Unknown command: ${command}`);
      usage();
      process.exitCode = 2;
  }
}

const COMMAND_OPTIONS = {
  start: new Set([
    "workspace", "stateDir", "workerName", "quiet", "json", "verbose", "rotateSecrets", "forceWorker",
    "daemonOnly", "noAutostart", "noPrintCredentials", "printMcpCredentials", "printCredentials",
    "noWrite", "noExec", "fullEnv", "unrestrictedPaths",
    "noApi", "api", "apiPort", "apiHost", "apiKey", "rotateApiKey", "apiModel", "port",
  ]),
  status: new Set(["workspace", "stateDir"]),
  doctor: new Set(["workspace", "stateDir"]),
  "rotate-secrets": new Set(["workspace", "stateDir", "workerName", "noPrintCredentials", "quiet"]),
  workspace: new Set(["workspace", "stateDir"]),
  service: new Set(["workspace", "stateDir", "quiet"]),
  autostart: new Set(["workspace", "stateDir", "quiet"]),
  uninstall: new Set(["stateDir", "keepWorker", "yes"]),
};

export function validateCommandOptions(command, args) {
  const allowed = COMMAND_OPTIONS[command];
  if (!allowed) return;
  for (const key of Object.keys(args)) {
    if (key === "_" || key === "help" || key === "version") continue;
    if (!allowed.has(key)) throw new Error(`Option --${toKebab(key)} is not valid for ${command}`);
  }
}

function toKebab(value) {
  return String(value).replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
}

export function validatePositionals(command, args) {
  const count = args._.length;
  const conflict = Boolean(args.workspace) && count > (command === "workspace" || command === "service" || command === "autostart" ? 1 : 0);
  if (conflict) throw new Error("workspace path was provided both positionally and with --workspace");
  if (["start", "status", "doctor", "rotate-secrets"].includes(command)) {
    if (count > 1) throw new Error(`${command} accepts at most one positional workspace path`);
    if (args.workspace && count) throw new Error("workspace path was provided both positionally and with --workspace");
    return;
  }
  if (command === "workspace") {
    const action = String(args._[0] || "show");
    const max = action === "set" || action === "select" ? 2 : 1;
    if (count > max) throw new Error(`workspace ${action} received too many positional arguments`);
    if (args.workspace && count > 1) throw new Error("workspace path was provided both positionally and with --workspace");
    return;
  }
  if (command === "service" || command === "autostart") {
    const action = String(args._[0] || "status");
    const max = action === "install" ? 2 : 1;
    if (count > max) throw new Error(`service ${action} received too many positional arguments`);
    if (args.workspace && count > 1) throw new Error("workspace path was provided both positionally and with --workspace");
    return;
  }
  if (command === "uninstall" && count) throw new Error("uninstall does not accept positional arguments");
}

function normalizeCommand(argv) {
  if (!argv.length || argv[0].startsWith("--")) return ["start", argv];
  return [argv[0], argv.slice(1)];
}

export function parseArgs(argv) {
  const out = { _: [] };
  let positionalOnly = false;
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (positionalOnly || raw === "-" || !raw.startsWith("--")) {
      out._.push(raw);
      continue;
    }
    if (raw === "--") {
      positionalOnly = true;
      continue;
    }
    const eq = raw.indexOf("=");
    const rawKey = raw.slice(2, eq >= 0 ? eq : undefined);
    if (!rawKey) throw new Error("invalid empty option");
    const key = toCamel(rawKey);
    if (!BOOLEAN_OPTIONS.has(key) && !VALUE_OPTIONS.has(key)) throw new Error(`Unknown option: --${rawKey}`);
    if (Object.prototype.hasOwnProperty.call(out, key)) throw new Error(`Duplicate option: --${rawKey}`);
    if (BOOLEAN_OPTIONS.has(key)) {
      out[key] = eq >= 0 ? parseBooleanOption(raw.slice(eq + 1), rawKey) : true;
      continue;
    }
    const value = eq >= 0 ? raw.slice(eq + 1) : argv[++i];
    if (value === undefined || value === "" || value.startsWith("--")) throw new Error(`Option --${rawKey} requires a value`);
    out[key] = value;
  }
  return out;
}

function parseBooleanOption(value, key) {
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`Option --${key} expects true or false when using =`);
}

function toCamel(key) {
  return key.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
}

function stateRootFromArgs(args) {
  return args.stateDir ? expandHome(String(args.stateDir)) : defaultStateRoot();
}

async function chooseWorkspace(args, { promptOnFirstRun, save, allowPositional = false }) {
  const stateRoot = stateRootFromArgs(args);
  const explicit = args.workspace || (allowPositional ? args._[0] : undefined);
  if (explicit && explicit !== true) {
    const workspace = resolveWorkspace(String(explicit));
    if (save) setSelectedWorkspace(workspace, stateRoot);
    return workspace;
  }

  const remembered = selectedWorkspace(stateRoot);
  if (remembered) return resolveWorkspace(remembered);

  const fallback = process.cwd();
  if (!promptOnFirstRun || !process.stdin.isTTY) {
    const workspace = resolveWorkspace(fallback);
    if (save) setSelectedWorkspace(workspace, stateRoot);
    return workspace;
  }

  const answer = await ask(`Workspace path [${fallback}]: `);
  const workspace = resolveWorkspace(answer.trim() || fallback);
  if (save) setSelectedWorkspace(workspace, stateRoot);
  return workspace;
}

async function workspaceCommand(args) {
  const action = String(args._[0] || "show");
  const stateRoot = stateRootFromArgs(args);
  if (action === "show") {
    const workspace = selectedWorkspace(stateRoot);
    console.log(workspace || "No workspace selected yet. Run `machine-mcp workspace set` or `mbm workspace set`.");
    return;
  }
  if (action === "set" || action === "select") {
    const raw = args.workspace || args._[1];
    let workspace;
    if (raw && raw !== true) workspace = resolveWorkspace(String(raw));
    else {
      const current = selectedWorkspace(stateRoot) || process.cwd();
      const answer = process.stdin.isTTY ? await ask(`Workspace path [${current}]: `) : current;
      workspace = resolveWorkspace(String(answer || current));
    }
    setSelectedWorkspace(workspace, stateRoot);
    console.log(`Selected workspace: ${workspace}`);
    console.log("Run `machine-mcp` (or `mbm`) to use this workspace.");
    return;
  }
  if (action === "reset") {
    const config = loadGlobalConfig(stateRoot);
    delete config.selectedWorkspace;
    delete config.selectedWorkspaceHash;
    saveGlobalConfig(config, stateRoot);
    console.log("Workspace selection reset. Next start will ask again.");
    return;
  }
  throw new Error(`Unknown workspace action: ${action}`);
}

async function ask(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

async function confirm(prompt, assumeYes = false) {
  if (assumeYes) return true;
  if (!process.stdin.isTTY) return false;
  const answer = (await ask(`${prompt} [y/N]: `)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

async function startCommand(args) {
  assertNodeVersion();
  assertNoRemovedLocalApiOptions(args);
  const logger = createLogger({ quiet: Boolean(args.quiet || args.json), verbose: Boolean(args.verbose), component: "cli" });
  const workspace = await chooseWorkspace(args, { promptOnFirstRun: true, save: true, allowPositional: true });
  const state = loadState(workspace, { stateDir: args.stateDir });
  const startupLock = acquireStartupLock(state);
  if (!startupLock.acquired) {
    const pid = startupLock.owner?.pid ? `pid ${startupLock.owner.pid}` : "unknown pid";
    throw new Error(`another startup/deployment operation is already running for this workspace (${pid})`);
  }
  try {
    if (args.daemonOnly) {
      const { trimAutostartLogs } = await import("./service.mjs");
      trimAutostartLogs(state.paths.stateRoot);
    }
    const previousMcpServerUrl = state.worker?.mcpServerUrl || "";
    const firstMcpConnection = !previousMcpServerUrl || !state.worker?.oauthPassword;

    const workerName = validateWorkerName(args.workerName);
    ensureWorkerSecrets(state, { rotateSecrets: Boolean(args.rotateSecrets), workerName });
    state.policy = {
      allowWrite: args.noWrite ? false : true,
      allowExec: args.noExec ? false : true,
      unrestrictedPaths: Boolean(args.unrestrictedPaths),
      minimalEnv: args.fullEnv ? false : true,
      updatedAt: new Date().toISOString(),
    };
    saveState(state);

    if (!args.daemonOnly) await ensureWorker(state, args);
    else if (!state.worker.url) throw new Error("--daemon-only requires an existing worker URL in state; run start once without --daemon-only");

    const mcpConnectionChanged = previousMcpServerUrl && previousMcpServerUrl !== state.worker.mcpServerUrl;
    const shouldPrintMcpCredentials = Boolean(args.json || args.printMcpCredentials || args.printCredentials || firstMcpConnection || args.rotateSecrets || mcpConnectionChanged);

    if (!args.daemonOnly && !args.noAutostart) {
      await installAutostartBestEffort({ workspace, stateRoot: state.paths.stateRoot, entryScript: process.argv[1], policy: state.policy });
    }

    if (!args.daemonOnly) await stopAutostartBestEffort(Boolean(args.quiet));

    const lock = acquireDaemonLock(state);
    let daemon = null;
    if (!lock.acquired) {
      if (!args.quiet) {
        const pid = lock.owner?.pid ? `pid ${lock.owner.pid}` : "unknown pid";
        logger.warn(`local daemon already running for this workspace (${pid}); not starting a duplicate`);
        if (!args.json) printMcpConnection(state, {
          noPrintCredentials: Boolean(args.noPrintCredentials),
          includeCredentials: shouldPrintMcpCredentials,
          quiet: Boolean(args.quiet),
        });
      }
      if (args.json) printStartJson(state, { noPrintCredentials: Boolean(args.noPrintCredentials) });
      return;
    }

    try {
      daemon = new LocalDaemon({
        workerUrl: state.worker.url,
        secret: state.worker.daemonSecret,
        workspace,
        policy: state.policy,
        logger: createLogger({ quiet: Boolean(args.quiet || args.json), verbose: Boolean(args.verbose), component: "daemon" }),
      });

      const waitForConnect = daemon.start();
      await waitForConnectWithNotice(waitForConnect, 20_000, Boolean(args.quiet || args.json));
      if (args.json) printStartJson(state, { noPrintCredentials: Boolean(args.noPrintCredentials) });
      else {
        printMcpConnection(state, {
          noPrintCredentials: Boolean(args.noPrintCredentials),
          includeCredentials: shouldPrintMcpCredentials,
          quiet: Boolean(args.quiet),
        });
      }
      keepProcessAlive({ daemon, lock, logger });
    } catch (error) {
      try { daemon?.stop?.(); } catch {}
      lock.release();
      throw error;
    }
  } finally {
    startupLock.release();
  }
}

function assertNoRemovedLocalApiOptions(args) {
  const removed = ["api", "noApi", "apiPort", "apiHost", "apiKey", "rotateApiKey", "apiModel", "port"].filter((key) => args[key] !== undefined);
  if (removed.length) throw removedLocalApiError();
}

function removedLocalApiError() {
  return new Error("Local /v1 API support has been removed. Use the printed Remote MCP Server URL/password with an MCP client instead.");
}

async function ensureWorker(state, args) {
  const logger = createLogger({ quiet: Boolean(args.quiet || args.json), verbose: Boolean(args.verbose), component: "worker" });
  const desiredHash = workerDeployHash(state);
  const expectedVersion = currentPackageVersion();
  const complete = state.worker.url && state.worker.mcpServerUrl && state.worker.oauthPassword && state.worker.daemonSecret && state.worker.oauthTokenVersion && state.worker.name;
  if (!args.forceWorker && !args.rotateSecrets && complete && state.worker.deployHash === desiredHash) {
    const health = await workerHealth(state.worker.url, expectedVersion);
    if (health.ok) {
      logger.success("Worker unchanged and healthy", { url: state.worker.url });
      return state.worker;
    }
    logger.warn("Worker health check failed; redeploying", { error: health.error });
  }

  logger.info("Checking Cloudflare Wrangler login");
  const whoami = await runWrangler(["whoami"], { capture: true, allowFailure: true });
  if (whoami.code !== 0) {
    logger.info("Wrangler is not logged in; opening Cloudflare login");
    await runWrangler(["login"]);
  }

  logger.info("Deploying Cloudflare Worker", { name: state.worker.name });
  const deploy = await withSecretsFile(state, secretFile => runWrangler([
    "deploy",
    "--name", state.worker.name,
    "--minify",
    "--keep-vars",
    "--secrets-file", secretFile,
  ], { capture: true }));

  const workerUrl = extractWorkerUrl(deploy.stdout) || extractWorkerUrl(deploy.stderr) || state.worker.url;
  if (!workerUrl) throw new Error("Worker deployed but URL could not be detected. Re-run with --worker-name or inspect Wrangler output.");
  state.worker.url = workerUrl.replace(/\/+$/, "");
  state.worker.mcpServerUrl = `${state.worker.url}/mcp`;
  delete state.worker.deployHash;
  state.worker.updatedAt = new Date().toISOString();
  saveState(state);

  const health = await retryHealth(state.worker.url, expectedVersion, 8);
  if (!health.ok) {
    throw new Error(`Worker deployment did not become healthy at the expected version: ${health.error}`);
  }
  state.worker.deployHash = desiredHash;
  saveState(state);
  logger.success("Worker ready", { url: state.worker.url, version: health.version });
  return state.worker;
}

async function withSecretsFile(state, callback) {
  const dir = state.paths.profileDir;
  ensureOwnerOnlyDir(dir);
  cleanupStaleSecretFiles(dir);
  const tempPath = resolve(dir, `worker-secrets-${process.pid}-${Date.now()}.json`);
  const payload = {
    MCP_OAUTH_PASSWORD: state.worker.oauthPassword,
    DAEMON_SHARED_SECRET: state.worker.daemonSecret,
    OAUTH_TOKEN_VERSION: state.worker.oauthTokenVersion,
  };
  writeFileSync(tempPath, JSON.stringify(payload), { mode: 0o600 });
  ownerOnlyFile(tempPath);
  try {
    return await callback(tempPath);
  } finally {
    try { unlinkSync(tempPath); } catch {}
  }
}

function cleanupStaleSecretFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !/^worker-secrets-.*\.json$/.test(entry.name)) continue;
    const file = resolve(dir, entry.name);
    try {
      if (Date.now() - statSync(file).mtimeMs > 60 * 60 * 1000) unlinkSync(file);
    } catch {}
  }
}

function workerDeployHash(state) {
  const hash = createHash("sha256");
  hash.update("mbm-worker-deploy-v1");
  hash.update(String(state.worker.name || ""));
  hash.update(String(state.worker.oauthPassword || ""));
  hash.update(String(state.worker.daemonSecret || ""));
  hash.update(String(state.worker.oauthTokenVersion || ""));
  for (const file of workerDeployHashFiles()) {
    hash.update(path.relative(packageRoot, file));
    hash.update(workerHashContent(file));
  }
  return hash.digest("hex");
}

function workerHashContent(file) {
  return readFileSync(file, "utf8");
}

function workerDeployHashFiles() {
  const files = [];
  for (const item of ["src/worker", "wrangler.jsonc", "tsconfig.json"]) {
    collectHashFiles(resolve(packageRoot, item), files);
  }
  return files.sort();
}

function collectHashFiles(target, out) {
  if (!existsSync(target)) return;
  const info = statSync(target);
  if (info.isFile()) {
    if (/\.(ts|js|mjs|json|jsonc|yaml|yml|lock)$/.test(target)) out.push(target);
    return;
  }
  if (!info.isDirectory()) return;
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".wrangler" || entry.name.endsWith(".d.ts")) continue;
    collectHashFiles(resolve(target, entry.name), out);
  }
}

async function workerHealth(workerUrl, expectedVersion = currentPackageVersion()) {
  if (!workerUrl) return { ok: false, error: "missing_worker_url" };
  try {
    const response = await fetch(`${String(workerUrl).replace(/\/+$/, "")}/healthz`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    const body = await response.json().catch(() => null);
    if (body?.ok !== true || body?.server !== appName) return { ok: false, error: "unexpected_health_response" };
    if (body?.version !== expectedVersion) return { ok: false, error: `version_mismatch:${body?.version || "unknown"}!=${expectedVersion}` };
    return { ok: true, version: body.version };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function retryHealth(workerUrl, expectedVersion, attempts) {
  let last = { ok: false, error: "not_checked" };
  for (let i = 0; i < attempts; i += 1) {
    last = await workerHealth(workerUrl, expectedVersion);
    if (last.ok) return last;
    await sleep(1000 + i * 500);
  }
  return last;
}

function extractWorkerUrl(text = "") {
  const matches = [...String(text).matchAll(/https:\/\/[^\s"'<>]+\.workers\.dev[^\s"'<>]*/g)];
  if (matches.length) return matches.at(-1)[0].replace(/[),.]+$/, "");
  const anyHttps = [...String(text).matchAll(/https:\/\/[^\s"'<>]+/g)];
  return anyHttps.find(match => /workers\.dev|\/healthz|\/mcp/.test(match[0]))?.[0]?.replace(/[),.]+$/, "") || "";
}

async function waitForConnectWithNotice(promise, timeoutMs, quiet = false) {
  let timeout;
  const timed = new Promise(resolvePromise => {
    timeout = setTimeout(() => resolvePromise("timeout"), timeoutMs);
  });
  const result = await Promise.race([promise.then(() => "connected"), timed]);
  clearTimeout(timeout);
  if (result === "timeout") createLogger({ component: "daemon", quiet }).warn("Still connecting; the process will keep retrying");
}


function printStartJson(state, { noPrintCredentials = false } = {}) {
  const mcpPassword = noPrintCredentials ? previewSecret(state.worker.oauthPassword) : state.worker.oauthPassword;
  createLogger({ component: "ready" }).json({
    mcp: {
      server_url: state.worker.mcpServerUrl,
      connection_password: mcpPassword,
      worker_url: state.worker.url,
      worker_name: state.worker.name,
    },
    workspace: state.workspace.path,
    state_path: state.paths.statePath,
    policy: state.policy,
  });
}

function printMcpConnection(state, { json = false, noPrintCredentials = false, includeCredentials = false, quiet = false } = {}) {
  const logger = createLogger({ component: "ready", quiet });
  const payload = {
    mcp_server_url: state.worker.mcpServerUrl,
    mcp_connection_password: state.worker.oauthPassword,
    worker_url: state.worker.url,
    worker_name: state.worker.name,
    workspace: state.workspace.path,
    state_path: state.paths.statePath,
    policy: state.policy,
  };
  if (json) {
    const safePayload = noPrintCredentials ? { ...payload, mcp_connection_password: previewSecret(payload.mcp_connection_password) } : payload;
    logger.json(safePayload);
    return;
  }
  if (includeCredentials) {
    logger.success("Remote MCP bridge is ready; save these connection details if your ChatGPT app needs to reconnect");
    logger.plain(`  MCP Server URL: ${payload.mcp_server_url}`);
    if (!noPrintCredentials) logger.plain(`  MCP connection password: ${payload.mcp_connection_password}`);
    else logger.plain(`  MCP connection password: ${previewSecret(payload.mcp_connection_password)} (redacted)`);
  } else {
    logger.success("Remote MCP bridge is ready; MCP connection details unchanged");
    logger.plain("  Use --print-mcp-credentials only when a ChatGPT app needs to reconnect.");
  }
  logger.plain(`  Workspace cwd: ${payload.workspace}`);
  logger.plain(`  Policy: write=${payload.policy.allowWrite ? "on" : "off"}, exec=${payload.policy.allowExec ? "on" : "off"}, unrestricted_paths=${payload.policy.unrestrictedPaths ? "on" : "off"}`);
  logger.plain(`  State: ${payload.state_path}`);
}

function keepProcessAlive({ daemon = null, lock = null, logger = createLogger({ component: "cli" }) } = {}) {
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    logger.info("stopping local services");
    try { daemon?.stop?.(); } catch {}
    try { lock?.release?.(); } catch {}
    process.exit(0);
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  process.once("exit", () => lock?.release?.());
  setInterval(() => {}, 2 ** 31 - 1);
}

async function statusCommand(args) {
  const workspace = await chooseWorkspace(args, { promptOnFirstRun: false, save: false, allowPositional: true });
  const state = loadState(workspace, { stateDir: args.stateDir });
  const health = state.worker?.url ? await workerHealth(state.worker.url) : { ok: false, error: "no worker url" };
  const payload = { ...redactState(state), workerHealth: health };
  console.log(JSON.stringify(payload, null, 2));
}

async function doctorCommand(args) {
  const workspace = await chooseWorkspace(args, { promptOnFirstRun: false, save: false, allowPositional: true });
  const checks = [];
  checks.push({ name: "node", ok: Number(process.versions.node.split(".")[0]) >= 22, detail: process.version });
  const wrangler = await runWrangler(["--version"], { capture: true, allowFailure: true });
  checks.push({ name: "wrangler", ok: wrangler.code === 0, detail: (wrangler.stdout || wrangler.stderr).trim() });
  const whoami = await runWrangler(["whoami"], { capture: true, allowFailure: true });
  checks.push({ name: "cloudflare-login", ok: whoami.code === 0, detail: whoami.code === 0 ? "authenticated" : sanitizeLines(whoami.stderr || whoami.stdout) });
  const state = loadState(workspace, { stateDir: args.stateDir });
  const health = state.worker?.url ? await workerHealth(state.worker.url) : { ok: false, error: "no worker url" };
  checks.push({ name: "worker-health", ok: health.ok, detail: health.ok ? state.worker.url : health.error });
  console.log(JSON.stringify({ ok: checks.every(check => check.ok), checks, state: redactState(state) }, null, 2));
}

async function rotateSecretsCommand(args) {
  const workspace = await chooseWorkspace(args, { promptOnFirstRun: false, save: false, allowPositional: true });
  const state = loadState(workspace, { stateDir: args.stateDir });
  const startupLock = acquireStartupLock(state);
  if (!startupLock.acquired) {
    const pid = startupLock.owner?.pid ? `pid ${startupLock.owner.pid}` : "unknown pid";
    throw new Error(`another startup/deployment operation is already running for this workspace (${pid})`);
  }
  try {
    await stopAutostartBestEffort(Boolean(args.quiet));
    await sleep(500);
    const daemonOwner = readDaemonLockOwner(daemonLockPathForState(state));
    if (daemonOwner?.pid && isPidAlive(daemonOwner.pid)) {
      throw new Error(`refusing to rotate secrets while the daemon is active (pid ${daemonOwner.pid}); stop the foreground daemon and retry`);
    }
    ensureWorkerSecrets(state, { rotateSecrets: true, workerName: validateWorkerName(args.workerName) });
    saveState(state);
    console.log(`Rotated MCP password: ${args.noPrintCredentials ? "<redacted>" : state.worker.oauthPassword}`);
    console.log(`Rotated daemon secret: ${args.noPrintCredentials ? "<redacted>" : previewSecret(state.worker.daemonSecret)}`);
    console.log("Run start to redeploy the Worker with the new secrets and revoke old OAuth access tokens.");
  } finally {
    startupLock.release();
  }
}

async function serviceCommand(args) {
  const action = String(args._[0] || "status");
  const stateRoot = stateRootFromArgs(args);
  const { installAutostart, uninstallAutostart, autostartStatus, startAutostart, stopAutostart } = await import("./service.mjs");
  if (action === "status") {
    const status = await autostartStatus({ logger: structuredLogger(Boolean(args.quiet)) });
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  if (action === "install") {
    const workspaceArgs = { ...args, _: args._.slice(1) };
    const workspace = await chooseWorkspace(workspaceArgs, { promptOnFirstRun: true, save: true, allowPositional: true });
    const state = loadState(workspace, { stateDir: stateRoot });
    if (!state.worker?.url) {
      throw new Error("No deployed Worker is recorded for this workspace. Run `machine-mcp` once before `machine-mcp service install`.");
    }
    const result = await installAutostart({ workspace, stateRoot, entryScript: process.argv[1], policy: state.policy, logger: structuredLogger(Boolean(args.quiet)) });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (action === "start") {
    const result = await startAutostart({ logger: structuredLogger(Boolean(args.quiet)) });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (action === "stop") {
    const result = await stopAutostart({ logger: structuredLogger(Boolean(args.quiet)) });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (action === "uninstall" || action === "remove") {
    const result = await uninstallAutostart({ stateRoot, logger: structuredLogger(Boolean(args.quiet)) });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  throw new Error(`Unknown service action: ${action}`);
}

async function installAutostartBestEffort({ workspace, stateRoot, entryScript, policy }) {
  try {
    const { installAutostart } = await import("./service.mjs");
    const result = await installAutostart({ workspace, stateRoot, entryScript, policy, logger: structuredLogger(false) });
    if (result?.ok) console.log("Autostart installed for future logins. Use `machine-mcp service status` to inspect or `machine-mcp service uninstall` to remove.");
    else console.warn("Autostart installation returned a warning; run `machine-mcp service status` for details.");
  } catch (error) {
    console.warn(`Autostart installation skipped: ${error.message}`);
  }
}

async function stopAutostartBestEffort(quiet = false) {
  try {
    const { stopAutostart } = await import("./service.mjs");
    await stopAutostart({ logger: structuredLogger(true) });
  } catch (error) {
    if (!quiet) console.warn(`Autostart stop skipped: ${error.message}`);
  }
}

async function uninstallCommand(args) {
  const stateRoot = stateRootFromArgs(args);
  const deleteRemote = !args.keepWorker;
  validateStateRootForRemoval(stateRoot);
  const action = deleteRemote
    ? `delete deployed Worker(s), remove autostart entries, and remove local state at ${stateRoot}`
    : `remove autostart entries and local state at ${stateRoot} while keeping deployed Worker(s)`;
  const ok = await confirm(`Uninstall Machine Bridge MCP: ${action}?`, Boolean(args.yes));
  if (!ok) {
    console.log("Uninstall cancelled. Re-run with `machine-mcp uninstall --yes` to skip confirmation.");
    return;
  }
  const autostartRemoved = await removeAutostartBestEffort(stateRoot);
  if (!autostartRemoved) throw new Error("autostart removal failed; state and Worker were kept so the uninstall can be retried safely");
  await sleep(500);
  const activeLocks = activeStateLocks(stateRoot);
  if (activeLocks.length) {
    const detail = activeLocks.map((item) => `${item.kind}:${item.pid || "unknown"}`).join(", ");
    throw new Error(`refusing to uninstall while Machine Bridge processes are active (${detail}); stop foreground sessions and retry`);
  }
  if (deleteRemote) await deleteKnownWorkers(stateRoot);
  removeStateRoot(stateRoot);
  console.log("Removed local autostart entries and state.");
  if (deleteRemote) console.log("Requested deletion for known deployed Worker(s).");
  console.log("If installed globally, remove the npm package with:");
  console.log("  npm uninstall -g machine-bridge-mcp");
}

async function deleteKnownWorkers(stateRoot) {
  const names = knownWorkerNames(stateRoot);
  if (!names.length) {
    console.log("No deployed Worker name found in local state.");
    return;
  }
  const failures = [];
  for (const name of names) {
    const result = await runWrangler(["delete", name, "--force"], { capture: true, allowFailure: true });
    const detail = (result.stderr || result.stdout || "unknown error").trim();
    if (result.code === 0 || /not found|does not exist|could not find/i.test(detail)) {
      console.log(`Deleted Worker: ${name}`);
    } else {
      failures.push({ name, detail: sanitizeLines(detail) || "unknown error" });
    }
  }
  if (failures.length) {
    throw new Error(`failed to delete Worker(s): ${failures.map((item) => `${item.name} (${item.detail})`).join(", ")}; local state was kept for retry`);
  }
}

function knownWorkerNames(stateRoot) {
  const profiles = resolve(expandHome(stateRoot), "profiles");
  if (!existsSync(profiles)) return [];
  const names = new Set();
  for (const entry of readdirSync(profiles, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const stateFile = resolve(profiles, entry.name, "state.json");
    if (!existsSync(stateFile)) continue;
    try {
      const state = JSON.parse(readFileSync(stateFile, "utf8"));
      const name = String(state?.worker?.name || "");
      if (/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) names.add(name);
    } catch {}
  }
  return [...names];
}

async function removeAutostartBestEffort(stateRoot) {
  try {
    const { stopAutostart, uninstallAutostart } = await import("./service.mjs");
    await stopAutostart({ logger: structuredLogger(true) }).catch(() => {});
    const result = await uninstallAutostart({ stateRoot, logger: structuredLogger(false) });
    if (result?.ok === false) {
      console.warn("Autostart removal reported failure.");
      return false;
    }
    return true;
  } catch (error) {
    console.warn(`Autostart removal skipped or failed: ${error.message}`);
    return false;
  }
}

function activeStateLocks(stateRoot) {
  const profiles = resolve(expandHome(stateRoot), "profiles");
  if (!existsSync(profiles)) return [];
  const active = [];
  for (const profile of readdirSync(profiles, { withFileTypes: true })) {
    if (!profile.isDirectory()) continue;
    for (const [kind, name] of [["daemon", "daemon.lock"], ["startup", "startup.lock"]]) {
      const lockPath = resolve(profiles, profile.name, name);
      if (!existsSync(lockPath)) continue;
      const owner = readDaemonLockOwner(lockPath);
      if (owner?.pid && isPidAlive(owner.pid)) active.push({ kind, pid: owner.pid, path: lockPath });
    }
  }
  return active;
}

function isPidAlive(pid) {
  const parsed = Number(pid);
  if (!Number.isInteger(parsed) || parsed <= 0) return false;
  try {
    process.kill(parsed, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function structuredLogger(quiet) {
  return createLogger({ quiet, component: "daemon" });
}

function sanitizeLines(text) {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const homePattern = home ? new RegExp(escapeRegExp(home), "g") : null;
  let value = sanitizeLogText(text)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<email>");
  if (homePattern) value = value.replace(homePattern, "~");
  return value
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(0, 5)
    .join("\n");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function validateWorkerName(value) {
  if (value === undefined || value === null || value === false) return undefined;
  const name = String(value).trim();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) {
    throw new Error("--worker-name must be 1-63 lowercase letters, digits, or hyphens, and cannot start or end with a hyphen");
  }
  return name;
}

function assertNodeVersion() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) throw new Error(`Node.js >=22 is required; current ${process.version}`);
}

function usage() {
  console.log(`machine-bridge-mcp

Usage:
  npm install -g machine-bridge-mcp@latest && machine-mcp
  npx machine-bridge-mcp@latest                  # no global install; autostart may rely on npm cache
  ./mbm                                          # from source checkout
  .\\mbm.cmd                                      # from source checkout on Windows cmd

Commands:
  start             Deploy/update Worker, install autostart, start daemon
  workspace show    Show remembered workspace
  workspace set     Re-select workspace; prompts with current/default path
  service status    Show autostart status
  service install   Install login autostart for remembered/current workspace
  service start     Start the installed autostart service now
  service stop      Stop the installed autostart service
  service uninstall Remove only the autostart entry
  status            Print redacted local profile state and Worker health
  doctor            Check Node, Wrangler, Cloudflare login, Worker health
  rotate-secrets    Rotate MCP password and daemon secret in local state
  uninstall         Delete known Worker(s), remove autostart and local state

Start options:
  --workspace PATH      Use and remember this workspace path
  --worker-name NAME    Worker name (default: mbm-<workspace-hash>)
  --force-worker        Force wrangler deploy even if hash and health match
  --rotate-secrets      Rotate secrets before deploying
  --daemon-only         Skip deploy and only connect daemon from existing state
  --no-autostart        Do not install login autostart during start
  --no-print-credentials Redact credentials in console output
  --print-mcp-credentials Print MCP URL/password again for reconnecting ChatGPT apps
  --no-write            Disable write_file (default: write enabled)
  --no-exec             Disable exec_command (default: exec enabled)
  --full-env            Pass full parent environment to exec_command (default: minimal env)
  --unrestricted-paths  Allow absolute and parent paths outside the workspace (default: blocked)
  --state-dir DIR       Override state root
  --json                Print MCP connection details as JSON

Uninstall options:
  --keep-worker         Do not delete deployed Worker(s) during uninstall
  --yes                 Do not prompt before uninstall
`);
}

function currentPackageVersion() {
  const pkg = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
  return String(pkg.version);
}

function version() {
  const pkg = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
  console.log(`${pkg.name} ${pkg.version}`);
}

function sleep(ms) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms));
}
