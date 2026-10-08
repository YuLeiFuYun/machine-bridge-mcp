import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalConsumerTarballPath,
  validateConsumerAudit,
  validateConsumerSbom,
  validateConsumerTree,
} from "../scripts/consumer-package-security.mjs";


const pathRoot = mkdtempSync(join(tmpdir(), "mbm-consumer-path-test-"));
try {
  const realParent = join(pathRoot, "real");
  mkdirSync(realParent);
  const tarball = join(realParent, "fixture.tgz");
  writeFileSync(tarball, "fixture");
  assert.equal(canonicalConsumerTarballPath(tarball), realpathSync(tarball));
  if (process.platform !== "win32") {
    const parentAlias = join(pathRoot, "alias");
    symlinkSync(realParent, parentAlias, "dir");
    assert.equal(canonicalConsumerTarballPath(join(parentAlias, "fixture.tgz")), realpathSync(tarball),
      "consumer tarball did not canonicalize an aliased parent directory");
    const fileAlias = join(pathRoot, "fixture-link.tgz");
    symlinkSync(tarball, fileAlias);
    assert.throws(() => canonicalConsumerTarballPath(fileAlias), /non-symlink regular file/);
  }
  const privateMissingPath = process.platform === "win32"
    ? "C:\\Users\\synthetic-reviewer\\private-package\\missing.tgz"
    : ["", "Users", "synthetic-reviewer", "private-package", "missing.tgz"].join("/");
  assert.throws(
    () => canonicalConsumerTarballPath(privateMissingPath),
    (error) => /consumer tarball is unavailable/.test(error.message)
      && !error.message.includes("synthetic-reviewer")
      && error.message.includes("<home>"),
    "consumer tarball filesystem diagnostics exposed a private home path",
  );
} finally {
  rmSync(pathRoot, { recursive: true, force: true });
}

const packageName = "machine-bridge-mcp";
const packageVersion = "3.0.0-beta.41";
const audit = {
  metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
  },
};
assert.deepEqual(validateConsumerAudit(audit), { total: 0 });
assert.throws(() => validateConsumerAudit({
  metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 },
  },
}, 1), /high=1/);

for (const [key, value] of [
  ["low", -1], ["info", null], ["high", "0"], ["total", false], ["moderate", 0.5],
  ["critical", Number.MAX_SAFE_INTEGER + 1], ["info", undefined],
]) {
  assert.throws(() => validateConsumerAudit({
    metadata: { vulnerabilities: { ...audit.metadata.vulnerabilities, [key]: value } },
  }), /metadata is incomplete/);
}
assert.throws(() => validateConsumerAudit({
  metadata: { vulnerabilities: { ...audit.metadata.vulnerabilities, low: 1, high: -1 } },
}), /metadata is incomplete/, "negative counts cancelled out a real vulnerability");
for (const exitCode of [null, false, "0", 1]) {
  assert.throws(() => validateConsumerAudit(audit, exitCode), /audit failed/);
}
assert.throws(() => validateConsumerAudit({ ...audit, error: { code: "fixture" } }), /metadata is incomplete/);

const tree = {
  dependencies: {
    [packageName]: {
      version: packageVersion,
      dependencies: {
        ws: { version: "8.21.1" },
      },
    },
  },
};
assert.equal(validateConsumerTree(tree, { packageName, packageVersion }).dependencies, 2);
for (const [label, mutate, expected] of [
  ["package version array", (value) => { value.dependencies[packageName].version = [packageVersion]; }, /invalid dependency entry/],
  ["dependency version array", (value) => { value.dependencies[packageName].dependencies.undici = { version: ["7.29.0"] }; }, /invalid dependency entry/],
  ["malformed dependency node", (value) => { value.dependencies[packageName].dependencies.wrangler = []; }, /invalid dependency entry/],
  ["malformed dependency map", (value) => { value.dependencies[packageName].dependencies = []; }, /invalid dependency map/],
  ["malformed problem report", (value) => { value.problems = "invalid evidence"; }, /invalid dependency edges/],
]) {
  const malformed = structuredClone(tree);
  mutate(malformed);
  assert.throws(() => validateConsumerTree(malformed, { packageName, packageVersion }), expected, label);
}
assert.equal(validateConsumerTree({ ...tree, problems: [] }, { packageName, packageVersion }).dependencies, 2);

