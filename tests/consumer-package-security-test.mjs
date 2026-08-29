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
for (const [name, version, expected] of [
  ["wrangler", "4.127.1", /private control-plane package wrangler/],
  ["miniflare", "4.20260722.1", /private control-plane package miniflare/],
  ["undici", "7.28.0", /vulnerable undici 7\.28\.0/],
  ["sharp", "0.35.2", /unsupported sharp 0\.35\.2/],
]) {
  assert.throws(() => validateConsumerTree({
    dependencies: {
      [packageName]: { version: packageVersion, dependencies: { [name]: { version } } },
    },
  }, { packageName, packageVersion }), expected);
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

console.log("consumer package security validation test ok");
