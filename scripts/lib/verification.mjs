import { parse } from "@babel/parser";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readlinkSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import process from "node:process";
import { nestedNpmEnvironment } from "../../src/local/deploy/npm.mjs";
import { processStartTimeMs } from "../../src/local/process/identity.mjs";
import { readBoundedRegularFileWithInfoSync } from "../../src/local/core/secure-file.mjs";

export function escapeMarkdownTableCell(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|");
}

export function normalizeLineEndings(value) {
  return String(value).replace(/\r\n/g, "\n");
}

export async function runWithStableGeneration({ captureGeneration, run, label = "verification inputs" }) {
  if (typeof captureGeneration !== "function") throw new TypeError("captureGeneration must be a function");
  if (typeof run !== "function") throw new TypeError("run must be a function");
  const before = captureGeneration();
  let result;
  let runError;
  try { result = await run(); }
  catch (error) { runError = error; }
  const after = captureGeneration();
  if (after !== before) {
    throw new Error(`${label} changed during verification; discard this run (${before} -> ${after})`);
  }
  if (runError) throw runError;
  return result;
}

const VERIFICATION_ISOLATED_ENVIRONMENT_KEYS = new Set([
  "MBM_DEBUG",
  "MBM_MACOS_BACKGROUND_VISUAL_BACKEND",
  "MBM_MACOS_TRUST_BROKER",
  "MBM_RELAY_FALLBACK_PROXY",
  "MBM_RELAY_PROXY",
]);

export function verificationChildEnvironment(environment = process.env) {
  const result = nestedNpmEnvironment(environment);
  for (const key of Object.keys(result)) {
    if (VERIFICATION_ISOLATED_ENVIRONMENT_KEYS.has(key.toUpperCase())) delete result[key];
  }
  return result;
}

/** @param {string} source @param {string} [filename] */
export function parseAst(source, filename = "module.ts") {
  const isDts = /\.d\.[cm]?ts$/u.test(filename);
  return parse(String(source || ""), {
    sourceType: "module",
    sourceFilename: filename,
    plugins: [
      ["typescript", { dts: isDts }],
      "jsx",
      "importAttributes",
      "explicitResourceManagement",
    ],
    createImportExpressions: true,
    attachComment: false,
    errorRecovery: false,
  });
}

export const sourceDependencyTreeInstallTimeoutMs = 20 * 60 * 1000;

export function sourceDependencyTreeInstallArguments(repositoryRoot) {
  const value = String(repositoryRoot || "").trim();
  if (!value) throw new TypeError("source dependency installation requires a repository root");
  const root = resolve(value);
  return [
    "ci",
    "--dry-run=false",
    "--workspaces=false",
    "--global=false",
    "--ignore-scripts=false",
    "--package-lock-only=false",
    "--audit=false",
    "--fund=false",
    "--logs-max=0",
    "--prefix", root,
  ];
}

// Tasks that cannot complete on a host without a readable process start time: durable job
// recovery has to prove a recovered pid is still the same process.
const PROCESS_IDENTITY_TASKS = new Set(["agent-workflows:test", "test:agent", "self-test"]);

/**
 * Fail before the plan spends minutes on work the host cannot complete.
 *
 * @param {string[]} tasks
 * @param {{platform?: string, env?: Record<string, string | undefined>, probe?: (pid: number) => number | null, ppid?: number}} [options]
 */
export function assertHostCapabilities(tasks, options = {}) {
  const list = Array.isArray(tasks) ? tasks : [];
  const platform = options.platform || process.platform;
  if (platform === "win32") return;
  const env = options.env || process.env;
  const needed = list.filter((task) => {
    if (!PROCESS_IDENTITY_TASKS.has(task)) return false;
    return task === "agent-workflows:test" || task === "test:agent"
      ? env.MBM_ALLOW_AGENT_WORKFLOW_SKIP !== "1"
      : true;
  });
  if (!needed.length) return;
  const probe = typeof options.probe === "function" ? options.probe : processStartTimeMs;
  const ppid = Number.isInteger(options.ppid) ? options.ppid : process.ppid;
  if (probe(ppid) !== null) return;
  throw new Error(
    `${needed[0]} requires a host process start time from /proc or ps, and this host cannot provide one `
    + "(a sandbox or missing permissions is the usual cause). Fix the host before running this plan; "
    + "durable job recovery cannot verify a recovered pid without it.",
  );
}

export const VERIFICATION_IDLE_SLEEP_GUARD_ENV = "MBM_CHECK_IDLE_SLEEP_GUARD";

