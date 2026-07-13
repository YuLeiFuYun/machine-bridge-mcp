import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = resolve(root, ".wrangler", "worker-configuration.d.ts");
const wrangler = resolve(root, "node_modules", "wrangler", "bin", "wrangler.js");

mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
const result = spawnSync(process.execPath, [wrangler, "types", target], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
  windowsHide: true,
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
