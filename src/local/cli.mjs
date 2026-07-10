import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import path, { join, resolve } from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { LocalDaemon } from "./daemon.mjs";
import { runStdioServer } from "./stdio.mjs";
import { DEFAULT_POLICY_PROFILE, DEFAULT_POLICY_REVISION, POLICY_PROFILES, normalizePolicy, policyProfile } from "./tools.mjs";
import { classifyOperationalError, createLogger, normalizeLogLevel, sanitizeLogText } from "./log.mjs";
import { activeManagedJobs, inspectResourceFile, loadManagedJobPlan, ManagedJobManager, publicResourceRegistry, validateResourceName } from "./managed-jobs.mjs";
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
  "printCredentials", "noWrite", "noExec", "fullEnv", "unrestrictedPaths", "absolutePaths",
  "yes", "keepWorker", "allowInsecurePermissions",
]);
const VALUE_OPTIONS = new Set([
  "workspace", "stateDir", "workerName", "profile", "execMode", "client", "logLevel",
]);

export async function main(argv = process.argv.slice(2)) {
  const [command, rest] = normalizeCommand(argv);
  const args = parseArgs(rest);
  if (args.help || command === "help") return usage();
  if (args.version || command === "version") return version();
  if (command === "api") throw removedLocalApiError();
  validateCommandOptions(command, args);
  validatePositionals(command, args);
  validateLoggingOptions(args);

  switch (command) {
    case "start": return startCommand(args);
    case "stdio": return stdioCommand(args);
    case "client-config": return clientConfigCommand(args);
    case "status": return statusCommand(args);
    case "doctor": return doctorCommand(args);
    case "workspace": return workspaceCommand(args);
    case "service":
    case "autostart": return serviceCommand(args);
    case "rotate-secrets": return rotateSecretsCommand(args);
    case "resource": return resourceCommand(args);
    case "job": return jobCommand(args);
    case "uninstall": return uninstallCommand(args);
    default:
      console.error(`Unknown command: ${command}`);
      usage();
      process.exitCode = 2;
  }
}

