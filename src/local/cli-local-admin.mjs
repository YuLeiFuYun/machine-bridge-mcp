import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { createLogger } from "./log.mjs";
import { inspectResourceFile, loadManagedJobPlan, ManagedJobManager, publicResourceRegistry, validateResourceName } from "./managed-jobs.mjs";
import { generateRegisteredSshKey } from "./resource-operations.mjs";
import { readBoundedRegularFileSync } from "./secure-file.mjs";
import {
  acquireStartupLockWithWait, expandHome, loadState, ownerOnlyFile, packageRoot, saveState,
} from "./state.mjs";
import { resolvePolicy } from "./cli-policy.mjs";
import { readLoopbackJson } from "./loopback-health.mjs";

export function createLocalAdminCommands(dependencies) {
  const chooseWorkspace = dependencies.chooseWorkspace;
  const confirm = dependencies.confirm;
  if (typeof chooseWorkspace !== "function" || typeof confirm !== "function") {
    throw new TypeError("local admin commands require chooseWorkspace and confirm dependencies");
  }
  const context = Object.freeze({ chooseWorkspace, confirm });
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
]);

async function browserCommand(args, dependencies) {
  const action = String(args._[0] || "status").toLowerCase();
  const handler = BROWSER_ACTION_HANDLERS.get(action);
  if (!handler) throw new Error(`Unknown browser action: ${action}`);
  return handler(args, dependencies);
}

function browserPathAction(args) {
  const extensionPath = resolve(packageRoot, "browser-extension");
  if (args.json) console.log(JSON.stringify({ extension_path: extensionPath }, null, 2));
  else console.log(extensionPath);
}

async function browserStatusAction(args, { chooseWorkspace }) {
  const context = await browserCommandContext(args, chooseWorkspace);
  renderBrowserStatus(context.result, args.json === true);
}

async function browserPairAction(args, { chooseWorkspace }) {
  const context = await browserCommandContext(args, chooseWorkspace);
  if (!context.result.running) throw new Error("browser bridge is not reachable; keep machine-mcp running and retry");
  await openExternal(context.pairingUrl);
  if (args.json) {
    console.log(JSON.stringify({ ...context.result, pairing_page_opened: true }, null, 2));
    return;
  }
  console.log(`Extension path: ${context.extensionPath}`);
  console.log("Load this directory in the Chromium profile you use every day; Machine Bridge does not install it into Playwright or a separate automation profile.");
  console.log("Enable Developer mode, choose Load unpacked, and reload the extension after each Machine Bridge upgrade.");
  console.log(`Pairing page opened: ${context.pairingUrl}`);
}

async function browserCommandContext(args, chooseWorkspace) {
  const extensionPath = resolve(packageRoot, "browser-extension");
  const workspace = await chooseWorkspace({ ...args, _: [] }, { promptOnFirstRun: false, save: false, allowPositional: false });
  const state = loadState(workspace, { stateDir: args.stateDir });
  const pairingFile = join(state.paths.stateRoot, "browser-bridge.json");
  if (!existsSync(pairingFile)) {
    throw new Error("browser bridge is not initialized; start machine-mcp once, then run this command again");
  }
  ownerOnlyFile(pairingFile);
  const pairing = readBrowserPairingState(pairingFile);
  const pairingUrl = `http://127.0.0.1:${pairing.port}/pair`;
  const health = await readBrowserHealth(`http://127.0.0.1:${pairing.port}/healthz`);
  return { extensionPath, pairingUrl, result: browserStatusResult(health, extensionPath, pairingUrl) };
}

function readBrowserPairingState(pairingFile) {
  let pairing;
  try {
    pairing = JSON.parse(readBoundedRegularFileSync(pairingFile, 64 * 1024).toString("utf8"));
  } catch {
    throw new Error("browser bridge state is invalid; restart machine-mcp to repair it");
  }
  const port = Number(pairing.port);
  if (!/^[A-Za-z0-9_-]{32,100}$/.test(String(pairing.token || ""))) throw new Error("browser bridge state contains an invalid token");
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("browser bridge state contains an invalid port");
  return { port };
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

async function jobCommand(args, { chooseWorkspace, confirm }) {
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
