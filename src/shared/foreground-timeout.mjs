import relayContract from "./relay-contract.json" with { type: "json" };

const CONFIGURABLE_FOREGROUND_TOOLS = new Set([
  "exec_command", "run_process", "run_local_command", "open_local_application",
  "inspect_local_application", "operate_local_application", "browser_list_tabs",
  "browser_manage_tabs", "browser_wait", "browser_get_source", "browser_inspect_page",
  "browser_action", "browser_fill_form", "browser_screenshot", "browser_upload_files",
]);

const THIRTY_SECOND_FOREGROUND_TOOLS = new Set([
  "open_local_application", "inspect_local_application", "operate_local_application",
  "browser_list_tabs", "browser_manage_tabs", "browser_wait", "browser_get_source",
  "browser_inspect_page", "browser_action", "browser_screenshot",
]);

export const REMOTE_FOREGROUND_TIMEOUT_SECONDS = Math.floor(
  relayContract.maximumInteractiveExecutionTimeoutMs / 1000,
);

export function isConfigurableForegroundTool(name) {
  return CONFIGURABLE_FOREGROUND_TOOLS.has(name);
}

export function remoteForegroundDefaultSeconds(name) {
  return THIRTY_SECOND_FOREGROUND_TOOLS.has(name) ? 30 : 60;
}

export function effectiveForegroundTimeoutSeconds({
  tool,
  value,
  remote,
  localDefault,
  localMaximum,
}) {
  const fallback = remote ? remoteForegroundDefaultSeconds(tool) : localDefault;
  const maximum = remote ? REMOTE_FOREGROUND_TIMEOUT_SECONDS : localMaximum;
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new RangeError(`foreground timeout must be an integer from 1 to ${maximum}`);
  }
  return parsed;
}
