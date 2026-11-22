import { createHash, randomBytes } from "node:crypto";
import { accessSync, constants, existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { DEFAULT_POLICY_PROFILE, DEFAULT_POLICY_REVISION, POLICY_ORIGINS, POLICY_PROFILES, normalizePolicy, policyProfile } from "../core/policy.mjs";
import { packageName, packageRoot, packageVersion } from "../core/timing.mjs";
import serverMetadata from "../../shared/server-metadata.json" with { type: "json" };
import toolCatalog from "../../shared/tool-catalog.json" with { type: "json" };
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import process from "node:process";
import { createLogger, sanitizeLogText } from "../core/log.mjs";
import { readBoundedRegularFileSync } from "../core/secure-file.mjs";
import { inspectResourceFile, loadManagedJobPlan, ManagedJobManager, publicResourceRegistry, validateResourceName } from "../jobs/manager.mjs";
import { generateRegisteredSshKey } from "../runtime/resource-operations.mjs";
import { acquireMaintenanceLock, acquireStartupLockWithWait, defaultStateRoot, expandHome, loadState, profileDirForWorkspace, saveState, STATE_SCHEMA_VERSION } from "../state/state.mjs";
import { readBrowserPairing, readBrowserPairingPort, rotateBrowserPairing, startBrowserPairingLaunch } from "../automation/browser-pairing.mjs";
import { activeStateLocks } from "./state-inventory.mjs";
import { browserPairingLaunchCommand } from "../automation/browser-commands.mjs";
import { browserExtensionPathForRuntime } from "../automation/browser-extension-protocol.mjs";
import { readLoopbackJson } from "../transport/network-proxy.mjs";

const POLICY_OVERRIDE_KEYS = Object.freeze(["execMode", "noWrite", "noExec", "fullEnv", "unrestrictedPaths", "absolutePaths"]);

export function resolvePolicy(args = {}, stored = {}) {
  const hasStored = stored && typeof stored === "object" && typeof stored.profile === "string";
  const explicitKeys = ["profile", ...POLICY_OVERRIDE_KEYS];
  const hasExplicit = explicitKeys.some((key) => Object.prototype.hasOwnProperty.call(args, key));
  const base = { ...selectPolicyBase(args, stored, hasStored) };
  if (!hasExplicit) return policyState(base);
  applyPolicyOverrides(base, args);
  if (args.profile === undefined || POLICY_OVERRIDE_KEYS.some((key) => Object.prototype.hasOwnProperty.call(args, key))) {
    base.profile = "custom";
    base.origin = "custom";
    base.revision = DEFAULT_POLICY_REVISION;
  }
  return policyState(base);
}

function policyState(policy) {
  const normalized = normalizePolicy(policy);
  const state = {};
  for (const [key, value] of Object.entries(normalized)) {
    Object.defineProperty(state, key, { value, enumerable: true, writable: false, configurable: false });
  }
  Object.defineProperty(state, "updatedAt", { value: undefined, enumerable: true, writable: true, configurable: false });
  return Object.seal(state);
}

function selectPolicyBase(args, stored, hasStored) {
  if (args.profile !== undefined) {
    const profile = String(args.profile).trim().toLowerCase();
    if (!Object.hasOwn(POLICY_PROFILES, profile)) throw new Error(`--profile must be one of: ${Object.keys(POLICY_PROFILES).join(", ")}`);
    return policyProfile(profile, "explicit");
  }
  if (!hasStored) return policyProfile(DEFAULT_POLICY_PROFILE, "default");
  if (stored.revision !== DEFAULT_POLICY_REVISION || !POLICY_ORIGINS.has(stored.origin)) {
    throw new Error("stored policy schema is obsolete; preserve the state root and use a supported upgrade or backup recovery path");
  }
  return normalizePolicy(stored);
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
export function createLocalAdminCommands(dependencies) {
  const chooseWorkspace = dependencies.chooseWorkspace;
  const confirm = dependencies.confirm;
  if (typeof chooseWorkspace !== "function" || typeof confirm !== "function") {
    throw new TypeError("local admin commands require chooseWorkspace and confirm dependencies");
  }
  const context = Object.freeze({
    chooseWorkspace,
    confirm,
    openExternal: dependencies.openExternal || openExternal,
    readBrowserHealth: dependencies.readBrowserHealth || readBrowserHealth,
    startBrowserPairingLaunch: dependencies.startBrowserPairingLaunch || startBrowserPairingLaunch,
  });
  return Object.freeze({
    resourceCommand: (args) => resourceCommand(args, context),
    browserCommand: (args) => browserCommand(args, context),
    jobCommand: (args) => jobCommand(args, context),
  });
}

const RESOURCE_ACTION_HANDLERS = new Map([
  ["list", resourceListAction],
  ["add", resourceAddAction],
  ["generate-ssh-key", resourceGenerateSshKeyAction],
  ["remove", resourceRemoveAction],
  ["check", resourceCheckAction],
]);

async function resourceCommand(args, { chooseWorkspace }) {
  const action = String(args._[0] || "list").toLowerCase();
  const handler = RESOURCE_ACTION_HANDLERS.get(action);
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
  const resource = Object.hasOwn(state.resources, name) ? state.resources[name] : null;
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

const BROWSER_ACTION_HANDLERS = new Map([
  ["path", browserPathAction],
  ["status", browserStatusAction],
  ["setup", browserPairAction],
  ["pair", browserPairAction],
  ["reset", browserResetAction],
]);

async function browserCommand(args, dependencies) {
  const action = String(args._[0] || "status").toLowerCase();
  const handler = BROWSER_ACTION_HANDLERS.get(action);
  if (!handler) throw new Error(`Unknown browser action: ${action}`);
  return handler(args, dependencies);
}

function browserPathAction(args) {
  const stateRoot = resolve(expandHome(args.stateDir || defaultStateRoot()));
  const extensionPath = browserExtensionPathForRuntime({ stateRoot });
  if (args.json) console.log(JSON.stringify({ extension_path: extensionPath }, null, 2));
  else console.log(extensionPath);
}

async function browserStatusAction(args, { chooseWorkspace, readBrowserHealth: readHealth }) {
  const context = await browserCommandContext(args, chooseWorkspace, readHealth);
  renderBrowserStatus(context.result, args.json === true);
}

async function browserPairAction(args, {
  chooseWorkspace, openExternal: openTarget, readBrowserHealth: readHealth, startBrowserPairingLaunch: startPairingLaunch,
}) {
  const context = await browserCommandContext(args, chooseWorkspace, readHealth);
  if (!context.result.running) throw new Error("browser bridge is not reachable; keep machine-mcp running and retry");
  const pairing = readBrowserPairing(context.stateRoot);
  if (!pairing || pairing.port !== context.port) throw new Error("browser pairing state changed; retry setup");
  const launch = await startPairingLaunch({ brokerPort: pairing.port, extensionToken: pairing.extensionToken });
  try { await openTarget(launch.url); } catch (error) { launch.close(); throw error; }
  if (args.json) {
    console.log(JSON.stringify({ ...context.result, pairing_page_opened: true }, null, 2));
    return;
  }
  console.log(`Extension path: ${context.extensionPath}`);
  console.log("Load this directory in the Chromium profile you use every day; Machine Bridge does not install it into Playwright or a separate automation profile.");
  console.log("Enable Developer mode, choose Load unpacked once, and reload the same path after each Machine Bridge upgrade.");
  console.log(`Pairing page opened: ${context.pairingUrl}`);
}

async function browserResetAction(args, { chooseWorkspace, readBrowserHealth: readHealth }) {
  const context = await browserCommandContext(args, chooseWorkspace, readHealth);
  if (context.result.running) throw new Error("browser reset requires Machine Bridge runtimes to be stopped");
  const maintenance = acquireMaintenanceLock(context.stateRoot, { operation: "browser-reset" });
  if (!maintenance.acquired) {
    const pid = maintenance.owner?.pid ? `pid ${maintenance.owner.pid}` : "another process";
    throw new Error(`another state maintenance operation is active (${pid})`);
  }
  try {
    const locks = activeStateLocks(context.stateRoot);
    if (locks.length) {
      const detail = locks.slice(0, 5).map((item) => `${item.kind}:${item.pid || "unknown"}`).join(", ");
      throw new Error(`browser reset requires all Machine Bridge runtimes to be stopped (${detail})`);
    }
    const health = await readHealth(`http://127.0.0.1:${context.port}/healthz`);
    if (health?.ok === true && health?.broker === "machine-bridge-browser") {
      throw new Error("browser reset requires Machine Bridge runtimes to be stopped");
    }
    const rotated = rotateBrowserPairing(context.stateRoot);
    if (args.json) {
      console.log(JSON.stringify({ reset: true, port: rotated.port, repair_required: true }, null, 2));
      return;
    }
    console.log("Browser pairing credentials rotated. Start Machine Bridge, then run `machine-mcp browser setup` to pair the extension again.");
  } finally {
    maintenance.release();
  }
}

async function browserCommandContext(args, chooseWorkspace, readHealth) {
  const workspace = await chooseWorkspace({ ...args, _: [] }, { promptOnFirstRun: false, save: false, allowPositional: false });
  const state = loadState(workspace, { stateDir: args.stateDir });
  const extensionPath = browserExtensionPathForRuntime({ stateRoot: state.paths.stateRoot });
  const port = readBrowserPairingPort(state.paths.stateRoot);
  if (port === null) throw new Error("browser bridge is not initialized; start machine-mcp once, then run this command again");
  const pairingUrl = `http://127.0.0.1:${port}/pair`;
  const health = await readHealth(`http://127.0.0.1:${port}/healthz`);
  return { extensionPath, pairingUrl, port, stateRoot: state.paths.stateRoot, result: browserStatusResult(health, extensionPath, pairingUrl) };
}

function readBrowserHealth(healthUrl) {
  return readLoopbackJson(healthUrl, { pathname: "/healthz" });
}

function browserStatusResult(health, extensionPath, pairingUrl) {
  return {
    running: health?.ok === true && health?.broker === "machine-bridge-browser",
    connected: health?.broker === "machine-bridge-browser" && health?.connected === true,
    extension_path: extensionPath,
    pairing_url: pairingUrl,
    expected_extension_version: typeof health?.expected_extension_version === "string" ? health.expected_extension_version : "",
    extension_protocol: Number.isInteger(health?.extension_protocol) ? health.extension_protocol : null,
    extension_version: typeof health?.extension_version === "string" ? health.extension_version : "",
    extension_capabilities: Array.isArray(health?.extension_capabilities) ? health.extension_capabilities : [],
    extension_reload_required: health?.extension_reload_required === true,
    controls_existing_profile: health?.controls_existing_profile === true,
    controls_extension_profile: health?.controls_extension_profile === true,
    machine_bridge_launches_browser: health?.machine_bridge_launches_browser === true,
    profile_identity_verifiable: health?.profile_identity_verifiable === true,
    token_exposed: false,
  };
}

function renderBrowserStatus(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Browser bridge: ${result.running ? "running" : "not reachable"}`);
  console.log(`Extension: ${result.connected ? "connected" : result.extension_reload_required ? "reload required" : "not connected"}`);
  if (result.expected_extension_version) console.log(`Expected extension build: ${result.expected_extension_version}`);
  if (result.extension_version || result.extension_protocol) console.log(`Connected extension build: ${result.extension_version || "unknown"} (protocol ${result.extension_protocol ?? "unknown"})`);
  console.log(`Browser profile: ${result.controls_extension_profile ? "the Chromium profile where this extension is installed" : "unknown"}`);
  if (result.controls_extension_profile) console.log("Profile provenance: Machine Bridge did not launch the browser; daily-vs-isolated profile identity is not machine-verifiable.");
  console.log(`Extension path: ${result.extension_path}`);
}

function openExternal(target) {
  const command = browserPairingLaunchCommand(target);
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command.cmd, command.argv, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("spawn", () => {
      child.unref();
      resolvePromise();
    });
    child.once("error", rejectPromise);
  });
}

async function jobCommand(args, { chooseWorkspace }) {
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
  else if (action === "submit") {
    const planPath = args._[1];
    if (!planPath) throw new Error("job submit requires a JSON plan file");
    const plan = loadManagedJobPlan(expandHome(planPath));
    result = manager.start(plan);
  } else throw new Error(`Unknown job action: ${action}`);
  console.log(JSON.stringify(result, null, 2));
}
export function printStartJson(state, { requestedChangesApplied = true, notice = "", initialOwner = null } = {}) {
  createLogger({ component: "ready" }).rawJson({
    mcp: {
      server_url: state.worker.mcpServerUrl,
      worker_url: state.worker.url,
      worker_name: state.worker.name,
    },
    ...(initialOwner ? { initial_owner: initialOwner } : {}),
    workspace: state.workspace.path,
    state_path: state.paths.statePath,
    policy: state.policy,
    requested_changes_applied: requestedChangesApplied,
    ...(notice ? { notice } : {}),
  });
}

export function printMcpConnection(state, { quiet = false, verbose = false, initialOwner = null, logger: readyLogger = null } = {}) {
  const output = readyLogger || createLogger({ component: "ready", quiet, level: quiet ? "error" : verbose ? "debug" : "info" });
  if (output.format === "json" && !initialOwner) {
    output.event("success", "daemon.ready", {
      mcp_server_url: state.worker.mcpServerUrl,
      worker_name: state.worker.name,
      workspace_path: state.workspace.path,
      policy_profile: state.policy.profile,
      policy_origin: state.policy.origin,
      write_enabled: state.policy.allowWrite,
      exec_mode: state.policy.execMode,
    }, "Remote MCP bridge is ready");
    return;
  }
  const logger = output;
  logger.success("Remote MCP bridge is ready");
  logger.rawPlain(`  MCP Server URL: ${state.worker.mcpServerUrl}`);
  if (initialOwner) {
    logger.warn("Initial owner account created; save the password now because it is not stored locally or shown again. Do not share this terminal output; rotate the password immediately if it has been exposed.");
    logger.rawPlain(`  Account: ${initialOwner.name}`);
    logger.rawPlain(`  Password: ${initialOwner.password}`);
  } else {
    logger.safePlain("  Use `machine-mcp account` to manage account access.");
  }
  logger.rawPlain(`  Workspace: ${state.workspace.path}`);
  logger.safePlain(`  Policy: ${formatPolicySummary(state.policy)}`);
  if (verbose) logger.rawPlain(`  State: ${state.paths.statePath}`);
}

export function formatPolicySummary(policy = {}) {
  const scope = policy.unrestrictedPaths ? "all local paths" : "workspace only";
  const environment = policy.minimalEnv ? "isolated env" : "full parent env";
  return `${policy.profile || "custom"} [${policy.origin || "unknown"}; write=${policy.allowWrite ? "on" : "off"}; exec=${policy.execMode || "off"}; ${scope}; ${environment}; absolute_paths=${policy.exposeAbsolutePaths ? "on" : "off"}]`;
}

const PAIR_ROLES = new Set(["reviewer", "editor", "operator", "owner"]);

function verifyStateDirectory(stateRoot) {
  const stateCheck = { ok: true, initialized: false, readable: false, writable: false };
  let stateInfo = null;
  try { stateInfo = lstatSync(stateRoot); } catch (error) {
    if (error?.code !== "ENOENT") {
      stateCheck.ok = false;
      stateCheck.error = sanitizeLogText(error instanceof Error ? error.message : String(error), 200);
    }
  }
  if (!stateInfo) return stateCheck;
  stateCheck.initialized = true;
  if (stateInfo.isSymbolicLink() || !stateInfo.isDirectory()) {
    stateCheck.ok = false;
    stateCheck.error = "state_dir must be a real non-symlink directory";
    return stateCheck;
  }
  try { accessSync(stateRoot, constants.R_OK); stateCheck.readable = true; } catch (error) {
    stateCheck.error = sanitizeLogText(error instanceof Error ? error.message : String(error), 200);
  }
  try { accessSync(stateRoot, constants.W_OK); stateCheck.writable = true; } catch (error) {
    stateCheck.error ||= sanitizeLogText(error instanceof Error ? error.message : String(error), 200);
  }
  stateCheck.ok = stateCheck.readable && stateCheck.writable;
  return stateCheck;
}

function verifyWorkspacePolicy(workspacePath, stateRoot, stateCheck) {
  try {
    let sourcePolicy = policyProfile(DEFAULT_POLICY_PROFILE);
    if (workspacePath) {
      const wsInfo = statSync(workspacePath);
      if (!wsInfo.isDirectory()) throw new Error("workspace path is not a directory");
      if (stateCheck.initialized && stateCheck.ok) {
        const canonicalWs = realpathSync(workspacePath);
        const canonicalState = realpathSync(stateRoot);
        const statePath = join(profileDirForWorkspace(canonicalWs, canonicalState), "state.json");
        if (existsSync(statePath)) {
          const parsed = JSON.parse(readBoundedRegularFileSync(statePath, 4 * 1024 * 1024, "workspace state", { verifyPathIdentity: true }).toString("utf8"));
          if (parsed.schemaVersion !== STATE_SCHEMA_VERSION) {
            throw new Error(`unsupported workspace state schema version: ${parsed.schemaVersion}`);
          }
          if (parsed.policy) sourcePolicy = parsed.policy;
        }
      }
    }
    const normalized = normalizePolicy(sourcePolicy);
    return { ok: Boolean(normalized?.profile), profile: normalized.profile };
  } catch (error) {
    return { ok: false, error: sanitizeLogText(error instanceof Error ? error.message : String(error), 200) };
  }
}

export async function verifyCommand(args = {}) {
  const stateRoot = resolve(expandHome(args.stateDir || defaultStateRoot()));
  const workspacePath = args.workspace ? resolve(expandHome(args.workspace)) : "";
  const nodeMajor = Number.parseInt(String(process.versions.node || "0").split(".")[0], 10);
  const nodeOk = Number.isFinite(nodeMajor) && nodeMajor >= 26;
  const nodeCheck = { ok: nodeOk, current: process.versions.node, required: ">=26", ...(nodeOk ? {} : { error: `Node.js >=26 required; found ${process.versions.node}` }) };

  const digest = createHash("sha256").update(JSON.stringify(toolCatalog)).digest("hex");
  const catalogOk = digest === serverMetadata.toolCatalogSha256;
  const catalogCheck = { ok: catalogOk, tool_count: toolCatalog.length, schema_generation: Number(serverMetadata.toolSchemaGeneration), ...(catalogOk ? {} : { error: "tool_catalog digest does not match server-metadata.json" }) };

  let extensionCheck = { ok: false, version: null };
  try {
    const manifest = JSON.parse(readFileSync(join(packageRoot, "browser-extension", "manifest.json"), "utf8"));
    const extOk = manifest?.manifest_version === 3 && typeof manifest?.version === "string" && manifest.version.length > 0;
    extensionCheck = { ok: extOk, version: manifest?.version || null, ...(extOk ? {} : { error: "browser extension manifest is invalid" }) };
  } catch (error) {
    extensionCheck = { ok: false, version: null, error: sanitizeLogText(error instanceof Error ? error.message : String(error), 200) };
  }

  const stateCheck = verifyStateDirectory(stateRoot);
  const checks = { node: nodeCheck, state_dir: stateCheck, policy: verifyWorkspacePolicy(workspacePath, stateRoot, stateCheck), tool_catalog: catalogCheck, browser_extension: extensionCheck };
  const ok = Object.values(checks).every((entry) => entry.ok === true);
  const report = { ok, package: packageName, version: packageVersion, schema_generation: Number(serverMetadata.toolSchemaGeneration), checks };
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`${packageName} ${packageVersion} verify: ${ok ? "ok" : "failed"}`);
    for (const [name, entry] of Object.entries(checks)) console.log(`  - ${name}: ${entry.ok ? "ok" : `failed (${entry.error || "invalid"})`}`);
  }
  if (!ok) process.exitCode = 1;
  return report;
}

export async function pairCommand(args = {}) {
  let ttlSeconds = 300;
  if (args.ttl !== undefined) {
    if (!/^\d+$/.test(String(args.ttl))) throw new Error("--ttl must be an integer between 60 and 3600 seconds");
    ttlSeconds = Number.parseInt(String(args.ttl), 10);
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 3600) throw new Error("--ttl must be an integer between 60 and 3600 seconds");
  }
  const role = args.role === undefined ? "owner" : String(args.role).toLowerCase();
  if (!PAIR_ROLES.has(role)) throw new Error(`--role must be one of: ${[...PAIR_ROLES].join(", ")}`);
  const stateRoot = resolve(expandHome(args.stateDir || defaultStateRoot()));
  const issuedAt = new Date();
  const ticket = {
    ticket_id: `pair_${randomBytes(18).toString("base64url")}`,
    advisory_only: true,
    role,
    ttl_seconds: ttlSeconds,
    issued_at: issuedAt.toISOString(),
    expires_at: new Date(issuedAt.getTime() + ttlSeconds * 1000).toISOString(),
    state_initialized: existsSync(stateRoot),
    secrets_exposed: false,
    guidance: "Use `machine-mcp browser setup` for Chromium extension pairing or `machine-mcp account add <user> <role>` for multi-account access.",
  };
  if (args.json) console.log(JSON.stringify(ticket, null, 2));
  else console.log(`Pairing ticket: ${ticket.ticket_id} (role=${ticket.role}, ttl=${ticket.ttl_seconds}s)\nExpires at: ${ticket.expires_at}\n${ticket.guidance}`);
  return ticket;
}
