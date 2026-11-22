import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { prepareHardenedNpm } from "../../src/local/deploy/hardened-npm.mjs";
import { createHardenedNpmLauncher } from "../../src/local/deploy/hardened-npm.mjs";
import { nestedNpmEnvironment } from "../../src/local/deploy/npm.mjs";
import { releaseCommandFailure } from "../release-diagnostic.mjs";

export function resolveNpmGlobalPrefix(npmCli, options = {}) {
  const cli = String(npmCli || "").trim();
  if (!isAbsolute(cli)) throw new TypeError("npm global prefix resolution requires an absolute npm CLI path");
  const cwd = resolve(String(options.cwd || process.cwd()));
  const run = options.run || spawnSync;
  const result = run(process.execPath, [cli, "prefix", "--global", "--json=false", "--parseable=false"], {
    cwd,
    encoding: "utf8",
    env: nestedNpmEnvironment(options.env || process.env),
    timeout: 30_000,
    killSignal: "SIGKILL",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`npm global prefix resolution failed: ${releaseCommandFailure("npm", ["prefix"], result)}`);
  }
  const prefix = String(result.stdout || "").trim();
  if (!prefix || prefix.length > 32 * 1024 || /[\0\r\n]/.test(prefix) || !isAbsolute(prefix)) {
    throw new Error("npm global prefix output is invalid");
  }
  return resolve(prefix);
}

export async function createHardenedNpmSession(options = {}) {
  const parent = resolve(String(options.tempRoot || tmpdir()));
  const root = mkdtempSync(join(parent, "mbm-hardened-npm-session-"));
  let disposed = false;
  try {
    const prepared = await prepareHardenedNpm(join(root, "runtime"), options.hardenedNpm || {});
    return Object.freeze({
      cli: prepared.cli,
      bin: createHardenedNpmLauncher(root, prepared.cli),
      version: prepared.version,
      undiciVersion: prepared.undiciVersion,
      braceExpansionVersion: prepared.braceExpansionVersion,
      dispose() {
        if (disposed) return;
        rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
        disposed = true;
      },
    });
  } catch (error) {
    try { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "hardened npm session preparation failed and temporary cleanup was incomplete"); }
    throw error;
  }
}

export function settleHardenedNpmSession(
  session,
  primaryError = null,
  aggregateMessage = "hardened npm session failed and temporary cleanup was incomplete",
) {
  try { session?.dispose(); }
  catch (cleanupError) {
    return primaryError
      ? new AggregateError([primaryError, cleanupError], aggregateMessage)
      : cleanupError;
  }
  return primaryError;
}
