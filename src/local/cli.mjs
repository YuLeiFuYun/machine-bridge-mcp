import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import path, { join, resolve } from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { LocalRuntime } from "./runtime.mjs";
import { acquireDaemonLockWithTakeover, inspectWorkspaceDaemon, stopWorkspaceServiceDaemon } from "./daemon-process.mjs";
import { runStdioServer } from "./stdio.mjs";
import { assertCanonicalFullPolicy, DEFAULT_POLICY_PROFILE, DEFAULT_POLICY_REVISION, POLICY_PROFILES, normalizePolicy, policyProfile, toolsForPolicy } from "./tools.mjs";
import { classifyOperationalError, createLogger, normalizeLogLevel, sanitizeLogText } from "./log.mjs";
import { activeManagedJobs, inspectResourceFile, loadManagedJobPlan, ManagedJobManager, publicResourceRegistry, validateResourceName } from "./managed-jobs.mjs";
import { runWrangler } from "./shell.mjs";
import { generateRegisteredSshKey } from "./resource-operations.mjs";
import { runFullAccessTest } from "./full-access-test.mjs";
import { readBoundedRegularFileSync } from "./secure-file.mjs";
import { inspectProcessInstance } from "./process-identity.mjs";
import { stopAndRemoveAutostart } from "./service-lifecycle.mjs";
import { createExclusiveFileSync } from "./exclusive-file.mjs";
import {
  acquireMaintenanceLock,
  acquireStartupLockWithWait,
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
  "yes", "keepWorker", "allowInsecurePermissions", "showPaths",
]);
const VALUE_OPTIONS = new Set([
  "workspace", "stateDir", "workerName", "profile", "execMode", "client", "logLevel",
]);

const COMMAND_HANDLERS = Object.freeze({
  start: startCommand,
  stdio: stdioCommand,
  "client-config": clientConfigCommand,
  status: statusCommand,
  doctor: doctorCommand,
  "full-test": fullTestCommand,
  workspace: workspaceCommand,
  service: serviceCommand,
  autostart: serviceCommand,
  "rotate-secrets": rotateSecretsCommand,
  resource: resourceCommand,
  browser: browserCommand,
  job: jobCommand,
  uninstall: uninstallCommand,
});

