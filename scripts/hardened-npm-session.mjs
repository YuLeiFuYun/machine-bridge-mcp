import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepareHardenedNpm } from "../src/local/hardened-npm.mjs";

export async function createHardenedNpmSession(options = {}) {
  const parent = resolve(String(options.tempRoot || tmpdir()));
  const root = mkdtempSync(join(parent, "mbm-hardened-npm-session-"));
  let disposed = false;
  try {
    const prepared = await prepareHardenedNpm(join(root, "runtime"), options.hardenedNpm || {});
    return Object.freeze({
      cli: prepared.cli,
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
