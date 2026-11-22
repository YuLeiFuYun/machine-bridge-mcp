#!/usr/bin/env node
import { main } from "../src/local/cli/cli.mjs";
import { createLogger, sanitizeLogText } from "../src/local/core/log.mjs";
import { installFatalProcessHandlers } from "../src/local/process/settlement.mjs";

installFatalProcessHandlers({
  logger: createLogger({
    component: "process-fatal",
    level: "error",
    format: process.env.MBM_LOG_FORMAT === "json" ? "json" : "text",
    stderrOnly: true,
  }),
});

main().catch(error => {
  const message = process.env.MBM_DEBUG === "1"
    ? (error?.stack || error?.message || String(error))
    : (error?.message || String(error));
  console.error(`Error: ${sanitizeLogText(message)}`);
  process.exitCode = 1;
});