const COMMAND_OPTIONS = {
  start: new Set([
    "workspace", "stateDir", "workerName", "quiet", "json", "verbose", "logLevel", "rotateSecrets", "forceWorker",
    "daemonOnly", "noAutostart", "noPrintCredentials", "printMcpCredentials", "printCredentials",
    "profile", "execMode", "noWrite", "noExec", "fullEnv", "unrestrictedPaths", "absolutePaths",
  ]),
  stdio: new Set(["workspace", "stateDir", "profile", "execMode", "noWrite", "noExec", "fullEnv", "unrestrictedPaths", "absolutePaths", "verbose", "quiet", "logLevel"]),
  "client-config": new Set(["workspace", "stateDir", "profile", "client", "json"]),
  status: new Set(["workspace", "stateDir"]),
  doctor: new Set(["workspace", "stateDir"]),
  "rotate-secrets": new Set(["workspace", "stateDir", "workerName", "noPrintCredentials", "printMcpCredentials", "printCredentials", "quiet"]),
  workspace: new Set(["workspace", "stateDir"]),
  service: new Set(["workspace", "stateDir", "quiet"]),
  autostart: new Set(["workspace", "stateDir", "quiet"]),
  resource: new Set(["workspace", "stateDir", "allowInsecurePermissions", "json"]),
  job: new Set(["workspace", "stateDir", "json", "yes"]),
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

export function validateLoggingOptions(args = {}) {
  if (args.quiet && args.verbose) throw new Error("--quiet and --verbose cannot be used together");
  if (args.logLevel !== undefined && (args.quiet || args.verbose)) {
    throw new Error("--log-level cannot be combined with --quiet or --verbose");
  }
  if (args.logLevel !== undefined) normalizeLogLevel(args.logLevel);
}

function effectiveLogLevel(args = {}) {
  if (args.logLevel !== undefined) return normalizeLogLevel(args.logLevel);
  if (args.quiet) return "error";
  if (args.verbose) return "debug";
  return "info";
}

function toKebab(value) {
  return String(value).replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
}

export function validatePositionals(command, args) {
  const count = args._.length;
  if (["start", "stdio", "status", "doctor", "rotate-secrets"].includes(command)) {
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
  if (command === "client-config") {
    if (count > 1) throw new Error("client-config accepts at most one positional client name");
    return;
  }
  if (command === "resource") {
    const action = String(args._[0] || "list");
    const max = action === "add" ? 3 : action === "remove" || action === "check" ? 2 : 1;
    if (count > max) throw new Error(`resource ${action} received too many positional arguments`);
    return;
  }
  if (command === "job") {
    const action = String(args._[0] || "list");
    const max = action === "read" || action === "inspect" || action === "cancel" || action === "approve" || action === "submit" ? 2 : 1;
    if (count > max) throw new Error(`job ${action} received too many positional arguments`);
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
  const logger = createLogger({ level: args.json ? "error" : effectiveLogLevel(args), component: "cli" });
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
    } else {
      // Stop an installed service before acquiring the runtime lock. If a
      // foreground daemon owns the lock, no new policy or secret state is saved.
      await stopAutostartBestEffort(logger);
    }

    const lock = acquireDaemonLock(state);
    if (!lock.acquired) {
      const pid = lock.owner?.pid ? `pid ${lock.owner.pid}` : "unknown pid";
      logger.warn(`local daemon already running for this workspace (${pid}); requested changes were not applied`);
      if (args.json) printStartJson(state, {
        showCredentials: Boolean((args.printMcpCredentials || args.printCredentials) && !args.noPrintCredentials),
        requestedChangesApplied: false,
        notice: "local daemon already running; requested changes were not applied",
      });
      else printMcpConnection(state, {
        noPrintCredentials: Boolean(args.noPrintCredentials),
        includeCredentials: Boolean(args.printMcpCredentials || args.printCredentials),
        quiet: Boolean(args.quiet),
        verbose: Boolean(args.verbose),
      });
      return;
    }

    let daemon = null;
    try {
      const previousMcpServerUrl = state.worker?.mcpServerUrl || "";
      const firstMcpConnection = !previousMcpServerUrl || !state.worker?.oauthPassword;
      const workerName = validateWorkerName(args.workerName);
      ensureWorkerSecrets(state, { rotateSecrets: Boolean(args.rotateSecrets), workerName });
      const previousPolicyOrigin = state.policy?.origin;
      state.policy = resolvePolicy(args, state.policy);
      const policyMigrated = !previousPolicyOrigin && state.policy.origin === "migrated";
      state.policy.updatedAt = new Date().toISOString();
      saveState(state);

      if (!args.daemonOnly) await ensureWorker(state, args);
      else if (!state.worker.url) throw new Error("--daemon-only requires an existing worker URL in state; run start once without --daemon-only");

      const mcpConnectionChanged = previousMcpServerUrl && previousMcpServerUrl !== state.worker.mcpServerUrl;
      const shouldPrintMcpCredentials = Boolean(args.printMcpCredentials || args.printCredentials || firstMcpConnection || args.rotateSecrets || mcpConnectionChanged);

      if (!args.daemonOnly && !args.noAutostart) {
        await installAutostartBestEffort({ workspace, stateRoot: state.paths.stateRoot, entryScript: process.argv[1], logger });
      }

      daemon = new LocalDaemon({
        workerUrl: state.worker.url,
        secret: state.worker.daemonSecret,
        workspace,
        policy: state.policy,
        logger: createLogger({ level: args.json ? "error" : effectiveLogLevel(args), component: "daemon" }),
        jobRoot: join(state.paths.profileDir, "jobs"),
        resources: state.resources,
        resourceStatePath: state.paths.statePath,
        onSuperseded: () => {
          logger.warn("this daemon was replaced by a newer authenticated instance; exiting without reconnecting");
          lock.release();
          process.exit(0);
        },
      });

      const waitForConnect = daemon.start();
      await waitForConnectWithNotice(waitForConnect, 20_000, logger);
      if (args.json) printStartJson(state, {
        showCredentials: Boolean((args.printMcpCredentials || args.printCredentials) && !args.noPrintCredentials),
        notice: policyMigrated ? "legacy implicit policy migrated to full access" : "",
      });
      else {
        printMcpConnection(state, {
          noPrintCredentials: Boolean(args.noPrintCredentials),
          includeCredentials: shouldPrintMcpCredentials,
          quiet: Boolean(args.quiet),
          verbose: Boolean(args.verbose),
          policyMigrated,
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

export function resolvePolicy(args = {}, stored = {}) {
  const hasStored = stored && typeof stored === "object" && (
    typeof stored.allowWrite === "boolean" || typeof stored.allowExec === "boolean" || typeof stored.execMode === "string"
  );
  const explicitKeys = ["profile", "execMode", "noWrite", "noExec", "fullEnv", "unrestrictedPaths", "absolutePaths"];
  const hasExplicit = explicitKeys.some((key) => Object.prototype.hasOwnProperty.call(args, key));
  let base;

  if (args.profile !== undefined) {
    const profile = String(args.profile).trim().toLowerCase();
    if (!POLICY_PROFILES[profile]) throw new Error(`--profile must be one of: ${Object.keys(POLICY_PROFILES).join(", ")}`);
    base = policyProfile(profile, "explicit");
  } else if (hasStored) {
    base = migrateLegacyPolicy(stored);
  } else {
    base = policyProfile(DEFAULT_POLICY_PROFILE, "default");
  }

  if (!hasExplicit) return normalizePolicy(base);
  if (args.execMode !== undefined) {
    const execMode = String(args.execMode).trim().toLowerCase();
    if (!["off", "direct", "shell"].includes(execMode)) throw new Error("--exec-mode must be off, direct, or shell");
    base.execMode = execMode;
  }
  if (args.noWrite === true) base.allowWrite = false;
  if (args.noWrite === false) base.allowWrite = true;
  if (args.noExec === true) base.execMode = "off";
  if (args.noExec === false && base.execMode === "off") base.execMode = "direct";
  if (args.fullEnv === true) base.minimalEnv = false;
  if (args.fullEnv === false) base.minimalEnv = true;
  if (args.unrestrictedPaths === true) base.unrestrictedPaths = true;
  if (args.unrestrictedPaths === false) base.unrestrictedPaths = false;
  if (args.absolutePaths === true) base.exposeAbsolutePaths = true;
  if (args.absolutePaths === false) base.exposeAbsolutePaths = false;
  const overrideKeys = ["execMode", "noWrite", "noExec", "fullEnv", "unrestrictedPaths", "absolutePaths"];
  if (args.profile === undefined || overrideKeys.some((key) => Object.prototype.hasOwnProperty.call(args, key))) {
    base.profile = "custom";
    base.origin = "custom";
    base.revision = DEFAULT_POLICY_REVISION;
  }
  return normalizePolicy(base);
}

function migrateLegacyPolicy(stored = {}) {
  if (stored.origin === "default" && Number(stored.revision || 0) < DEFAULT_POLICY_REVISION) {
    return policyProfile(DEFAULT_POLICY_PROFILE, "default");
  }
  if (stored.origin === "migrated" && Number(stored.revision || 0) < DEFAULT_POLICY_REVISION) {
    return policyProfile(DEFAULT_POLICY_PROFILE, "migrated");
  }
  if (stored.origin) return normalizePolicy(stored);
  const normalized = normalizePolicy(stored);
  const looksLikeLegacyImplicitDefault = (
    normalized.profile === "custom" &&
    normalized.allowWrite === true &&
    normalized.execMode === "shell" &&
    normalized.unrestrictedPaths === false &&
    normalized.minimalEnv === true &&
    normalized.exposeAbsolutePaths === false
  );
  if (looksLikeLegacyImplicitDefault) return policyProfile("full", "migrated");
  return normalizePolicy({ ...normalized, origin: "legacy-preserved", revision: DEFAULT_POLICY_REVISION });
}


async function stdioCommand(args) {
  assertNodeVersion();
  const workspace = await chooseWorkspace(args, { promptOnFirstRun: false, save: false, allowPositional: true });
  const state = loadState(workspace, { stateDir: args.stateDir });
  const policy = resolvePolicy(args, state.policy);
  await runStdioServer({
    workspace,
    policy,
    logLevel: effectiveLogLevel(args),
    jobRoot: join(state.paths.profileDir, "jobs"),
    resources: state.resources,
    resourceStatePath: state.paths.statePath,
  });
}

async function resourceCommand(args) {
  const action = String(args._[0] || "list").toLowerCase();
  const workspace = await chooseWorkspace({ ...args, _: [] }, { promptOnFirstRun: false, save: false, allowPositional: false });
  const state = loadState(workspace, { stateDir: args.stateDir });
  state.resources ||= {};

  if (action === "list") {
    const resources = publicResourceRegistry(state.resources);
    if (args.json) console.log(JSON.stringify({ workspace, resources }, null, 2));
    else if (!Object.keys(resources).length) console.log("No local resources registered.");
    else for (const [name, value] of Object.entries(resources)) console.log(`${name}	${value.path}	${value.mode || "n/a"}	${value.size ?? "n/a"} bytes`);
    return;
  }

  if (action === "add") {
    const name = validateResourceName(args._[1]);
    const inputPath = args._[2];
    if (!inputPath) throw new Error("resource add requires NAME and FILE_PATH");
    const lock = acquireStartupLock(state);
    if (!lock.acquired) throw new Error("another state-changing operation is already running for this workspace");
    try {
      const latest = loadState(workspace, { stateDir: args.stateDir });
      latest.resources ||= {};
      const inspected = inspectResourceFile(expandHome(inputPath), { allowInsecurePermissions: args.allowInsecurePermissions === true });
      if (!Object.prototype.hasOwnProperty.call(latest.resources, name) && Object.keys(latest.resources).length >= 64) {
        throw new Error("local resource registry limit reached (64)");
      }
      latest.resources[name] = inspected;
      saveState(latest);
      const result = { name, ...inspected, contents_exposed: false, available_to_new_jobs_immediately: true };
      if (args.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`Registered local resource: ${name}`);
        console.log(`Path: ${inspected.path}`);
        console.log(`Mode: ${inspected.mode || "n/a"}; size: ${inspected.size} bytes`);
        console.log("The resource is available to newly submitted managed jobs immediately.");
      }
    } finally {
      lock.release();
    }
    return;
  }

  if (action === "remove") {
    const name = validateResourceName(args._[1]);
    const lock = acquireStartupLock(state);
    if (!lock.acquired) throw new Error("another state-changing operation is already running for this workspace");
    try {
      const latest = loadState(workspace, { stateDir: args.stateDir });
      latest.resources ||= {};
      const existed = Object.prototype.hasOwnProperty.call(latest.resources, name);
      delete latest.resources[name];
      saveState(latest);
      const result = { name, removed: existed, affects_new_jobs_immediately: true };
      if (args.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(existed ? `Removed local resource: ${name}` : `Local resource was not registered: ${name}`);
        console.log("The change applies to newly submitted managed jobs immediately.");
      }
    } finally {
      lock.release();
    }
    return;
  }

  if (action === "check") {
    const name = validateResourceName(args._[1]);
    const resource = state.resources[name];
    if (!resource) throw new Error(`local resource is not registered: ${name}`);
    const inspected = inspectResourceFile(resource.path, { allowInsecurePermissions: resource.allowInsecurePermissions === true });
    const result = { name, ...inspected, contents_exposed: false };
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else console.log(`${name}: available (${inspected.mode || "n/a"}, ${inspected.size} bytes)`);
    return;
  }

  throw new Error(`Unknown resource action: ${action}`);
}

async function jobCommand(args) {
  const action = String(args._[0] || "list").toLowerCase();
  const workspace = await chooseWorkspace({ ...args, _: [] }, { promptOnFirstRun: false, save: false, allowPositional: false });
  const state = loadState(workspace, { stateDir: args.stateDir });
  const manager = new ManagedJobManager({
    jobRoot: join(state.paths.profileDir, "jobs"),
    workspace,
    policy: resolvePolicy({}, state.policy),
    resources: state.resources,
    resourceStatePath: state.paths.statePath,
    logger: createLogger({ level: "warn", component: "job" }),
  });
  let result;
  if (action === "list") result = manager.list({ limit: 50 });
  else if (action === "read") result = manager.read({ job_id: args._[1] });
  else if (action === "inspect") result = manager.inspectLocal({ job_id: args._[1] });
  else if (action === "cancel") result = manager.cancel({ job_id: args._[1] });
  else if (action === "approve") {
    if (args.json && !args.yes) throw new Error("job approve --json requires --yes");
    const inspection = manager.inspectLocal({ job_id: args._[1] });
    if (!args.yes) {
      console.log(JSON.stringify(inspection, null, 2));
      const approved = await confirm(`Approve and execute managed job ${args._[1]}?`, false);
      if (!approved) {
        console.log("Managed job approval cancelled. Re-run with --yes after review to skip confirmation.");
        return;
      }
    }
    result = manager.approve({ job_id: args._[1] }, { localOperator: true });
  }
  else if (action === "submit") {
    const planPath = args._[1];
    if (!planPath) throw new Error("job submit requires a JSON plan file");
    const plan = loadManagedJobPlan(expandHome(planPath));
    result = manager.start(plan);
  } else throw new Error(`Unknown job action: ${action}`);
  console.log(JSON.stringify(result, null, 2));
}

async function clientConfigCommand(args) {
  const workspaceArgs = { ...args, _: [] };
  const workspace = await chooseWorkspace(workspaceArgs, { promptOnFirstRun: false, save: false, allowPositional: false });
  const requested = String(args.client || args._[0] || "all").trim().toLowerCase();
  const profile = String(args.profile || "full").trim().toLowerCase();
  if (!POLICY_PROFILES[profile]) throw new Error(`--profile must be one of: ${Object.keys(POLICY_PROFILES).join(", ")}`);
  if (!["all", "claude", "cursor", "codex", "generic"].includes(requested)) throw new Error("client must be all, claude, cursor, codex, or generic");
  const command = process.execPath;
  const argsList = [resolve(process.argv[1]), "stdio", "--workspace", workspace, "--profile", profile];
  const jsonConfig = { mcpServers: { "machine-bridge": { command, args: argsList } } };
  const codex = `[mcp_servers.machine_bridge]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(argsList)}\n`;
  if (args.json) {
    console.log(JSON.stringify({ workspace, profile, claude: jsonConfig, cursor: jsonConfig, generic: jsonConfig, codex_toml: codex }, null, 2));
    return;
  }
  if (["all", "claude", "cursor", "generic"].includes(requested)) {
    console.log(`${requested === "all" ? "Claude Desktop / Cursor / generic stdio" : requested}:`);
    console.log(JSON.stringify(jsonConfig, null, 2));
  }
  if (["all", "codex"].includes(requested)) {
    if (requested === "all") console.log("");
    console.log("Codex CLI:");
    console.log(codex.trimEnd());
  }
}

function removedLocalApiError() {
  return new Error("Local /v1 API support has been removed. Use the printed Remote MCP Server URL/password with an MCP client instead.");
}


async function ensureWorker(state, args) {
  const logger = createLogger({ level: args.json ? "error" : effectiveLogLevel(args), component: "worker" });
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
  const tempPath = resolve(dir, `worker-secrets-${process.pid}-${Date.now()}-${randomBytes(6).toString("hex")}.json`);
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
    if (!entry.isFile()) continue;
    const match = /^worker-secrets-(\d+)-(\d+)(?:-[a-f0-9]+)?\.json$/.exec(entry.name);
    if (!match) continue;
    const file = resolve(dir, entry.name);
    try {
      const pid = Number(match[1]);
      const ageMs = Date.now() - statSync(file).mtimeMs;
      if (!isPidAlive(pid) || ageMs > 60 * 60 * 1000) unlinkSync(file);
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
  for (const item of ["src/worker", "src/shared", "wrangler.jsonc", "tsconfig.json"]) {
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
    return { ok: false, error: workerHealthError(error) };
  }
}

function workerHealthError(error) {
  const message = String(error?.message || error || "");
  if (/timeout|aborted/i.test(message)) return "timeout";
  if (/certificate|TLS|SSL/i.test(message)) return "tls_error";
  if (/fetch failed|network|ECONN|ENOTFOUND|EAI_AGAIN/i.test(message)) return "network_error";
  return "request_failed";
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

async function waitForConnectWithNotice(promise, timeoutMs, logger) {
  let timeout;
  const timed = new Promise(resolvePromise => {
    timeout = setTimeout(() => resolvePromise("timeout"), timeoutMs);
  });
  const result = await Promise.race([promise.then(() => "connected"), timed]);
  clearTimeout(timeout);
  if (result === "timeout") logger.warn("Still connecting; the process will keep retrying");
}


function printStartJson(state, { showCredentials = false, requestedChangesApplied = true, notice = "" } = {}) {
  createLogger({ component: "ready" }).json({
    mcp: {
      server_url: state.worker.mcpServerUrl,
      connection_password: showCredentials ? state.worker.oauthPassword : previewSecret(state.worker.oauthPassword),
      worker_url: state.worker.url,
      worker_name: state.worker.name,
    },
    workspace: state.workspace.path,
    state_path: state.paths.statePath,
    policy: state.policy,
    requested_changes_applied: requestedChangesApplied,
    ...(notice ? { notice } : {}),
  });
}

function printMcpConnection(state, {
  noPrintCredentials = false,
  includeCredentials = false,
  quiet = false,
  verbose = false,
  policyMigrated = false,
} = {}) {
  const logger = createLogger({ component: "ready", quiet, level: quiet ? "error" : verbose ? "debug" : "info" });
  const payload = {
    mcp_server_url: state.worker.mcpServerUrl,
    mcp_connection_password: state.worker.oauthPassword,
    workspace: state.workspace.path,
    state_path: state.paths.statePath,
    policy: state.policy,
  };
  if (includeCredentials) {
    logger.success("Remote MCP bridge is ready; save these connection details if your ChatGPT app needs to reconnect");
    logger.plain(`  MCP Server URL: ${payload.mcp_server_url}`);
    if (!noPrintCredentials) logger.plain(`  MCP connection password: ${payload.mcp_connection_password}`);
    else logger.plain(`  MCP connection password: ${previewSecret(payload.mcp_connection_password)} (redacted)`);
  } else {
    logger.success("Remote MCP bridge is ready");
    logger.plain("  Connection credentials unchanged; use --print-mcp-credentials only when reconnecting a client.");
  }
  if (policyMigrated) {
    logger.warn("Legacy implicit policy migrated to full access; use --profile agent, edit, or review to narrow it.");
  }
  logger.plain(`  Workspace: ${payload.workspace}`);
  logger.plain(`  Policy: ${formatPolicySummary(payload.policy)}`);
  if (verbose) logger.plain(`  State: ${payload.state_path}`);
}

function formatPolicySummary(policy = {}) {
  const scope = policy.unrestrictedPaths ? "all local paths" : "workspace only";
  const environment = policy.minimalEnv ? "isolated env" : "full parent env";
  return `${policy.profile || "custom"} [${policy.origin || "unknown"}; write=${policy.allowWrite ? "on" : "off"}; exec=${policy.execMode || "off"}; ${scope}; ${environment}; absolute_paths=${policy.exposeAbsolutePaths ? "on" : "off"}]`;
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
  const storedPolicyOrigin = state.policy?.origin;
  state.policy = resolvePolicy({}, state.policy);
  const health = state.worker?.url ? await workerHealth(state.worker.url) : { ok: false, error: "no worker url" };
  const payload = {
    ...redactState(state),
    policyMigrationPending: !storedPolicyOrigin && state.policy.origin === "migrated",
    workerHealth: health,
  };
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
  const storedPolicyOrigin = state.policy?.origin;
  state.policy = resolvePolicy({}, state.policy);
  checks.push({ name: "policy", ok: true, detail: formatPolicySummary(state.policy) });
  const health = state.worker?.url ? await workerHealth(state.worker.url) : { ok: false, error: "no worker url" };
  checks.push({ name: "worker-health", ok: health.ok, detail: health.ok ? state.worker.url : health.error });
  const diagnosticRuntime = new LocalDaemon({
    workspace,
    policy: state.policy,
    logger: createLogger({ level: "error", component: "doctor" }),
    jobRoot: join(state.paths.profileDir, "jobs"),
    resources: state.resources,
    resourceStatePath: state.paths.statePath,
    recoverJobs: false,
  });
  let runtimeDiagnostics;
  try {
    runtimeDiagnostics = await diagnosticRuntime.diagnoseRuntime();
  } finally {
    diagnosticRuntime.stop();
  }
  for (const check of runtimeDiagnostics.checks) {
    checks.push({
      name: `runtime:${check.layer}`,
      ok: check.skipped === true || check.ok === true,
      detail: check.skipped ? `skipped (${check.error_class || "not applicable"})` : check.ok ? "ok" : check.error_class || "failed",
    });
  }
  console.log(JSON.stringify({
    ok: checks.every(check => check.ok),
    checks,
    runtimeDiagnostics,
    policyMigrationPending: !storedPolicyOrigin && state.policy.origin === "migrated",
    state: redactState(state),
  }, null, 2));
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
    await stopAutostartBestEffort(createLogger({ level: args.quiet ? "error" : "warn", component: "service" }));
    await sleep(500);
    const daemonOwner = readDaemonLockOwner(daemonLockPathForState(state));
    if (daemonOwner?.pid && isPidAlive(daemonOwner.pid)) {
      throw new Error(`refusing to rotate secrets while the daemon is active (pid ${daemonOwner.pid}); stop the foreground daemon and retry`);
    }
    ensureWorkerSecrets(state, { rotateSecrets: true, workerName: validateWorkerName(args.workerName) });
    saveState(state);
    const showMcpPassword = Boolean((args.printMcpCredentials || args.printCredentials) && !args.noPrintCredentials);
    console.log(`Rotated MCP connection password: ${showMcpPassword ? state.worker.oauthPassword : previewSecret(state.worker.oauthPassword)}`);
    console.log(`Rotated daemon secret: ${previewSecret(state.worker.daemonSecret)}`);
    console.log("Run `machine-mcp --print-mcp-credentials` to redeploy and display the new client connection credentials when needed.");
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
    const result = await installAutostart({ workspace, stateRoot, entryScript: process.argv[1], logger: structuredLogger(Boolean(args.quiet)) });
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

async function installAutostartBestEffort({ workspace, stateRoot, entryScript, logger }) {
  try {
    const { installAutostart } = await import("./service.mjs");
    const result = await installAutostart({ workspace, stateRoot, entryScript, logger: structuredLogger(true) });
    if (result?.ok) logger.info("Autostart installed for future logins", { provider: result.provider });
    else logger.warn("Autostart installation reported a problem; run `machine-mcp service status` for details");
  } catch (error) {
    logger.warn("Autostart installation skipped", { error_class: classifyOperationalError(error) });
  }
}

async function stopAutostartBestEffort(logger) {
  try {
    const { stopAutostart } = await import("./service.mjs");
    await stopAutostart({ logger: structuredLogger(true) });
  } catch (error) {
    logger.warn("Autostart stop skipped", { error_class: classifyOperationalError(error) });
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
  const activeJobs = activeStateJobs(stateRoot);
  if (activeJobs.length) {
    const detail = activeJobs.slice(0, 5).map((item) => `${item.job_id}:${item.status}`).join(", ");
    const suffix = activeJobs.length > 5 ? `, and ${activeJobs.length - 5} more` : "";
    throw new Error(`refusing to uninstall while managed jobs are active (${detail}${suffix}); inspect or cancel them with machine-mcp job list/cancel`);
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
      if (statSync(stateFile).size > 2 * 1024 * 1024) continue;
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
    console.warn(`Autostart removal skipped or failed (${classifyOperationalError(error)}). Run machine-mcp service status for details.`);
    return false;
  }
}

function activeStateJobs(stateRoot) {
  const profiles = resolve(expandHome(stateRoot), "profiles");
  if (!existsSync(profiles)) return [];
  const active = [];
  for (const profile of readdirSync(profiles, { withFileTypes: true })) {
    if (!profile.isDirectory()) continue;
    for (const job of activeManagedJobs(resolve(profiles, profile.name, "jobs"))) {
      active.push({ profile: profile.name, ...job });
    }
  }
  return active;
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
  return createLogger({ quiet, component: "service" });
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
  npm install -g --allow-scripts=esbuild,workerd,sharp machine-bridge-mcp@latest && machine-mcp
  npx machine-bridge-mcp@latest                  # no global install; autostart may rely on npm cache
  ./mbm                                          # from source checkout
  .\\mbm.cmd                                      # from source checkout on Windows cmd

Commands:
  start             Deploy/update Worker, install autostart, start remote daemon
  stdio             Run a local MCP stdio server for Claude, Cursor, Codex, and compatible clients
  client-config     Print stdio client configuration snippets
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
  --profile NAME        Policy profile: full (default), agent, edit, or review
  --exec-mode MODE      Command mode: off, direct argv, or full shell
  --no-write            Disable write_file, edit_file, and apply_patch
  --no-exec             Disable run_process and exec_command
  --full-env            Pass the full parent environment to local commands
  --unrestricted-paths  Allow filesystem tools outside the workspace
  --absolute-paths      Return absolute local paths (enabled by the full profile)
  --state-dir DIR       Override state root
  --json                Print connection details as JSON; credentials stay redacted unless explicitly requested
  --log-level LEVEL     error, warn, info (default), or debug
  --verbose             Alias for --log-level debug; includes per-tool success/correlation logs
  --quiet               Alias for --log-level error
  --allow-insecure-permissions
                        Permit resource registration when a file is group/other-readable

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
