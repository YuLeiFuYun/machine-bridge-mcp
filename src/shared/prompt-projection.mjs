// @ts-check

/** @param {unknown} value @returns {Record<string, unknown>} */
function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : {};
}

/** @param {unknown} value */
export function instructionPromptText(value) {
  const result = record(value);
  if (typeof result.effective_instructions !== "string") throw new Error("Agent context did not return its effective instructions.");
  const text = result.effective_instructions;
  const warnings = Array.isArray(result.instruction_warnings) ? result.instruction_warnings.filter((x) => typeof x === "string") : [];
  return [text || "No specific instructions configured.", ...(result.instructions_truncated === true ? ["Instruction inventory is incomplete; inspect omitted-file warnings before proceeding."] : []), ...warnings].join("\n\n");
}

/** @param {unknown} value */
export function diffPromptText(value) {
  const result = record(value);
  if (result.code !== 0 || typeof result.stdout !== "string") throw new Error("Git diff did not complete successfully.");
  const notices = [];
  if (Number(result.stdout_truncated_bytes || 0) > 0 || Number(result.stdout_omitted_bytes || 0) > 0 || result.truncated === true) notices.push("Diff output is incomplete; inspect narrower file ranges before completing the review.");
  if (result.sensitive_files_omitted === true || Number(result.sensitive_files_omitted || 0) > 0) notices.push("Sensitive paths were omitted from this diff.");
  return [result.stdout || (notices.length ? "No diff content is visible in this bounded result." : "No changes found."), ...notices].join("\n\n");
}

/** @param {unknown} value */
export function skillPromptText(value) {
  const result = record(value);
  const skill = record(result.skill);
  if (typeof result.content === "string") return result.content;
  if (typeof skill.content === "string") return skill.content;
  throw new Error("Skill load did not return its instruction content.");
}

export const MCP_PROMPTS = Object.freeze([
  Object.freeze({
    name: "agent_instructions",
    description: "Project-specific developer instructions and operating constraints",
    arguments: Object.freeze([]),
  }),
  Object.freeze({
    name: "code_review",
    description: "Review current staged or unstaged git changes",
    arguments: Object.freeze([
      Object.freeze({ name: "staged", description: "Whether to review staged changes only (boolean)", required: false }),
    ]),
  }),
  Object.freeze({
    name: "run_skill",
    description: "Load instructions for a discovered local agent skill; loading does not execute its files",
    arguments: Object.freeze([
      Object.freeze({ name: "skill", description: "Name of the skill to load", required: true }),
    ]),
  }),
]);

/**
 * @param {string} method
 * @param {unknown} rawParams
 * @param {(name: string, args: Record<string, unknown>) => Promise<unknown>} invokeTool
 * @returns {Promise<{ ok: true, value: Record<string, unknown> } | { ok: false, code: number, message: string }>}
 */
export async function resolveSharedPromptOperation(method, rawParams, invokeTool) {
  if (method === "prompts/list") {
    return { ok: true, value: { prompts: MCP_PROMPTS.map((item) => ({ ...item, arguments: [...item.arguments] })) } };
  }
  const params = record(rawParams);
  const name = String(params.name || "");
  if (!name) return { ok: false, code: -32602, message: "prompts/get requires a prompt name" };
  const args = record(params.arguments);
  if (name === "agent_instructions") {
    if (Object.keys(args).length) {
      return { ok: false, code: -32602, message: "agent_instructions does not accept arguments" };
    }
    const result = await invokeTool("agent_context", {});
    const text = String(instructionPromptText(result));
    return {
      ok: true,
      value: {
        description: "Project developer instructions",
        messages: [{ role: "user", content: { type: "text", text } }],
      },
    };
  }
  if (name === "code_review") {
    if (Object.keys(args).some((key) => key !== "staged") || (args.staged !== undefined && typeof args.staged !== "boolean")) {
      return { ok: false, code: -32602, message: "code_review accepts only an optional boolean staged argument" };
    }
    const staged = args.staged === true;
    const diffResult = await invokeTool("git_diff", { staged });
    const diffText = diffPromptText(diffResult);
    return {
      ok: true,
      value: {
        description: `Code review prompt for ${staged ? "staged" : "unstaged"} changes`,
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: `Please review the following git diff for correctness, security, and architecture:\n\n\`\`\`diff\n${diffText}\n\`\`\``,
          },
        }],
      },
    };
  }
  if (name === "run_skill") {
    const skillName = typeof args.skill === "string" ? args.skill.trim() : "";
    if (!skillName || Object.keys(args).some((key) => key !== "skill")) {
      return { ok: false, code: -32602, message: "run_skill requires only a non-empty skill argument" };
    }
    const skillResult = await invokeTool("load_local_skill", { skill: skillName });
    const text = skillPromptText(skillResult);
    return {
      ok: true,
      value: {
        description: `Skill: ${skillName}`,
        messages: [{ role: "user", content: { type: "text", text } }],
      },
    };
  }
  return { ok: false, code: -32602, message: `Unknown prompt: ${name.slice(0, 128)}` };
}
