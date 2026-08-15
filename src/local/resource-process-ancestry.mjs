import { runResourceProbeAsync, runResourceProbeSync } from "./resource-probe-command.mjs";

const COMMAND_OPTIONS = { timeoutMs: 3_000, maxOutputBytes: 1024 * 1024 };

export function sampleResourceProcessParents(options = {}) {
  const run = options.run || ((command, args) => runResourceProbeSync(command, args, COMMAND_OPTIONS));
  const result = processParentCommand(run);
  return result?.ok ? parseResourceProcessParents(result.stdout) : null;
}

export async function sampleResourceProcessParentsAsync(options = {}) {
  const run = options.run || ((command, args) => runResourceProbeAsync(command, args, COMMAND_OPTIONS));
  const result = await processParentCommand(run);
  return result?.ok ? parseResourceProcessParents(result.stdout) : null;
}

export function parseResourceProcessParents(value) {
  const parents = {};
  for (const line of String(value || "").split(/\r?\n/)) {
    const match = /^\s*([1-9][0-9]*)\s+([0-9]+)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]); const parent = Number(match[2]);
    if (Number.isInteger(pid) && pid > 0 && Number.isInteger(parent) && parent >= 0) parents[String(pid)] = parent;
  }
  return Object.keys(parents).length ? parents : null;
}

function processParentCommand(run) {
  return process.platform === "win32"
    ? run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }"])
    : run("ps", ["-axo", "pid=,ppid="]);
}
