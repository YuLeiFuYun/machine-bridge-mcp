// @ts-check
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { clampInteger } from "../../shared/numbers.mjs";
import { isPlainRecord } from "../../shared/records.mjs";
import { createHash } from "node:crypto";
import { BridgeError } from "../core/errors.mjs";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";

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

const COMMAND_KEYS = new Set([
  "description", "argv", "cwd", "timeout_seconds", "allow_extra_args",
  "execution_mode", "managed_job_timeout_seconds",
]);

/**
 * @typedef {{
 *   description: string,
 *   argv: string[],
 *   cwd: string,
 *   timeoutSeconds: number,
 *   allowExtraArgs: boolean,
 *   executionMode: "foreground" | "managed_job",
 *   managedJobTimeoutSeconds: number | null,
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
  const executionMode = value.execution_mode === undefined ? "foreground" : requiredString(value.execution_mode, `commands.${name}.execution_mode`);
  if (executionMode !== "foreground" && executionMode !== "managed_job") {
    throw new Error(`registered command '${name}' execution_mode must be foreground or managed_job: ${configPath}`);
  }
  if (value.managed_job_timeout_seconds !== undefined && executionMode !== "managed_job") {
    throw new Error(`registered command '${name}' managed_job_timeout_seconds requires execution_mode=managed_job: ${configPath}`);
  }
  const managedJobTimeoutSeconds = executionMode === "managed_job"
    ? clampInteger(value.managed_job_timeout_seconds, 600, 1, 21_600)
    : null;
  if (value.managed_job_timeout_seconds !== undefined && managedJobTimeoutSeconds !== value.managed_job_timeout_seconds) {
    throw new Error(`registered command '${name}' managed_job_timeout_seconds must be an integer from 1 to 21600: ${configPath}`);
  }
  return {
    description,
    argv,
    cwd,
    timeoutSeconds,
    allowExtraArgs: value.allow_extra_args === true,
    executionMode,
    managedJobTimeoutSeconds,
  };
}

/** @param {unknown} value @param {string} configPath */
function validateInstructionFiles(value, configPath) {
  const files = validateStringArray(value, "instruction_files", 32, 64 * 1024);
  if (!files.length) throw new Error(`instruction_files must not be empty: ${configPath}`);
  for (const name of files) resolveInstructionPath("/", name);
  return files;
}
/** @typedef {(value: string) => string} DisplayPath */
/**
 * @typedef {object} InstructionItem
 * @property {string} [source]
 * @property {string} [path]
 * @property {string} scope
 * @property {number} bytes
 * @property {string} sha256
 * @property {number} precedence
 * @property {string} content
 */
/**
 * @typedef {object} SkillSummary
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {string} entrypoint
 * @property {string} sourceRoot
 * @property {number} bytes
 * @property {string} sha256
 */
/**
 * @typedef {object} CommandSummary
 * @property {string} name
 * @property {string} description
 * @property {string[]} argv
 * @property {string} cwd
 * @property {number} timeoutSeconds
 * @property {boolean} allowExtraArgs
 * @property {"foreground" | "managed_job"} [executionMode]
 * @property {number | null} [managedJobTimeoutSeconds]
 * @property {string} source
 * @property {string} [sourceType]
 * @property {string} [script]
 */
/**
 * @typedef {object} ProjectionState
 * @property {string} target
 * @property {string} targetDir
 * @property {string} scopeRoot
 * @property {string[]} configFiles
 * @property {InstructionItem | null} builtinInstructions
 * @property {InstructionItem | null} automaticProjectContext
 * @property {InstructionItem | null} modelInstructions
 * @property {InstructionItem[]} instructions
 * @property {Map<string, CommandSummary>} commands
 */