// npm 12.0.2 --long leaves absent optional/peerOptional edges as {}, while retaining declarations on their parent.
for (const declarations of [
  { optionalDependencies: { bufferutil: "^4.0.1" } },
  { peerDependencies: { bufferutil: "^4.0.1" }, peerDependenciesMeta: { bufferutil: { optional: true } } },
]) {
  const optionalTree = structuredClone(tree);
  Object.assign(optionalTree.dependencies[packageName].dependencies.ws, {
    ...declarations, dependencies: { bufferutil: {} },
  });
  assert.equal(validateConsumerTree(optionalTree, { packageName, packageVersion }).dependencies, 2);
  for (const entry of [{ version: ["4.0.1"] }, { dependencies: {} }, []]) {
    optionalTree.dependencies[packageName].dependencies.ws.dependencies.bufferutil = entry;
    assert.throws(() => validateConsumerTree(optionalTree, { packageName, packageVersion }), /invalid dependency entry/);
  }
}
for (const declarations of [
  {}, { optionalDependencies: { bufferutil: ["^4.0.1"] } },
  { peerDependencies: { bufferutil: "^4.0.1" } },
  { peerDependencies: { bufferutil: "^4.0.1" }, peerDependenciesMeta: { bufferutil: { optional: "true" } } },
]) {
  const requiredTree = structuredClone(tree);
  Object.assign(requiredTree.dependencies[packageName].dependencies.ws, {
    ...declarations, dependencies: { bufferutil: {} },
  });
  assert.throws(() => validateConsumerTree(requiredTree, { packageName, packageVersion }), /invalid dependency entry/);
}


for (const [name, version, expected] of [
  ["wrangler", "4.131.2", /private control-plane package wrangler/],
  ["miniflare", "4.20260722.1", /private control-plane package miniflare/],
  ["undici", "7.28.0", /vulnerable undici 7\.28\.0/],
  ["sharp", "0.35.2", /unsupported sharp 0\.35\.2/],
  ["sharp", "0.35.4", /unsupported sharp 0\.35\.4/],
]) {
  assert.throws(() => validateConsumerTree({
    dependencies: {
      [packageName]: { version: packageVersion, dependencies: { [name]: { version } } },
    },
  }, { packageName, packageVersion }), expected);
}

for (const version of ["not-a-version", "9", "9.0", "Infinity.0.0", "09.0.0", "7.29.0-beta.1", "9007199254740992.0.0"]) {
  for (const name of ["undici", "sharp"]) {
    assert.throws(() => validateConsumerTree({
      dependencies: { [packageName]: { version: packageVersion, dependencies: { [name]: { version } } } },
    }, { packageName, packageVersion }), /invalid or prerelease undici|vulnerable undici|unsupported sharp/);
  }
}
for (const version of ["6.28.0", "7.29.0", "8.9.0", "9.0.0+fixture.1"]) {
  assert.equal(validateConsumerTree({
    dependencies: { [packageName]: { version: packageVersion, dependencies: { undici: { version } } } },
  }, { packageName, packageVersion }).dependencies, 2);
}

for (const version of ["0.35.5", "0.36.0"]) {
  assert.equal(validateConsumerTree({
    dependencies: { [packageName]: { version: packageVersion, dependencies: { sharp: { version } } } },
  }, { packageName, packageVersion }).dependencies, 2);
}

