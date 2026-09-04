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
    let killer; let descendantSweep; let timer;
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
    const sweepDescendants = () => {
      const pid = Number(child.pid);
      const script = windowsDescendantSweepScript(pid);
      try { descendantSweep = spawnProcess("powershell.exe", [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script,
      ], { stdio: "ignore", windowsHide: true, shell: false }); } catch { fallback(); return; }
      descendantSweep.once?.("error", fallback);
      descendantSweep.once?.("close", (code) => { if (code === 0) finish(true); else fallback(); });
    };
    try {
      killer = spawnProcess("taskkill.exe", ["/PID", String(child.pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])], {
        stdio: "ignore", windowsHide: true, shell: false,
      });
    } catch { fallback(); return; }
    killer.once?.("error", fallback);
    killer.once?.("close", (code) => { if (code === 0) sweepDescendants(); else fallback(); });
    timer = schedule(() => {
      try { killer.kill?.("SIGKILL"); } catch { /* The bounded false settlement remains authoritative. */ }
      try { descendantSweep?.kill?.("SIGKILL"); } catch { /* The bounded false settlement remains authoritative. */ }
      fallback();
    }, waitMs);
  });
}

function windowsDescendantSweepScript(rootPid) {
  if (!Number.isSafeInteger(rootPid) || rootPid < 1) throw new TypeError("Windows process-tree root PID is invalid");
  return `$ErrorActionPreference='Stop'; $root=${rootPid}; $roots=New-Object 'System.Collections.Generic.HashSet[int]'; [void]$roots.Add($root); for($pass=0; $pass -lt 3; $pass++){ $all=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId); do { $changed=$false; foreach($p in $all){ $processId=[int]$p.ProcessId; $parentId=[int]$p.ParentProcessId; if($processId -ne $root -and $roots.Contains($parentId) -and $roots.Add($processId)){ $changed=$true } } } while($changed); $targets=@($roots | Where-Object { $_ -ne $root }); foreach($processId in $targets){ Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 75 }; $live=@(Get-CimInstance Win32_Process | Select-Object -ExpandProperty ProcessId); foreach($liveId in $live){ if($liveId -ne $root -and $roots.Contains([int]$liveId)){ exit 1 } }; exit 0`;
}

function boundedWait(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.min(30_000, Math.floor(parsed)) : DEFAULT_FORCE_TREE_SETTLEMENT_MS;
}
