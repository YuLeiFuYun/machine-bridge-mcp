import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CF_NETWORK_ARTIFACT as contract, verifyCfNetworkArtifact } from "../src/local/cf-network-integrity.mjs";

const cfRoot = path.dirname(createRequire(import.meta.url).resolve("cf/package.json"));
const original = readFileSync(path.join(cfRoot, contract.bundle));
assert.equal(createHash("sha256").update(original).digest("hex"), contract.sha256);
const root = mkdtempSync(path.join(tmpdir(), "mbm-cf-network-test-"));
try {
  const packageDirectory = path.join(root, "node_modules", "cf");
  const bundle = path.join(packageDirectory, contract.bundle);
  const manifest = path.join(packageDirectory, "package.json");
  mkdirSync(path.dirname(bundle), { recursive: true, mode: 0o700 });
  const reset = () => {
    rmSync(bundle, { force: true });
    writeFileSync(bundle, original, { mode: 0o600 });
    writeFileSync(manifest, JSON.stringify({ name: "cf", version: contract.version }), { mode: 0o600 });
  };
  reset();
  const before = readFileSync(bundle);
  const verified = verifyCfNetworkArtifact(root);
  assert.equal(verified.bundleSha256, contract.sha256);
  assert.deepEqual(readFileSync(bundle), before, "verification rewrote the upstream artifact");
  assert.deepEqual(verifyCfNetworkArtifact(root), verified);
  writeFileSync(bundle, Buffer.concat([original, Buffer.from("\n")]));
  assert.throws(() => verifyCfNetworkArtifact(root), /pinned upstream artifact/);
  reset();
  writeFileSync(bundle, Buffer.alloc(2 * 1024 * 1024 + 1));
  assert.throws(() => verifyCfNetworkArtifact(root), /exceeds 2097152 bytes/);
  reset();
  writeFileSync(manifest, JSON.stringify({ name: "cf", version: "1.0.0-beta.999" }));
  assert.throws(() => verifyCfNetworkArtifact(root), /package version/);
  for (const invalid of ["null", "{"]) {
    writeFileSync(manifest, invalid);
    assert.throws(() => verifyCfNetworkArtifact(root), /package version|not valid JSON/);
  }
  reset();
  const outside = path.join(root, "outside.mjs");
  writeFileSync(outside, original, { mode: 0o600 });
  rmSync(bundle);
  symlinkSync(outside, bundle);
  assert.throws(() => verifyCfNetworkArtifact(root), /private regular file/);
  rmSync(bundle);
  linkSync(outside, bundle);
  assert.throws(() => verifyCfNetworkArtifact(root), /private regular file/);
  reset();
  if (process.platform !== "win32") {
    chmodSync(bundle, 0o622);
    assert.throws(() => verifyCfNetworkArtifact(root), /private regular file/);
    chmodSync(bundle, 0o600);
  }
  const aliasedDist = path.join(root, "aliased-dist");
  mkdirSync(aliasedDist);
  writeFileSync(path.join(aliasedDist, path.basename(bundle)), original, { mode: 0o600 });
  rmSync(path.dirname(bundle), { recursive: true });
  symlinkSync(aliasedDist, path.dirname(bundle), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => verifyCfNetworkArtifact(root), /without aliases/);
  rmSync(packageDirectory, { recursive: true });
  assert.deepEqual(verifyCfNetworkArtifact(root, { allowAbsent: true }), { present: false });
  assert.throws(() => verifyCfNetworkArtifact([root]), TypeError);
  symlinkSync(cfRoot, packageDirectory, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => verifyCfNetworkArtifact(root), /real directory/);

  const observed = await observeFactory();
  assert.equal(observed.connectorPreserved, true);
  assert.equal(observed.tlsVerifierPreserved, true);
  assert.equal(observed.publicFactoryMatches, true);
  assert.equal(observed.requests, 0, "construction initiated a network request");
  console.log("cf upstream network behavior, read-only integrity, and tamper checks ok");
} finally { rmSync(root, { recursive: true, force: true }); }

async function observeFactory() {
  const observer = path.join(cfRoot, "dist", "mbm-cf-offline-" + randomUUID() + ".mjs");
  writeFileSync(observer, original.toString("utf8") + "\nexport { K_ as mbmObservedFactory };\n", { flag: "wx", mode: 0o600 });
  try {
    const observed = await import(pathToFileURL(observer).href);
    const library = observed.mbmObservedFactory();
    let requests = 0, captured;
    const connect = () => { requests += 1; throw new Error("Offline construction initiated a connection"); };
    const checkServerIdentity = () => new Error("Offline TLS sentinel");
    const pool = new library.BalancedPool("https://example.invalid", {
      connect, tls: { checkServerIdentity },
      factory(origin, options) { captured = options; return new library.Pool(origin, options); },
    });
    try {
      return {
        connectorPreserved: captured.connect === connect,
        tlsVerifierPreserved: captured.tls?.checkServerIdentity === checkServerIdentity,
        publicFactoryMatches: observed.B() === library,
        requests,
      };
    } finally { await pool.close(); }
  } finally { rmSync(observer, { force: true }); }
}
