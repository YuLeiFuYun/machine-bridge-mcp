// @ts-check
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * @typedef {object} RuntimeRedactionOptions
 * @property {unknown} error
 * @property {unknown} toolArgs
 * @property {string} workspace
 * @property {string} workspaceInput
 * @property {string} runtimeDir
 * @property {string | undefined} home
 * @property {(value: string) => string} displayPath
 */

/** @param {string} statePath */
export function stateRootFromProfileStatePath(statePath) {
  const absolute = resolve(statePath);
  if (basename(absolute) !== "state.json") throw new Error("local resource state path is invalid");
  const profileDir = dirname(absolute);
  const profilesDir = dirname(profileDir);
  if (basename(profilesDir) !== "profiles") throw new Error("local resource state path is outside the expected profile layout");
  return dirname(profilesDir);
}

/** @param {string} root @param {string} target */
export function assertContainedPath(root, target) {
  const rel = relative(root, target);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) return;
  throw new Error("path is outside the configured workspace; restart with --unrestricted-paths to allow it");
}

export function createRuntimeDir() {
  const root = mkdtempSync(join(tmpdir(), "machine-bridge-mcp-"));
  for (const name of ["home", "tmp", "cache"]) mkdirSync(join(root, name), { recursive: true, mode: 0o700 });
  return root;
}

/** @param {unknown} message @param {RuntimeRedactionOptions} options */
export function redactRuntimeErrorMessage(message, {
  error,
  toolArgs,
  workspace,
  workspaceInput,
  runtimeDir,
  home,
  displayPath,
}) {
  let redacted = String(message);
  for (const prefix of equivalentPathPrefixes(workspace, workspaceInput)) redacted = replacePathPrefix(redacted, prefix, ".");
  for (const prefix of equivalentPathPrefixes(runtimeDir)) redacted = replacePathPrefix(redacted, prefix, "<runtime>");
  if (home) redacted = replacePathPrefix(redacted, resolve(home), "<home>");
  for (const candidate of collectToolPathCandidates(error, toolArgs, workspaceInput)) {
    const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(workspaceInput, candidate);
    const replacement = displayPath(absolute);
    for (const prefix of equivalentPathPrefixes(candidate, absolute)) redacted = replacePathPrefix(redacted, prefix, replacement);
  }
  return redacted;
}

/** @param {unknown} error @param {unknown} toolArgs @param {string} workspace */
function collectToolPathCandidates(error, toolArgs, workspace) {
  /** @type {Set<string>} */
  const candidates = new Set();
  const pathError = error && typeof error === "object"
    ? /** @type {{ path?: unknown, dest?: unknown }} */ (error)
    : {};
  for (const value of [pathError.path, pathError.dest]) {
    if (typeof value === "string" && value) candidates.add(value);
  }
  /** @param {unknown} value @param {string} [key] @param {number} [depth] */
  const visit = (value, key = "", depth = 0) => {
    if (depth > 5 || value === null || value === undefined) return;
    if (typeof value === "string") {
      if (/(?:^|[_-])(?:path|cwd|workspace|root|directory|dir)(?:$|[_-])/i.test(key) && value && !value.includes("\0")) candidates.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 64)) visit(item, key, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    for (const [childKey, child] of Object.entries(/** @type {Record<string, unknown>} */ (value)).slice(0, 128)) {
      visit(child, childKey, depth + 1);
    }
  };
  visit(toolArgs);
  candidates.delete(workspace);
  return [...candidates].sort((left, right) => right.length - left.length);
}

/** @param {...(string | null | undefined)} values */
function equivalentPathPrefixes(...values) {
  const prefixes = new Set(values.filter(Boolean).map((value) => String(value)));
  for (const value of [...prefixes]) {
    if (value.startsWith("/private/")) prefixes.add(value.slice("/private".length));
    else if (value.startsWith("/") && ["/var/", "/tmp/", "/etc/"].some((prefix) => value.startsWith(prefix))) prefixes.add(`/private${value}`);
  }
  return [...prefixes].sort((left, right) => right.length - left.length);
}

/** @param {string} message @param {string} pathValue @param {string} replacement */
function replacePathPrefix(message, pathValue, replacement) {
  if (!pathValue) return message;
  return message.split(pathValue).join(replacement);
}
