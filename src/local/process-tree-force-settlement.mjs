import { spawn } from "node:child_process";
import { terminateProcessTree } from "./process-tree-signal.mjs";

export const DEFAULT_FORCE_TREE_SETTLEMENT_MS = 5_000;

export function terminateProcessTreeAndWait(child, signal = "SIGKILL", options = {}) {
  if (!child?.pid) return Promise.resolve(false);
  if (String(options.platform || process.platform) !== "win32") {
    return Promise.resolve(terminateProcessTree(child, signal, options));
  }
  const spawnProcess = typeof options.spawnProcess === "function" ? options.spawnProcess : spawn;
  const schedule = typeof options.setTimeout === "function" ? options.setTimeout : setTimeout;
  const clearSchedule = typeof options.clearTimeout === "function" ? options.clearTimeout : clearTimeout;
  const waitMs = boundedWait(options.waitMs);
  return new Promise((resolvePromise) => {
    let killer;
    let timer;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearSchedule(timer);
      resolvePromise(value === true);
    };
    const fallback = () => {
      try { child.kill(signal); } catch { /* Request failure is reported by the false settlement below. */ }
      finish(false);
    };
    try {
      killer = spawnProcess("taskkill.exe", ["/PID", String(child.pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])], {
        stdio: "ignore", windowsHide: true, shell: false,
      });
    } catch { fallback(); return; }
    killer.once?.("error", fallback);
    killer.once?.("close", (code) => { if (code === 0) finish(true); else fallback(); });
    timer = schedule(() => {
      try { killer.kill?.("SIGKILL"); } catch { /* The bounded false settlement remains authoritative. */ }
      fallback();
    }, waitMs);
  });
}

function boundedWait(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.min(30_000, Math.floor(parsed)) : DEFAULT_FORCE_TREE_SETTLEMENT_MS;
}
