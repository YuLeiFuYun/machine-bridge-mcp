// @ts-check

export const ACTIONABLE_GUIDANCE = Object.freeze({
  not_found: "Verify target path or resource exists before retrying.",
  path_boundary: "Ensure path is within the workspace boundary.",
  permission_denied: "Verify filesystem permissions for the resource.",
  conflict: "Resource state changed; inspect current state before retrying.",
  timeout: "Operation timed out; inspect its settlement and recovery metadata before deciding whether to retry.",
  limit_exceeded: "Resource limit exceeded; reduce input size or batch items.",
  invalid_request: "Check input arguments against the tool schema.",
  policy_denied: "Operation was denied by security policy. Do not attempt shell obfuscation or encoding retries; fall back to narrower read-only inspection.",
  execution_failed: "The tool ran but the operation failed. Read details.reason, fix that condition, or fall back to an equivalent read-only diagnostic observation; do not assume the effect was applied.",
  internal_error: "The bridge hit an internal inconsistency. Retry once; if it repeats, run doctor and report details.reason.",
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
  mbm_multiple_hard_links: "A local state file kept a second hard link, which the secure reader rejects. Run doctor --repair-resource-coordinator to restore the single-link invariant.",
  mbm_identity_changed: "A local state file was replaced while it was being read. Retry; if it repeats, run doctor and inspect the state directory.",
  mbm_resource_transaction_busy: "Another local operation holds the resource coordinator transaction lock. Wait for it to finish, or run doctor to reclaim a stale lock.",
  host_elevation_rejected: "Host privilege escalation (sudo/su) was denied. Do not guess passwords; continue with unprivileged read-only diagnostics or inspect current permissions via id and getent.",
  network_scan_unsupported: "Raw socket scanning or packet capture (nmap/tcpdump) is not permitted or unavailable. Use target-specific TCP listener verification (lsof -nP -iTCP or ss -tlnp) instead.",
  certificate_verification_failed: "TLS certificate verification failed. Do not disable verification (-k/--insecure); inspect the issuer chain and validity with openssl x509 or s_client.",
  connection_endpoint_refused: "Endpoint connection refused. Verify whether the local service is running and inspect bound ports before repeating requests.",
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

/**
 * Verbal self-reflection feedback loop (Reflexion paper).
 * Provides structured diagnosis (observation, hypothesis flaw, strategic alternative).
 * @param {unknown} value
 * @returns {{ observation: string, flaw: string, next_step: string } | null}
 */
export function verbalSelfReflection(value) {
  if (!value || typeof value !== "object") return null;
  const guidance = settlementGuidance(value);
  if (!guidance) return null;
  const details = "details" in value && value.details && typeof value.details === "object" ? value.details : {};
  const reason = "reason" in details ? String(details.reason) : ("code" in value ? String(value.code) : "unknown");
  return {
    observation: `Tool invocation encountered ${reason}.`,
    flaw: "Initial assumptions about file contents, concurrent state, or environment constraints diverged from reality.",
    next_step: guidance,
  };
}
