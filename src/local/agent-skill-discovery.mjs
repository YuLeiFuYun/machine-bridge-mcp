// @ts-check
import { lstat, opendir, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { assertAllowedPath, MAX_SKILL_ROOTS } from "./agent-contract.mjs";
import { sha256 } from "./agent-context-projection.mjs";
import { readRegularUtf8 } from "./agent-text-file.mjs";
import { classifyOperationalError } from "./log.mjs";

export const MAX_SKILL_ENTRY_BYTES = 512 * 1024;
export const MAX_SKILL_RESULTS = 500;
export const MAX_SKILL_FILES = 500;
const MAX_SKILL_SCAN_ENTRIES = 20_000;
const MAX_SKILL_SCAN_DEPTH = 8;

/**
 * @typedef {object} SkillSummary
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {string} entrypoint
 * @property {string} directory
 * @property {string} sourceRoot
 * @property {number} bytes
 * @property {string} sha256
 */
/**
 * @typedef {object} SkillDiscoveryOptions
 * @property {string[]} skillRoots
 * @property {string} query
 * @property {number} maxResults
 * @property {string} workspace
 * @property {boolean} unrestricted
 * @property {(value: string) => string} displayPath
 * @property {unknown} context
 * @property {(context: unknown) => void} throwIfCancelled
 */

/** @param {SkillDiscoveryOptions} options */
export async function discoverLocalSkills(options) {
  const query = String(options.query || "").trim().toLowerCase();
  /** @type {SkillSummary[]} */
  const skills = [];
  /** @type {Array<{entrypoint: string, message: string}>} */
  const warnings = [];
  const seenEntrypoints = new Set();
  const seenDirectories = new Set();
  let visitedEntries = 0;
  let truncated = false;

  for (const configuredRoot of options.skillRoots.slice(0, MAX_SKILL_ROOTS)) {
    options.throwIfCancelled(options.context);
    const rootInfo = await lstat(configuredRoot).catch((error) => isMissing(error) ? null : Promise.reject(error));
    if (!rootInfo) continue;
    const root = await realpath(configuredRoot);
    const canonicalRootInfo = await stat(root);
    if (!canonicalRootInfo.isDirectory()) throw new Error(`skill root is not a directory: ${options.displayPath(configuredRoot)}`);
    assertAllowedPath(root, options.workspace, options.unrestricted, "skill root");
    const stack = [{ directory: root, depth: 0 }];
    while (stack.length) {
      options.throwIfCancelled(options.context);
      const current = stack.pop();
      if (!current || seenDirectories.has(current.directory)) continue;
      seenDirectories.add(current.directory);
      visitedEntries += 1;
      if (visitedEntries > MAX_SKILL_SCAN_ENTRIES) {
        truncated = true;
        break;
      }
      const entrypoint = await findSkillEntrypoint(current.directory);
      if (entrypoint) {
        const canonical = await realpath(entrypoint);
        if (!seenEntrypoints.has(canonical)) {
          seenEntrypoints.add(canonical);
          try {
            const summary = await summarizeSkill(canonical, root);
            const haystack = `${summary.id}\n${summary.name}\n${summary.description}\n${summary.entrypoint}`.toLowerCase();
            if (!query || haystack.includes(query)) {
              skills.push(summary);
              if (skills.length >= options.maxResults) {
                truncated = true;
                break;
              }
            }
          } catch (error) {
            if (warnings.length < 100) warnings.push({ entrypoint: canonical, message: boundedMessage(error) });
          }
        }
        continue;
      }
      if (current.depth >= MAX_SKILL_SCAN_DEPTH) continue;
      const handle = await opendir(current.directory);
      for await (const entry of handle) {
        options.throwIfCancelled(options.context);
        visitedEntries += 1;
        if (visitedEntries > MAX_SKILL_SCAN_ENTRIES) {
          truncated = true;
          break;
        }
        const child = join(current.directory, entry.name);
        if (entry.isDirectory()) {
          stack.push({ directory: child, depth: current.depth + 1 });
        } else if (entry.isSymbolicLink()) {
          let target;
          try { target = await realpath(child); } catch (error) {
            if (warnings.length < 100) warnings.push({ entrypoint: child, message: boundedMessage(error) });
            continue;
          }
          let targetInfo;
          try { targetInfo = await stat(target); } catch (error) {
            if (warnings.length < 100) warnings.push({ entrypoint: child, message: boundedMessage(error) });
            continue;
          }
          if (!targetInfo.isDirectory()) continue;
          assertAllowedPath(target, options.workspace, options.unrestricted, "skill symlink target");
          stack.push({ directory: target, depth: current.depth + 1 });
        }
      }
      if (truncated) break;
    }
    if (truncated && skills.length >= options.maxResults) break;
    if (visitedEntries > MAX_SKILL_SCAN_ENTRIES) break;
  }

  skills.sort((left, right) => left.name.localeCompare(right.name) || left.entrypoint.localeCompare(right.entrypoint));
  return { skills, warnings, truncated };
}

/** @param {string} root @param {number} maxFiles @param {unknown} context @param {(context: unknown) => void} throwIfCancelled */
export async function listSkillFiles(root, maxFiles, context, throwIfCancelled) {
  /** @type {Array<{path: string, bytes: number, type: "file" | "symlink"}>} */
  const files = [];
  const stack = [{ directory: root, depth: 0 }];
  let visited = 0;
  let truncated = false;
  while (stack.length) {
    throwIfCancelled(context);
    const current = stack.pop();
    if (!current) continue;
    const handle = await opendir(current.directory);
    for await (const entry of handle) {
      throwIfCancelled(context);
      visited += 1;
      if (visited > MAX_SKILL_SCAN_ENTRIES) {
        truncated = true;
        break;
      }
      const full = join(current.directory, entry.name);
      const rel = relative(root, full).split(sep).join("/");
      if (entry.isDirectory()) {
        if (current.depth < MAX_SKILL_SCAN_DEPTH) stack.push({ directory: full, depth: current.depth + 1 });
        else truncated = true;
      } else if (entry.isFile()) {
        const info = await lstat(full);
        files.push({ path: rel, bytes: info.size, type: "file" });
      } else if (entry.isSymbolicLink()) {
        files.push({ path: rel, bytes: 0, type: "symlink" });
      }
      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }
    }
    if (truncated && (files.length >= maxFiles || visited > MAX_SKILL_SCAN_ENTRIES)) break;
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { files, truncated };
}

/** @param {unknown} content @returns {{name?: string, description?: string}} */
export function parseSkillMetadata(content) {
  const text = String(content || "");
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return {};
  const lines = text.split(/\r?\n/);
  let end = -1;
  for (let index = 1; index < Math.min(lines.length, 200); index += 1) {
    if (lines[index].trim() === "---") {
      end = index;
      break;
    }
  }
  if (end === -1) return {};
  /** @type {{name?: string, description?: string}} */
  const metadata = {};
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase();
    if (key === "name" || key === "description") metadata[key] = unquoteScalar(match[2].trim());
  }
  return metadata;
}

