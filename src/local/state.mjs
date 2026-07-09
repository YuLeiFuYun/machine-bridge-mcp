import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const appName = "machine-bridge-mcp";

export function expandHome(input = "") {
  if (!input || input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

export function resolveWorkspace(input = process.cwd()) {
  const resolved = path.resolve(expandHome(input));
  return realpathSync(resolved);
}

export function defaultStateRoot() {
  if (process.platform === "win32") {
    const base = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(base, appName);
  }
  if (process.env.XDG_STATE_HOME) return path.join(expandHome(process.env.XDG_STATE_HOME), appName);
  return path.join(os.homedir(), ".local", "state", appName);
}


export function configPath(stateRoot = defaultStateRoot()) {
  return path.join(expandHome(stateRoot), "config.json");
}

export function loadGlobalConfig(stateRoot = defaultStateRoot()) {
  const file = configPath(stateRoot);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function saveGlobalConfig(config, stateRoot = defaultStateRoot()) {
  const root = expandHome(stateRoot);
  ensureOwnerOnlyDir(root);
  const file = configPath(root);
  writeFileSync(file, `${JSON.stringify({ ...config, updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  ownerOnlyFile(file);
}

export function setSelectedWorkspace(workspace, stateRoot = defaultStateRoot()) {
  const root = expandHome(stateRoot);
  const config = loadGlobalConfig(root);
  config.selectedWorkspace = workspace;
  config.selectedWorkspaceHash = workspaceHash(workspace);
  saveGlobalConfig(config, root);
  return config;
}

export function selectedWorkspace(stateRoot = defaultStateRoot()) {
  const value = loadGlobalConfig(stateRoot).selectedWorkspace;
  return typeof value === "string" && value.trim() ? value : "";
}

export function removeStateRoot(stateRoot = defaultStateRoot()) {
  const root = expandHome(stateRoot);
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
}

export function workspaceHash(workspace) {
  return createHash("sha256").update(String(workspace)).digest("hex").slice(0, 24);
}

export function profileDirForWorkspace(workspace, stateRoot = defaultStateRoot()) {
  return path.join(expandHome(stateRoot), "profiles", workspaceHash(workspace));
}

export function statePathForWorkspace(workspace, stateRoot = defaultStateRoot()) {
  return path.join(profileDirForWorkspace(workspace, stateRoot), "state.json");
}

export function loadState(workspace, options = {}) {
  const stateRoot = options.stateDir ? expandHome(options.stateDir) : defaultStateRoot();
  const profileDir = profileDirForWorkspace(workspace, stateRoot);
  const statePath = path.join(profileDir, "state.json");
  ensureOwnerOnlyDir(profileDir);
  let state = {};
  if (existsSync(statePath)) {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  }
  state.schemaVersion = 1;
  state.workspace = {
    path: workspace,
    hash: workspaceHash(workspace),
    updatedAt: new Date().toISOString(),
  };
  state.paths = { stateRoot, profileDir, statePath };
  state.worker ||= {};
  state.policy ||= {};
  return state;
}

export function saveState(state) {
  const statePath = state?.paths?.statePath;
  if (!statePath) throw new Error("state path is missing");
  ensureOwnerOnlyDir(path.dirname(statePath));
  const serializable = { ...state };
  writeFileSync(statePath, `${JSON.stringify(serializable, null, 2)}\n`, { mode: 0o600 });
  ownerOnlyFile(statePath);
}

export function ensureWorkerSecrets(state, options = {}) {
  state.worker ||= {};
  if (!state.worker.oauthPassword || options.rotateSecrets) state.worker.oauthPassword = randomToken("mcp_password");
  if (!state.worker.daemonSecret || options.rotateSecrets) state.worker.daemonSecret = randomToken("daemon_secret");
  if (!state.worker.oauthTokenVersion || options.rotateSecrets) state.worker.oauthTokenVersion = randomToken("token_version");
  if (!state.worker.name || options.workerName) state.worker.name = options.workerName || defaultWorkerName(state.workspace.hash);
}

export function defaultWorkerName(hash) {
  return `mbm-${String(hash || "default").slice(0, 12)}`;
}

export function randomToken(prefix) {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export function fileSha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

export function ensureOwnerOnlyDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch {}
}

export function ownerOnlyFile(filePath) {
  try { chmodSync(filePath, 0o600); } catch {}
}

export function redactState(state) {
  const clone = redactHomeInValue(JSON.parse(JSON.stringify(state)));
  if (clone.worker?.oauthPassword) clone.worker.oauthPassword = previewSecret(clone.worker.oauthPassword);
  if (clone.worker?.daemonSecret) clone.worker.daemonSecret = previewSecret(clone.worker.daemonSecret);
  if (clone.worker?.oauthTokenVersion) clone.worker.oauthTokenVersion = previewSecret(clone.worker.oauthTokenVersion);
  return clone;
}

function redactHomeInValue(value) {
  const home = os.homedir();
  if (typeof value === "string") return home && value.startsWith(home) ? `~${value.slice(home.length)}` : value;
  if (Array.isArray(value)) return value.map(redactHomeInValue);
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) value[key] = redactHomeInValue(value[key]);
  }
  return value;
}

export function previewSecret(value) {
  const text = String(value || "");
  if (text.length <= 12) return "<redacted>";
  return `${text.slice(0, 10)}...${text.slice(-6)}`;
}
