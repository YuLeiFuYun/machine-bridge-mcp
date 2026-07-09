import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import path, { resolve } from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { LocalDaemon } from "./daemon.mjs";
import { runWrangler } from "./shell.mjs";
import {
  appName,
  defaultStateRoot,
  ensureOwnerOnlyDir,
  ensureWorkerSecrets,
  expandHome,
  loadGlobalConfig,
  loadState,
  ownerOnlyFile,
  packageRoot,
  previewSecret,
  redactState,
  removeStateRoot,
  resolveWorkspace,
  saveGlobalConfig,
  saveState,
  selectedWorkspace,
  setSelectedWorkspace,
} from "./state.mjs";

export async function main(argv = process.argv.slice(2)) {
  const [command, rest] = normalizeCommand(argv);
  const args = parseArgs(rest);
  if (args.help || command === "help") return usage();
  if (args.version || command === "version") return version();

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

function normalizeCommand(argv) {
  if (!argv.length || argv[0].startsWith("--")) return ["start", argv];
  return [argv[0], argv.slice(1)];
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith("--")) {
      out._.push(raw);
      continue;
    }
    const eq = raw.indexOf("=");
    const key = raw.slice(2, eq >= 0 ? eq : undefined);
    let value = eq >= 0 ? raw.slice(eq + 1) : true;
    if (eq < 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) value = argv[++i];
    out[toCamel(key)] = value;
  }
  return out;
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
  const workspace = await chooseWorkspace(args, { promptOnFirstRun: true, save: true, allowPositional: true });
  const state = loadState(workspace, { stateDir: args.stateDir });
  ensureWorkerSecrets(state, { rotateSecrets: Boolean(args.rotateSecrets), workerName: args.workerName && String(args.workerName) });
  state.policy = {
    allowWrite: args.noWrite ? false : true,
    allowExec: args.noExec ? false : true,
    unrestrictedPaths: true,
    minimalEnv: args.fullEnv ? false : true,
    updatedAt: new Date().toISOString(),
  };
  saveState(state);

  if (!args.daemonOnly) await ensureWorker(state, args);
  else if (!state.worker.url) throw new Error("--daemon-only requires an existing worker URL in state; run start once without --daemon-only");

  if (!args.daemonOnly && !args.noAutostart) {
    await installAutostartBestEffort({ workspace, stateRoot: state.paths.stateRoot, entryScript: process.argv[1], policy: state.policy });
  }

  const daemon = new LocalDaemon({
    workerUrl: state.worker.url,
    secret: state.worker.daemonSecret,
    workspace,
    policy: state.policy,
    logger: structuredLogger(args.quiet),
  });

  const waitForConnect = daemon.start();
  await waitForConnectWithNotice(waitForConnect, 20_000);
  printConnection(state, { json: Boolean(args.json), noPrintCredentials: Boolean(args.noPrintCredentials) });
  keepProcessAlive(daemon);
}

async function ensureWorker(state, args) {
  const desiredHash = workerDeployHash(state);
  const complete = state.worker.url && state.worker.mcpServerUrl && state.worker.oauthPassword && state.worker.daemonSecret && state.worker.oauthTokenVersion && state.worker.name;
  if (!args.forceWorker && !args.rotateSecrets && complete && state.worker.deployHash === desiredHash) {
    const health = await workerHealth(state.worker.url);
    if (health.ok) {
      console.log(`Worker unchanged and healthy: ${state.worker.url}`);
      return state.worker;
    }
    console.warn(`Worker health check failed, redeploying: ${health.error}`);
  }

  console.log("Checking Cloudflare Wrangler login...");
  const whoami = await runWrangler(["whoami"], { capture: true, allowFailure: true });
  if (whoami.code !== 0) {
    console.log("Wrangler is not logged in; opening Cloudflare login...");
    await runWrangler(["login"]);
  }

  console.log(`Deploying Cloudflare Worker '${state.worker.name}'...`);
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
  state.worker.deployHash = desiredHash;
  state.worker.updatedAt = new Date().toISOString();
  saveState(state);

  const health = await retryHealth(state.worker.url, 8);
  if (!health.ok) console.warn(`Worker deployed but health check did not pass yet: ${health.error}`);
  else console.log(`Worker ready: ${state.worker.url}`);
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
    hash.update(readFileSync(file));
  }
  return hash.digest("hex");
}

