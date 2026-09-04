import { execFile, spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

const COMMAND_TIMEOUT_MS = 3000;
const COMMAND_OUTPUT_BYTES = 256 * 1024;
const START_TIME_TOLERANCE_MS = 15_000;

export function isPidAlive(pid) {
  const parsed = normalizePid(pid);
  if (!parsed) return false;
  try {
    process.kill(parsed, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function currentProcessStartTimeMs() {
  const value = Number(performance.timeOrigin);
  return Number.isFinite(value) && value > 0 ? value : Date.now();
}

export function processStartTimeMs(pid) {
  const parsed = normalizePid(pid);
  if (!parsed) return null;
  if (parsed === process.pid) return currentProcessStartTimeMs();
  const [command, args] = processStartCommand(parsed);
  const result = runBounded(command, args);
  return result.ok ? parseTime(result.stdout) : null;
}

export async function processStartTimeMsAsync(pid) {
  const parsed = normalizePid(pid);
  if (!parsed) return null;
  if (parsed === process.pid) return currentProcessStartTimeMs();
  const [command, args] = processStartCommand(parsed);
  const result = await runBoundedAsync(command, args);
  return result.ok ? parseTime(result.stdout) : null;
}

export async function sampleProcessStartTimesAsync(options = {}) {
  const run = typeof options.run === "function" ? options.run : ((command, args) => runBoundedAsync(command, args, options));
  const [command, args] = processStartSnapshotCommand(options.platform || process.platform);
  const result = await run(command, args);
  if (!result?.ok) return null;
  const starts = {};
  for (const line of String(result.stdout || "").split(/\r?\n/)) {
    const parsed = parseProcessStartSnapshotLine(line);
    if (parsed) starts[String(parsed.pid)] = parsed.startedAt;
  }
  return starts;
}

export function processStartTimeFromSnapshot(snapshot, pid) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const key = String(pid);
  return Object.hasOwn(snapshot, key) ? Number(snapshot[key]) : null;
}

export function processState(pid) {
  const parsed = normalizePid(pid);
  if (!parsed || process.platform === "win32") return "unknown";
  const result = runBounded("ps", ["-p", String(parsed), "-o", "state="]);
  if (!result.ok) return "unknown";
  const state = result.stdout.trim().charAt(0).toUpperCase();
  if (state === "Z") return "zombie";
  return state ? "running" : "unknown";
}

export function processCommandLine(pid) {
  const parsed = normalizePid(pid);
  if (!parsed) return "";
  if (process.platform === "win32") {
    const command = `(Get-CimInstance Win32_Process -Filter "ProcessId = ${parsed}").CommandLine`;
    const result = runBounded("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command]);
    return result.ok ? result.stdout.trim() : "";
  }
  const result = runBounded("ps", ["-ww", "-p", String(parsed), "-o", "command="]);
  return result.ok ? result.stdout.trim() : "";
}

export function splitProcessCommandLine(value) {
  const args = [];
  let current = "";
  let quote = "";
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === quote) quote = "";
      else if (character === "\\" && quote === '"' && ['"', "\\"].includes(text[index + 1])) {
        current += text[index + 1];
        index += 1;
      } else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    if (character === "\\" && /[\s'"\\]/.test(text[index + 1] || "")) {
      current += text[index + 1];
      index += 1;
      continue;
    }
    current += character;
  }
  if (current) args.push(current);
  return args;
}

export function inspectProcessInstance(owner, options = {}) {
  const pid = normalizePid(owner?.pid);
  if (!pid) return { current: false, alive: false, reclaimable: true, reason: "invalid_pid", pid: null };
  const alive = (options.isAlive || isPidAlive)(pid);
  if (!alive) return { current: false, alive: false, reclaimable: true, reason: "not_running", pid };

  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const lockStartedAt = parseTime(owner?.startedAt);
  if (!lockStartedAt) return { current: false, alive: true, reclaimable: false, reason: "invalid_lock_timestamp", pid };
  if (lockStartedAt > now + START_TIME_TOLERANCE_MS) return { current: false, alive: true, reclaimable: false, reason: "future_lock_timestamp", pid };

  const observedStart = (options.getProcessStartTime || processStartTimeMs)(pid);
  const recordedStart = parseTime(owner?.processStartedAt);
  if (Number.isFinite(observedStart) && observedStart > 0) {
    if (recordedStart && Math.abs(observedStart - recordedStart) > START_TIME_TOLERANCE_MS) {
      return { current: false, alive: true, reclaimable: true, reason: "pid_reused", pid, process_started_at: observedStart };
    }
    if (!recordedStart && lockStartedAt + START_TIME_TOLERANCE_MS < observedStart) {
      return { current: false, alive: true, reclaimable: true, reason: "pid_reused", pid, process_started_at: observedStart };
    }
  }
  const maxAgeMs = Number(options.maxAgeMs);
  if (Number.isFinite(maxAgeMs) && maxAgeMs > 0 && now - lockStartedAt > maxAgeMs) {
    return { current: false, alive: true, reclaimable: false, reason: "lock_expired", pid, age_ms: now - lockStartedAt };
  }
  return {
    current: true,
    alive: true,
    reclaimable: false,
    reason: "current_process",
    pid,
    age_ms: Math.max(0, now - lockStartedAt),
    process_started_at: Number.isFinite(observedStart) ? observedStart : null,
  };
}

export async function inspectProcessInstanceAsync(owner, options = {}) {
  const pid = normalizePid(owner?.pid);
  if (!pid) return { current: false, alive: false, reclaimable: true, reason: "invalid_pid", pid: null };
  const alive = (options.isAlive || isPidAlive)(pid);
  if (!alive) return { current: false, alive: false, reclaimable: true, reason: "not_running", pid };
  const observedStart = await (options.getProcessStartTimeAsync || processStartTimeMsAsync)(pid);
  return inspectProcessInstance(owner, {
    ...options,
    isAlive: () => true,
    getProcessStartTime: () => observedStart,
  });
}

function processStartCommand(pid) {
  if (process.platform === "win32") {
    const command = `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CreationDate.ToUniversalTime().ToString('o')`;
    return ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command]];
  }
  return ["ps", ["-p", String(pid), "-o", "lstart="]];
}

function processStartSnapshotCommand(platform) {
  if (platform === "win32") {
    return ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId)|$($_.CreationDate.ToUniversalTime().ToString('o'))\" }"]];
  }
  return ["ps", ["-axo", "pid=,lstart="]];
}

