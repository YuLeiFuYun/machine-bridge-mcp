import { execFile, spawnSync } from "node:child_process";

export function runResourceProbeSync(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: positive(options.timeoutMs, 2_500),
    killSignal: "SIGKILL",
    maxBuffer: positive(options.maxOutputBytes, 256 * 1024),
    windowsHide: true,
    env: probeEnvironment(),
    stdio: ["ignore", "pipe", "ignore"],
  });
  return { ok: !result.error && result.status === 0, stdout: String(result.stdout || "") };
}

export function runResourceProbeAsync(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    execFile(command, args, {
      encoding: "utf8",
      timeout: positive(options.timeoutMs, 2_500),
      killSignal: "SIGKILL",
      maxBuffer: positive(options.maxOutputBytes, 256 * 1024),
      windowsHide: true,
      env: probeEnvironment(),
    }, (error, stdout) => resolvePromise({ ok: !error, stdout: String(stdout || "") }));
  });
}

function probeEnvironment() {
  return process.platform === "win32" ? process.env : { ...process.env, LC_ALL: "C", LANG: "C" };
}
function positive(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
