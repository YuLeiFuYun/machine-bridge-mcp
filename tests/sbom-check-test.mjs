import assert from "node:assert/strict";
import { validateCycloneDxSbom } from "../scripts/sbom-check.mjs";

const valid = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  metadata: { component: { "bom-ref": "example@1.0.0", name: "example", version: "1.0.0" } },
  components: [{ "bom-ref": "dependency@2.0.0", name: "dependency", version: "2.0.0" }],
  dependencies: [
    { ref: "example@1.0.0", dependsOn: ["dependency@2.0.0"] },
    { ref: "dependency@2.0.0", dependsOn: [] },
  ],
};
const summary = validateCycloneDxSbom(valid, { packageName: "example", packageVersion: "1.0.0", forbiddenPaths: ["/private/example"] });
assert.deepEqual(summary, {
  bom_format: "CycloneDX",
  spec_version: "1.5",
  package: "example@1.0.0",
  components: 1,
  dependencies: 2,
});
assert.throws(() => validateCycloneDxSbom({ ...valid, bomFormat: "SPDX" }, { packageName: "example", packageVersion: "1.0.0" }), /CycloneDX 1.5/);
assert.throws(() => validateCycloneDxSbom({ ...valid, metadata: { component: { ...valid.metadata.component, version: "2.0.0" } } }, { packageName: "example", packageVersion: "1.0.0" }), /package identity/);
assert.throws(() => validateCycloneDxSbom({ ...valid, components: [valid.components[0], valid.components[0]] }, { packageName: "example", packageVersion: "1.0.0" }), /duplicate component/);
assert.throws(() => validateCycloneDxSbom({ ...valid, dependencies: [{ ref: "dependency@2.0.0", dependsOn: [] }] }, { packageName: "example", packageVersion: "1.0.0" }), /omits a component reference/);
assert.throws(() => validateCycloneDxSbom({ ...valid, dependencies: [{ ref: "example@1.0.0", dependsOn: ["missing@1.0.0"] }, valid.dependencies[1]] }, { packageName: "example", packageVersion: "1.0.0" }), /invalid reference/);
assert.throws(() => validateCycloneDxSbom({ ...valid, dependencies: [...valid.dependencies, valid.dependencies[0]] }, { packageName: "example", packageVersion: "1.0.0" }), /invalid reference/);
assert.throws(() => validateCycloneDxSbom({ ...valid, metadata: { ...valid.metadata, note: "/private/example" } }, { packageName: "example", packageVersion: "1.0.0", forbiddenPaths: ["/private/example"] }), /local filesystem path/);
console.log("SBOM validation test ok");
