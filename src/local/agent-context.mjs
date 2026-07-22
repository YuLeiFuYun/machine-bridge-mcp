import { commandMatchText, recommendTools, relevanceScore } from "./capability-ranking.mjs";
import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createBuiltinInstruction, discoverAutomaticProjectInstruction } from "./default-instructions.mjs";
import { automaticPackageCommands, readProjectPackageMetadata } from "./project-package.mjs";
import { clampInteger } from "./numbers.mjs";
import {
  discoverLocalSkills, listSkillFiles, MAX_SKILL_ENTRY_BYTES, MAX_SKILL_FILES, MAX_SKILL_RESULTS,
} from "./agent-skill-discovery.mjs";
import { readOptionalRegularUtf8, readRegularUtf8 } from "./agent-text-file.mjs";
import {
  capabilityFingerprint, contextSkillSummaries, effectiveInstructionItems, publicCommands,
  publicSkill, publicSkillWarnings, publicVirtualInstruction, renderEffectiveInstructions, sha256,
} from "./agent-context-projection.mjs";
import {
  MAX_COMMAND_ARGUMENT_BYTES, MAX_COMMANDS,
  assertContainedPath, isContainedPath, normalizeAgentConfig, requiredString,
  resolveConfiguredPath, resolveInstructionPath, validateStringArray,
} from "./agent-contract.mjs";
export { parseSkillMetadata } from "./agent-skill-discovery.mjs";

const CONFIG_RELATIVE_PATH = join(".machine-bridge", "agent.json");
const GLOBAL_CONFIG_RELATIVE_PATH = join(".config", "machine-bridge-mcp", "agent.json");
const DEFAULT_INSTRUCTION_FILES = Object.freeze(["AGENTS.override.md", "AGENTS.md"]);
const DEFAULT_INSTRUCTION_MAX_BYTES = 32 * 1024;
const MAX_CONTEXT_SKILL_SUMMARY_CHARS = 8_000;
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_INSTRUCTION_FILE_BYTES = 512 * 1024;
const MAX_INSTRUCTION_FILES = 64;

export class AgentContextManager {
  constructor({ workspace, policy, policyForContext = null, displayPath, resolveExistingPath, throwIfCancelled = () => {}, home = process.env.HOME || process.env.USERPROFILE || "", codexHome = process.env.CODEX_HOME || "" }) {
    this.workspace = resolve(workspace);
    this.policy = policy || {};
    this.policyForContext = typeof policyForContext === "function" ? policyForContext : () => this.policy;
    this.displayPath = displayPath;
    this.resolveExistingPath = resolveExistingPath;
    this.throwIfCancelled = throwIfCancelled;
    this.home = home ? resolve(home) : "";
    this.codexHome = codexHome ? resolve(codexHome) : this.home ? resolve(this.home, ".codex") : "";
  }

  async agentContext(args = {}, context = {}) {
    const state = await this.discoverState(args.path || ".", context);
    const includeContent = args.include_instruction_content !== false;
    const skillLimit = clampInteger(args.max_skills, 100, 1, MAX_SKILL_RESULTS);
    const discoveredSkills = await this.discoverSkills(state, { maxResults: MAX_SKILL_RESULTS }, context);
    const contextSkills = contextSkillSummaries(discoveredSkills.skills, (value) => this.displayPath(value, context), skillLimit, MAX_CONTEXT_SKILL_SUMMARY_CHARS);
    const result = {
      target: this.displayPath(state.target, context),
      scope_root: this.displayPath(state.scopeRoot, context),
      precedence: "built-in defaults, automatic project facts, user-global guidance, then scope root to target directory; explicit files loaded later have higher precedence",
      config_files: state.configFiles.map((file) => this.displayPath(file, context)),
      builtin_instructions: publicVirtualInstruction(state.builtinInstructions, includeContent),
      automatic_project_context: publicVirtualInstruction(state.automaticProjectContext, includeContent),
      model_instructions_file: state.modelInstructions ? {
        path: this.displayPath(state.modelInstructions.path, context),
        bytes: state.modelInstructions.bytes,
        sha256: state.modelInstructions.sha256,
        ...(includeContent ? { content: state.modelInstructions.content } : {}),
      } : null,
      instruction_files: state.instructions.map((item) => ({
        scope: item.scope,
        path: this.displayPath(item.path, context),
        bytes: item.bytes,
        sha256: item.sha256,
        precedence: item.precedence,
        ...(includeContent ? { content: item.content } : {}),
      })),
      skills: contextSkills.skills,
      skills_truncated: discoveredSkills.truncated || contextSkills.truncated,
      skill_warnings: publicSkillWarnings(discoveredSkills.warnings, (value) => this.displayPath(value, context)),
      instructions_truncated: state.instructionsTruncated,
      commands: publicCommands(state.commands, (value) => this.displayPath(value, context)),
      guidance: [
        "Apply built-in instructions and automatic project context as lower-precedence defaults; explicit global/project instruction files loaded later take precedence.",
        "Treat instruction_files as authoritative workspace guidance in the returned precedence order.",
        "Load a relevant skill with load_local_skill before following its workflow; SKILL.md is an instruction bundle, not executable code by itself.",
        "Prefer run_local_command for registered repeatable commands. Use run_process or exec_command only when no registered command fits and policy permits it.",
      ],
    };
    if (includeContent) result.effective_instructions = renderEffectiveInstructions(effectiveInstructionItems(state), (value) => this.displayPath(value, context));
    return result;
  }