/** @param {ProjectionState} state @param {SkillSummary[]} skills */
export function capabilityFingerprint(state, skills) {
  return sha256(JSON.stringify({
    target: state.target,
    target_dir: state.targetDir,
    scope_root: state.scopeRoot,
    configs: [...state.configFiles],
    instructions: [
      instructionFingerprintItem(state.builtinInstructions),
      instructionFingerprintItem(state.automaticProjectContext),
      instructionFingerprintItem(state.modelInstructions),
      ...state.instructions.map(instructionFingerprintItem),
    ],
    skills: skills
      .map((skill) => [skill.id, skill.name, skill.entrypoint, skill.sourceRoot, skill.sha256])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
    commands: [...state.commands.values()]
      .map((command) => [
        command.name, command.description, command.argv, command.cwd, command.timeoutSeconds,
        command.allowExtraArgs, command.executionMode || "foreground", command.managedJobTimeoutSeconds || 0,
        command.source, command.sourceType || "", command.script || "",
      ])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
  }));
}

/** @param {InstructionItem | null | undefined} item */
function instructionFingerprintItem(item) {
  if (!item) return null;
  return [item.source || "", item.path || "", item.scope, item.sha256, item.precedence, item.bytes];
}

/** @param {SkillSummary} skill @param {DisplayPath} displayPath */
export function publicSkill(skill, displayPath) {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    entrypoint: displayPath(skill.entrypoint),
    source_root: displayPath(skill.sourceRoot),
    bytes: skill.bytes,
    sha256: skill.sha256,
  };
}

/** @param {SkillSummary[]} skills @param {DisplayPath} displayPath @param {number} maxSkills @param {number} budgetChars */
export function contextSkillSummaries(skills, displayPath, maxSkills, budgetChars) {
  /** @type {Array<ReturnType<typeof publicSkill> & {description_truncated?: boolean}>} */
  const selected = [];
  let used = 0;
  for (const skill of skills) {
    if (selected.length >= maxSkills) return { skills: selected, truncated: true };
    const item = publicSkill(skill, displayPath);
    const fullSize = JSON.stringify(item).length;
    if (used + fullSize <= budgetChars) {
      selected.push(item);
      used += fullSize;
      continue;
    }
    const withoutDescription = { ...item, description: "", description_truncated: true };
    const baseSize = JSON.stringify(withoutDescription).length;
    const available = budgetChars - used - baseSize;
    if (available >= 32) selected.push({ ...withoutDescription, description: item.description.slice(0, available) });
    return { skills: selected, truncated: true };
  }
  return { skills: selected, truncated: false };
}

/** @param {Array<{entrypoint: string, message: string}>} warnings @param {DisplayPath} displayPath */
export function publicSkillWarnings(warnings, displayPath) {
  return warnings.map((warning) => {
    const entrypoint = displayPath(warning.entrypoint);
    return { entrypoint, message: warning.message.replaceAll(warning.entrypoint, () => entrypoint) };
  });
}