function workerDeployHashFiles() {
  const files = [];
  for (const item of ["src/worker", "wrangler.jsonc", "tsconfig.json", "package.json", "package-lock.json"]) {
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

async function workerHealth(workerUrl) {
  if (!workerUrl) return { ok: false, error: "missing_worker_url" };
  try {
    const response = await fetch(`${String(workerUrl).replace(/\/+$/, "")}/healthz`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    const body = await response.json().catch(() => null);
    if (body?.ok !== true || body?.server !== appName) return { ok: false, error: "unexpected_health_response" };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function retryHealth(workerUrl, attempts) {
  let last = { ok: false, error: "not_checked" };
  for (let i = 0; i < attempts; i += 1) {
    last = await workerHealth(workerUrl);
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

async function waitForConnectWithNotice(promise, timeoutMs) {
  let timeout;
  const timed = new Promise(resolvePromise => {
    timeout = setTimeout(() => resolvePromise("timeout"), timeoutMs);
  });
  const result = await Promise.race([promise.then(() => "connected"), timed]);
  clearTimeout(timeout);
  if (result === "timeout") console.warn("Daemon is still connecting; credentials are printed now and the process will keep retrying.");
}

function printConnection(state, { json = false, noPrintCredentials = false } = {}) {
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
    console.log(JSON.stringify(safePayload, null, 2));
    return;
  }
  console.log("\nMachine Bridge MCP is ready. Keep this process running.\n");
  console.log(`MCP Server URL: ${payload.mcp_server_url}`);
  if (!noPrintCredentials) console.log(`MCP connection password: ${payload.mcp_connection_password}`);
  else console.log(`MCP connection password: ${previewSecret(payload.mcp_connection_password)} (redacted)`);
  console.log(`Workspace cwd for relative paths: ${payload.workspace}`);
  console.log(`Policy: write=${payload.policy.allowWrite ? "on" : "off"}, exec=${payload.policy.allowExec ? "on" : "off"}, unrestricted_paths=${payload.policy.unrestrictedPaths ? "on" : "off"}`);
  console.log(`State: ${payload.state_path}\n`);
}

function keepProcessAlive(daemon) {
  const stop = () => {
    console.log("Stopping daemon...");
    daemon.stop();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
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
  checks.push({ name: "node", ok: Number(process.versions.node.split(".")[0]) >= 20, detail: process.version });
  const wrangler = await runWrangler(["--version"], { capture: true, allowFailure: true });
  checks.push({ name: "wrangler", ok: wrangler.code === 0, detail: (wrangler.stdout || wrangler.stderr).trim() });
  const whoami = await runWrangler(["whoami"], { capture: true, allowFailure: true });
  checks.push({ name: "cloudflare-login", ok: whoami.code === 0, detail: sanitizeLines(whoami.stdout || whoami.stderr) });
  const state = loadState(workspace, { stateDir: args.stateDir });
  const health = state.worker?.url ? await workerHealth(state.worker.url) : { ok: false, error: "no worker url" };
  checks.push({ name: "worker-health", ok: health.ok, detail: health.ok ? state.worker.url : health.error });
  console.log(JSON.stringify({ ok: checks.every(check => check.ok), checks, state: redactState(state) }, null, 2));
}

async function rotateSecretsCommand(args) {
  const workspace = await chooseWorkspace(args, { promptOnFirstRun: false, save: false, allowPositional: true });
  const state = loadState(workspace, { stateDir: args.stateDir });
  ensureWorkerSecrets(state, { rotateSecrets: true, workerName: args.workerName && String(args.workerName) });
  saveState(state);
  console.log(`Rotated MCP password: ${state.worker.oauthPassword}`);
  console.log(`Rotated daemon secret: ${previewSecret(state.worker.daemonSecret)}`);
  console.log("Run start to redeploy the Worker with the new secrets and revoke old OAuth access tokens.");
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

async function uninstallCommand(args) {
  const stateRoot = stateRootFromArgs(args);
  const deleteRemote = !args.keepWorker;
  const action = deleteRemote
    ? `delete deployed Worker(s), remove autostart entries, and remove local state at ${stateRoot}`
    : `remove autostart entries and local state at ${stateRoot} while keeping deployed Worker(s)`;
  const ok = await confirm(`Uninstall Machine Bridge MCP: ${action}?`, Boolean(args.yes));
  if (!ok) {
    console.log("Uninstall cancelled. Re-run with `machine-mcp uninstall --yes` to skip confirmation.");
    return;
  }
  if (deleteRemote) await deleteKnownWorkers(stateRoot);
  await removeAutostartBestEffort(stateRoot);
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
  for (const name of names) {
    const result = await runWrangler(["delete", name, "--force"], { capture: true, allowFailure: true });
    if (result.code === 0) console.log(`Deleted Worker: ${name}`);
    else console.warn(`Failed to delete Worker ${name}: ${(result.stderr || result.stdout || "unknown error").trim()}`);
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
      if (state?.worker?.name) names.add(String(state.worker.name));
    } catch {}
  }
  return [...names];
}

async function removeAutostartBestEffort(stateRoot) {
  try {
    const { uninstallAutostart } = await import("./service.mjs");
    await uninstallAutostart({ stateRoot, logger: structuredLogger(false) });
  } catch (error) {
    console.warn(`Autostart removal skipped or failed: ${error.message}`);
  }
}

function structuredLogger(quiet) {
  if (quiet) return { info() {}, warn() {}, error() {} };
  return {
    info: msg => console.log(`[daemon] ${msg}`),
    warn: msg => console.warn(`[daemon] ${msg}`),
    error: msg => console.error(`[daemon] ${msg}`),
  };
}

function sanitizeLines(text) {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const homePattern = home ? new RegExp(escapeRegExp(home), "g") : null;
  let value = String(text || "")
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

function assertNodeVersion() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20) throw new Error(`Node.js >=20 is required; current ${process.version}`);
}

function usage() {
  console.log(`machine-bridge-mcp

Usage:
  npm install -g machine-bridge-mcp@latest && machine-mcp
  npx machine-bridge-mcp@latest                  # no global install; autostart may rely on npm cache
  ./mbm                                          # from source checkout
  .\\mbm.cmd                                      # from source checkout on Windows cmd

Commands:
  start             Deploy/update Worker, install autostart, start local daemon
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
  --no-write            Disable write_file (default: write enabled)
  --no-exec             Disable exec_command (default: exec enabled)
  --full-env            Pass full parent environment to exec_command (default: minimal env)
  --state-dir DIR       Override state root
  --json                Print connection details as JSON

Uninstall options:
  --keep-worker         Do not delete deployed Worker(s) during uninstall
  --yes                 Do not prompt before uninstall
`);
}

function version() {
  const pkg = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
  console.log(`${pkg.name} ${pkg.version}`);
}

function sleep(ms) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms));
}
