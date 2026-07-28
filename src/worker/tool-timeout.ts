import relayContract from "../shared/relay-contract.json" with { type: "json" };
import { WorkerToolError } from "./errors.ts";

const CONFIGURABLE_FOREGROUND_TOOLS = new Set([
  "exec_command", "run_process", "run_local_command", "open_local_application",
  "inspect_local_application", "operate_local_application", "browser_list_tabs",
  "browser_manage_tabs", "browser_wait", "browser_get_source", "browser_inspect_page",
  "browser_action", "browser_fill_form", "browser_screenshot", "browser_upload_files",
]);

export const REMOTE_FOREGROUND_TIMEOUT_SECONDS = Math.floor(
  relayContract.maximumInteractiveExecutionTimeoutMs / 1000,
);
const THIRTY_SECOND_FOREGROUND_TOOLS = new Set([
  "open_local_application", "inspect_local_application", "operate_local_application",
  "browser_list_tabs", "browser_manage_tabs", "browser_wait", "browser_get_source",
  "browser_inspect_page", "browser_action", "browser_screenshot",
]);

export function isConfigurableForegroundTool(name: string): boolean {
  return CONFIGURABLE_FOREGROUND_TOOLS.has(name);
}

export function remoteForegroundDefaultSeconds(name: string): number {
  return THIRTY_SECOND_FOREGROUND_TOOLS.has(name) ? 30 : 60;
}

export function daemonToolTimeoutMs(name: string, args: Record<string, unknown>): number {
  if (name === "session_bootstrap") return 10_000;
  if (!isConfigurableForegroundTool(name)) return 60_000;

  const seconds = remoteForegroundSeconds(name, args.timeout_seconds);
  const executionMs = Math.min(seconds * 1000, relayContract.maximumExecutionTimeoutMs);
  return Math.min(executionMs + relayContract.toolCallOverheadMs, relayContract.maximumRelayToolTimeoutMs);
}

function remoteForegroundSeconds(name: string, value: unknown): number {
  if (value === undefined) return remoteForegroundDefaultSeconds(name);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw foregroundTimeoutError("remote foreground timeout must be an integer of at least 1 second");
  }
  if (value > REMOTE_FOREGROUND_TIMEOUT_SECONDS) {
    throw foregroundTimeoutError(
      `remote foreground timeout exceeds ${REMOTE_FOREGROUND_TIMEOUT_SECONDS} seconds; split mutations from verification and use start_process/read_process or start_job/read_job for longer work`,
    );
  }
  return value;
}

function foregroundTimeoutError(message: string): WorkerToolError {
  return new WorkerToolError(
    "invalid_request",
    message,
    false,
    {
      side_effects_started: false,
      minimum_foreground_timeout_seconds: 1,
      maximum_foreground_timeout_seconds: REMOTE_FOREGROUND_TIMEOUT_SECONDS,
      recommended_tools: ["start_process", "read_process", "start_job", "read_job"],
    },
  );
}
