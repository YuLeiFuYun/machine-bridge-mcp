import {
  existsSync, mkdirSync, readFileSync, realpathSync, rmSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  brotliCompressSync, brotliDecompressSync, constants as zlibConstants,
} from "node:zlib";
import { readBoundedRegularFileWithInfoSync } from "../src/local/secure-file.mjs";
import { replaceFileAtomicallySync } from "../src/local/exclusive-file.mjs";
import { runCompletedWranglerCommand } from "./wrangler-command-lifecycle.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = resolve(root, ".wrangler", "worker-configuration.d.ts");
const seed = resolve(root, "toolchain", "worker-runtime-types-seed.b64");
const wrangler = resolve(root, "node_modules", "wrangler", "bin", "wrangler.js");
const wranglerConfig = resolve(root, "wrangler.jsonc");
const workerdPackage = resolve(root, "node_modules", "workerd", "package.json");
const RUNTIME_MARKER = "// Begin runtime types\n";
const RUNTIME_HEADER = /^\/\/ Runtime types generated with workerd@[^\r\n]+$/gm;
const SEED_LINE_WIDTH = 76;
export const WRANGLER_TYPES_COMPLETION_MARKER = "Remember to rerun 'wrangler types' after you change your ";

export async function runWranglerTypes(options = {}) {
  const state = prepareWranglerTypesRun(options);
  mkdirSync(dirname(state.targetPath), { recursive: true, mode: 0o700 });
  try {
    const trustedSeed = prepareRuntimeSeedInput(state);
    const generatedRuntime = await generateRuntimeTypes(state, options);
    persistOrVerifyRuntimeSeed(state, generatedRuntime, trustedSeed);
  } catch (error) {
    try { restoreWranglerTypesRun(state); }
    catch (recoveryError) {
      throw new AggregateError([error, recoveryError], "Worker types generation failed and recovery was incomplete");
    }
    throw error;
  }
}

function prepareWranglerTypesRun(options) {
  const cwd = resolve(options.cwd || root);
  const targetPath = options.targetPath ? resolve(cwd, options.targetPath) : target;
  const seedPath = options.seedPath ? resolve(cwd, options.seedPath) : seed;
  const targetArgument = wranglerTypesTargetArgument(cwd, targetPath);
  assertTargetParent(cwd, targetPath);
  const targetSnapshot = snapshotFile(targetPath);
  return {
    cwd,
    targetPath,
    seedPath,
    targetArgument,
    wranglerPath: options.wranglerPath || wrangler,
    refreshRuntimeSeed: options.refreshRuntimeSeed === true,
    expectedHeader: options.expectedRuntimeHeader || expectedRuntimeHeader({
      configPath: options.configPath || wranglerConfig,
      workerdPackagePath: options.workerdPackagePath || workerdPackage,
    }),
    targetSnapshot,
    targetWitness: targetSnapshot,
    seedSnapshot: snapshotFile(seedPath),
  };
}

function wranglerTypesTargetArgument(cwd, targetPath) {
  const targetArgument = relative(cwd, targetPath);
  if (!targetArgument || isAbsolute(targetArgument) || targetArgument === ".." || targetArgument.startsWith(`..${sep}`)) {
    throw new Error("Wrangler types target must remain inside its working directory");
  }
  return targetArgument;
}

function prepareRuntimeSeedInput(state) {
  if (state.refreshRuntimeSeed) {
    rmSync(state.targetPath, { force: true });
    state.targetWitness = snapshotFile(state.targetPath);
    return null;
  }
  const trustedSeed = decodeRuntimeSeed(state.seedPath, state.expectedHeader);
  seedRuntimeCacheIfNeeded(state.targetPath, trustedSeed);
  state.targetWitness = snapshotFile(state.targetPath);
  return trustedSeed;
}

