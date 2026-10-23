import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { validateCfBuildOutput } from "../src/local/cf-project.mjs";

const root = mkdtempSync(join(tmpdir(), "mbm-cf-build-test-"));
const require = createRequire(import.meta.url);
const cfRoot = dirname(require.resolve("cf/package.json"));
const nodeModules = join(dirname(dirname(cfRoot)), "node_modules");
const workerName = "mbm-cf-build-fixture";
try {
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({
    private: true,
    type: "module",
    devDependencies: { wrangler: "4.151.3" },
  }));
  writeFileSync(join(root, "cloudflare.config.ts"), `import { bindings, defineConfig, exports as workerExports } from "cf/config";
const name = ${JSON.stringify(workerName)};
export default defineConfig({
  worker: {
    name,
    entrypoint: "src/index.ts",
    compatibilityDate: "2026-07-11",
    unsafe: { metadata: { keep_bindings: ["plain_text", "json", "secret_text", "secret_key"] } },
    exports: { BridgeRoom: workerExports.durableObject({ storage: "sqlite" }) },
    env: {
      BRIDGE: bindings.durableObject({ worker: name, exportName: "BridgeRoom" }),
      STATEFUL_GLOBAL_RATE_LIMITER: bindings.rateLimit({ namespace: "4301702", simple: { limit: 1200, period: 60 } }),
      STATEFUL_RATE_LIMITER: bindings.rateLimit({ namespace: "4301701", simple: { limit: 120, period: 60 } }),
    },
  },
});
`);
  writeFileSync(join(root, "wrangler.config.ts"), `export default { minify: true, sendMetrics: false, types: { generate: false } };\n`);
  writeFileSync(join(root, "src", "index.ts"), `export class BridgeRoom { fetch() { return new Response("ok"); } }\nexport default { fetch() { return new Response("ok"); } };\n`);
  symlinkSync(nodeModules, join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const result = await run(process.execPath, [join(cfRoot, "bin", "cf"), "build"], {
    cwd: root,
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false", MBM_WORKER_NAME: workerName },
  });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const config = validateCfBuildOutput(root, workerName);
  assert.equal(config.manifest.mainModule, "index.js");
  assert.equal(config.exports.BridgeRoom.storage, "sqlite");
  assert.equal(config.env.BRIDGE.worker, workerName);
  console.log("cf build delegation and Build Output contract ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}
