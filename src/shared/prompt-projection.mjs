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