async function generateRuntimeTypes(state, options) {
  await runCompletedWranglerCommand({
    ...options,
    cwd: state.cwd,
    wranglerPath: state.wranglerPath,
    args: ["types", state.targetArgument],
    label: "wrangler types",
    completionMarker: WRANGLER_TYPES_COMPLETION_MARKER,
    completionCheck: () => existsSync(state.targetPath),
  });
  assertTargetParent(state.cwd, state.targetPath);
  const generatedSnapshot = snapshotFile(state.targetPath);
  if (!generatedSnapshot.exists) throw new Error("generated Worker types are missing");
  if (state.targetWitness.exists && !sameFile(state.targetWitness, generatedSnapshot)) {
    throw new Error("Worker types target changed during generation; replacement preserved");
  }
  state.targetWitness = generatedSnapshot;
  const generated = strictUtf8(generatedSnapshot.bytes, "generated Worker types");
  const generatedRuntime = extractRuntimePayload(generated);
  if (generatedRuntime.header !== state.expectedHeader) {
    throw new Error("generated Worker runtime header does not match the current workerd compatibility contract");
  }
  return generatedRuntime;
}

function persistOrVerifyRuntimeSeed(state, generatedRuntime, trustedSeed) {
  if (state.refreshRuntimeSeed) {
    atomicWriteText(
      state.seedPath,
      encodeRuntimeSeed(generatedRuntime.payload),
      state.seedSnapshot.exists ? state.seedSnapshot.mode : 0o644,
    );
    return;
  }
  if (generatedRuntime.payload !== trustedSeed.payload) {
    throw new Error("generated Worker runtime declarations do not match the tracked runtime seed");
  }
}

function restoreWranglerTypesRun(state) {
  assertTargetParent(state.cwd, state.targetPath);
  restoreFile(state.targetPath, state.targetSnapshot, state.targetWitness);
}

export function parseWorkerTypesArguments(args = []) {
  if (args.length === 0) return { refreshRuntimeSeed: false };
  if (args.length === 1 && args[0] === "--refresh-runtime-seed") return { refreshRuntimeSeed: true };
  throw new Error(`unknown worker-types option: ${args.join(" ")}`);
}

function seedRuntimeCacheIfNeeded(targetPath, trustedSeed) {
  if (!existsSync(targetPath)) {
    atomicWriteText(targetPath, trustedSeed.payload, 0o600);
    return;
  }
  let current;
  try {
    current = extractRuntimePayload(strictUtf8(snapshotFile(targetPath).bytes, "existing Worker types"));
  } catch {
    atomicWriteText(targetPath, trustedSeed.payload, 0o600);
    return;
  }
  if (current.payload !== trustedSeed.payload) atomicWriteText(targetPath, trustedSeed.payload, 0o600);
}

function decodeRuntimeSeed(seedPath, expectedHeader) {
  const encoded = strictUtf8(snapshotFile(seedPath).bytes, "Worker runtime seed");
  const compact = encoded.replace(/\n/g, "");
  if (!compact || /[^A-Za-z0-9+/=]/.test(compact) || canonicalBase64(compact) !== encoded) {
    throw new Error("Worker runtime seed is not canonical UTF-8 Base64 text");
  }
  let decompressed;
  try { decompressed = brotliDecompressSync(Buffer.from(compact, "base64")); }
  catch { throw new Error("Worker runtime seed is not valid Brotli-compressed data"); }
  const payloadText = strictUtf8(decompressed, "decoded Worker runtime seed");
  const parsed = extractRuntimePayload(payloadText);
  if (parsed.payload !== payloadText || parsed.header !== expectedHeader) {
    throw new Error("Worker runtime seed is stale or contains non-runtime declarations");
  }
  return parsed;
}

function encodeRuntimeSeed(payload) {
  const parsed = extractRuntimePayload(payload);
  if (parsed.payload !== payload) throw new Error("Worker runtime seed source contains non-runtime declarations");
  const compressed = brotliCompressSync(Buffer.from(payload), {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
      [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
    },
  });
  return canonicalBase64(compressed.toString("base64"));
}

