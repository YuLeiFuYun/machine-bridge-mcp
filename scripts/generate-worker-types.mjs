import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runCompletedWranglerCommand } from "./wrangler-command-lifecycle.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = resolve(root, ".wrangler", "worker-configuration.d.ts");
const wrangler = resolve(root, "node_modules", "wrangler", "bin", "wrangler.js");
export const WRANGLER_TYPES_COMPLETION_MARKER = "Remember to rerun 'wrangler types' after you change your ";

export async function runWranglerTypes(options = {}) {
  const cwd = resolve(options.cwd || root);
  const targetPath = options.targetPath ? resolve(cwd, options.targetPath) : target;
  const wranglerPath = options.wranglerPath || wrangler;
  const targetArgument = relative(cwd, targetPath);
  if (!targetArgument || isAbsolute(targetArgument) || targetArgument === ".." || targetArgument.startsWith(`..${sep}`)) {
    throw new Error("Wrangler types target must remain inside its working directory");
  }
  mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
  rmSync(targetPath, { force: true });
  await runCompletedWranglerCommand({
    ...options,
    cwd,
    wranglerPath,
    args: ["types", targetArgument],
    label: "wrangler types",
    completionMarker: WRANGLER_TYPES_COMPLETION_MARKER,
    completionCheck: () => existsSync(targetPath),
  });
}

if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) await runWranglerTypes();
