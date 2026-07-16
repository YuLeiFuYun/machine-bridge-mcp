// @ts-check

import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { clampInteger } from "./numbers.mjs";
import { isPlainRecord } from "./records.mjs";

export const MAX_TOTAL_INSTRUCTION_BYTES = 2 * 1024 * 1024;
export const MAX_SKILL_ROOTS = 32;
export const MAX_COMMANDS = 128;
export const MAX_COMMAND_ARGV = 128;
export const MAX_COMMAND_ARGUMENT_BYTES = 256 * 1024;

const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const CONFIG_KEYS = new Set([
  "version", "builtin_instructions", "automatic_project_context", "model_instructions_file",
  "instruction_files", "instruction_max_bytes", "skill_roots", "commands",
]);
const COMMAND_KEYS = new Set(["description", "argv", "cwd", "timeout_seconds", "allow_extra_args"]);

/**
 * @typedef {{
 *   description: string,
 *   argv: string[],
 *   cwd: string,
 *   timeoutSeconds: number,
 *   allowExtraArgs: boolean,
 * }} NormalizedCommand
 */

/**
 * @typedef {{
 *   builtinInstructions: boolean | null,
 *   automaticProjectContext: boolean | null,
 *   modelInstructionsFile: string | null,
 *   instructionFiles: string[] | null,
 *   instructionMaxBytes: number | null,
 *   skillRoots: string[] | null,
 *   commands: Map<string, NormalizedCommand | null>,
 * }} NormalizedAgentConfig
 */

/**
 * @param {unknown} value
 * @param {string} configPath
 * @returns {NormalizedAgentConfig}
 */
export function normalizeAgentConfig(value, configPath) {
  if (!isPlainRecord(value)) throw new Error(`agent config must be a JSON object: ${configPath}`);
  for (const key of Object.keys(value)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`unknown agent config field '${key}': ${configPath}`);
  }
  if (value.version !== 1) throw new Error(`agent config version must be 1: ${configPath}`);
  /** @type {NormalizedAgentConfig} */
  const result = {
    builtinInstructions: null,
    automaticProjectContext: null,
    modelInstructionsFile: null,
    instructionFiles: null,
    instructionMaxBytes: null,
    skillRoots: null,
    commands: new Map(),
  };
  if (value.builtin_instructions !== undefined) {
    if (typeof value.builtin_instructions !== "boolean") throw new Error(`builtin_instructions must be boolean: ${configPath}`);
    result.builtinInstructions = value.builtin_instructions;
  }
  if (value.automatic_project_context !== undefined) {
    if (typeof value.automatic_project_context !== "boolean") throw new Error(`automatic_project_context must be boolean: ${configPath}`);
    result.automaticProjectContext = value.automatic_project_context;
  }
  if (value.model_instructions_file !== undefined) {
    result.modelInstructionsFile = requiredString(value.model_instructions_file, "model_instructions_file");
  }
  if (value.instruction_files !== undefined) {
    result.instructionFiles = validateInstructionFiles(value.instruction_files, configPath);
  }
  if (value.instruction_max_bytes !== undefined) {
    const maximum = value.instruction_max_bytes;
    if (typeof maximum !== "number" || !Number.isInteger(maximum)
        || maximum < 1024 || maximum > MAX_TOTAL_INSTRUCTION_BYTES) {
      throw new Error(`instruction_max_bytes must be an integer from 1024 to ${MAX_TOTAL_INSTRUCTION_BYTES}: ${configPath}`);
    }
    result.instructionMaxBytes = maximum;
  }
  if (value.skill_roots !== undefined) {
    result.skillRoots = validateStringArray(value.skill_roots, "skill_roots", MAX_SKILL_ROOTS, MAX_COMMAND_ARGUMENT_BYTES);
  }
  if (value.commands !== undefined) {
    if (!isPlainRecord(value.commands)) throw new Error(`agent config commands must be an object: ${configPath}`);
    for (const [name, definition] of Object.entries(value.commands)) {
      if (!COMMAND_NAME_PATTERN.test(name)) throw new Error(`invalid registered command name '${name}': ${configPath}`);
      result.commands.set(name, definition === null ? null : normalizeCommand(definition, name, configPath));
    }
  }
  return result;
}