function parseProcessStartSnapshotLine(value) {
  const line = String(value || "").trim();
  if (!line) return null;
  const pipe = /^([1-9][0-9]*)\|(.+)$/.exec(line);
  const spaced = /^([1-9][0-9]*)\s+(.+)$/.exec(line);
  const match = pipe || spaced;
  if (!match) return null;
  const startedAt = parseTime(match[2]);
  return startedAt ? { pid: Number(match[1]), startedAt } : null;
}

function runBounded(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: COMMAND_OUTPUT_BYTES,
    windowsHide: true,
    env: process.platform === "win32" ? process.env : { ...process.env, LC_ALL: "C", LANG: "C" },
    stdio: ["ignore", "pipe", "ignore"],
  });
  return { ok: !result.error && result.status === 0, stdout: String(result.stdout || "") };
}

function runBoundedAsync(command, args, options = {}) {
  const execute = typeof options.execFile === "function" ? options.execFile : execFile;
  return new Promise((resolvePromise) => {
    try {
      execute(command, args, {
        encoding: "utf8", timeout: COMMAND_TIMEOUT_MS, killSignal: "SIGKILL",
        maxBuffer: COMMAND_OUTPUT_BYTES, windowsHide: true,
        env: process.platform === "win32" ? process.env : { ...process.env, LC_ALL: "C", LANG: "C" },
      }, (error, stdout) => resolvePromise({ ok: !error, stdout: String(stdout || "") }));
    } catch {
      resolvePromise({ ok: false, stdout: "" });
    }
  });
}

function normalizePid(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

function parseTime(value) {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
  const parsed = Date.parse(String(value || "").trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
