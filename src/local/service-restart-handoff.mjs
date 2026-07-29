import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { restartOwnedServiceRuntime } from "./service-runtime.mjs";
import { createLogger } from "./log.mjs";
import { acquireMachineServiceLockWithWait } from "./state.mjs";

const DEFAULT_DELAY_MS = 300;
const MAX_DELAY_MS = 5_000;

export async function runServiceRestartHandoff(options = {}) {
  const delayMs = boundedDelay(options.delayMs ?? process.argv[2]);
  const restart = typeof options.restartServiceRuntime === "function"
    ? options.restartServiceRuntime
    : typeof options.restartAutostart === "function" ? options.restartAutostart : restartOwnedServiceRuntime;
  const sleep = typeof options.sleep === "function" ? options.sleep : delay;
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
  if (!Number.isFinite(parsed)) return DEFAULT_DELAY_MS;
  return Math.min(MAX_DELAY_MS, Math.max(50, Math.floor(parsed)));
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => { setTimeout(resolvePromise, milliseconds); });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await serviceRestartHandoffMain();
}
