import { realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { packageName, packageRoot, packageVersion } from "./package-identity.mjs";
import { readOptionalRegularUtf8 } from "./project-metadata.mjs";
import { releaseControlCommandIsLight } from "./resource-release-control-classification.mjs";
import { releaseControlExecutableIsTrusted } from "./resource-release-control-executable.mjs";

const PACKAGE_BYTES = 1024 * 1024, ENTRY_BYTES = 256 * 1024;
const CANARY_ENTRY = join("scripts", "release-oauth-canary.mjs");

export async function releaseControlWorkspaceForCommand(command, args = [], cwd = "", environment = {}) {
  const base = basename(String(command || "")).toLowerCase();
  const values = args.map((value) => String(value));
  if (!releaseControlCommandIsLight(base, values)) return false;
  if (!await releaseControlExecutableIsTrusted(command, environment, { cwd })) return false;
  if (!await releaseControlRuntimeEntrypointMatches(values[0])) return false;
  return releaseControlWorkspaceMatches(cwd);
}

export async function releaseControlWorkspaceMatches(cwd) {
  if (typeof cwd !== "string" || !cwd.trim()) return false;
  try {
    const root = resolve(cwd);
    const packageText = await readOptionalRegularUtf8(join(root, "package.json"), PACKAGE_BYTES);
    if (!packageText) return false;
    const manifest = JSON.parse(packageText);
    if (manifest?.name !== packageName || manifest?.version !== packageVersion) return false;
    const [target, runtime] = await Promise.all([
      readOptionalRegularUtf8(join(root, CANARY_ENTRY), ENTRY_BYTES),
      readOptionalRegularUtf8(join(packageRoot, CANARY_ENTRY), ENTRY_BYTES),
    ]);
    return target !== null && target === runtime;
  } catch { return false; }
}

async function releaseControlRuntimeEntrypointMatches(entry) {
  try {
    const [target, runtime] = await Promise.all([realpath(String(entry || "")), realpath(join(packageRoot, CANARY_ENTRY))]);
    return process.platform === "win32" ? target.toLowerCase() === runtime.toLowerCase() : target === runtime;
  } catch { return false; }
}