/** @param {string} directory */
async function findSkillEntrypoint(directory) {
  for (const name of ["SKILL.md", "skill.md"]) {
    const candidate = join(directory, name);
    const info = await lstat(candidate).catch((error) => isMissing(error) ? null : Promise.reject(error));
    if (!info) continue;
    if (info.isSymbolicLink()) throw new Error(`skill entrypoint must not be a symbolic link: ${candidate}`);
    if (!info.isFile()) throw new Error(`skill entrypoint is not a regular file: ${candidate}`);
    return candidate;
  }
  return "";
}

/** @param {string} entrypoint @param {string} sourceRoot @returns {Promise<SkillSummary>} */
async function summarizeSkill(entrypoint, sourceRoot) {
  const content = await readRegularUtf8(entrypoint, MAX_SKILL_ENTRY_BYTES, "skill entrypoint");
  const metadata = parseSkillMetadata(content.text);
  if (!metadata.name || !metadata.description) throw new Error("SKILL.md front matter requires non-empty name and description fields");
  return {
    id: `skill_${sha256(entrypoint).slice(0, 16)}`,
    name: metadata.name.slice(0, 200),
    description: metadata.description.slice(0, 1000),
    entrypoint,
    directory: dirname(entrypoint),
    sourceRoot,
    bytes: content.bytes,
    sha256: sha256(content.text),
  };
}

/** @param {unknown} error */
function boundedMessage(error) {
  if (error !== null && typeof error === "object" && "code" in error && error.code) {
    return `local skill access failed (${classifyOperationalError(error)})`;
  }
  const message = error instanceof Error ? error.message : String(error || "invalid local skill");
  return message.replace(/[\r\n\u0000-\u001f\u007f]+/g, " ").slice(0, 1000);
}

/** @param {string} value */
function unquoteScalar(value) {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) return value.slice(1, -1);
  return value;
}

/** @param {unknown} error */
function isMissing(error) {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