export async function main(argv = process.argv.slice(2)) {
  const [command, rest] = normalizeCommand(argv);
  const args = parseArgs(rest);
  if (args.help || command === "help") return usage();
  if (args.version || command === "version") return version();
  if (command === "api") throw removedLocalApiError();
  validateCommandOptions(command, args);
  validatePositionals(command, args);
  validateLoggingOptions(args);
  const handler = COMMAND_HANDLERS[command];
  if (handler) return handler(args);
  console.error(`Unknown command: ${command}`);
  usage();
  process.exitCode = 2;
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
  "full-test": new Set(["workspace", "stateDir", "json"]),
  "rotate-secrets": new Set(["workspace", "stateDir", "workerName", "noPrintCredentials", "printMcpCredentials", "printCredentials", "quiet"]),
  workspace: new Set(["workspace", "stateDir"]),
  service: new Set(["workspace", "stateDir", "quiet"]),
  autostart: new Set(["workspace", "stateDir", "quiet"]),
  resource: new Set(["workspace", "stateDir", "allowInsecurePermissions", "showPaths", "json"]),
  browser: new Set(["workspace", "stateDir", "json"]),
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

const SINGLE_WORKSPACE_POSITIONAL_COMMANDS = new Set(["start", "stdio", "status", "doctor", "full-test", "rotate-secrets"]);
const STATIC_POSITIONAL_RULES = Object.freeze({
  "client-config": Object.freeze({ max: 1, tooMany: "client-config accepts at most one positional client name" }),
  uninstall: Object.freeze({ max: 0, tooMany: "uninstall does not accept positional arguments" }),
});
const RESOURCE_POSITIONAL_LIMITS = Object.freeze({ add: 3, "generate-ssh-key": 3, remove: 2, check: 2 });
const JOB_POSITIONAL_LIMITS = Object.freeze({ read: 2, inspect: 2, cancel: 2, approve: 2, submit: 2 });
const ACTION_POSITIONAL_RULES = Object.freeze({
  workspace(args) {
    const action = String(args._[0] || "show");
    return { max: action === "set" || action === "select" ? 2 : 1, tooMany: `workspace ${action} received too many positional arguments`, workspaceConflictAfter: 1 };
  },
  service(args) {
    const action = String(args._[0] || "status");
    return { max: ["install", "status", "stop", "uninstall", "remove"].includes(action) ? 2 : 1, tooMany: `service ${action} received too many positional arguments`, workspaceConflictAfter: 1 };
  },
  autostart(args) {
    return ACTION_POSITIONAL_RULES.service(args);
  },
  resource(args) {
    const action = String(args._[0] || "list");
    return { max: RESOURCE_POSITIONAL_LIMITS[action] ?? 1, tooMany: `resource ${action} received too many positional arguments` };
  },
  browser(args) {
    const action = String(args._[0] || "status");
    return { max: 1, tooMany: `browser ${action} received too many positional arguments` };
  },
  job(args) {
    const action = String(args._[0] || "list");
    return { max: JOB_POSITIONAL_LIMITS[action] ?? 1, tooMany: `job ${action} received too many positional arguments` };
  },
});

export function validatePositionals(command, args) {
  const count = args._.length;
  const rule = positionalRule(command, args);
  if (!rule) return;
  if (count > rule.max) throw new Error(rule.tooMany);
  if (args.workspace && Number.isInteger(rule.workspaceConflictAfter) && count > rule.workspaceConflictAfter) {
    throw new Error("workspace path was provided both positionally and with --workspace");
  }
}

function positionalRule(command, args) {
  if (SINGLE_WORKSPACE_POSITIONAL_COMMANDS.has(command)) {
    return {
      max: 1,
      tooMany: `${command} accepts at most one positional workspace path`,
      workspaceConflictAfter: 0,
    };
  }
  if (STATIC_POSITIONAL_RULES[command]) return STATIC_POSITIONAL_RULES[command];
  return ACTION_POSITIONAL_RULES[command]?.(args) || null;
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
  const startupLock = await acquireStartupLockWithWait(state, { operation: "start", logger });

  try {
    const startMode = await prepareStartMode(args, state, logger);
    const daemonLock = await acquireDaemonLockWithTakeover(state, {
      takeOverServiceOwner: startMode.takeOverServiceOwner,
      ownerMetadata: {
        mode: args.daemonOnly ? "service" : "foreground",
        version: currentPackageVersion(),
      },
      logger,
    });
    if (!daemonLock.acquired) {
      reportExistingDaemon(args, state, daemonLock.owner, logger);
      return;
    }
    await startRemoteRuntime({ args, workspace, state, daemonLock, logger });
  } finally {
    startupLock.release();
  }
}

async function prepareStartMode(args, state, logger) {
  if (args.daemonOnly) {
    const { trimAutostartLogs } = await import("./service.mjs");
    trimAutostartLogs(state.paths.stateRoot);
    return { takeOverServiceOwner: false };
  }
  // A normal foreground start first asks the platform service manager to
  // unload the job, then independently reclaims a verified daemon-only
  // process. The second step handles legacy/orphan daemons that launchd or
  // another service manager no longer tracks.
  return stopAutostartBestEffort(logger);
}

function reportExistingDaemon(args, state, owner, logger) {
  const pid = owner?.pid ? `pid ${owner.pid}` : "unknown pid";
  if (isIdempotentDaemonOnlyStart(args)) {
    logger.debug?.("local daemon already running; daemon-only start completed as an idempotent no-op", { owner_pid_known: Boolean(owner?.pid) });
    return;
  }
  const mode = owner?.mode === "foreground" ? "foreground" : owner?.mode === "service" ? "background service" : "local";
  const version = owner?.version ? `, version ${owner.version}` : "";
  const notice = `${mode} daemon already running for this workspace (${pid}${version}); it was not restarted and requested changes were not applied`;
  logger.warn(notice);
  if (args.json) {
    printStartJson(state, {
      showCredentials: Boolean((args.printMcpCredentials || args.printCredentials) && !args.noPrintCredentials),
      requestedChangesApplied: false,
      notice,
    });
    return;
  }
  if (owner?.mode === "foreground") {
    logger.safePlain("  Stop the existing foreground process with Ctrl+C in its terminal, then retry.");
  } else {
    logger.safePlain("  Run `machine-mcp service stop`, verify `machine-mcp service status`, then retry.");
  }
  logger.plain(`  Workspace: ${state.workspace.path}`);
}

function isIdempotentDaemonOnlyStart(args) {
  if (!args.daemonOnly || args.json) return false;
  return !Boolean(
    args.profile
    || args.execMode
    || args.rotateSecrets
    || args.forceWorker
    || args.workerName
    || args.noWrite
    || args.noExec
    || args.fullEnv
    || args.unrestrictedPaths
    || args.absolutePaths
    || args.printMcpCredentials
    || args.printCredentials
  );
}

async function startRemoteRuntime({ args, workspace, state, daemonLock, logger }) {
  let runtime = null;
  try {
    const readiness = await prepareRemoteState({ args, workspace, state, logger });
    runtime = createRemoteRuntime({ args, workspace, state, daemonLock, logger });
    await runtime.start();
    reportRemoteReady(args, state, readiness);
    keepProcessAlive({ daemon: runtime, lock: daemonLock, logger });
  } catch (error) {
    try { runtime?.stop?.(); } catch {}
    daemonLock.release();
    throw error;
  }
}

async function prepareRemoteState({ args, workspace, state, logger }) {
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

  if (!args.daemonOnly && !args.noAutostart) {
    await installAutostartBestEffort({ workspace, stateRoot: state.paths.stateRoot, entryScript: process.argv[1], logger });
  }
  const mcpConnectionChanged = Boolean(previousMcpServerUrl && previousMcpServerUrl !== state.worker.mcpServerUrl);
  return {
    policyMigrated,
    shouldPrintMcpCredentials: Boolean(args.printMcpCredentials || args.printCredentials || firstMcpConnection || args.rotateSecrets || mcpConnectionChanged),
  };
}

function createRemoteRuntime({ args, workspace, state, daemonLock, logger }) {
  return new LocalRuntime({
    workerUrl: state.worker.url,
    secret: state.worker.daemonSecret,
    expectedRelayVersion: currentPackageVersion(),
    workspace,
    policy: state.policy,
    logger: createLogger({ level: args.json ? "error" : effectiveLogLevel(args), component: "daemon" }),
    jobRoot: join(state.paths.profileDir, "jobs"),
    resources: state.resources,
    resourceStatePath: state.paths.statePath,
    browserStateRoot: state.paths.stateRoot,
    onSuperseded: () => {
      daemonLock.release();
      process.exit(0);
    },
    onFatal: () => {
      daemonLock.release();
      process.exit(1);
    },
  });
}

function reportRemoteReady(args, state, readiness) {
  if (args.json) {
    printStartJson(state, {
      showCredentials: Boolean((args.printMcpCredentials || args.printCredentials) && !args.noPrintCredentials),
      notice: readiness.policyMigrated ? "legacy implicit policy migrated to full access" : "",
    });
    return;
  }
  printMcpConnection(state, {
    noPrintCredentials: Boolean(args.noPrintCredentials),
    includeCredentials: readiness.shouldPrintMcpCredentials,
    quiet: Boolean(args.quiet),
    verbose: Boolean(args.verbose),
    policyMigrated: readiness.policyMigrated,
  });
}

export function resolvePolicy(args = {}, stored = {}) {
  const hasStored = stored && typeof stored === "object" && (
    typeof stored.allowWrite === "boolean" || typeof stored.allowExec === "boolean" || typeof stored.execMode === "string"
  );
  const explicitKeys = ["profile", ...POLICY_OVERRIDE_KEYS];
  const hasExplicit = explicitKeys.some((key) => Object.prototype.hasOwnProperty.call(args, key));
  const base = selectPolicyBase(args, stored, hasStored);
  if (!hasExplicit) return normalizePolicy(base);
  applyPolicyOverrides(base, args);
  if (args.profile === undefined || POLICY_OVERRIDE_KEYS.some((key) => Object.prototype.hasOwnProperty.call(args, key))) {
    base.profile = "custom";
    base.origin = "custom";
    base.revision = DEFAULT_POLICY_REVISION;
  }
  return normalizePolicy(base);
}

const POLICY_OVERRIDE_KEYS = Object.freeze(["execMode", "noWrite", "noExec", "fullEnv", "unrestrictedPaths", "absolutePaths"]);

function selectPolicyBase(args, stored, hasStored) {
  if (args.profile !== undefined) {
    const profile = String(args.profile).trim().toLowerCase();
    if (!POLICY_PROFILES[profile]) throw new Error(`--profile must be one of: ${Object.keys(POLICY_PROFILES).join(", ")}`);
    return policyProfile(profile, "explicit");
  }
  if (hasStored) return migrateLegacyPolicy(stored);
  return policyProfile(DEFAULT_POLICY_PROFILE, "default");
}

function applyPolicyOverrides(policy, args) {
  if (args.execMode !== undefined) {
    const execMode = String(args.execMode).trim().toLowerCase();
    if (!["off", "direct", "shell"].includes(execMode)) throw new Error("--exec-mode must be off, direct, or shell");
    policy.execMode = execMode;
  }
  applyBooleanOverride(args, "noWrite", (enabled) => { policy.allowWrite = !enabled; });
  applyBooleanOverride(args, "noExec", (enabled) => {
    if (enabled) policy.execMode = "off";
    else if (policy.execMode === "off") policy.execMode = "direct";
  });
  applyBooleanOverride(args, "fullEnv", (enabled) => { policy.minimalEnv = !enabled; });
  applyBooleanOverride(args, "unrestrictedPaths", (enabled) => { policy.unrestrictedPaths = enabled; });
  applyBooleanOverride(args, "absolutePaths", (enabled) => { policy.exposeAbsolutePaths = enabled; });
}

function applyBooleanOverride(args, key, apply) {
  if (typeof args[key] === "boolean") apply(args[key]);
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
    browserStateRoot: state.paths.stateRoot,
  });
}

