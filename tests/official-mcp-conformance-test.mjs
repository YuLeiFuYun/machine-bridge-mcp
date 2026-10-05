import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conformanceProxyTarget, runOfficialMcpConformance, validateConformanceCheckout } from "../scripts/official-mcp-conformance.mjs";

const upstream = new URL("https://mcp.example.test/custom/mcp");
assert.equal(conformanceProxyTarget("/mcp?case=1", upstream).href, "https://mcp.example.test/custom/mcp?case=1");
assert.equal(conformanceProxyTarget("", upstream).href, "https://mcp.example.test/custom/mcp");
for (const target of [
  "https://attacker.example/mcp",
  "//attacker.example/mcp",
  "http://127.0.0.1:9/mcp",
  "/mcp#fragment",
  "/healthz",
  "/oauth/token",
  `/${"x".repeat(9000)}`,
]) {
  assert.throws(() => conformanceProxyTarget(target, upstream), /relative request target|only its MCP endpoint|too large/);
}

const checkoutRoot = mkdtempSync(join(tmpdir(), "mbm-conformance-checkout-"));
try {
  const missing = join(checkoutRoot, "missing");
  assert.throws(() => validateConformanceCheckout(missing), /does not exist/);
  const checkout = join(checkoutRoot, "checkout");
  mkdirSync(checkout);
  assert.throws(() => validateConformanceCheckout(checkout), /omits package.json/);
  writeFileSync(join(checkout, "package.json"), JSON.stringify({ scripts: { start: "tsx src/index.ts" } }));
  writeFileSync(join(checkout, "package-lock.json"), "{}\n");
  assert.throws(() => validateConformanceCheckout(checkout), /dependencies are not installed/);
  mkdirSync(join(checkout, "node_modules"));
  assert.equal(validateConformanceCheckout(checkout), realpathSync.native(checkout));
  assert.throws(() => validateConformanceCheckout(checkout, {
    lstatSync(path) {
      if (path.endsWith("package-lock.json")) throw Object.assign(new Error("synthetic permission failure"), { code: "EACCES" });
      return lstatSync(path);
    },
  }), /could not be inspected/);
  const alias = join(checkoutRoot, "alias");
  symlinkSync(checkout, alias);
  assert.throws(() => validateConformanceCheckout(alias), /real directory/);
} finally {
  rmSync(checkoutRoot, { recursive: true, force: true });
}

const proxyRoot = mkdtempSync(join(tmpdir(), "mbm-conformance-proxy-"));
const previousLauncher = process.env.npm_execpath;
const tokenEnvironmentName = "MBM_OFFICIAL_CONFORMANCE_ACCESS_TOKEN";
const previousTokens = Object.entries(process.env).filter(([key]) => key.toUpperCase() === tokenEnvironmentName);
const previousFetch = globalThis.fetch;
try {
  mkdirSync(join(proxyRoot, "node_modules"));
  writeFileSync(join(proxyRoot, "package.json"), JSON.stringify({ scripts: { start: "node fixture.mjs" } }));
  writeFileSync(join(proxyRoot, "package-lock.json"), "{}");
  const launcher = join(proxyRoot, "owned-launcher.mjs");
  process.env.npm_execpath = launcher;
  for (const [key] of previousTokens) delete process.env[key];
  process.env.mBm_Official_Conformance_Access_Token = "owned-synthetic-token";
  process.env.MBM_OFFICIAL_CONFORMANCE_ACCESS_TOKEN = "owned-synthetic-token";
  for (const mode of ["backpressure", "backpressure-cancel-failure", "read-failure", "complete"]) {
    writeFileSync(launcher, [
      'import http from "node:http";',
      'console.log(JSON.stringify({ credential_inherited: Object.keys(process.env).some(key => key.toUpperCase() === "MBM_OFFICIAL_CONFORMANCE_ACCESS_TOKEN") }));',
      'const req = http.get(process.argv[process.argv.indexOf("--url") + 1], response => {',
      mode.startsWith("backpressure") ? 'response.once("data", () => { response.destroy(); req.destroy(); });' : 'response.resume();',
      'response.on("error", () => {});',
      '});',
      'req.on("error", () => {});',
      'req.once("close", () => process.exit(0));',
      'setTimeout(() => process.exit(2), 5000).unref();',
    ].join("\n"));
    let released = false;
    let cancelled = 0;
    let reads = 0;
    let finishRead;
    let forwardedAuthorization = false;
    globalThis.fetch = async (_target, options) => {
      forwardedAuthorization = options.headers.get("authorization") === "Bearer owned-synthetic-token";
      return { status: 200, headers: new Headers({ "content-type": "text/event-stream" }), body: {
        getReader() { return {
          async read() {
            reads += 1;
            if (mode === "read-failure") throw new Error("synthetic upstream read failure");
            if (mode === "complete") return reads === 1
              ? { done: false, value: new TextEncoder().encode("data: owned\n\n") } : { done: true };
            return reads === 1 ? { done: false, value: new Uint8Array(16 * 1024 * 1024) }
              : new Promise((resolve) => { finishRead = resolve; });
          },
          async cancel() {
            cancelled += 1;
            finishRead?.({ done: true });
            if (mode === "backpressure-cancel-failure") throw new Error("synthetic cancellation failure");
          },
          releaseLock() { released = true; },
        }; },
      } };
    };
    const result = await runOfficialMcpConformance({
      checkout: proxyRoot, upstream: "http://127.0.0.1:9/mcp",
      accessToken: "owned-synthetic-token", scenario: "owned-fixture", timeoutMs: 10_000,
    });
    assert.equal(result.code, 0, "owned conformance child did not settle");
    assert(result.stdout.includes('"credential_inherited":false'), "conformance credential reached the third-party child environment");
    assert(forwardedAuthorization, "proxy stopped injecting authentication into the owned upstream request");
    const deadline = performance.now() + 2000;
    while (!released && performance.now() < deadline) await new Promise((resolve) => { setTimeout(resolve, 10); });
    assert(released, "proxy retained its response reader after completion/disconnection/failure");
    assert.equal(cancelled, mode === "complete" ? 0 : 1, "proxy cancellation did not match upstream completion");
  }
} finally {
  globalThis.fetch = previousFetch;
  if (previousLauncher === undefined) delete process.env.npm_execpath; else process.env.npm_execpath = previousLauncher;
  for (const key of Object.keys(process.env)) {
    if (key.toUpperCase() === tokenEnvironmentName) delete process.env[key];
  }
  for (const [key, value] of previousTokens) process.env[key] = value;
  rmSync(proxyRoot, { recursive: true, force: true });
}

console.log("official MCP conformance proxy test ok");
