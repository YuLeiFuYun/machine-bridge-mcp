import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export function createHardenedNpmLauncher(parent, cli) {
  if (typeof parent !== "string" || !isAbsolute(parent)
    || typeof cli !== "string" || !isAbsolute(cli) || /[\0\r\n]/.test(cli)) {
    throw new TypeError("hardened npm launcher requires absolute paths");
  }
  const windows = process.platform === "win32";
  const quote = windows ? cmdQuote : shellQuote;
  const command = windows
    ? `@echo off\r\n"${quote(process.execPath)}" "${quote(cli)}" %*\r\n`
    : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(cli)} "$@"\n`;
  const bin = mkdtempSync(join(parent, "npm-bin-"));
  try {
    const wrapper = join(bin, windows ? "npm.cmd" : "npm");
    writeFileSync(wrapper, command, { flag: "wx", mode: 0o700 });
    if (!windows) chmodSync(wrapper, 0o700);
    return bin;
  } catch (error) {
    try { rmSync(bin, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "hardened npm launcher creation and cleanup failed"); }
    throw error;
  }
}

export async function withHardenedNpmLauncher(parent, cli, callback) {
  const bin = createHardenedNpmLauncher(parent, cli);
  let result, primaryError, failed = false;
  try { result = await callback(bin); } catch (error) { failed = true; primaryError = error; }
  try { rmSync(bin, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  catch (cleanupError) {
    if (failed) throw new AggregateError([primaryError, cleanupError], "hardened npm operation and launcher cleanup failed");
    throw cleanupError;
  }
  if (failed) throw primaryError;
  return result;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function cmdQuote(value) {
  const text = String(value);
  if (/[\0\r\n"%&|<>^!]/.test(text)) throw new Error("Windows wrapper path contains an unsupported character");
  return text;
}
