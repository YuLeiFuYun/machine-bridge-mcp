import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BridgeError } from "./errors.mjs";

const DEFAULT_HANDOFF_DELAY_MS = 300;

export function scheduleServiceRestart(options = {}) {
  const platform = String(options.platform || process.platform);
  if (platform === "win32") {
    throw new BridgeError("unavailable", "in-process Windows service restart is not behavior-verified; run `machine-mcp service stop` and then `machine-mcp service start` from an independent terminal");
  }
  const spawnProcess = typeof options.spawnProcess === "function" ? options.spawnProcess : spawn;
  const node = String(options.node || process.execPath);
  const helper = String(options.helper || fileURLToPath(new URL("./service-restart-handoff.mjs", import.meta.url)));
  const delayMs = boundedPositiveInteger(options.delayMs, DEFAULT_HANDOFF_DELAY_MS);
  const child = spawnProcess(node, [helper, String(delayMs)], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    shell: false,
    env: serviceControlEnvironment(options.env || process.env),
  });
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      callback();
    };
    child.once("spawn", () => settle(() => {
      child.unref?.();
      resolvePromise({ ok: true, scheduled: true, delay_ms: delayMs });
    }));
    child.once("error", (error) => settle(() => rejectPromise(error)));
  });
}

export function serviceControlEnvironment(source = {}) {
  const env = {};
  for (const key of ["PATH", "HOME", "USERPROFILE", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "LC_CTYPE"]) {
    if (typeof source[key] === "string" && source[key]) env[key] = source[key];
  }
  return env;
}

function boundedPositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
