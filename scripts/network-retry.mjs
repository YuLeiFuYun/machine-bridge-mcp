import { spawnSync } from "node:child_process";

const WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));
const TRANSIENT_NETWORK_FAILURE = /(?:SSL_ERROR_SYSCALL|SSL_connect|TLS handshake timeout|Client network socket disconnected before secure TLS connection was established|unexpected EOF|unexpected eof while reading|\bEOF\b|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|ECONNREFUSED|Could not resolve host|Failed to connect|connection (?:was )?reset|remote end hung up|unexpected disconnect|HTTP (?:429|5\d\d)|(?:502|503|504) (?:Bad Gateway|Service Unavailable|Gateway Timeout))/i;

export function runNetworkCommand(command, args, options = {}) {
  const attempts = clampInteger(options.attempts, 3, 1, 5);
  const baseDelayMs = clampInteger(options.baseDelayMs, 750, 0, 10_000);
  const timeoutMs = clampInteger(options.timeoutMs, 120_000, 10, 600_000);
  const actualArgs = networkCommandArgs(command, args);
  let result;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    result = spawnSync(command, actualArgs, {
      cwd: options.cwd,
      encoding: "utf8",
      stdio: "pipe",
      env: options.env,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    result.attempts = attempt;
    if (!isTransientNetworkFailure(result) || attempt === attempts) return result;
    sleepSync(Math.min(baseDelayMs * attempt, 5_000));
  }
  return result;
}

export function networkCommandArgs(command, args) {
  const executable = String(command || "");
  return /(?:^|[\\/])git(?:\.exe)?$/i.test(executable)
    ? ["-c", "http.version=HTTP/1.1", ...args]
    : [...args];
}

export function isTransientNetworkFailure(result) {
  if (result?.error) {
    const code = String(result.error.code || "");
    if (["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENETUNREACH", "ECONNREFUSED"].includes(code)) return true;
  }
  const detail = `${result?.stdout ?? ""}\n${result?.stderr ?? ""}\n${result?.error?.message ?? ""}`;
  return TRANSIENT_NETWORK_FAILURE.test(detail);
}

function sleepSync(milliseconds) {
  if (milliseconds > 0) Atomics.wait(WAIT_BUFFER, 0, 0, milliseconds);
}

function clampInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  const number = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(Math.max(number, minimum), maximum);
}
