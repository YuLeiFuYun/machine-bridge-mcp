import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runCompletedWranglerCommand } from "./wrangler-command-lifecycle.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = resolve(root, "node_modules", "wrangler", "bin", "wrangler.js");
export const WRANGLER_DRY_RUN_COMPLETION_MARKER = "--dry-run: exiting now.";

export async function runWorkerDryRun(options = {}) {
  await runCompletedWranglerCommand({
    ...options,
    cwd: options.cwd || root,
    wranglerPath: options.wranglerPath || wrangler,
    args: ["deploy", "--dry-run"],
    label: "wrangler deploy --dry-run",
    completionMarker: WRANGLER_DRY_RUN_COMPLETION_MARKER,
  });
}

if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) await runWorkerDryRun();
