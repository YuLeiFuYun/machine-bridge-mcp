import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareHardenedNpm } from "../src/local/hardened-npm.mjs";

const githubPath = process.env.GITHUB_PATH;
if (!githubPath) throw new Error("GITHUB_PATH is required; this bootstrap is intended for GitHub Actions");

const root = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "mbm-npm-bootstrap-"));
try {
  const hardened = join(root, "hardened");
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const prepared = await prepareHardenedNpm(hardened);

  const posixWrapper = join(bin, "npm");
  writeFileSync(posixWrapper, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(prepared.cli)} "$@"\n`, { mode: 0o755 });
  chmodSync(posixWrapper, 0o755);
  writeFileSync(join(bin, "npm.cmd"), `@echo off\r\n"${cmdQuote(process.execPath)}" "${cmdQuote(prepared.cli)}" %*\r\n`);
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

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function cmdQuote(value) {
  const text = String(value);
  if (/[\0\r\n"%&|<>^!]/.test(text)) throw new Error("Windows wrapper path contains an unsupported character");
  return text;
}