const sbom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  metadata: { component: { "bom-ref": "consumer-fixture@1.0.0", name: "machine-bridge-mcp-consumer-fixture", version: "1.0.0" } },
  components: [
    { "bom-ref": `${packageName}@${packageVersion}`, name: packageName, version: packageVersion },
    { "bom-ref": "ws@8.21.1", name: "ws", version: "8.21.1" },
  ],
  dependencies: [
    { ref: "consumer-fixture@1.0.0", dependsOn: [`${packageName}@${packageVersion}`] },
    { ref: `${packageName}@${packageVersion}`, dependsOn: ["ws@8.21.1"] },
    { ref: "ws@8.21.1", dependsOn: [] },
  ],
};
assert.equal(validateConsumerSbom(sbom, { packageName, packageVersion }).components, 2);
for (const [label, mutate, expected] of [
  ["component reference array", (value) => { value.components[1]["bom-ref"] = ["ws@8.21.1"]; }, /references are missing or duplicated/],
  ["component name array", (value) => { value.components[1].name = ["ws"]; }, /names and versions must be non-empty strings/],
  ["component version array", (value) => { value.components[1].version = ["8.21.1"]; }, /names and versions must be non-empty strings/],
  ["undici version array", (value) => { value.components[1].name = "undici"; value.components[1].version = ["7.29.0"]; }, /names and versions must be non-empty strings/],
  ["dependency reference array", (value) => { value.dependencies[2].ref = ["ws@8.21.1"]; }, /invalid reference/],
  ["edge reference array", (value) => { value.dependencies[1].dependsOn = [["ws@8.21.1"]]; }, /invalid reference/],
  ["root reference array", (value) => { value.metadata.component["bom-ref"] = ["consumer-fixture@1.0.0"]; }, /references are missing or duplicated/],
  ["duplicate edge", (value) => { value.dependencies[1].dependsOn.push("ws@8.21.1"); }, /invalid reference/],
]) {
  const malformed = structuredClone(sbom);
  mutate(malformed);
  assert.throws(() => validateConsumerSbom(malformed, { packageName, packageVersion }), expected, label);
}

assert.throws(() => validateConsumerSbom({
  ...sbom,
  dependencies: sbom.dependencies.filter((entry) => entry.ref !== "ws@8.21.1"),
}, { packageName, packageVersion }), /omits a component reference/);
assert.throws(() => validateConsumerSbom({
  ...sbom,
  dependencies: sbom.dependencies.map((entry) => entry.ref === `${packageName}@${packageVersion}`
    ? { ...entry, dependsOn: ["missing@1.0.0"] }
    : entry),
}, { packageName, packageVersion }), /invalid reference/);
assert.throws(() => validateConsumerSbom({
  ...sbom,
  dependencies: [...sbom.dependencies, sbom.dependencies[0]],
}, { packageName, packageVersion }), /invalid reference/);
assert.throws(() => validateConsumerSbom({
  ...sbom,
  components: [...sbom.components, { "bom-ref": "undici@7.28.0", name: "undici", version: "7.28.0" }],
  dependencies: [...sbom.dependencies, { ref: "undici@7.28.0", dependsOn: [] }],
}, { packageName, packageVersion }), /vulnerable undici/);
assert.throws(() => validateConsumerSbom({
  ...sbom,
  components: [...sbom.components, { "bom-ref": "sharp@0.35.4", name: "sharp", version: "0.35.4" }],
  dependencies: [...sbom.dependencies, { ref: "sharp@0.35.4", dependsOn: [] }],
}, { packageName, packageVersion }), /unsupported sharp 0\.35\.4/);

for (const version of ["invalid", "9", "7.29.0-beta.1"]) {
  const ref = "undici@" + version;
  assert.throws(() => validateConsumerSbom({
    ...sbom,
    components: [...sbom.components, { "bom-ref": ref, name: "undici", version }],
    dependencies: [...sbom.dependencies, { ref, dependsOn: [] }],
  }, { packageName, packageVersion }), /invalid or prerelease undici/);
}
for (const version of ["invalid", "0.35", "0.35.5-beta.1"]) {
  const ref = "sharp@" + version;
  assert.throws(() => validateConsumerSbom({
    ...sbom,
    components: [...sbom.components, { "bom-ref": ref, name: "sharp", version }],
    dependencies: [...sbom.dependencies, { ref, dependsOn: [] }],
  }, { packageName, packageVersion }), /unsupported sharp/);
}

console.log("consumer package security validation test ok");
