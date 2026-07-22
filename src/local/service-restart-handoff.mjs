import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { restartAutostart } from "./service.mjs";
import { createLogger } from "./log.mjs";

const DEFAULT_DELAY_MS = 300;
const MAX_DELAY_MS = 5_000;

export async function runServiceRestartHandoff(options = {}) {
  const delayMs = boundedDelay(options.delayMs ?? process.argv[2]);
  const restart = typeof options.restartAutostart === "function" ? options.restartAutostart : restartAutostart;
  const sleep = typeof options.sleep === "function" ? options.sleep : delay;
  const logger = options.logger || createLogger({ component: "service-restart", level: "warn", format: "json", stderrOnly: true });
  await sleep(delayMs);
  const result = await restart({ logger });
  if (result?.ok !== true) {
    const error = new Error(`service restart handoff failed (${result?.reason || result?.provider || "unknown"})`);
    error.result = result;
    throw error;
  }
  return result;
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
