import { spawn } from "node:child_process";

export const DEFAULT_PROCESS_TERMINATION_GRACE_MS = 2000;

export function terminateProcessTree(child, signal = "SIGTERM", options = {}) {
  if (!child?.pid) return false;
  const platform = options.platform || process.platform;
  if (platform === "win32") {
    try {
      const spawnProcess = typeof options.spawnProcess === "function" ? options.spawnProcess : spawn;
      const force = signal === "SIGKILL";
      const killer = spawnProcess("taskkill.exe", ["/PID", String(child.pid), "/T", ...(force ? ["/F"] : [])], {
        stdio: "ignore",
        windowsHide: true,
        shell: false,
      });
      const fallback = () => {
        try { child.kill(signal); } catch {}
      };
      killer?.once?.("error", fallback);
      killer?.once?.("exit", (code) => { if (code !== 0) fallback(); });
      killer?.unref?.();
      return true;
    } catch {
      // Fall through to ChildProcess.kill for environments without taskkill.
    }
  }

  const killProcess = typeof options.killProcess === "function" ? options.killProcess : process.kill.bind(process);
  try {
    killProcess(-child.pid, signal);
    return true;
  } catch {
    try {
      return child.kill(signal) !== false;
    } catch {
      return false;
    }
  }
}

export function terminateProcessTreeWithEscalation(child, options = {}) {
  const graceMs = Number.isFinite(Number(options.graceMs))
    ? Math.max(0, Number(options.graceMs))
    : DEFAULT_PROCESS_TERMINATION_GRACE_MS;
  const schedule = typeof options.setTimeout === "function" ? options.setTimeout : setTimeout;
  const terminate = typeof options.terminate === "function" ? options.terminate : terminateProcessTree;
  terminate(child, "SIGTERM", options);
  return schedule(() => {
    terminate(child, "SIGKILL", options);
    options.onEscalated?.();
  }, graceMs);
}
