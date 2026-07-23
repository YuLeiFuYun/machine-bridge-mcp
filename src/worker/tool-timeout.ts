import relayContract from "../shared/relay-contract.json" with { type: "json" };

export function daemonToolTimeoutMs(name: string, args: Record<string, unknown>): number {
  if (name === "session_bootstrap") return 10_000;
  const configurable = new Set([
    "exec_command", "run_process", "run_local_command", "open_local_application",
    "inspect_local_application", "operate_local_application", "browser_list_tabs",
    "browser_manage_tabs", "browser_wait", "browser_get_source", "browser_inspect_page",
    "browser_action", "browser_fill_form", "browser_screenshot", "browser_upload_files",
  ]);
  if (!configurable.has(name)) return 60_000;
  const seconds = clampNumber(args.timeout_seconds, name === "browser_fill_form" ? 60 : 120, 1, 600);
  const executionMs = Math.min(seconds * 1000, relayContract.maximumExecutionTimeoutMs);
  return Math.min(executionMs + relayContract.toolCallOverheadMs, relayContract.maximumRelayToolTimeoutMs);
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === "number" && Number.isFinite(value) ? value : Number.parseInt(String(value ?? ""), 10);
  const safe = Number.isFinite(number) ? number : fallback;
  return Math.min(Math.max(Math.floor(safe), min), max);
}
