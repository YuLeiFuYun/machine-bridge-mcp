import relayContract from "./relay-contract.json" with { type: "json" };

const CONFIGURABLE_FOREGROUND_TOOLS = new Set([
  "exec_command", "run_process", "run_local_command", "open_local_application",
  "inspect_local_application", "operate_local_application", "browser_list_tabs",
  "browser_manage_tabs", "browser_wait", "browser_get_source", "browser_inspect_page",
  "browser_action", "browser_fill_form", "browser_screenshot", "browser_upload_files",
  "computer_observe", "computer_act",
]);

const REMOTE_DURABLE_PROCESS_TOOLS = new Set([
  "exec_command", "run_process", "run_local_command",
]);

export const REMOTE_FOREGROUND_TIMEOUT_SECONDS = Math.floor(
  relayContract.maximumInteractiveExecutionTimeoutMs / 1000,
);

export const REMOTE_DURABLE_PROCESS_MAXIMUM_TIMEOUT_SECONDS = Math.floor(
  relayContract.maximumDurableProcessExecutionTimeoutMs / 1000,
);
export const REMOTE_DURABLE_PROCESS_DEFAULT_TIMEOUT_SECONDS = REMOTE_DURABLE_PROCESS_MAXIMUM_TIMEOUT_SECONDS;

export function isRemoteDurableProcessTool(name) {
  return REMOTE_DURABLE_PROCESS_TOOLS.has(name);
}

export function remoteDurableProcessTimeoutSeconds(value) {
  const parsed = value === undefined ? REMOTE_DURABLE_PROCESS_DEFAULT_TIMEOUT_SECONDS : value;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > REMOTE_DURABLE_PROCESS_MAXIMUM_TIMEOUT_SECONDS) {
    throw new RangeError(`durable process timeout must be an integer from 1 to ${REMOTE_DURABLE_PROCESS_MAXIMUM_TIMEOUT_SECONDS}`);
  }
  return parsed;
}

export function isConfigurableForegroundTool(name) {
  return CONFIGURABLE_FOREGROUND_TOOLS.has(name);
}

export function remoteForegroundDefaultSeconds(name) {
  if (CONFIGURABLE_FOREGROUND_TOOLS.has(name)) return 20;
  return Math.min(60, remoteForegroundMaximumSeconds(name));
}

export function remoteForegroundMaximumSeconds() {
  return REMOTE_FOREGROUND_TIMEOUT_SECONDS;
}

export function effectiveForegroundTimeoutSeconds({
  tool,
  value,
  remote,
  localDefault,
  localMaximum,
}) {
  const fallback = remote ? remoteForegroundDefaultSeconds(tool) : localDefault;
  const maximum = remote ? remoteForegroundMaximumSeconds(tool) : localMaximum;
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new RangeError(`foreground timeout must be an integer from 1 to ${maximum}`);
  }
  return parsed;
}
