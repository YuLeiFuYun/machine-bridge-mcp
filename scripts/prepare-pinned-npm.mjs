import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareHardenedNpm } from "../src/local/hardened-npm.mjs";
import { createHardenedNpmLauncher } from "../src/local/hardened-npm-launcher.mjs";

const githubPath = process.env.GITHUB_PATH;
if (!githubPath) throw new Error("GITHUB_PATH is required; this bootstrap is intended for GitHub Actions");

const root = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "mbm-npm-bootstrap-"));
try {
  const hardened = join(root, "hardened");
  const prepared = await prepareHardenedNpm(hardened);
  const bin = createHardenedNpmLauncher(root, prepared.cli);
  writeFileSync(githubPath, `${bin}\n`, { flag: "a" });
  console.log(`Prepared integrity-verified hardened npm ${prepared.version} (undici ${prepared.undiciVersion}; brace-expansion ${prepared.braceExpansionVersion})`);
} catch (error) {
  let cleanupError = null;
  try { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  catch (failure) { cleanupError = failure; }
  if (cleanupError) {
    throw new AggregateError([error, cleanupError], "pinned npm bootstrap failed and temporary cleanup was incomplete");
  }
  throw error;
}
