import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function expandHome(value) {
  if (!value || value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

export function defaultStateRoot() {
  if (process.env.MBM_STATE_DIR) return resolve(expandHome(process.env.MBM_STATE_DIR));
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    return join(base, "machine-bridge-mcp");
  }
  const xdg = process.env.XDG_STATE_HOME;
  return xdg ? join(resolve(expandHome(xdg)), "machine-bridge-mcp") : join(homedir(), ".local", "state", "machine-bridge-mcp");
}

export function profileStateDir(root, workspace) {
  return join(root, "profiles", workspaceHash(workspace));
}

export function machineServiceControlRoot(root = defaultStateRoot()) {
  return join(resolve(root), "service-control");
}

export function resourceRoot(root = defaultStateRoot()) {
  return join(root, "resources");
}

export function workspaceHash(workspace) {
  return createHash("sha256").update(resolve(workspace)).digest("hex").slice(0, 24);
}
