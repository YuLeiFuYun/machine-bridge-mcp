import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ensureCloudflareToolchain } from "./wrangler-toolchain.mjs";
import { runCf as defaultRunCf, runExecutable } from "./shell.mjs";
import { packageRoot } from "./package-identity.mjs";
import { readBoundedRegularFileSync } from "./secure-file.mjs";

const PRESERVED_BINDING_TYPES = ["plain_text", "json", "secret_text", "secret_key"];
const MAX_OUTPUT_MODULES = 256, MAX_MODULE_BYTES = 16 * 1024 * 1024, MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

export async function withCfProject(snapshot, workerName, callback, options = {}) {
  if (typeof workerName !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(workerName)) throw new Error("Invalid Worker deployment name");
  if (typeof callback !== "function") throw new TypeError("cf project requires a callback");
  const toolchainRoot = await (options.ensureToolchain || ensureCloudflareToolchain)({
    stateRoot: options.stateRoot, packageRoot: options.packageRoot || packageRoot,
    env: options.env || process.env, runCommand: options.runCommand || runExecutable,
  });
  const toolchainManifest = JSON.parse(readBoundedRegularFileSync(path.join(toolchainRoot, "package.json"),
    128 * 1024, "Cloudflare toolchain manifest", { verifyPathIdentity: true, rejectMultipleLinks: true }));
  const builderVersion = toolchainManifest.dependencies.wrangler;
  const directory = mkdtempSync(path.join(toolchainRoot, "cf-project-"));
  let result, primaryError, failed = false;
  try {
    chmodSync(directory, 0o700);
    for (const file of snapshot.files) {
      const target = path.resolve(directory, file.path);
      const relative = path.relative(directory, target);
      if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
        throw new Error("Worker deployment snapshot escapes the private project");
      }
      mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, file.content, { flag: "wx", mode: 0o600 });
    }
    writeFileSync(path.join(directory, "package.json"), JSON.stringify({ private: true, type: "module", devDependencies: { wrangler: builderVersion } }), { flag: "wx", mode: 0o600 });
    symlinkSync(path.join(toolchainRoot, "node_modules"), path.join(directory, "node_modules"), "dir");
    const project = {
      cwd: directory,
      env: { ...(options.env || process.env), MBM_WORKER_NAME: workerName, CI: "1", WRANGLER_SEND_METRICS: "false" },
    };
    const runCf = options.runCf || defaultRunCf;
    await runCf(["build"], { ...project, stateRoot: options.stateRoot, packageRoot: options.packageRoot || packageRoot,
      capture: true, hardTimeout: true, timeoutMs: options.buildTimeoutMs ?? 120_000 });
    validateCfBuildOutput(directory, workerName);
    result = await callback(project);
  } catch (error) { primaryError = error; failed = true; }
  try { rmSync(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 30 }); }
  catch (cleanupError) {
    if (failed) throw new AggregateError([primaryError, cleanupError], "cf project operation failed and private cleanup was incomplete");
    throw cleanupError;
  }
  if (failed) throw primaryError;
  return result;
}

export function validateCfBuildOutput(directory, workerName) {
  const configPath = ".cloudflare/output/v0/workers/default/worker.config.json";
  const config = JSON.parse(readProjectArtifact(directory, configPath, 128 * 1024));
  const kept = config?.unsafe?.metadata?.keep_bindings;
  const modules = config?.manifest?.modules;
  if (typeof workerName !== "string" || config?.name !== workerName
      || config.exports?.BridgeRoom?.storage !== "sqlite" || config.exports.BridgeRoom.type !== "durable-object"
      || config.env?.BRIDGE?.type !== "durable-object" || config.env.BRIDGE.worker !== workerName
      || config.env.BRIDGE.exportName !== "BridgeRoom"
      || !rateLimitMatches(config.env.STATEFUL_GLOBAL_RATE_LIMITER, "4301702", 1200)
      || !rateLimitMatches(config.env.STATEFUL_RATE_LIMITER, "4301701", 120)
      || !Array.isArray(kept) || kept.length !== PRESERVED_BINDING_TYPES.length
      || PRESERVED_BINDING_TYPES.some(type => !kept.includes(type))
      || config.manifest?.type !== "complete" || config.manifest.mainModule !== "index.js"
      || !modules || typeof modules !== "object" || Array.isArray(modules) || modules["index.js"]?.type !== "esm") {
    throw new Error("cf Build Output does not preserve the Machine Bridge deployment contract");
  }
  let count = 0;
  for (const module in modules) {
    if (!Object.hasOwn(modules, module)) continue;
    if (++count > MAX_OUTPUT_MODULES) throw new Error("cf Build Output exceeds its module limit");
    if (module.includes("\\") || module.split("/").some(part => !part || part === "." || part === "..")) {
      throw new Error("cf Build Output module escapes its bundle");
    }
  }
  const prefix = ".cloudflare/output/v0/workers/default/bundle/";
  let remaining = MAX_OUTPUT_BYTES;
  for (const module in modules) {
    if (!Object.hasOwn(modules, module)) continue;
    const bytes = readProjectArtifact(directory, prefix + module, Math.min(MAX_MODULE_BYTES, remaining));
    remaining -= bytes.length;
  }
  return config;
}

function rateLimitMatches(binding, namespace, limit) {
  return binding?.type === "rate-limit" && binding.namespace === namespace
    && binding.simple?.limit === limit && binding.simple.period === 60;
}
function readProjectArtifact(directory, relativePath, limit) {
  const root = realpathSync(directory);
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    throw new Error("cf Build Output artifact escapes the private project");
  }
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error("cf Build Output artifact must not be a symbolic link");
  }
  return readBoundedRegularFileSync(target, limit, "cf Build Output artifact",
    { verifyPathIdentity: true, rejectMultipleLinks: true });
}