/** @param {string} directory @param {unknown} configuredName */
export function resolveInstructionPath(directory, configuredName) {
  const raw = requiredString(configuredName, "instruction file name");
  if (raw.includes("\0") || isAbsolute(raw)) throw new Error(`instruction file path must be relative: ${raw}`);
  const candidate = resolve(directory, raw);
  assertContainedPath(resolve(directory), candidate, "instruction file path");
  return candidate;
}

/**
 * @param {unknown} configuredPath
 * @param {string} baseDir
 * @param {string} home
 * @param {string} workspace
 * @param {boolean} unrestricted
 */
export function resolveConfiguredPath(configuredPath, baseDir, home, workspace, unrestricted) {
  const raw = requiredString(configuredPath, "configured path");
  if (raw.includes("\0")) throw new Error("configured path contains a NUL byte");
  let expanded = raw;
  if (raw === "~" || raw.startsWith(`~${sep}`) || raw.startsWith("~/") || raw.startsWith("~\\")) {
    if (!home) throw new Error("HOME or USERPROFILE is required to expand '~'");
    expanded = raw === "~" ? home : join(home, raw.slice(2));
  }
  const candidate = isAbsolute(expanded) ? resolve(expanded) : resolve(baseDir, expanded);
  assertAllowedPath(candidate, workspace, unrestricted, "configured path");
  return candidate;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {number} maxItems
 * @param {number} maxBytes
 * @returns {string[]}
 */
export function validateStringArray(value, label, maxItems, maxBytes) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array of strings`);
  if (value.length > maxItems) throw new Error(`${label} contains more than ${maxItems} items`);
  let bytes = 0;
  return value.map((item, index) => {
    if (typeof item !== "string" || !item.length || item.includes("\0")) {
      throw new Error(`${label}[${index}] must be a non-empty string without NUL bytes`);
    }
    bytes += Buffer.byteLength(item);
    if (bytes > maxBytes) throw new Error(`${label} exceeds maximum encoded size (${maxBytes} bytes)`);
    return item;
  });
}

/** @param {string} candidate @param {string} workspace @param {boolean} unrestricted @param {string} label */
export function assertAllowedPath(candidate, workspace, unrestricted, label) {
  if (!unrestricted) assertContainedPath(workspace, candidate, label);
}

/** @param {string} root @param {string} target @param {string} label */
export function assertContainedPath(root, target, label) {
  if (isContainedPath(root, target)) return;
  throw new Error(`${label} is outside the configured workspace`);
}

/** @param {string} root @param {string} target */
export function isContainedPath(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** @param {unknown} value @param {string} label */
export function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

/** @param {unknown} value @param {string} name @param {string} configPath @returns {NormalizedCommand} */
function normalizeCommand(value, name, configPath) {
  if (!isPlainRecord(value)) throw new Error(`registered command '${name}' must be an object: ${configPath}`);
  for (const key of Object.keys(value)) {
    if (!COMMAND_KEYS.has(key)) throw new Error(`unknown field '${key}' for registered command '${name}': ${configPath}`);
  }
  const argv = validateStringArray(value.argv, `commands.${name}.argv`, MAX_COMMAND_ARGV, MAX_COMMAND_ARGUMENT_BYTES);
  if (!argv.length) throw new Error(`registered command '${name}' requires a non-empty argv: ${configPath}`);
  const description = typeof value.description === "string" ? value.description.trim() : "";
  if (!description || description.length > 1000) {
    throw new Error(`registered command '${name}' requires a description of at most 1000 characters: ${configPath}`);
  }
  const cwd = value.cwd === undefined ? "." : requiredString(value.cwd, `commands.${name}.cwd`);
  const timeoutSeconds = clampInteger(value.timeout_seconds, 120, 1, 600);
  if (value.timeout_seconds !== undefined && timeoutSeconds !== value.timeout_seconds) {
    throw new Error(`registered command '${name}' timeout_seconds must be an integer from 1 to 600: ${configPath}`);
  }
  if (value.allow_extra_args !== undefined && typeof value.allow_extra_args !== "boolean") {
    throw new Error(`registered command '${name}' allow_extra_args must be boolean: ${configPath}`);
  }
  return {
    description,
    argv,
    cwd,
    timeoutSeconds,
    allowExtraArgs: value.allow_extra_args === true,
  };
}

/** @param {unknown} value @param {string} configPath */
function validateInstructionFiles(value, configPath) {
  const files = validateStringArray(value, "instruction_files", 32, 64 * 1024);
  if (!files.length) throw new Error(`instruction_files must not be empty: ${configPath}`);
  for (const name of files) resolveInstructionPath("/", name);
  return files;
}