  async sessionBootstrap(args = {}, context = {}) {
    const state = await this.discoverState(args.path || ".", context);
    const fingerprint = capabilityFingerprint(state, []);
    return {
      target: this.displayPath(state.target, context),
      instructions: renderEffectiveInstructions(effectiveInstructionItems(state), (value) => this.displayPath(value, context)),
      builtin_instructions: publicVirtualInstruction(state.builtinInstructions, false),
      automatic_project_context: publicVirtualInstruction(state.automaticProjectContext, false),
      model_instructions_file: state.modelInstructions ? this.displayPath(state.modelInstructions.path, context) : null,
      capability_refresh: {
        strategy: "resolve_task_capabilities-rescans-on-every-call",
        instruction_and_command_fingerprint: fingerprint,
        skills_scanned: false,
        generated_at: new Date().toISOString(),
      },
      guidance: [
        "Built-in working agreements and bounded automatic project facts are present by default unless disabled in the user-global agent config.",
        "Call resolve_task_capabilities with the current user task before substantive local work or at the start of a reused-host conversation.",
        "The resolver returns the effective instructions again and rescans skill and command metadata on every call; the runtime supplements application and browser capability metadata.",
      ],
    };
  }

  async resolveTaskCapabilities(args = {}, context = {}) {
    const task = requiredString(args.task, "task");
    if (task.length > 20_000) throw new Error("task exceeds 20000 characters");
    const state = await this.discoverState(args.path || ".", context);
    const discovered = await this.discoverSkills(state, { maxResults: MAX_SKILL_RESULTS }, context);
    const maxSkills = clampInteger(args.max_skills, 10, 1, 50);
    const skillMatches = discovered.skills
      .map((skill) => ({ skill, score: relevanceScore(task, `${skill.name} ${skill.description}`, skill.name) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
      .slice(0, maxSkills);
    const commandMatches = [...state.commands.values()]
      .map((command) => ({ command, score: relevanceScore(task, commandMatchText(command), command.name) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.command.name.localeCompare(b.command.name))
      .slice(0, 20);
    const selected = skillMatches[0]?.score >= 3 ? skillMatches[0].skill : null;
    let selectedSkill = null;
    if (selected && args.include_selected_skill !== false) {
      const content = await readRegularUtf8(selected.entrypoint, MAX_SKILL_ENTRY_BYTES, "skill entrypoint");
      selectedSkill = { ...publicSkill(selected, (value) => this.displayPath(value, context)), instructions: content.text };
    }
    const recommendedTools = recommendTools(task, {
      commandsAvailable: state.commands.size > 0,
      commandRelevant: (commandMatches[0]?.score || 0) >= 3,
      skillRelevant: Boolean(selected),
    });
    const refresh = capabilityFingerprint(state, discovered.skills);
    return {
      task,
      target: this.displayPath(state.target, context),
      effective_instructions: renderEffectiveInstructions(effectiveInstructionItems(state), (value) => this.displayPath(value, context)),
      builtin_instructions: publicVirtualInstruction(state.builtinInstructions, false),
      automatic_project_context: publicVirtualInstruction(state.automaticProjectContext, false),
      model_instructions_file: state.modelInstructions ? this.displayPath(state.modelInstructions.path, context) : null,
      instruction_files: state.instructions.map((item) => ({ path: this.displayPath(item.path, context), scope: item.scope, bytes: item.bytes, sha256: item.sha256, precedence: item.precedence })),
      instructions_truncated: state.instructionsTruncated,
      refresh: { strategy: "rescan-on-every-call", fingerprint: refresh, generated_at: new Date().toISOString() },
      selected_skill: selectedSkill,
      skill_matches: skillMatches.map(({ skill, score }) => ({ ...publicSkill(skill, (value) => this.displayPath(value, context)), score })),
      command_matches: commandMatches.map(({ command, score }) => ({ ...publicCommands(new Map([[command.name, command]]), (value) => this.displayPath(value, context))[0], score })),
      recommended_tools: recommendedTools,
      host_semantics: "Machine Bridge can discover, rank, and load capabilities automatically. The MCP host remains responsible for deciding whether to call the recommended tools.",
      warnings: publicSkillWarnings(discovered.warnings, (value) => this.displayPath(value, context)),
      truncated: discovered.truncated,
    };
  }

  async collectModelInstructions(state, context) {
    this.throwIfCancelled(context);
    const path = state.modelInstructionsFile;
    const info = await lstat(path).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (!info) throw new Error(`model_instructions_file does not exist: ${path}`);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`model_instructions_file must be a regular non-symbolic-link file: ${path}`);
    const content = await readRegularUtf8(path, MAX_INSTRUCTION_FILE_BYTES, "model instructions file");
    if (!content.text.trim()) throw new Error(`model_instructions_file is empty: ${path}`);
    state.modelInstructions = { scope: "model", path, bytes: content.bytes, sha256: sha256(content.text), content: content.text, precedence: 0 };
  }

  async listLocalSkills(args = {}, context = {}) {
    const state = await this.discoverState(args.path || ".", context);
    const result = await this.discoverSkills(state, {
      query: typeof args.query === "string" ? args.query : "",
      maxResults: clampInteger(args.max_results, 100, 1, MAX_SKILL_RESULTS),
    }, context);
    return {
      target: this.displayPath(state.target, context),
      scope_root: this.displayPath(state.scopeRoot, context),
      skill_roots: state.skillRoots.map((root) => this.displayPath(root, context)),
      skills: result.skills.map((skill) => publicSkill(skill, (value) => this.displayPath(value, context))),
      warnings: publicSkillWarnings(result.warnings, (value) => this.displayPath(value, context)),
      truncated: result.truncated,
    };
  }

  async loadLocalSkill(args = {}, context = {}) {
    const requested = requiredString(args.skill, "skill");
    const state = await this.discoverState(args.path || ".", context);
    const result = await this.discoverSkills(state, { maxResults: MAX_SKILL_RESULTS }, context);
    const matches = result.skills.filter((skill) => skill.id === requested || skill.name === requested || this.displayPath(skill.entrypoint, context) === requested);
    if (!matches.length) throw new Error(`local skill not found: ${requested}`);
    if (matches.length > 1) throw new Error(`local skill name is ambiguous; use its id: ${requested}`);
    const skill = matches[0];
    const content = await readRegularUtf8(skill.entrypoint, MAX_SKILL_ENTRY_BYTES, "skill entrypoint");
    const inventory = await listSkillFiles(skill.directory, clampInteger(args.max_files, 200, 1, MAX_SKILL_FILES), context, this.throwIfCancelled);
    return {
      skill: publicSkill(skill, (value) => this.displayPath(value, context)),
      instructions: content.text,
      files: inventory.files,
      files_truncated: inventory.truncated,
      execution_semantics: "Loading a skill returns its instructions and file inventory. It does not execute scripts or commands implicitly.",
    };
  }

  async listLocalCommands(args = {}, context = {}) {
    const state = await this.discoverState(args.path || ".", context);
    return {
      target: this.displayPath(state.target, context),
      scope_root: this.displayPath(state.scopeRoot, context),
      commands: publicCommands(state.commands, (value) => this.displayPath(value, context)),
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
    const effectivePolicy = this.policyForContext(context);
    this.workspace = await realpath(this.workspace);
    const target = await realpath(await this.resolveExistingPath(inputPath, context));
    const targetInfo = await stat(target);
    const targetDir = targetInfo.isDirectory() ? target : dirname(target);
    const scopeRoot = await findScopeRoot({
      targetDir,
      workspace: this.workspace,
      unrestricted: effectivePolicy.unrestrictedPaths === true,
    });
    const directories = directoriesBetween(scopeRoot, targetDir);
    const state = {
      target,
      targetDir,
      scopeRoot,
      instructionFiles: [...DEFAULT_INSTRUCTION_FILES],
      instructionMaxBytes: DEFAULT_INSTRUCTION_MAX_BYTES,
      skillRoots: defaultSkillRoots(directories, this.home, this.codexHome, effectivePolicy.unrestrictedPaths === true),
      commands: new Map(),
      builtinInstructionsEnabled: true,
      automaticProjectContextEnabled: true,
      builtinInstructions: null,
      automaticProjectContext: null,
      modelInstructionsFile: "",
      modelInstructions: null,
      configFiles: [],
      instructions: [],
      instructionBytes: 0,
      instructionsTruncated: false,
    };

    const packageMetadata = await readProjectPackageMetadata(scopeRoot, () => this.throwIfCancelled(context));
    state.commands = automaticPackageCommands(packageMetadata, scopeRoot);

    if (this.home) {
      const globalConfig = join(this.home, GLOBAL_CONFIG_RELATIVE_PATH);
      const config = await readOptionalConfig(globalConfig, this.home, false);
      if (config) {
        if (effectivePolicy.unrestrictedPaths === true) this.applyConfig(state, config, globalConfig, this.home, { global: true, unrestricted: true });
        else {
          state.configFiles.push(globalConfig);
          if (config.builtinInstructions !== null) state.builtinInstructionsEnabled = config.builtinInstructions;
          if (config.automaticProjectContext !== null) state.automaticProjectContextEnabled = config.automaticProjectContext;
          if (config.modelInstructionsFile) state.modelInstructionsFile = resolveConfiguredPath(config.modelInstructionsFile, this.home, this.home, this.workspace, true);
        }
      }
    }

    state.builtinInstructions = createBuiltinInstruction(state.builtinInstructionsEnabled);
    state.automaticProjectContext = await discoverAutomaticProjectInstruction({
      scopeRoot,
      targetDir,
      enabled: state.automaticProjectContextEnabled,
      throwIfCancelled: () => this.throwIfCancelled(context),
    });

    if (this.home) {
      if (state.modelInstructionsFile) await this.collectModelInstructions(state, context);
      if (effectivePolicy.unrestrictedPaths === true && this.codexHome) await this.collectDirectoryInstruction(state, this.codexHome, context, "global");
    }

    for (const directory of directories) {
      this.throwIfCancelled(context);
      const configPath = join(directory, CONFIG_RELATIVE_PATH);
      const config = await readOptionalConfig(configPath, directory, true);
      if (config) this.applyConfig(state, config, configPath, directory, { global: false, unrestricted: effectivePolicy.unrestrictedPaths === true });
      await this.collectDirectoryInstruction(state, directory, context, "project");
    }
    return state;
  }

  applyConfig(state, config, configPath, baseDir, { global = false, unrestricted = false } = {}) {
    state.configFiles.push(configPath);
    if (config.builtinInstructions !== null) {
      if (!global) throw new Error(`builtin_instructions is only allowed in the global agent config: ${configPath}`);
      state.builtinInstructionsEnabled = config.builtinInstructions;
    }
    if (config.automaticProjectContext !== null) {
      if (!global) throw new Error(`automatic_project_context is only allowed in the global agent config: ${configPath}`);
      state.automaticProjectContextEnabled = config.automaticProjectContext;
    }
    if (config.modelInstructionsFile) {
      if (!global) throw new Error(`model_instructions_file is only allowed in the global agent config: ${configPath}`);
      state.modelInstructionsFile = resolveConfiguredPath(config.modelInstructionsFile, baseDir, this.home, this.workspace, true);
    }
    if (config.instructionFiles) state.instructionFiles = [...config.instructionFiles];
    if (config.instructionMaxBytes !== null) {
      state.instructionMaxBytes = config.instructionMaxBytes;
      if (state.instructionBytes >= state.instructionMaxBytes) state.instructionsTruncated = true;
    }
    if (config.skillRoots) {
      state.skillRoots = config.skillRoots.map((value) => resolveConfiguredPath(value, baseDir, this.home, this.workspace, unrestricted));
    }
    for (const [name, definition] of config.commands) {
      if (definition === null) {
        state.commands.delete(name);
        continue;
      }
      const cwd = resolveConfiguredPath(definition.cwd, baseDir, this.home, this.workspace, unrestricted);
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
    const effectivePolicy = this.policyForContext(context);
    return discoverLocalSkills({
      skillRoots: state.skillRoots,
      query: String(options.query || ""),
      maxResults: clampInteger(options.maxResults, 100, 1, MAX_SKILL_RESULTS),
      workspace: this.workspace,
      unrestricted: effectivePolicy.unrestrictedPaths === true,
      displayPath: (value) => this.displayPath(value, context),
      context,
      throwIfCancelled: this.throwIfCancelled,
    });
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

function defaultSkillRoots(directories, home, codexHome, unrestricted) {
  const roots = [];
  for (const directory of [...directories].reverse()) {
    roots.push(resolve(directory, ".agents", "skills"));
    roots.push(resolve(directory, ".codex", "skills"));
  }
  if (unrestricted && home) roots.push(resolve(home, ".agents", "skills"));
  if (unrestricted && codexHome) roots.push(resolve(codexHome, "skills"));
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
  return normalizeAgentConfig(parsed, configPath);
}