export async function rerunVerificationUnderIdleSleepGuard(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (platform !== "darwin" || env[VERIFICATION_IDLE_SLEEP_GUARD_ENV] === "1") return null;

  const executable = String(options.execPath || process.execPath);
  const argv = Array.isArray(options.argv) ? options.argv.map(String) : process.argv.slice(1);
  if (!executable || argv.length === 0 || !argv[0]) {
    throw new Error("verification idle-sleep guard requires the current Node executable and entrypoint");
  }
  const spawnProcess = typeof options.spawnProcess === "function" ? options.spawnProcess : spawn;
  let child;
  try {
    child = spawnProcess("/usr/bin/caffeinate", ["-i", executable, ...argv], {
      env: { ...env, [VERIFICATION_IDLE_SLEEP_GUARD_ENV]: "1" },
      stdio: "inherit",
      shell: false,
      windowsHide: true,
    });
  } catch (error) {
    throw new Error("could not start the macOS verification idle-sleep guard", { cause: error });
  }
  return await new Promise((resolvePromise, rejectPromise) => {
    child.once("error", (error) => {
      rejectPromise(new Error("could not start the macOS verification idle-sleep guard", { cause: error }));
    });
    child.once("close", (code, signal) => {
      if (Number.isInteger(code)) resolvePromise(code);
      else rejectPromise(new Error(`macOS verification idle-sleep guard ended by signal ${signal || "unknown"}`));
    });
  });
}

const DEFAULT_ROOTS = ["src", "scripts", "tests", "browser-extension", ".github/scripts"];
const DEFAULT_FILES = ["package.json", "package-lock.json", "tsconfig.json", "tsconfig.local.json", "wrangler.jsonc"];
const MAX_GENERATION_FILE_BYTES = 16 * 1024 * 1024;

export function captureCoverageGeneration(root, options = {}) {
  const entries = [];
  for (const name of options.roots || DEFAULT_ROOTS) collectGenerationEntry(join(root, name), root, entries);
  for (const name of options.files || DEFAULT_FILES) collectGenerationEntry(join(root, name), root, entries);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(entry.path); hash.update("\0"); hash.update(String(entry.mode)); hash.update("\0");
    hash.update(entry.content); hash.update("\0");
  }
  return hash.digest("hex");
}

function collectGenerationEntry(path, root, entries) {
  let info;
  try { info = lstatSync(path); } catch (error) { if (error?.code === "ENOENT") return; throw error; }
  const name = relative(root, path).split("\\").join("/");
  const mode = Number(info.mode) & 0o777;
  if (info.isSymbolicLink()) {
    entries.push({ path: name, mode, content: Buffer.from(`link:${readlinkSync(path)}`) });
    return;
  }
  if (info.isFile()) {
    const snapshot = readBoundedRegularFileWithInfoSync(path, MAX_GENERATION_FILE_BYTES, `verification input ${name}`, {
      verifyPathIdentity: true,
    });
    entries.push({ path: name, mode: Number(snapshot.info.mode) & 0o777, content: snapshot.buffer });
    return;
  }
  if (!info.isDirectory()) return;
  for (const entry of readdirSync(path, { withFileTypes: true })) collectGenerationEntry(join(path, entry.name), root, entries);
}

export function mergeFunctionExecutions(executions = []) {
  const normalized = executions.map(normalizeExecution).filter((ranges) => ranges.length);
  const functionCovered = normalized.some((ranges) => ranges[0].count > 0);
  const candidates = new Map();
  for (const ranges of normalized) {
    for (const range of ranges.slice(1)) candidates.set(rangeKey(range), range);
  }
  return {
    functionCovered,
    blocks: new Map([...candidates].map(([key, range]) => [
      key,
      rangeCoveredAcrossExecutions(normalized, range.startOffset, range.endOffset),
    ])),
  };
}

export function rangeCoveredAcrossExecutions(executions, startOffset, endOffset) {
  if (!(Number.isInteger(startOffset) && Number.isInteger(endOffset) && startOffset < endOffset)) return false;
  return (executions || []).some((ranges) => effectiveRangeCount(ranges, startOffset, endOffset) > 0);
}

function effectiveRangeCount(ranges, startOffset, endOffset) {
  let selected = null;
  for (const range of ranges || []) {
    if (range.startOffset > startOffset || range.endOffset < endOffset) continue;
    if (!selected || range.endOffset - range.startOffset <= selected.endOffset - selected.startOffset) selected = range;
  }
  return selected ? selected.count : 0;
}

function normalizeExecution(ranges) {
  return (ranges || []).map((range) => ({
    startOffset: Number(range.startOffset),
    endOffset: Number(range.endOffset),
    count: Math.max(0, Number(range.count) || 0),
  })).filter((range) => Number.isInteger(range.startOffset) && Number.isInteger(range.endOffset) && range.startOffset < range.endOffset);
}

function rangeKey(range) {
  return `${range.startOffset}:${range.endOffset}`;
}
