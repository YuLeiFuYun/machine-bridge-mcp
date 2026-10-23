// @ts-check
import { MCP_TEXT_PROJECTION_KEY } from "../shared/result-projection.mjs";
import { sensitiveValuePattern } from "../shared/sensitive-value-patterns.mjs";
import { BridgeError } from "./errors.mjs";

const PRIVATE_KEY_BLOCK = /-----BEGIN\s+(?:(?:OPENSSH|RSA|EC|DSA)\s+|ENCRYPTED\s+)?PRIVATE\s+KEY-----[\s\S]{1,16384}?-----END\s+(?:(?:OPENSSH|RSA|EC|DSA)\s+|ENCRYPTED\s+)?PRIVATE\s+KEY-----/g;
const BINARY_PAYLOAD_PATTERN = /(?:\\x[0-9a-fA-F]{2}){8,}/g;
const REVERSE_SHELL_PATTERN = /\b(?:bash|sh|zsh)\s+-i\s+>&\s*\/dev\/tcp\/[^\s]+|\bnc\s+-e\s+\/bin\/(?:ba)?sh\b/g;
const INTERACTIVE_PROMPT_TAIL_PATTERN = /(?:(?:\[(?:y\/n|Y\/n|y\/N)\]|(?:\(y\/n\))|(?:\b(?:password|passphrase)\b[^:\r\n]{0,40}:)|(?:\bcontinue\?\s*\(?[yYnN/]+\)?)|(?:\boverwrite\b[^?\r\n]{0,40}\?))\s*)$/i;

/** @type {ReadonlyArray<[RegExp, string]>} */
const PROCESS_REPLACEMENTS = Object.freeze([
  [PRIVATE_KEY_BLOCK, "<redacted:private_key>"],
  [sensitiveValuePattern("privateKeyHeader", "g"), "<redacted:private_key_header>"],
  [sensitiveValuePattern("awsAccessKey", "g"), "<redacted:aws_key>"],
  [sensitiveValuePattern("githubAccessToken", "g"), "<redacted:github_token>"],
  [sensitiveValuePattern("gitlabAccessToken", "g"), "<redacted:gitlab_token>"],
  [sensitiveValuePattern("npmAccessToken", "g"), "<redacted:npm_token>"],
  [sensitiveValuePattern("slackAccessToken", "g"), "<redacted:slack_token>"],
  [sensitiveValuePattern("googleApiKey", "g"), "<redacted:google_api_key>"],
  [sensitiveValuePattern("livePaymentApiKey", "g"), "<redacted:payment_key>"],
  [sensitiveValuePattern("apiSecretToken", "g"), "<redacted:api_secret>"],
  [sensitiveValuePattern("jwtLikeBearerToken", "g"), "<redacted:jwt_token>"],
  [sensitiveValuePattern("credentialUrl", "g"), "https://<redacted:credentials>@$1"],
  [BINARY_PAYLOAD_PATTERN, "<redacted:binary_payload>"],
  [REVERSE_SHELL_PATTERN, "<redacted:reverse_shell>"],
]);

/** @param {unknown} text @returns {string} */
export function redactSensitiveProcessOutput(text) {
  if (typeof text !== "string" || !text) return "";
  let current = text;
  for (const [pattern, replacement] of PROCESS_REPLACEMENTS) current = current.replace(pattern, replacement);
  return current;
}

/** @param {string} stdout @param {string} stderr @returns {string | null} */
export function detectInteractivePromptStall(stdout, stderr) {
  const combinedTail = `${String(stdout || "").slice(-256)}\n${String(stderr || "").slice(-256)}`.trim();
  const match = combinedTail ? INTERACTIVE_PROMPT_TAIL_PATTERN.exec(combinedTail) : null;
  return match ? match[0].trim() : null;
}