function canonicalBase64(compact) {
  const lines = compact.match(new RegExp(`.{1,${SEED_LINE_WIDTH}}`, "g")) || [];
  return `${lines.join("\n")}\n`;
}

function extractRuntimePayload(text) {
  const headers = [...text.matchAll(RUNTIME_HEADER)];
  if (headers.length !== 1) throw new Error("Worker types must contain exactly one runtime generation header");
  const marker = text.indexOf(RUNTIME_MARKER);
  if (marker < 0 || headers[0].index >= marker) throw new Error("Worker types runtime marker is missing or malformed");
  const header = headers[0][0];
  return { header, payload: `${header}\n${text.slice(marker)}` };
}

function expectedRuntimeHeader({ configPath, workerdPackagePath }) {
  const workerd = JSON.parse(strictUtf8(readFileSync(workerdPackagePath), "workerd package metadata"));
  if (!/^\d+\.\d+/.test(String(workerd.version || ""))) throw new Error("workerd package version is missing");
  const config = strictUtf8(readFileSync(configPath), "Wrangler configuration");
  const date = /"compatibility_date"\s*:\s*"([^"]+)"/.exec(config)?.[1];
  const flagsBlock = /"compatibility_flags"\s*:\s*\[([\s\S]*?)\]/.exec(config)?.[1];
  if (!date || flagsBlock === undefined) throw new Error("Wrangler compatibility date/flags are missing");
  const flags = [...flagsBlock.matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort();
  return `// Runtime types generated with workerd@${workerd.version} ${date}${flags.length ? ` ${flags.join(",")}` : ""}`;
}

function snapshotFile(filePath) {
  try {
    const opened = readBoundedRegularFileWithInfoSync(filePath, 16 * 1024 * 1024, "Worker types state target", {
      verifyPathIdentity: true, rejectMultipleLinks: true,
    });
    return { exists: true, bytes: opened.buffer, mode: opened.info.mode & 0o777, info: opened.identityInfo };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, bytes: null, mode: null, info: null };
    throw error;
  }
}

function restoreFile(path, snapshot, witness) {
  const current = snapshotFile(path);
  if (current.exists && (!witness.exists || !sameFile(current, witness))) {
    throw new Error("Worker types target changed during generation; replacement preserved");
  }
  if (!snapshot.exists) {
    if (current.exists) rmSync(path);
    return;
  }
  if (current.exists && current.mode === snapshot.mode && current.bytes.equals(snapshot.bytes)) return;
  atomicWriteText(path, snapshot.bytes, snapshot.mode);
}

function sameFile(left, right) {
  return left.info.dev === right.info.dev && left.info.ino === right.info.ino
    && left.info.birthtimeNs === right.info.birthtimeNs;
}

function atomicWriteText(path, text, mode) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  replaceFileAtomicallySync(path, text, { mode });
}

function assertTargetParent(cwd, targetPath) {
  const canonicalRoot = realpathSync(cwd);
  let ancestor = dirname(targetPath);
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error("Worker types target parent is unavailable");
    ancestor = parent;
  }
  const canonicalAncestor = realpathSync(ancestor);
  if (canonicalAncestor !== resolve(canonicalRoot, relative(cwd, ancestor))) {
    throw new Error("Wrangler types target parent must remain inside its working directory without aliases");
  }
  const inside = relative(canonicalRoot, canonicalAncestor);
  if (isAbsolute(inside) || inside === ".." || inside.startsWith(".." + sep)) {
    throw new Error("Wrangler types target parent must remain inside its working directory");
  }
}

function strictUtf8(buffer, label) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
  catch { throw new Error(`${label} is not valid UTF-8`); }
}

if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  const parsed = parseWorkerTypesArguments(process.argv.slice(2));
  await runWranglerTypes(parsed);
}
