import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runCompletedWranglerCommand } from "./wrangler-command-lifecycle.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = resolve(root, ".wrangler", "worker-configuration.d.ts");
const wrangler = resolve(root, "node_modules", "wrangler", "bin", "wrangler.js");
export const WRANGLER_TYPES_COMPLETION_MARKER = "Remember to rerun 'wrangler types' after you change your ";

export async function runWranglerTypes(options = {}) {
  const cwd = options.cwd || root;
  const targetPath = options.targetPath || target;
  const wranglerPath = options.wranglerPath || wrangler;
  mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
  rmSync(targetPath, { force: true });
  await runCompletedWranglerCommand({
    ...options,
    cwd,
    wranglerPath,
    args: ["types", targetPath],
    label: "wrangler types",
    completionMarker: WRANGLER_TYPES_COMPLETION_MARKER,
    completionCheck: () => existsSync(targetPath),
  });
}

if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) await runWranglerTypes();
