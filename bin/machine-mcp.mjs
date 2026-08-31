#!/usr/bin/env node
import { main } from "../src/local/cli.mjs";
import { sanitizeLogText } from "../src/local/log.mjs";

main().catch(error => {
  const message = process.env.MBM_DEBUG === "1"
    ? sanitizeLogText(error?.stack || error?.message || String(error))
    : (error?.message || String(error));
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
