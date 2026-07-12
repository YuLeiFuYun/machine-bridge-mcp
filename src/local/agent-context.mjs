import { createHash } from "node:crypto";
import { lstat, open, opendir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const CONFIG_RELATIVE_PATH = join(".machine-bridge", "agent.json");
const GLOBAL_CONFIG_RELATIVE_PATH = join(".config", "machine-bridge-mcp", "agent.json");
const DEFAULT_INSTRUCTION_FILES = Object.freeze(["AGENTS.override.md", "AGENTS.md"]);
const DEFAULT_INSTRUCTION_MAX_BYTES = 32 * 1024;
const MAX_CONTEXT_SKILL_SUMMARY_CHARS = 8_000;
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_INSTRUCTION_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_INSTRUCTION_BYTES = 2 * 1024 * 1024;
const MAX_INSTRUCTION_FILES = 64;
const MAX_SKILL_ENTRY_BYTES = 512 * 1024;
const MAX_SKILL_ROOTS = 32;
const MAX_SKILL_RESULTS = 500;
const MAX_SKILL_SCAN_ENTRIES = 20_000;
const MAX_SKILL_SCAN_DEPTH = 8;
const MAX_SKILL_FILES = 500;
const MAX_COMMANDS = 128;
const MAX_COMMAND_ARGV = 128;
const MAX_COMMAND_ARGUMENT_BYTES = 256 * 1024;
const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const CONFIG_KEYS = new Set(["version", "instruction_files", "instruction_max_bytes", "skill_roots", "commands"]);
const COMMAND_KEYS = new Set(["description", "argv", "cwd", "timeout_seconds", "allow_extra_args"]);

export class AgentContextManager {
  constructor({ workspace, policy, displayPath, resolveExistingPath, throwIfCancelled = () => {}, home = process.env.HOME || process.env.USERPROFILE || "", codexHome = process.env.CODEX_HOME || "" }) {
    this.workspace = resolve(workspace);
    this.policy = policy || {};
    this.displayPath = displayPath;
    this.resolveExistingPath = resolveExistingPath;
    this.throwIfCancelled = throwIfCancelled;
    this.home = home ? resolve(home) : "";
    this.codexHome = codexHome ? resolve(codexHome) : this.home ? resolve(this.home, ".codex") : "";
  }

  async agentContext(args = {}, context = {}) {
    const state = await this.discoverState(args.path || ".", context);
    const includeContent = args.include_instruction_content !== false;
    const skillLimit = clampInt(args.max_skills, 100, 1, MAX_SKILL_RESULTS);
    const discoveredSkills = await this.discoverSkills(state, { maxResults: MAX_SKILL_RESULTS }, context);
    const contextSkills = contextSkillSummaries(discoveredSkills.skills, this.displayPath, skillLimit, MAX_CONTEXT_SKILL_SUMMARY_CHARS);
    const result = {
      target: this.displayPath(state.target),
      scope_root: this.displayPath(state.scopeRoot),
      precedence: "global guidance first, then scope root to target directory; each directory contributes the first non-empty instruction_files candidate; later directories have higher precedence",
      config_files: state.configFiles.map((file) => this.displayPath(file)),
      instruction_files: state.instructions.map((item) => ({
        scope: item.scope,
        path: this.displayPath(item.path),
        bytes: item.bytes,
        sha256: item.sha256,
        precedence: item.precedence,
        ...(includeContent ? { content: item.content } : {}),
      })),
      skills: contextSkills.skills,
      skills_truncated: discoveredSkills.truncated || contextSkills.truncated,
      skill_warnings: publicSkillWarnings(discoveredSkills.warnings, this.displayPath),
      instructions_truncated: state.instructionsTruncated,
      commands: publicCommands(state.commands, this.displayPath),
      guidance: [
        "Treat instruction_files as authoritative workspace guidance in the returned precedence order.",
        "Load a relevant skill with load_local_skill before following its workflow; SKILL.md is an instruction bundle, not executable code by itself.",
        "Prefer run_local_command for registered repeatable commands. Use run_process or exec_command only when no registered command fits and policy permits it.",
      ],
    };
    if (includeContent) result.effective_instructions = renderEffectiveInstructions(state.instructions, this.displayPath);
    return result;
  }

  async listLocalSkills(args = {}, context = {}) {
    const state = await this.discoverState(args.path || ".", context);
    const result = await this.discoverSkills(state, {
      query: typeof args.query === "string" ? args.query : "",
      maxResults: clampInt(args.max_results, 100, 1, MAX_SKILL_RESULTS),
    }, context);
    return {
      target: this.displayPath(state.target),
      scope_root: this.displayPath(state.scopeRoot),
      skill_roots: state.skillRoots.map((root) => this.displayPath(root)),
      skills: result.skills.map((skill) => publicSkill(skill, this.displayPath)),
      warnings: publicSkillWarnings(result.warnings, this.displayPath),
      truncated: result.truncated,
    };
  }

  async loadLocalSkill(args = {}, context = {}) {
    const requested = requiredString(args.skill, "skill");
    const state = await this.discoverState(args.path || ".", context);
    const result = await this.discoverSkills(state, { maxResults: MAX_SKILL_RESULTS }, context);
    const matches = result.skills.filter((skill) => skill.id === requested || skill.name === requested || this.displayPath(skill.entrypoint) === requested);
    if (!matches.length) throw new Error(`local skill not found: ${requested}`);
    if (matches.length > 1) throw new Error(`local skill name is ambiguous; use its id: ${requested}`);
    const skill = matches[0];
    const content = await readRegularUtf8(skill.entrypoint, MAX_SKILL_ENTRY_BYTES, "skill entrypoint");
    const inventory = await listSkillFiles(skill.directory, clampInt(args.max_files, 200, 1, MAX_SKILL_FILES), context, this.throwIfCancelled);
    return {
      skill: publicSkill(skill, this.displayPath),
      instructions: content.text,
      files: inventory.files,
      files_truncated: inventory.truncated,
      execution_semantics: "Loading a skill returns its instructions and file inventory. It does not execute scripts or commands implicitly.",
    };
  }

  async listLocalCommands(args = {}, context = {}) {
    const state = await this.discoverState(args.path || ".", context);
    return {
      target: this.displayPath(state.target),
      scope_root: this.displayPath(state.scopeRoot),
      commands: publicCommands(state.commands, this.displayPath),
    };
  }

  async resolveLocalCommand(args = {}, context = {}) {
    const name = requiredString(args.name, "name");
    const state = await this.discoverState(args.path || ".", context);
    const command = state.commands.get(name);
    if (!command) throw new Error(`registered local command not found: ${name}`);
    const extraArgs = args.args === undefined ? [] : validateStringArray(args.args, "args", 64, MAX_COMMAND_ARGUMENT_BYTES);
    if (extraArgs.length && !command.allowExtraArgs) throw new Error(`registered local command does not accept extra args: ${name}`);
    return {
      name,
      description: command.description,
      argv: [...command.argv, ...extraArgs],
      cwd: command.cwd,
      timeoutSeconds: command.timeoutSeconds,
      source: command.source,
    };
  }

  async discoverState(inputPath, context = {}) {
    this.throwIfCancelled(context);
    this.workspace = await realpath(this.workspace);
    const target = await realpath(await this.resolveExistingPath(inputPath));
    const targetInfo = await stat(target);
    const targetDir = targetInfo.isDirectory() ? target : dirname(target);
    const scopeRoot = await findScopeRoot({
      targetDir,
      workspace: this.workspace,
      unrestricted: this.policy.unrestrictedPaths === true,
    });
    const directories = directoriesBetween(scopeRoot, targetDir);
    const state = {
      target,
      targetDir,
      scopeRoot,
      instructionFiles: [...DEFAULT_INSTRUCTION_FILES],
      instructionMaxBytes: DEFAULT_INSTRUCTION_MAX_BYTES,
      skillRoots: defaultSkillRoots(directories, this.home, this.policy.unrestrictedPaths === true),
      commands: new Map(),
      configFiles: [],
      instructions: [],
      instructionBytes: 0,
      instructionsTruncated: false,
    };

    if (this.policy.unrestrictedPaths === true && this.home) {
      const globalConfig = join(this.home, GLOBAL_CONFIG_RELATIVE_PATH);
      const config = await readOptionalConfig(globalConfig, this.home, false);
      if (config) this.applyConfig(state, config, globalConfig, this.home);
      if (this.codexHome) await this.collectDirectoryInstruction(state, this.codexHome, context, "global");
    }

    for (const directory of directories) {
      this.throwIfCancelled(context);
      const configPath = join(directory, CONFIG_RELATIVE_PATH);
      const config = await readOptionalConfig(configPath, directory, true);
      if (config) this.applyConfig(state, config, configPath, directory);
      await this.collectDirectoryInstruction(state, directory, context, "project");
    }
    return state;
  }

  applyConfig(state, config, configPath, baseDir) {
    state.configFiles.push(configPath);
    if (config.instructionFiles) state.instructionFiles = [...config.instructionFiles];
    if (config.instructionMaxBytes !== null) {
      state.instructionMaxBytes = config.instructionMaxBytes;
      if (state.instructionBytes >= state.instructionMaxBytes) state.instructionsTruncated = true;
    }
    if (config.skillRoots) {
      state.skillRoots = config.skillRoots.map((value) => resolveConfiguredPath(value, baseDir, this.home, this.workspace, this.policy.unrestrictedPaths === true));
    }
    for (const [name, definition] of config.commands) {
      if (definition === null) {
        state.commands.delete(name);
        continue;
      }
      const cwd = resolveConfiguredPath(definition.cwd, baseDir, this.home, this.workspace, this.policy.unrestrictedPaths === true);
      state.commands.set(name, {
        name,
        description: definition.description,
        argv: definition.argv,
        cwd,
        timeoutSeconds: definition.timeoutSeconds,
        allowExtraArgs: definition.allowExtraArgs,
        source: configPath,
      });
    }
    if (state.commands.size > MAX_COMMANDS) throw new Error(`agent config defines more than ${MAX_COMMANDS} commands`);
  }

  async collectDirectoryInstruction(state, directory, context, scope) {
    if (state.instructionsTruncated) return;
    const directoryInfo = await lstat(directory).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (!directoryInfo) return;
    const canonicalDirectory = await realpath(directory);
    if (!(await stat(canonicalDirectory)).isDirectory()) throw new Error(`instruction scope is not a directory: ${directory}`);
    for (const configuredName of state.instructionFiles) {
      this.throwIfCancelled(context);
      if (state.instructions.length >= MAX_INSTRUCTION_FILES) {
        state.instructionsTruncated = true;
        return;
      }
      const candidate = resolveInstructionPath(canonicalDirectory, configuredName);
      const info = await lstat(candidate).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
      if (!info) continue;
      if (info.isSymbolicLink()) throw new Error(`instruction file must not be a symbolic link: ${candidate}`);
      if (!info.isFile()) throw new Error(`instruction file is not a regular file: ${candidate}`);
      const canonical = await realpath(candidate);
      assertContainedPath(canonicalDirectory, canonical, "instruction file path");
      if (info.size > MAX_INSTRUCTION_FILE_BYTES) throw new Error(`instruction file exceeds maximum size (${info.size} > ${MAX_INSTRUCTION_FILE_BYTES})`);
      const remaining = state.instructionMaxBytes - state.instructionBytes;
      if (info.size > remaining) {
        state.instructionsTruncated = true;
        return;
      }
      const content = await readRegularUtf8(canonical, Math.max(remaining, 1), "instruction file");
      if (!content.text.trim()) continue;
      state.instructionBytes += content.bytes;
      state.instructions.push({
        scope,
        path: canonical,
        bytes: content.bytes,
        sha256: sha256(content.text),
        content: content.text,
        precedence: state.instructions.length + 1,
      });
      return;
    }
  }

  async discoverSkills(state, options = {}, context = {}) {
    const query = String(options.query || "").trim().toLowerCase();
    const maxResults = clampInt(options.maxResults, 100, 1, MAX_SKILL_RESULTS);
    const skills = [];
    const warnings = [];
    const seenEntrypoints = new Set();
    const seenDirectories = new Set();
    let visitedEntries = 0;
    let truncated = false;

    for (const configuredRoot of state.skillRoots.slice(0, MAX_SKILL_ROOTS)) {
      this.throwIfCancelled(context);
      const rootInfo = await lstat(configuredRoot).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
      if (!rootInfo) continue;
      const root = await realpath(configuredRoot);
      const canonicalRootInfo = await stat(root);
      if (!canonicalRootInfo.isDirectory()) throw new Error(`skill root is not a directory: ${this.displayPath(configuredRoot)}`);
      assertAllowedPath(root, this.workspace, this.policy.unrestrictedPaths === true, "skill root");
      const stack = [{ directory: root, depth: 0 }];
      while (stack.length) {
        this.throwIfCancelled(context);
        const current = stack.pop();
        if (seenDirectories.has(current.directory)) continue;
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
              const haystack = `${summary.id}
${summary.name}
${summary.description}
${summary.entrypoint}`.toLowerCase();
              if (!query || haystack.includes(query)) {
                skills.push(summary);
                if (skills.length >= maxResults) {
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
          this.throwIfCancelled(context);
          visitedEntries += 1;
          if (visitedEntries > MAX_SKILL_SCAN_ENTRIES) {
            truncated = true;
            break;
          }
          const child = join(current.directory, entry.name);
          if (entry.isDirectory()) {
            stack.push({ directory: child, depth: current.depth + 1 });
          } else if (entry.isSymbolicLink()) {
            const target = await realpath(child).catch(() => "");
            if (!target) continue;
            const targetInfo = await stat(target).catch(() => null);
            if (!targetInfo?.isDirectory()) continue;
            assertAllowedPath(target, this.workspace, this.policy.unrestrictedPaths === true, "skill symlink target");
            stack.push({ directory: target, depth: current.depth + 1 });
          }
        }
        if (truncated) break;
      }
      if (truncated && skills.length >= maxResults) break;
      if (visitedEntries > MAX_SKILL_SCAN_ENTRIES) break;
    }

    skills.sort((left, right) => left.name.localeCompare(right.name) || left.entrypoint.localeCompare(right.entrypoint));
    return { skills, warnings, truncated };
  }
}

async function findScopeRoot({ targetDir, workspace, unrestricted }) {
  const target = await realpath(targetDir);
  const canonicalWorkspace = await realpath(workspace);
  if (!unrestricted) assertContainedPath(canonicalWorkspace, target, "target path");
  const fallback = isContainedPath(canonicalWorkspace, target) ? canonicalWorkspace : target;
  let cursor = target;
  while (true) {
    const gitMarker = await lstat(join(cursor, ".git")).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (gitMarker) return cursor;
    if (!unrestricted && cursor === canonicalWorkspace) break;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    if (!unrestricted && !isContainedPath(canonicalWorkspace, parent)) break;
    cursor = parent;
  }
  return fallback;
}

function directoriesBetween(root, leaf) {
  assertContainedPath(root, leaf, "target directory");
  const result = [];
  let cursor = leaf;
  while (true) {
    result.push(cursor);
    if (cursor === root) break;
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error("failed to construct instruction precedence chain");
    cursor = parent;
  }
  return result.reverse();
}

function defaultSkillRoots(directories, home, unrestricted) {
  const roots = [...directories].reverse().map((directory) => resolve(directory, ".agents", "skills"));
  if (unrestricted && home) roots.push(resolve(home, ".agents", "skills"));
  if (unrestricted && process.platform !== "win32") roots.push(resolve("/etc/codex/skills"));
  return [...new Set(roots)];
}

async function readOptionalConfig(configPath, allowedRoot, rejectPathAliases) {
  const content = await readOptionalRegularUtf8(configPath, MAX_CONFIG_BYTES, "agent config");
  if (!content) return null;
  const [canonical, canonicalAllowedRoot] = await Promise.all([realpath(configPath), realpath(allowedRoot)]);
  assertContainedPath(canonicalAllowedRoot, canonical, "agent config path");
  if (rejectPathAliases && canonical !== resolve(configPath)) throw new Error("agent config path must not traverse symbolic links");
  let parsed;
  try {
    parsed = JSON.parse(content.text);
  } catch {
    throw new Error(`agent config is not valid JSON: ${configPath}`);
  }
  return normalizeConfig(parsed, configPath);
}

function normalizeConfig(value, configPath) {
  if (!isPlainRecord(value)) throw new Error(`agent config must be a JSON object: ${configPath}`);
  for (const key of Object.keys(value)) if (!CONFIG_KEYS.has(key)) throw new Error(`unknown agent config field '${key}': ${configPath}`);
  if (value.version !== 1) throw new Error(`agent config version must be 1: ${configPath}`);
  const result = { instructionFiles: null, instructionMaxBytes: null, skillRoots: null, commands: new Map() };
  if (value.instruction_files !== undefined) {
    result.instructionFiles = validateInstructionFiles(value.instruction_files, configPath);
  }
  if (value.instruction_max_bytes !== undefined) {
    if (!Number.isInteger(value.instruction_max_bytes) || value.instruction_max_bytes < 1024 || value.instruction_max_bytes > MAX_TOTAL_INSTRUCTION_BYTES) {
      throw new Error(`instruction_max_bytes must be an integer from 1024 to ${MAX_TOTAL_INSTRUCTION_BYTES}: ${configPath}`);
    }
    result.instructionMaxBytes = value.instruction_max_bytes;
  }
  if (value.skill_roots !== undefined) {
    result.skillRoots = validateStringArray(value.skill_roots, "skill_roots", MAX_SKILL_ROOTS, MAX_COMMAND_ARGUMENT_BYTES);
  }
  if (value.commands !== undefined) {
    if (!isPlainRecord(value.commands)) throw new Error(`agent config commands must be an object: ${configPath}`);
    for (const [name, definition] of Object.entries(value.commands)) {
      if (!COMMAND_NAME_PATTERN.test(name)) throw new Error(`invalid registered command name '${name}': ${configPath}`);
      if (definition === null) {
        result.commands.set(name, null);
        continue;
      }
      result.commands.set(name, normalizeCommand(definition, name, configPath));
    }
  }
  return result;
}

function normalizeCommand(value, name, configPath) {
  if (!isPlainRecord(value)) throw new Error(`registered command '${name}' must be an object: ${configPath}`);
  for (const key of Object.keys(value)) if (!COMMAND_KEYS.has(key)) throw new Error(`unknown field '${key}' for registered command '${name}': ${configPath}`);
  const argv = validateStringArray(value.argv, `commands.${name}.argv`, MAX_COMMAND_ARGV, MAX_COMMAND_ARGUMENT_BYTES);
  if (!argv.length) throw new Error(`registered command '${name}' requires a non-empty argv: ${configPath}`);
  const description = typeof value.description === "string" ? value.description.trim() : "";
  if (!description || description.length > 1000) throw new Error(`registered command '${name}' requires a description of at most 1000 characters: ${configPath}`);
  const cwd = value.cwd === undefined ? "." : requiredString(value.cwd, `commands.${name}.cwd`);
  const timeoutSeconds = clampInt(value.timeout_seconds, 120, 1, 600);
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

function validateInstructionFiles(value, configPath) {
  const files = validateStringArray(value, "instruction_files", 32, 64 * 1024);
  if (!files.length) throw new Error(`instruction_files must not be empty: ${configPath}`);
  for (const name of files) resolveInstructionPath("/", name);
  return files;
}

function resolveInstructionPath(directory, configuredName) {
  const raw = requiredString(configuredName, "instruction file name");
  if (raw.includes("\0") || isAbsolute(raw)) throw new Error(`instruction file path must be relative: ${raw}`);
  const candidate = resolve(directory, raw);
  assertContainedPath(resolve(directory), candidate, "instruction file path");
  return candidate;
}

function resolveConfiguredPath(configuredPath, baseDir, home, workspace, unrestricted) {
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

async function findSkillEntrypoint(directory) {
  for (const name of ["SKILL.md", "skill.md"]) {
    const candidate = join(directory, name);
    const info = await lstat(candidate).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (!info) continue;
    if (info.isSymbolicLink()) throw new Error(`skill entrypoint must not be a symbolic link: ${candidate}`);
    if (!info.isFile()) throw new Error(`skill entrypoint is not a regular file: ${candidate}`);
    return candidate;
  }
  return "";
}

async function summarizeSkill(entrypoint, sourceRoot) {
  const content = await readRegularUtf8(entrypoint, MAX_SKILL_ENTRY_BYTES, "skill entrypoint");
  const metadata = parseSkillMetadata(content.text);
  if (!metadata.name || !metadata.description) throw new Error("SKILL.md front matter requires non-empty name and description fields");
  const directory = dirname(entrypoint);
  const name = metadata.name.slice(0, 200);
  return {
    id: `skill_${sha256(entrypoint).slice(0, 16)}`,
    name,
    description: metadata.description.slice(0, 1000),
    entrypoint,
    directory,
    sourceRoot,
    bytes: content.bytes,
    sha256: sha256(content.text),
  };
}

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
  const metadata = {};
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase();
    if (key !== "name" && key !== "description") continue;
    metadata[key] = unquoteScalar(match[2].trim());
  }
  return metadata;
}


async function listSkillFiles(root, maxFiles, context, throwIfCancelled) {
  const files = [];
  const stack = [{ directory: root, depth: 0 }];
  let visited = 0;
  let truncated = false;
  while (stack.length) {
    throwIfCancelled(context);
    const current = stack.pop();
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

function publicSkill(skill, displayPath) {
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

function contextSkillSummaries(skills, displayPath, maxSkills, budgetChars) {
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
    if (available >= 32) {
      selected.push({ ...withoutDescription, description: item.description.slice(0, available) });
    }
    return { skills: selected, truncated: true };
  }
  return { skills: selected, truncated: false };
}

function publicSkillWarnings(warnings, displayPath) {
  return warnings.map((warning) => ({ entrypoint: displayPath(warning.entrypoint), message: warning.message }));
}

function publicCommands(commands, displayPath) {
  return [...commands.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((command) => ({
      name: command.name,
      description: command.description,
      argv: [...command.argv],
      cwd: displayPath(command.cwd),
      timeout_seconds: command.timeoutSeconds,
      allow_extra_args: command.allowExtraArgs,
      source: displayPath(command.source),
    }));
}

function renderEffectiveInstructions(instructions, displayPath) {
  return instructions.map((item) => [
    `--- BEGIN ${displayPath(item.path)} (precedence ${item.precedence}) ---`,
    item.content,
    `--- END ${displayPath(item.path)} ---`,
  ].join("\n")).join("\n\n");
}

async function readOptionalRegularUtf8(filePath, maxBytes, label) {
  const info = await lstat(filePath).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (!info) return null;
  if (info.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${filePath}`);
  if (!info.isFile()) throw new Error(`${label} is not a regular file: ${filePath}`);
  return readRegularUtf8(filePath, maxBytes, label);
}

async function readRegularUtf8(filePath, maxBytes, label) {
  const handle = await open(filePath, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`${label} is not a regular file: ${filePath}`);
    if (info.size > maxBytes) throw new Error(`${label} exceeds maximum size (${info.size} > ${maxBytes})`);
    const buffer = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset));
    } catch {
      throw new Error(`${label} is not valid UTF-8 text: ${filePath}`);
    }
    return { text, bytes: offset };
  } finally {
    await handle.close();
  }
}

function validateStringArray(value, label, maxItems, maxBytes) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array of strings`);
  if (value.length > maxItems) throw new Error(`${label} contains more than ${maxItems} items`);
  let bytes = 0;
  return value.map((item, index) => {
    if (typeof item !== "string" || !item.length || item.includes("\0")) throw new Error(`${label}[${index}] must be a non-empty string without NUL bytes`);
    bytes += Buffer.byteLength(item);
    if (bytes > maxBytes) throw new Error(`${label} exceeds maximum encoded size (${maxBytes} bytes)`);
    return item;
  });
}

function assertAllowedPath(candidate, workspace, unrestricted, label) {
  if (!unrestricted) assertContainedPath(workspace, candidate, label);
}

function assertContainedPath(root, target, label) {
  if (isContainedPath(root, target)) return;
  throw new Error(`${label} is outside the configured workspace`);
}

function isContainedPath(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function isPlainRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedMessage(error) {
  return String(error?.message || error || "invalid local skill").replace(/[\r\n]+/g, " ").slice(0, 1000);
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function unquoteScalar(value) {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

function clampInt(value, fallback, min, max) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}