/** @param {Map<string, CommandSummary>} commands @param {DisplayPath} displayPath */
export function publicCommands(commands, displayPath) {
  return [...commands.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((command) => ({
      name: command.name,
      description: command.description,
      argv: [...command.argv],
      cwd: displayPath(command.cwd),
      timeout_seconds: command.timeoutSeconds,
      allow_extra_args: command.allowExtraArgs,
      execution_mode: command.executionMode || "foreground",
      ...((command.executionMode || "foreground") === "managed_job"
        ? { managed_job_timeout_seconds: command.managedJobTimeoutSeconds || 600 }
        : {}),
      source: displayPath(command.source),
      source_type: command.sourceType || "agent-config",
      ...(command.script ? { package_script: command.script } : {}),
    }));
}

/** @param {ProjectionState} state */
export function effectiveInstructionItems(state) {
  return [
    ...(state.builtinInstructions ? [state.builtinInstructions] : []),
    ...(state.automaticProjectContext ? [state.automaticProjectContext] : []),
    ...(state.modelInstructions ? [state.modelInstructions] : []),
    ...state.instructions,
  ];
}

/** @param {InstructionItem | null} item @param {boolean} includeContent */
export function publicVirtualInstruction(item, includeContent) {
  if (!item) return null;
  return {
    source: item.source,
    scope: item.scope,
    bytes: item.bytes,
    sha256: item.sha256,
    precedence: item.precedence,
    ...(includeContent ? { content: item.content } : {}),
  };
}

/** @param {InstructionItem[]} instructions @param {DisplayPath} displayPath */
export function renderEffectiveInstructions(instructions, displayPath) {
  return instructions.map((item) => {
    const source = item.source || displayPath(item.path || "");
    return [
      `--- BEGIN ${source} (precedence ${item.precedence}) ---`,
      item.content,
      `--- END ${source} ---`,
    ].join("\n");
  }).join("\n\n");
}

/** @param {unknown} value */
export function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}
/** @param {string} filePath @param {number} maxBytes @param {string} label @param {(canonical: string) => void | Promise<void>} [assertCanonicalPath] */
export async function readOptionalRegularUtf8(filePath, maxBytes, label, assertCanonicalPath = () => {}) {
  const info = await lstat(filePath, { bigint: true }).catch((error) => isMissing(error) ? null : Promise.reject(error));
  if (!info) return null;
  if (info.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${filePath}`);
  if (!info.isFile()) throw new Error(`${label} is not a regular file: ${filePath}`);
  const canonical = await realpath(filePath);
  await assertCanonicalPath(canonical);
  return readRegularUtf8(canonical, maxBytes, label, { expectedInfo: info, canonicalPath: canonical });
}

/** @param {string} filePath @param {number} maxBytes @param {string} label @param {{expectedInfo?: import("node:fs").BigIntStats, canonicalPath?: string}} [options] */
export async function readRegularUtf8(filePath, maxBytes, label, options = {}) {
  const expected = options.expectedInfo || await lstat(filePath, { bigint: true });
  if (!expected.isFile() || expected.isSymbolicLink()) throw new Error(`${label} is not a regular file: ${filePath}`);
  if (expected.nlink > 1n) throw new Error(`${label} must not have multiple hard links: ${filePath}`);
  const canonical = await realpath(filePath);
  if (options.canonicalPath !== undefined && canonical !== options.canonicalPath) throw new Error(`${label} changed during read`);
  const assertCurrent = async () => {
    const current = await lstat(filePath, { bigint: true });
    if (!sameRegularFile(current, expected) || await realpath(filePath) !== canonical) {
      throw new Error(`${label} changed during read`);
    }
  };
  await assertCurrent();
  const handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0) | (fsConstants.O_NONBLOCK || 0));
  try {
    const info = await handle.stat({ bigint: true });
    if (!sameRegularFile(info, expected)) throw new Error(`${label} changed during read`);
    if (info.nlink > 1n) throw new Error(`${label} must not have multiple hard links: ${filePath}`);
    await assertCurrent();
    if (info.size > BigInt(maxBytes)) throw new BridgeError("limit_exceeded", `${label} exceeds maximum size (${info.size} > ${maxBytes})`);
    const buffer = Buffer.alloc(Number(info.size));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== buffer.length || !sameRegularFile(await handle.stat({ bigint: true }), expected)) {
      throw new Error(`${label} changed during read`);
    }
    await assertCurrent();
    try {
      return { text: new TextDecoder("utf-8", { fatal: true }).decode(buffer), bytes: offset };
    } catch {
      throw new Error(`${label} is not valid UTF-8 text: ${filePath}`);
    }
  } finally {
    await handle.close();
  }
}

/** @param {import("node:fs").BigIntStats} current @param {import("node:fs").BigIntStats} expected */
function sameRegularFile(current, expected) {
  return current.isFile() && !current.isSymbolicLink() && expected.isFile() && !expected.isSymbolicLink()
    && current.dev === expected.dev && current.ino === expected.ino && current.size === expected.size
    && current.mtimeNs === expected.mtimeNs && current.ctimeNs === expected.ctimeNs;
}

/** @param {unknown} error */
function isMissing(error) {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
