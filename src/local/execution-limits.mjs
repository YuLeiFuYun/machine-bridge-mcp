export const MAX_CONCURRENT_TOOL_CALLS = 16;
export const MAX_PROCESS_SESSIONS = 8;
export const MIN_PROCESS_TIMEOUT_SECONDS = 1;
export const MAX_PROCESS_TIMEOUT_SECONDS = 600;
export const DEFAULT_PROCESS_OUTPUT_BYTES = 512 * 1024;
export const MAX_PROCESS_STDIN_BYTES = 1024 * 1024;
export const MAX_PROCESS_SESSION_OUTPUT_BYTES = 1024 * 1024;
export const MAX_PROCESS_SESSION_STDIN_BYTES = 64 * 1024;
export const PROCESS_SESSION_RETENTION_MS = 30 * 60 * 1000;

export function executionGuardrailsSnapshot() {
  return {
    tool_calls: {
      maximum_concurrent: MAX_CONCURRENT_TOOL_CALLS,
    },
    one_shot_processes: {
      timeout_seconds: { minimum: MIN_PROCESS_TIMEOUT_SECONDS, maximum: MAX_PROCESS_TIMEOUT_SECONDS },
      stdin_max_bytes: MAX_PROCESS_STDIN_BYTES,
      output_max_bytes_per_stream: DEFAULT_PROCESS_OUTPUT_BYTES,
      process_tree_termination: "sigterm-then-sigkill",
    },
    process_sessions: {
      maximum_concurrent: MAX_PROCESS_SESSIONS,
      retained_output_max_bytes_per_stream: MAX_PROCESS_SESSION_OUTPUT_BYTES,
      write_stdin_max_bytes: MAX_PROCESS_SESSION_STDIN_BYTES,
      exited_retention_ms: PROCESS_SESSION_RETENTION_MS,
      process_tree_termination: "sigterm-then-sigkill",
    },
    operating_system_enforcement: {
      cpu_quota: "not-enforced",
      memory_quota: "not-enforced",
      network_isolation: "not-enforced",
      required_boundary: "dedicated-low-privilege-account-or-vm-container",
    },
  };
}
