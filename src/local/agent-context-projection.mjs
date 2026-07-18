// @ts-check
import { createHash } from "node:crypto";

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
 * @property {string} source
 * @property {string} [sourceType]
 * @property {string} [script]
 */
/**
 * @typedef {object} ProjectionState
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
    configs: state.configFiles,
    instructions: [
      state.builtinInstructions?.sha256 || "",
      state.automaticProjectContext?.sha256 || "",
      state.modelInstructions?.sha256 || "",
      ...state.instructions.map((item) => item.sha256),
    ],
    skills: skills.map((skill) => [skill.id, skill.sha256]),
    commands: [...state.commands.values()].map((command) => [command.name, command.argv]),
  }));
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
  return warnings.map((warning) => ({ entrypoint: displayPath(warning.entrypoint), message: warning.message }));
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
