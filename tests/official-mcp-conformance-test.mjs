import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conformanceProxyTarget, validateConformanceCheckout } from "../scripts/official-mcp-conformance.mjs";

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
console.log("official MCP conformance proxy test ok");
