import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ensureCloudflareToolchain } from "./wrangler-toolchain.mjs";
import { runCf as defaultRunCf, runExecutable } from "./shell.mjs";
import { packageRoot } from "./package-identity.mjs";
import { readBoundedRegularFileSync } from "./secure-file.mjs";

const PRESERVED_BINDING_TYPES = ["plain_text", "json", "secret_text", "secret_key"];

export async function withCfProject(snapshot, workerName, callback, options = {}) {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(workerName)) throw new Error("Invalid Worker deployment name");
  const toolchainRoot = await (options.ensureToolchain || ensureCloudflareToolchain)({
    stateRoot: options.stateRoot, packageRoot: options.packageRoot || packageRoot,
    env: options.env || process.env, runCommand: options.runCommand || runExecutable,
  });
  const toolchainManifest = JSON.parse(readBoundedRegularFileSync(path.join(toolchainRoot, "package.json"),
    128 * 1024, "Cloudflare toolchain manifest", { verifyPathIdentity: true, rejectMultipleLinks: true }));
  const builderVersion = toolchainManifest.dependencies.wrangler;
  const directory = mkdtempSync(path.join(toolchainRoot, "cf-project-"));
  chmodSync(directory, 0o700);
  try {
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
    return await callback(project);
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 30 });
  }
}

export function validateCfBuildOutput(directory, workerName) {
  const configPath = ".cloudflare/output/v0/workers/default/worker.config.json";
  const config = JSON.parse(readProjectArtifact(directory, configPath, 128 * 1024));
  const kept = config.unsafe?.metadata?.keep_bindings;
  if (config.name !== workerName || config.exports?.BridgeRoom?.storage !== "sqlite"
      || config.exports.BridgeRoom.type !== "durable-object"
      || config.env?.BRIDGE?.worker !== workerName || config.env.BRIDGE.exportName !== "BridgeRoom"
      || config.env.STATEFUL_GLOBAL_RATE_LIMITER?.namespace !== "4301702"
      || config.env.STATEFUL_RATE_LIMITER?.namespace !== "4301701"
      || !Array.isArray(kept) || kept.length !== PRESERVED_BINDING_TYPES.length
      || PRESERVED_BINDING_TYPES.some(type => !kept.includes(type))
      || config.manifest?.type !== "complete" || config.manifest.mainModule !== "index.js"
      || config.manifest.modules?.["index.js"]?.type !== "esm") {
    throw new Error("cf Build Output does not preserve the Machine Bridge deployment contract");
  }
  const prefix = ".cloudflare/output/v0/workers/default/bundle/";
  for (const module of Object.keys(config.manifest.modules)) readProjectArtifact(directory, prefix + module, 16 * 1024 * 1024);
  return config;
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
