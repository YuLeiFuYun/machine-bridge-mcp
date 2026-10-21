// @ts-check

export const ACTIONABLE_GUIDANCE = Object.freeze({
  not_found: "Verify target path or resource exists before retrying.",
  path_boundary: "Ensure path is within the workspace boundary.",
  permission_denied: "Verify filesystem permissions for the resource.",
  conflict: "Resource state changed; inspect current state before retrying.",
  timeout: "Operation timed out; inspect its settlement and recovery metadata before deciding whether to retry.",
  limit_exceeded: "Resource limit exceeded; reduce input size or batch items.",
  invalid_request: "Check input arguments against the tool schema.",
  policy_denied: "Operation was denied by security policy.",
});

const REASON_ACTIONABLE_GUIDANCE = Object.freeze({
  text_not_found: "old_text was not found in the target file. Read the current file content with read_file to verify line contents and whitespace before retrying.",
  text_ambiguous: "old_text matches multiple locations. Provide a larger unique context with surrounding lines or set replace_all=true.",
  hash_mismatch: "File was modified concurrently. Re-read the file to inspect the latest content and SHA-256 hash before re-attempting.",
  write_limit: "Payload exceeds maximum write bytes limit. Split the content or changes into smaller files or operations.",
  patch_limit: "Patch payload exceeds maximum patch limit. Split the patch into smaller batches.",
  unsupported_target_type: "Target path must be a regular non-symbolic-link file.",
  missing_path: "Provide a valid non-empty relative workspace path matching the tool schema.",
  empty_old_text: "Provide a non-empty old_text matching the exact text to replace.",
  missing_patch: "Provide a valid Begin Patch/End Patch envelope text.",
  line_out_of_range: "start_line exceeds total lines in the file. Inspect file length or omit start_line to read from the beginning.",
  invalid_line_range: "end_line must be greater than or equal to start_line. Provide a valid line range [start_line, end_line].",
  read_limit: "Selected file slice exceeds max_bytes limit. Use narrower start_line and end_line bounds to paginate reading.",
  unsupported_image_format: "Image format is unsupported. Ensure the target file is a valid PNG, JPEG, GIF, or WebP image.",
  already_exists: "Target file already exists. To overwrite an existing file, do not set create_only=true, or use edit_file.",
  symbolic_link: "Refusing to mutate a symbolic link. Target the canonical file directly.",
  precondition_target_missing: "Target file does not exist. Ensure the target file exists before specifying expected_sha256.",
  context_not_found: "Patch hunk context did not match current file contents. Re-read the file with read_file to retrieve current context lines.",
  context_ambiguous: "Patch hunk context matched multiple locations. Include more surrounding lines in the hunk header context.",
});

/** @param {unknown} value @returns {string | null} */
export function settlementGuidance(value) {
  if (!value || typeof value !== "object") return null;
  const code = "code" in value ? String(value.code) : "";
  const details = "details" in value && value.details && typeof value.details === "object" ? value.details : {};
  const recovery = "recovery" in details && details.recovery && typeof details.recovery === "object" ? details.recovery : {};
  const mode = "mode" in recovery ? recovery.mode : "";
  if (mode === "read_same_job") return "Recover the accepted operation with read_job using its original job_id and recovery_key; do not resubmit the business operation.";
  if (mode === "idempotent_replay") return "Recover using the original arguments and idempotency key; do not create a new operation or key.";
  if (("side_effects_started" in details && details.side_effects_started === true)
      || ("effect_settlement" in details && ["unknown", "pending"].includes(String(details.effect_settlement)))) {
    return "The operation may have started and its effects are unsettled. Inspect current state or the accepted job before any retry; do not repeat the side effect blindly.";
  }
  if (code === "timeout" && "retryable" in value && value.retryable === false) return "The timeout is not retryable. Inspect current state and settle the original operation before taking another action.";
  const reason = "reason" in details ? String(details.reason) : "";
  return /** @type {Record<string, string>} */ (REASON_ACTIONABLE_GUIDANCE)[reason]
    || /** @type {Record<string, string>} */ (ACTIONABLE_GUIDANCE)[code] || null;
}
