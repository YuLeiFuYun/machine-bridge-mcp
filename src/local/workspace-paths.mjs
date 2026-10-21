// @ts-check
import { mkdirSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { appName } from "./package-identity.mjs";
import { inspectPathIfPresentSync } from "./secure-file.mjs";

/**
 * @param {string} [input]
 * @returns {string}
 */
export function expandHome(input = "") {
  if (!input || input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

/**
 * @param {string} input
 * @param {string} home
 * @returns {string}
 */
export function expandHomeFrom(input, home) {
  if (!input || input === "~") return home;
  if (input.startsWith("~/")) return path.join(home, input.slice(2));
  return input;
}

/**
 * @param {string} [input]
 * @returns {string}
 */
export function resolveWorkspace(input = process.cwd()) {
  const resolved = path.resolve(expandHome(input));
  return realpathSync.native ? realpathSync.native(resolved) : realpathSync(resolved);
}

/**
 * @param {{ platform?: string, home?: string, cwd?: string }} [options]
 * @returns {string}
 */
export function defaultFirstRunWorkspace({ platform = process.platform, home = os.homedir(), cwd = process.cwd() } = {}) {
  return path.resolve(platform === "win32" ? path.join(home, "MachineBridge") : cwd);
}

/**
 * @param {string} input
 * @returns {string}
 */
export function ensureWorkspaceDirectory(input) {
  const requested = path.resolve(expandHome(input));
  mkdirSync(requested, { recursive: true });
  return resolveWorkspace(requested);
}

/**
 * @param {{ platform?: string, home?: string, environment?: Record<string, unknown> }} [options]
 * @returns {string}
 */
export function defaultStateRoot(options = {}) {
  const platform = String(options.platform || process.platform);
  const home = path.resolve(String(options.home || os.homedir()));
  const environment = options.environment && typeof options.environment === "object" ? options.environment : process.env;
  if (platform === "win32") {
    const base = environment.APPDATA ? expandHomeFrom(String(environment.APPDATA), home) : path.join(home, "AppData", "Roaming");
    return path.join(base, appName);
  }
  if (environment.XDG_STATE_HOME) return path.join(expandHomeFrom(String(environment.XDG_STATE_HOME), home), appName);
  return path.join(home, ".local", "state", appName);
}

/**
 * @param {string} input
 * @returns {string}
 */
export function canonicalizePotentialPath(input) {
  let existing = path.resolve(input);
  const suffix = [];
  while (!inspectPathIfPresentSync(existing, "path identity")) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  const canonicalExisting = realpathSync.native ? realpathSync.native(existing) : realpathSync(existing);
  return path.join(canonicalExisting, ...suffix);
}

/**
 * @param {string} stateRoot
 * @param {string} workspace
 */
export function assertStateRootSeparatedFromWorkspace(stateRoot, workspace) {
  const canonicalStateRoot = canonicalizePotentialPath(stateRoot);
  const stateIdentity = process.platform === "win32" ? canonicalStateRoot.toLowerCase() : canonicalStateRoot;
  const workspaceIdentity = process.platform === "win32" ? workspace.toLowerCase() : workspace;
  const relativeWorkspace = path.relative(canonicalStateRoot, workspace);
  const relativeState = path.relative(workspace, canonicalStateRoot);
  const contains = (/** @type {string} */ value) => value === "" || (!value.startsWith(`..${path.sep}`) && value !== ".." && !path.isAbsolute(value));
  if (stateIdentity === workspaceIdentity || contains(relativeWorkspace) || contains(relativeState)) {
    throw new Error("state root and selected workspace must be separate, non-overlapping directories");
  }
}