/** @param {string} stderr @param {string} stdout @param {number | null | undefined} code @returns {string} */
export function refusalPreventionAdvisory(stderr, stdout, code) {
  if (code === 0) return "";
  const combined = `${stderr || ""}\n${stdout || ""}`;
  if (/SSL certificate problem|unable to get local issuer certificate|CERT_HAS_EXPIRED|DEPTH_ZERO_SELF_SIGNED_CERT/i.test(combined)) {
    return " [SRE Advisory: Certificate verification failed. Inspect local CA bundle or use `openssl s_client` / `curl -v` to diagnose the TLS chain rather than disabling verification globally.]";
  }
  if (/operation not permitted|permission denied|EACCES|EPERM/i.test(combined) && /nmap|tcpdump|wireshark|raw socket/i.test(combined)) {
    return " [SRE Advisory: Elevated packet capture or port probe failed due to OS privileges. Use unprivileged socket diagnostics (`nc -zv`, `lsof -i`, `ss -tulpn`, or `curl -v`) instead.]";
  }
  if (/command not found: (?:nmap|masscan|rustscan|nikto|sqlmap|hydra|john|hashcat)|(?:nmap|masscan|tcpdump): command not found/i.test(combined)) {
    return " [SRE Advisory: Raw packet capture or broad port scanning is unavailable in this environment. Use standard POSIX/network diagnostics (`lsof -i`, `netstat -an`, `nc -zv`, `dig`, or `curl -v`) to inspect service reachability.]";
  }
  const promptStall = detectInteractivePromptStall(stdout, stderr);
  return promptStall
    ? ` [SRE Advisory: Process output ended at an interactive prompt (${JSON.stringify(promptStall)}). Pass non-interactive flags (e.g., --yes, -y, CI=1, GIT_TERMINAL_PROMPT=0) or use start_process + write_process for interactive sessions.]`
    : "";
}

/** @param {Record<string, any>} value */
export function publicProcessToolResult(value) {
  const safeStdout = typeof value.stdout === "string" ? redactSensitiveProcessOutput(value.stdout) : value.stdout;
  const safeStderr = typeof value.stderr === "string" ? redactSensitiveProcessOutput(value.stderr) : value.stderr;
  const truncated = Number(value.stdout_truncated_bytes) + Number(value.stderr_truncated_bytes);
  const continuation = value.output_session_id
    ? ` Continue with read_process session ${value.output_session_id}.`
    : truncated > 0 ? " Additional output could not be retained because the process-session limit was reached." : "";
  const advisory = refusalPreventionAdvisory(safeStderr, safeStdout, value.code);
  const summary = `Process exited with code ${value.code}.${truncated > 0 ? ` ${truncated} inline byte(s) omitted.` : ""}${continuation}${advisory}`;
  return {
    ...value,
    ...(typeof safeStdout === "string" ? { stdout: safeStdout } : {}),
    ...(typeof safeStderr === "string" ? { stderr: safeStderr } : {}),
    [MCP_TEXT_PROJECTION_KEY]: summary,
  };
}

/** @param {string} trigger @param {Record<string, unknown>} [details] */
export function processOutcomeUnknownAfterSpawn(trigger, details = {}) {
  const terminationRequested = trigger === "cancelled" || trigger === "timeout" || trigger === "resource_binding";
  return new BridgeError(
    "execution_failed",
    "command execution may have partially completed; the outcome is unknown. Inspect command effects before retrying.",
    {
      expose: true,
      retryable: false,
      details: {
        ...details,
        reason: "process_outcome_unknown_after_spawn",
        trigger: String(trigger || "unknown").slice(0, 64),
        side_effects_started: "unknown",
        termination_requested: terminationRequested,
        effect_settlement: terminationRequested ? "pending" : "unknown",
      },
    },
  );
}

/** @param {Record<string, any>} result */
export function processFailureMessage(result) {
  const safeStderr = redactSensitiveProcessOutput(String(result.stderr || ""));
  const safeStdout = redactSensitiveProcessOutput(String(result.stdout || ""));
  const advisory = refusalPreventionAdvisory(safeStderr, safeStdout, result.code);
  const source = String(safeStderr || safeStdout || `process exited ${result.code}`).replace(/[\r\n]+/g, " ").trim().slice(0, 2000);
  const suffix = result.output_session_id
    ? `; additional output is available through read_process session ${result.output_session_id}`
    : result.stdout_truncated_bytes > 0 || result.stderr_truncated_bytes > 0 ? "; additional output was truncated" : "";
  return `${source || `process exited ${result.code}`}${suffix}${advisory}`;
}
