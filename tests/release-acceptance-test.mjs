import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ACCEPTANCE_CONFIRMATION,
  ACCEPTANCE_SCHEMA_VERSION,
  acceptancePath,
  packProject,
  requiresLocalAcceptance,
  verifyAcceptanceRecord,
  verifyCurrentReleaseAcceptance,
} from "../scripts/release-acceptance.mjs";

const root = mkdtempSync(join(tmpdir(), "mbm-release-acceptance-test-"));
const output = join(root, "output");
try {
  mkdirSync(output, { recursive: true });
  writePackage("1.2.8");
  writeFileSync(join(root, "index.js"), "export const value = 1;\n");

  assert(!requiresLocalAcceptance("1.2.7"), "acceptance was required before the policy version");
  assert(requiresLocalAcceptance("1.2.8"), "acceptance was not required at the policy version");
  assert(requiresLocalAcceptance("2.0.0"), "acceptance was not required after the policy version");

  const metadata = packProject(root, output);
  const record = {
    schema_version: ACCEPTANCE_SCHEMA_VERSION,
    result: "passed",
    confirmation: ACCEPTANCE_CONFIRMATION,
    ...metadata,
    accepted_at: "2026-07-17T12:00:00.000Z",
  };
  verifyAcceptanceRecord(record, metadata);
  const recordPath = acceptancePath(root, metadata.package_version);
  mkdirSync(dirname(recordPath), { recursive: true });
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);

  const verified = verifyCurrentReleaseAcceptance(root);
  assert(verified.required && verified.metadata.shasum === metadata.shasum, "current package did not match its local acceptance record");

  writeFileSync(join(root, "index.js"), "export const value = 2;\n");
  expectThrow(() => verifyCurrentReleaseAcceptance(root), "does not match the current npm package");

  writePackage("1.2.7");
  const grandfathered = verifyCurrentReleaseAcceptance(root);
  assert(grandfathered.required === false, "pre-policy package unexpectedly required an acceptance record");

  console.log("release acceptance gate test ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}

function writePackage(version) {
  writeFileSync(join(root, "package.json"), `${JSON.stringify({
    name: "release-acceptance-fixture",
    version,
    type: "module",
    files: ["index.js"],
  }, null, 2)}\n`);
}

function expectThrow(callback, expected) {
  try {
    callback();
  } catch (error) {
    if (String(error?.message || error).includes(expected)) return;
    throw error;
  }
  throw new Error(`expected throw containing: ${expected}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
