import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { restartOwnedServiceRuntime } from "./service-runtime.mjs";
import { createLogger } from "../core/log.mjs";
import { acquireMachineServiceLockWithWait } from "../state/state.mjs";
import { spawn } from "node:child_process";
import { BridgeError } from "../core/errors.mjs";

const HANDOFF_DELAY_MS = 300;

const MAX_DELAY_MS = 5_000;

export async function runServiceRestartHandoff(options = {}) {
  const delayMs = boundedDelay(options.delayMs ?? process.argv[2]);
  const restart = typeof options.restartServiceRuntime === "function"
    ? options.restartServiceRuntime
    : typeof options.restartAutostart === "function" ? options.restartAutostart : restartOwnedServiceRuntime;
  const sleep = typeof options.sleep === "function" ? options.sleep : handoffDelay;
  const logger = options.logger || createLogger({ component: "service-restart", level: "warn", format: "json", stderrOnly: true });
  const acquireLock = typeof options.acquireServiceLock === "function"
    ? options.acquireServiceLock
    : () => acquireMachineServiceLockWithWait({ operation: "service-restart", logger, ...(options.serviceLockOptions || {}) });
  await sleep(delayMs);
  const lock = await acquireLock();
  if (!lock?.acquired || typeof lock.release !== "function") {
    throw new Error("machine-service operation lock could not be acquired for restart");
  }
  try {
    const result = await restart({ logger });
    if (result?.ok !== true) {
      const error = new Error(`service restart handoff failed (${result?.reason || result?.provider || "unknown"})`);
      error.result = result;
      throw error;
    }
    return result;
  } finally {
    lock.release();
  }
}

export async function serviceRestartHandoffMain(options = {}) {
  const run = typeof options.run === "function"
    ? options.run
    : () => runServiceRestartHandoff(options.handoffOptions);
  const logger = options.logger || createLogger({ component: "service-restart", level: "error", format: "json", stderrOnly: true });
  try {
    await run();
    return 0;
  } catch (error) {
    logger.error("service restart handoff failed", { error_class: error?.code || error?.name || "execution_failed" });
    return 1;
  }
}

function boundedDelay(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return HANDOFF_DELAY_MS;
  return Math.min(MAX_DELAY_MS, Math.max(50, Math.floor(parsed)));
}

function handoffDelay(milliseconds) {
  return new Promise((resolvePromise) => { setTimeout(resolvePromise, milliseconds); });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await serviceRestartHandoffMain();
}
const DEFAULT_HANDOFF_DELAY_MS = 300;

export function scheduleServiceRestart(options = {}) {
  const platform = String(options.platform || process.platform);
  if (platform === "win32") {
    throw new BridgeError("unavailable", "in-process Windows service restart is not behavior-verified; run `machine-mcp service stop` and then `machine-mcp service start` from an independent terminal");
  }
  const spawnProcess = typeof options.spawnProcess === "function" ? options.spawnProcess : spawn;
  const node = String(options.node || process.execPath);
  const helper = String(options.helper || fileURLToPath(new URL("./service-handoff.mjs", import.meta.url)));
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