const RESOURCE_ACTION_HANDLERS = Object.freeze({
  list: resourceListAction,
  add: resourceAddAction,
  "generate-ssh-key": resourceGenerateSshKeyAction,
  remove: resourceRemoveAction,
  check: resourceCheckAction,
});

async function resourceCommand(args) {
  const action = String(args._[0] || "list").toLowerCase();
  const handler = RESOURCE_ACTION_HANDLERS[action];
  if (!handler) throw new Error(`Unknown resource action: ${action}`);
  const workspace = await chooseWorkspace({ ...args, _: [] }, { promptOnFirstRun: false, save: false, allowPositional: false });
  const state = loadState(workspace, { stateDir: args.stateDir });
  state.resources ||= {};
  return handler({ args, workspace, state });
}

function resourceListAction({ args, workspace, state }) {
  const includePaths = args.showPaths === true;
  const resources = publicResourceRegistry(state.resources, { includePaths });
  if (args.json) {
    console.log(JSON.stringify({
      workspace: includePaths ? workspace : "<local-workspace>",
      paths_exposed: includePaths,
      resources,
    }, null, 2));
    return;
  }
  if (!Object.keys(resources).length) {
    console.log("No local resources registered.");
    return;
  }
  for (const [name, value] of Object.entries(resources)) {
    const fields = [name, value.mode || "n/a", `${value.size ?? "n/a"} bytes`];
    if (includePaths) fields.splice(1, 0, value.path);
    console.log(fields.join("	"));
  }
}

