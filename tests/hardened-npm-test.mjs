import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureHardenedNpm,
  hardenedNpmIdentity,
  prepareHardenedNpm,
  verifyHardenedNpm,
} from "../src/local/hardened-npm.mjs";
import { downloadHardenedNpmArtifact } from "../src/local/hardened-npm-download.mjs";
import { createHardenedNpmSession, settleHardenedNpmSession } from "../scripts/hardened-npm-session.mjs";
import { operationalErrorCode, throwOperationalOrIntegrity } from "../src/local/private-toolchain-integrity.mjs";

const root = mkdtempSync(join(tmpdir(), "mbm-hardened-npm-test-"));
try {
  const fixtures = join(root, "fixtures");
  mkdirSync(fixtures);
  const definitions = [
    { name: "npm", version: "12.0.1", maximumBytes: 2 * 1024 * 1024 },
    { name: "undici", version: "6.28.0", maximumBytes: 512 * 1024 },
    { name: "brace-expansion", version: "5.0.9", maximumBytes: 512 * 1024 },
  ];
  const bytesByName = new Map();
  const artifacts = definitions.map((definition) => {
    const bytes = createPackageArchive(fixtures, definition);
    bytesByName.set(definition.name, bytes);
    return {
      ...definition,
      url: `https://registry.npmjs.org/${definition.name}/-/${definition.name}-${definition.version}.tgz`,
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    };
  });

  const session = await createHardenedNpmSession({
    tempRoot: root,
    hardenedNpm: {
      artifacts,
      readArtifact: (artifact) => bytesByName.get(artifact.name),
    },
  });
  assert.equal(session.version, "12.0.1");
  assert.equal(session.undiciVersion, "6.28.0");
  session.dispose();
  assert.equal(session.dispose(), undefined, "hardened npm session disposal was not idempotent");
  const primary = new Error("primary failure");
  const cleanup = new Error("cleanup failure");
  const aggregated = settleHardenedNpmSession({ dispose() { throw cleanup; } }, primary, "combined failure");
  assert(aggregated instanceof AggregateError && aggregated.message === "combined failure");
  assert.deepEqual(aggregated.errors, [primary, cleanup]);
  assert.equal(settleHardenedNpmSession({ dispose() {} }, primary), primary);
  assert.equal(settleHardenedNpmSession({ dispose() { throw cleanup; } }), cleanup);
  for (const code of ["EDQUOT", "ENOMEM", "EAGAIN", "ENOBUFS", "EINTR", "ESTALE"]) {
    const operational = Object.assign(new Error(`synthetic ${code}`), { code });
    assert.equal(operationalErrorCode(operational), code, `${code} was not classified as operational`);
    assert.throws(() => throwOperationalOrIntegrity(operational, "must not reconstruct"), error => error === operational);
  }

  const preparedRoot = join(root, "prepared");
  const prepared = await prepareHardenedNpm(preparedRoot, {
    artifacts,
    readArtifact: (artifact) => bytesByName.get(artifact.name),
  });
  assert.equal(prepared.version, "12.0.1");
  assert.equal(prepared.undiciVersion, "6.28.0");
  assert.equal(prepared.braceExpansionVersion, "5.0.9");
  assert.equal(verifyHardenedNpm(preparedRoot, { artifacts }).cli, prepared.cli);

  let downloads = 0;
  const parent = join(root, "toolchains");
  const options = {
    artifacts,
    readArtifact: (artifact) => {
      downloads += 1;
      return bytesByName.get(artifact.name);
    },
  };
  const first = await ensureHardenedNpm(parent, options);
  assert.equal(downloads, 3);
  const second = await ensureHardenedNpm(parent, options);
  assert.equal(first.root, second.root);
  assert.equal(downloads, 3, "verified hardened npm was downloaded again");
  const timeout = Object.assign(new Error("synthetic npm verification timeout"), { code: "ETIMEDOUT" });
  await assert.rejects(
    ensureHardenedNpm(parent, { ...options, run: () => { throw timeout; } }),
    error => error === timeout,
  );
  assert.equal(downloads, 3, "operational hardened npm verification failure triggered destructive reconstruction");
  const markerPath = join(first.root, ".machine-bridge-mcp-hardened-npm.json");
  const marker = JSON.parse(readFileSync(markerPath, "utf8"));
  writeFileSync(markerPath, `${JSON.stringify({ ...marker, undici: "6.27.0" })}\n`);
  await ensureHardenedNpm(parent, options);
  assert.equal(downloads, 6, "hardened npm accepted a marker with mismatched component versions");
  writeFileSync(join(first.root, "package", "node_modules", "undici", "package.json"), '{"name":"undici","version":"6.27.0"}\n');
  const repaired = await ensureHardenedNpm(parent, options);
  assert.equal(repaired.undiciVersion, "6.28.0");
  assert.equal(downloads, 9, "tampered hardened npm was not reconstructed");
  if (process.platform !== "win32") {
    const cli = join(first.root, "package", "bin", "npm-cli.js");
    rmSync(cli);
    symlinkSync("../package.json", cli);
    await ensureHardenedNpm(parent, options);
    assert.equal(downloads, 12, "symlinked hardened npm CLI was accepted instead of reconstructed");
  }

  const redirectRequest = fakeRequest(302);
  await assert.rejects(
    downloadHardenedNpmArtifact(artifacts[0], { request: redirectRequest, proxyAgentForUrl: () => ({ agent: null }) }),
    /HTTP 302/,
  );
  assert.equal(redirectRequest.calls, 1, "hardened npm followed a registry redirect");

  const deceptiveOrigin = artifacts.map((item) => ({ ...item }));
  deceptiveOrigin[0].url = deceptiveOrigin[0].url.replace("registry.npmjs.org/", "registry.npmjs.org.evil/");
  assert.throws(() => hardenedNpmIdentity(deceptiveOrigin), /artifact metadata is invalid/);

  const identity = hardenedNpmIdentity(artifacts);
  assert.match(identity.directoryName, /^npm-12\.0\.1-hardened-[a-f0-9]{16}$/);
  const corrupt = artifacts.map((item) => ({ ...item }));
  corrupt[1].integrity = corrupt[1].integrity.replace(/^sha512-./, (value) => value === "sha512-A" ? "sha512-B" : "sha512-A");
  await assert.rejects(
    prepareHardenedNpm(join(root, "corrupt"), {
      artifacts: corrupt,
      readArtifact: (artifact) => bytesByName.get(artifact.name),
    }),
    /failed SHA-512 verification/,
  );

  console.log("hardened npm bootstrap test ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}

function fakeRequest(statusCode) {
  const create = () => {
    create.calls += 1;
    const request = new EventEmitter();
    request.destroy = (error) => { if (error) request.emit("error", error); };
    request.end = () => {
      queueMicrotask(() => {
        const response = new EventEmitter();
        response.statusCode = statusCode;
        response.headers = {};
        response.resume = () => {};
        request.emit("response", response);
      });
    };
    return request;
  };
  create.calls = 0;
  return create;
}

function createPackageArchive(fixtures, definition) {
  const source = join(fixtures, `${definition.name}-source`);
  const packageDirectory = join(source, "package");
  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(join(packageDirectory, "package.json"), `${JSON.stringify({ name: definition.name, version: definition.version })}\n`);
  if (definition.name === "npm") {
    const bin = join(packageDirectory, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "npm-cli.js"), `process.stdout.write(${JSON.stringify(`${definition.version}\n`)});\n`);
    for (const [name, version] of [["undici", "6.27.0"], ["brace-expansion", "5.0.7"]]) {
      const dependency = join(packageDirectory, "node_modules", name);
      mkdirSync(dependency, { recursive: true });
      writeFileSync(join(dependency, "package.json"), `${JSON.stringify({ name, version })}\n`);
    }
  }
  const archive = join(fixtures, `${definition.name}.tgz`);
  execFileSync("tar", ["-czf", archive, "-C", source, "package"]);
  return readFileSync(archive);
}