async function resourceAddAction({ args, workspace, state }) {
  const name = validateResourceName(args._[1]);
  const inputPath = args._[2];
  if (!inputPath) throw new Error("resource add requires NAME and FILE_PATH");
  const lock = await acquireStartupLockWithWait(state, { operation: "resource-add" });
  try {
    const latest = loadState(workspace, { stateDir: args.stateDir });
    latest.resources ||= {};
    const inspected = inspectResourceFile(expandHome(inputPath), { allowInsecurePermissions: args.allowInsecurePermissions === true });
    if (!Object.prototype.hasOwnProperty.call(latest.resources, name) && Object.keys(latest.resources).length >= 64) {
      throw new Error("local resource registry limit reached (64)");
    }
    latest.resources[name] = inspected;
    saveState(latest);
    const result = publicResourceInspection(name, inspected, {
      includePath: args.showPaths === true,
      available_to_new_jobs_immediately: true,
    });
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Registered local resource: ${name}`);
      if (args.showPaths === true) console.log(`Path: ${inspected.path}`);
      console.log(`Mode: ${inspected.mode || "n/a"}; size: ${inspected.size} bytes`);
      console.log("The resource is available to newly submitted managed jobs immediately.");
    }
  } finally {
    lock.release();
  }
}

async function resourceGenerateSshKeyAction({ args, workspace }) {
  const name = validateResourceName(args._[1]);
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) throw new Error("HOME or USERPROFILE is required to choose a default SSH key path");
  const requestedPath = args._[2] ? expandHome(args._[2]) : join(home, ".ssh", `machine-mcp-${name}-ed25519`);
  const key = await generateRegisteredSshKey({
    workspace,
    stateDir: args.stateDir,
    name,
    targetPath: requestedPath,
    comment: `machine-mcp:${name}`,
  });
  const includePaths = args.showPaths === true;
  const result = {
    name: key.name,
    created: key.created,
    fingerprint: key.fingerprint,
    key_type: key.keyType,
    private_mode: key.privateMode,
    public_mode: key.publicMode,
    private_key_content_exposed: key.privateKeyContentExposed,
    registered: key.registered,
    available_to_new_jobs_immediately: key.availableToNewJobsImmediately,
    paths_exposed: includePaths,
    ...(includePaths ? { private_key_path: key.privateKeyPath, public_key_path: key.publicKeyPath } : {}),
  };
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`${key.created ? "Generated and registered" : "Reused and registered"} SSH key resource: ${name}`);
    if (includePaths) {
      console.log(`Private key: ${key.privateKeyPath}`);
      console.log(`Public key: ${key.publicKeyPath}`);
    }
    console.log(`Fingerprint: ${key.fingerprint}`);
    console.log("Private key content was not printed or sent through MCP.");
  }
}

async function resourceRemoveAction({ args, workspace, state }) {
  const name = validateResourceName(args._[1]);
  const lock = await acquireStartupLockWithWait(state, { operation: "resource-remove" });
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
}

function resourceCheckAction({ args, state }) {
  const name = validateResourceName(args._[1]);
  const resource = state.resources[name];
  if (!resource) throw new Error(`local resource is not registered: ${name}`);
  const inspected = inspectResourceFile(resource.path, { allowInsecurePermissions: resource.allowInsecurePermissions === true });
  const result = publicResourceInspection(name, inspected, { includePath: args.showPaths === true });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else {
    const pathDetail = args.showPaths === true ? ` at ${inspected.path}` : "";
    console.log(`${name}: available${pathDetail} (${inspected.mode || "n/a"}, ${inspected.size} bytes)`);
  }
}

function publicResourceInspection(name, inspected, { includePath = false, ...extra } = {}) {
  return {
    name,
    kind: inspected.kind,
    size: inspected.size ?? null,
    mode: inspected.mode ?? null,
    updated_at: inspected.updatedAt ?? null,
    allow_insecure_permissions: inspected.allowInsecurePermissions === true,
    ...extra,
    paths_exposed: includePath,
    contents_exposed: false,
    ...(includePath ? { path: inspected.path } : {}),
  };
}

async function browserCommand(args) {
  const action = String(args._[0] || "status").toLowerCase();
  const extensionPath = resolve(packageRoot, "browser-extension");
  if (action === "path") {
    if (args.json) console.log(JSON.stringify({ extension_path: extensionPath }, null, 2));
    else console.log(extensionPath);
    return;
  }
  if (!["status", "setup", "pair"].includes(action)) throw new Error(`Unknown browser action: ${action}`);
  const workspace = await chooseWorkspace({ ...args, _: [] }, { promptOnFirstRun: false, save: false, allowPositional: false });
  const state = loadState(workspace, { stateDir: args.stateDir });
  const pairingFile = join(state.paths.stateRoot, "browser-bridge.json");
  if (!existsSync(pairingFile)) {
    throw new Error("browser bridge is not initialized; start machine-mcp once, then run this command again");
  }
  ownerOnlyFile(pairingFile);
  let pairing;
  try {
    pairing = JSON.parse(readBoundedRegularFileSync(pairingFile, 64 * 1024).toString("utf8"));
  } catch {
    throw new Error("browser bridge state is invalid; restart machine-mcp to repair it");
  }
  const port = Number(pairing.port);
  if (!/^[A-Za-z0-9_-]{32,100}$/.test(String(pairing.token || ""))) throw new Error("browser bridge state contains an invalid token");
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("browser bridge state contains an invalid port");
  const pairingUrl = `http://127.0.0.1:${port}/pair`;
  const healthUrl = `http://127.0.0.1:${port}/healthz`;
  const health = await fetch(healthUrl, { signal: AbortSignal.timeout(2000), cache: "no-store" })
    .then(async (response) => response.ok ? await response.json() : null)
    .catch(() => null);
  const result = {
    running: health?.ok === true && health?.broker === "machine-bridge-browser",
    connected: health?.broker === "machine-bridge-browser" && health?.connected === true,
    extension_path: extensionPath,
    pairing_url: pairingUrl,
    token_exposed: false,
  };
  if (action === "status") {
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Browser bridge: ${result.running ? "running" : "not reachable"}`);
      console.log(`Extension: ${result.connected ? "connected" : "not connected"}`);
      console.log(`Extension path: ${extensionPath}`);
    }
    return;
  }
  if (!result.running) throw new Error("browser bridge is not reachable; keep machine-mcp running and retry");
  await openExternal(pairingUrl);
  if (args.json) console.log(JSON.stringify({ ...result, pairing_page_opened: true }, null, 2));
  else {
    console.log(`Extension path: ${extensionPath}`);
    console.log("Load this directory once from the Chromium extensions page with Developer mode enabled.");
    console.log(`Pairing page opened: ${pairingUrl}`);
  }
}

function openExternal(target) {
  const command = process.platform === "darwin"
    ? { file: "open", args: [target] }
    : process.platform === "win32"
      ? { file: "cmd.exe", args: ["/d", "/s", "/c", "start", "", target] }
      : { file: "xdg-open", args: [target] };
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command.file, command.args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("spawn", () => {
      child.unref();
      resolvePromise();
    });
    child.once("error", rejectPromise);
  });
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
    stateRoot: state.paths.stateRoot,
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
    logger.warn("Worker is not healthy at the expected version; redeploying automatically", { reason: workerHealthUserReason(health.error) });
    logger.debug("Worker health check detail", { health_error: health.error });
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
  createExclusiveFileSync(tempPath, JSON.stringify(payload), { mode: 0o600 });
  ownerOnlyFile(tempPath);
  try {
    return await callback(tempPath);
  } finally {
    try { unlinkSync(tempPath); } catch {}
  }
}

export function cleanupStaleSecretFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const match = /^worker-secrets-(\d+)-(\d+)(?:-[a-f0-9]+)?\.json$/.exec(entry.name);
    if (!match) continue;
    const file = resolve(dir, entry.name);
    try {
      const pid = Number(match[1]);
      const createdAt = Number(match[2]);
      const identity = inspectProcessInstance({ pid, startedAt: new Date(createdAt).toISOString() });
      if (!identity.current) unlinkSync(file);
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

export function workerHealthUserReason(value) {
  const reason = String(value || "");
  if (reason.startsWith("version_mismatch:")) return "deployed version does not match the local package";
  if (/^HTTP \d+$/.test(reason)) return "health endpoint returned an HTTP error";
  if (reason === "unexpected_health_response") return "health endpoint returned an unexpected response";
  if (reason === "timeout") return "health check timed out";
  if (reason === "tls_error") return "TLS validation failed";
  if (reason === "network_error") return "network request failed";
  if (reason === "missing_worker_url") return "Worker URL is missing";
  return "health check failed";
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
    logger.safePlain("  Connection credentials unchanged; use --print-mcp-credentials only when reconnecting a client.");
  }
  if (policyMigrated) {
    logger.warn("Legacy implicit policy migrated to full access; use --profile agent, edit, or review to narrow it.");
  }
  logger.plain(`  Workspace: ${payload.workspace}`);
  logger.safePlain(`  Policy: ${formatPolicySummary(payload.policy)}`);
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
  checks.push({ name: "node", ok: isSupportedNodeVersion(), detail: process.version });
  const wrangler = await runWrangler(["--version"], { capture: true, allowFailure: true });
  checks.push({ name: "wrangler", ok: wrangler.code === 0, detail: (wrangler.stdout || wrangler.stderr).trim() });
  const whoami = await runWrangler(["whoami"], { capture: true, allowFailure: true });
  checks.push({ name: "cloudflare-login", ok: whoami.code === 0, detail: whoami.code === 0 ? "authenticated" : sanitizeLines(whoami.stderr || whoami.stdout) });
  const state = loadState(workspace, { stateDir: args.stateDir });
  const storedPolicyOrigin = state.policy?.origin;
  state.policy = resolvePolicy({}, state.policy);
  checks.push({ name: "policy", ok: true, detail: formatPolicySummary(state.policy) });
  if (state.policy.profile === "full") {
    try {
      assertCanonicalFullPolicy(state.policy);
      checks.push({ name: "full-policy-contract", ok: true, detail: `${toolsForPolicy(state.policy).length} tools exposed` });
    } catch (error) {
      checks.push({ name: "full-policy-contract", ok: false, detail: sanitizeLines(error?.message || error) });
    }
  }
  const health = state.worker?.url ? await workerHealth(state.worker.url) : { ok: false, error: "no worker url" };
  checks.push({ name: "worker-health", ok: health.ok, detail: health.ok ? state.worker.url : health.error });
  const diagnosticRuntime = new LocalRuntime({
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

async function fullTestCommand(args) {
  const workspace = await chooseWorkspace(args, { promptOnFirstRun: false, save: false, allowPositional: true });
  const state = loadState(workspace, { stateDir: args.stateDir });
  const policy = resolvePolicy({}, state.policy);
  const result = await runFullAccessTest({ workspace, policy });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

async function rotateSecretsCommand(args) {
  const workspace = await chooseWorkspace(args, { promptOnFirstRun: false, save: false, allowPositional: true });
  const state = loadState(workspace, { stateDir: args.stateDir });
  const operationLogger = createLogger({ level: args.quiet ? "error" : "warn", component: "service" });
  const startupLock = await acquireStartupLockWithWait(state, { operation: "rotate-secrets", logger: operationLogger });
  try {
    await stopAutostartBestEffort(operationLogger);
    const stopped = await stopWorkspaceServiceDaemon(state, { logger: operationLogger, reason: "secret rotation" });
    if (stopped.found && !stopped.ok) {
      const pid = stopped.pid ? `pid ${stopped.pid}` : "unknown pid";
      throw new Error(`refusing to rotate secrets while a daemon cannot be safely stopped (${pid}; ${stopped.reason})`);
    }
    await sleep(100);
    const daemonOwner = readDaemonLockOwner(daemonLockPathForState(state));
    const daemonIdentity = daemonOwner ? inspectProcessInstance(daemonOwner) : null;
    if (daemonIdentity?.current) {
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
    const state = optionalServiceState(args, stateRoot);
    const workspaceDaemon = state ? inspectWorkspaceDaemon(state) : null;
    console.log(JSON.stringify({
      ...status,
      workspace: state?.workspace?.path || null,
      workspace_daemon: workspaceDaemon,
      effective_active: Boolean(status.active || workspaceDaemon?.alive),
      orphaned_workspace_daemon: Boolean(!status.active && workspaceDaemon?.alive && workspaceDaemon?.verified_service_daemon),
    }, null, 2));
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
    if (result?.ok === false) process.exitCode = 1;
    return;
  }
  if (action === "start") {
    const result = await startAutostart({ logger: structuredLogger(Boolean(args.quiet)) });
    console.log(JSON.stringify(result, null, 2));
    if (result?.ok === false) process.exitCode = 1;
    return;
  }
  if (action === "stop") {
    const logger = structuredLogger(Boolean(args.quiet));
    const provider = await stopAutostart({ logger });
    const state = optionalServiceState(args, stateRoot);
    const workspaceDaemon = state
      ? await stopWorkspaceServiceDaemon(state, { logger, reason: "service stop" })
      : { ok: true, found: false, stopped: false, verified_service_daemon: false, reason: "workspace_not_selected" };
    const result = {
      ...provider,
      ok: provider?.ok !== false && workspaceDaemon.ok,
      workspace: state?.workspace?.path || null,
      workspace_daemon: workspaceDaemon,
    };
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (action === "uninstall" || action === "remove") {
    const logger = structuredLogger(Boolean(args.quiet));
    const state = optionalServiceState(args, stateRoot);
    const lifecycle = await stopAndRemoveAutostart({
      states: state ? [state] : [],
      stateRoot,
      logger,
      reason: "service uninstall",
      stopAutostart,
      uninstallAutostart,
      stopWorkspaceServiceDaemon,
    });
    const output = {
      ...lifecycle,
      workspace: state?.workspace?.path || null,
      workspace_daemon: lifecycle.workspace_daemons[0] || null,
      autostart_removed: lifecycle.removed,
    };
    console.log(JSON.stringify(output, null, 2));
    if (!output.ok) process.exitCode = 1;
    return;
  }
  throw new Error(`Unknown service action: ${action}`);
}

function optionalServiceState(args, stateRoot) {
  const requested = args.workspace || args._[1] || selectedWorkspace(stateRoot);
  if (!requested || requested === true) return null;
  return loadState(resolveWorkspace(String(requested)), { stateDir: stateRoot });
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
  let result = null;
  try {
    const { stopAutostart } = await import("./service.mjs");
    result = await stopAutostart({ logger: structuredLogger(true) });
  } catch (error) {
    logger.warn("Autostart stop command was unavailable; checking the workspace daemon directly", { error_class: classifyOperationalError(error) });
    return { takeOverServiceOwner: true, provider: null };
  }
  if (result?.active_before && result?.ok) logger.info("stopping the background service before foreground startup");
  if (result?.ok === false && result?.active === true) {
    throw new Error("the background service is still active after the stop request; run `machine-mcp service status` for details");
  }
  return { takeOverServiceOwner: true, provider: result };
}

async function uninstallCommand(args) {
  const stateRoot = stateRootFromArgs(args);
  const deleteRemote = !args.keepWorker;
  const validation = validateStateRootForRemoval(stateRoot);
  const action = deleteRemote
    ? `delete deployed Worker(s), remove autostart entries, and remove local state at ${stateRoot}`
    : `remove autostart entries and local state at ${stateRoot} while keeping deployed Worker(s)`;
  const ok = await confirm(`Uninstall Machine Bridge MCP: ${action}?`, Boolean(args.yes));
  if (!ok) {
    console.log("Uninstall cancelled. Re-run with `machine-mcp uninstall --yes` to skip confirmation.");
    return;
  }
  const currentValidation = validateStateRootForRemoval(stateRoot);
  const maintenance = currentValidation.exists ? acquireMaintenanceLock(stateRoot, { operation: "uninstall" }) : null;
  if (maintenance && !maintenance.acquired) {
    const pid = maintenance.owner?.pid ? `pid ${maintenance.owner.pid}` : "another process";
    throw new Error(`another state maintenance operation is active (${pid})`);
  }
  try {
    if (currentValidation.exists) validateStateRootForRemoval(stateRoot);
    assertNoActiveJobsForUninstall(stateRoot);
    const autostartRemoved = await removeAutostartBestEffort(stateRoot);
    if (!autostartRemoved) throw new Error("autostart removal failed; state and Worker were kept so the uninstall can be retried safely");
    await sleep(100);
    assertNoActiveJobsForUninstall(stateRoot);
    assertNoActiveLocksForUninstall(stateRoot);
    if (deleteRemote) await deleteKnownWorkers(stateRoot);
    assertNoActiveJobsForUninstall(stateRoot);
    assertNoActiveLocksForUninstall(stateRoot);
    removeStateRoot(stateRoot);
    console.log("Removed local autostart entries and state.");
    if (deleteRemote) console.log("Requested deletion for known deployed Worker(s).");
    console.log("If installed globally, remove the npm package with:");
    console.log("  npm uninstall -g machine-bridge-mcp");
  } finally {
    maintenance?.release?.();
  }
}

function assertNoActiveJobsForUninstall(stateRoot) {
  const activeJobs = activeStateJobs(stateRoot);
  if (!activeJobs.length) return;
  const detail = activeJobs.slice(0, 5).map((item) => `${item.job_id}:${item.status}`).join(", ");
  const suffix = activeJobs.length > 5 ? `, and ${activeJobs.length - 5} more` : "";
  throw new Error(`refusing to uninstall while managed jobs are active (${detail}${suffix}); inspect or cancel them with machine-mcp job list/cancel`);
}

function assertNoActiveLocksForUninstall(stateRoot) {
  const activeLocks = activeStateLocks(stateRoot);
  if (!activeLocks.length) return;
  const detail = activeLocks.map((item) => `${item.kind}:${item.pid || "unknown"}`).join(", ");
  throw new Error(`refusing to uninstall while Machine Bridge processes are active (${detail}); stop foreground sessions and retry`);
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

export function knownWorkerNames(stateRoot) {
  const profiles = resolve(expandHome(stateRoot), "profiles");
  if (!existsSync(profiles)) return [];
  const names = new Set();
  for (const entry of readdirSync(profiles, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9]{24}$/.test(entry.name)) continue;
    const profileDir = resolve(profiles, entry.name);
    const stateFile = resolve(profileDir, "state.json");
    if (!existsSync(stateFile)) {
      const evidence = readdirSync(profileDir).some((name) => /^state\.json\.corrupt-/.test(name) || name === "daemon.lock");
      if (evidence) throw new Error(`cannot determine deployed Worker from profile ${entry.name}; local state was kept for inspection`);
      continue;
    }
    let state;
    try {
      state = JSON.parse(readBoundedRegularFileSync(stateFile, 2 * 1024 * 1024).toString("utf8"));
    } catch {
      throw new Error(`cannot determine deployed Worker from profile ${entry.name}; local state was kept for inspection`);
    }
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      throw new Error(`cannot determine deployed Worker from profile ${entry.name}; local state was kept for inspection`);
    }
    const name = String(state?.worker?.name || "");
    if (name && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) {
      throw new Error(`profile ${entry.name} contains an invalid Worker name; local state was kept for inspection`);
    }
    if (name) names.add(name);
  }
  return [...names];
}

async function removeAutostartBestEffort(stateRoot) {
  const logger = structuredLogger(false);
  try {
    const { stopAutostart, uninstallAutostart } = await import("./service.mjs");
    const lifecycle = await stopAndRemoveAutostart({
      states: knownProfileStates(stateRoot),
      stateRoot,
      logger,
      reason: "uninstall",
      stopAutostart,
      uninstallAutostart,
      stopWorkspaceServiceDaemon,
    });
    if (!lifecycle.ok) {
      console.warn(`Autostart removal stopped at ${lifecycle.reason}; service definitions and state were kept.`);
      return false;
    }
    return true;
  } catch (error) {
    console.warn(`Autostart removal skipped or failed (${classifyOperationalError(error)}). Run machine-mcp service status for details.`);
    return false;
  }
}

export function knownProfileStates(stateRoot) {
  const canonicalStateRoot = resolve(expandHome(stateRoot));
  const profiles = resolve(canonicalStateRoot, "profiles");
  if (!existsSync(profiles)) return [];
  const states = [];
  const seen = new Set();
  for (const entry of readdirSync(profiles, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9]{24}$/.test(entry.name)) continue;
    const profileDir = resolve(profiles, entry.name);
    const statePath = resolve(profileDir, "state.json");
    const candidates = [];
    if (existsSync(statePath)) {
      try {
        const value = JSON.parse(readBoundedRegularFileSync(statePath, 2 * 1024 * 1024).toString("utf8"));
        if (typeof value?.workspace?.path === "string") candidates.push(value.workspace.path);
      } catch {}
    }
    const daemonLock = resolve(profileDir, "daemon.lock");
    const daemonOwner = readDaemonLockOwner(daemonLock);
    if (existsSync(daemonLock) && !daemonOwner) {
      throw new Error(`cannot inspect daemon lock for profile ${entry.name}; service definitions and state were kept`);
    }
    if (typeof daemonOwner?.workspace === "string") candidates.push(daemonOwner.workspace);
    for (const candidate of candidates) {
      try {
        const workspace = resolveWorkspace(candidate);
        if (seen.has(workspace)) break;
        states.push({
          schemaVersion: 5,
          workspace: { path: workspace, hash: entry.name },
          paths: { stateRoot: canonicalStateRoot, profileDir, statePath },
        });
        seen.add(workspace);
        break;
      } catch {}
    }
  }
  return states;
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
      if (!owner) {
        active.push({ kind, pid: null, path: lockPath, reason: "invalid_or_unreadable_lock" });
        continue;
      }
      const identity = inspectProcessInstance(owner, { maxAgeMs: kind === "startup" ? 2 * 60 * 60 * 1000 : Number.POSITIVE_INFINITY });
      if (identity.current || (identity.alive && !identity.reclaimable)) active.push({ kind, pid: owner.pid, path: lockPath, reason: identity.reason });
    }
  }
  return active;
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

export function isSupportedNodeVersion(version = process.versions.node) {
  const major = Number(String(version || "").split(".")[0]);
  return Number.isInteger(major) && major >= 26;
}

function assertNodeVersion() {
  if (!isSupportedNodeVersion()) throw new Error(`Node.js >=26 is required; current ${process.version}`);
}

function usage() {
  console.log(`machine-bridge-mcp

Usage:
  npm install -g --omit=optional --allow-scripts=esbuild,workerd,sharp,fsevents machine-bridge-mcp@latest && machine-mcp
  npx machine-bridge-mcp@latest                  # no global install; autostart may rely on npm cache
  ./mbm                                          # from source checkout
  .\\mbm.cmd                                      # from source checkout on Windows cmd

Commands:
  start             Deploy/update Worker, take over autostart, run foreground daemon
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
  full-test         Run real local full-profile capability tests in a temporary sandbox
  rotate-secrets    Rotate MCP password and daemon secret in local state
  resource generate-ssh-key NAME [PATH]
                    Generate/reuse an Ed25519 key locally and register its private file by alias
  browser status    Show browser-extension bridge and connection status
  browser setup     Print the extension path and open the local pairing page
  browser path      Print the packaged unpacked-extension directory
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
  --show-paths          Include local absolute paths in resource command output

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
