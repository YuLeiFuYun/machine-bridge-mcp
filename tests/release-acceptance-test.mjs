import {
  copyFileSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import {
  PERSISTENT_OWNER_ACTIVATED_CONFIRMATION,
  ACCEPTANCE_SCHEMA_VERSION,
  LEGACY_ACCEPTANCE_CONFIRMATION,
  OWNER_STARTED_ACCEPTANCE_CONFIRMATION,
  acceptanceConfirmationForVersion,
  acceptancePath,
  packProject,
  requiresLocalAcceptance,
  verifyAcceptanceRecord,
  verifyCurrentReleaseAcceptance,
  verifyTarball,
} from "../scripts/release-acceptance.mjs";
import { computePromotionContentDigest } from "../scripts/promotion-digest.mjs";
import { resolveAcceptedCandidateTarball, stageAcceptedCandidateTarball } from "../scripts/accepted-candidate-tarball.mjs";
import {
  canonicalPackageDigest,
  verifyPortableAcceptance,
} from "../.github/scripts/verify-release-acceptance.mjs";

const root = mkdtempSync(join(tmpdir(), "mbm-release-acceptance-test-"));
const output = join(root, "output");
try {
  mkdirSync(output, { recursive: true });
  writePackage("3.0.0-beta.1");
  writeFileSync(join(root, "index.js"), "export const value = 1;\n");
  git(["init", "-q"]);
  git(["add", "package.json", "index.js"]);

  assert(!requiresLocalAcceptance("1.2.7"), "acceptance was required before the policy version");
  assert(requiresLocalAcceptance("1.2.8"), "acceptance was not required at the policy version");
  assert(requiresLocalAcceptance("3.0.0-beta.1"), "acceptance was not required after the policy version");
  assert(acceptanceConfirmationForVersion("3.0.0-beta.1") === PERSISTENT_OWNER_ACTIVATED_CONFIRMATION, "v3 acceptance did not require owner activation plus agent verification");

  const metadata = packProject(root, output);
  const inheritedDryRunOutput = join(root, "inherited-dry-run-output");
  mkdirSync(inheritedDryRunOutput, { recursive: true });
  const previousDryRun = process.env.npm_config_dry_run;
  process.env.npm_config_dry_run = "true";
  try {
    const inheritedDryRunMetadata = packProject(root, inheritedDryRunOutput);
    assert(inheritedDryRunMetadata.shasum === metadata.shasum, "nested npm pack inherited the outer dry-run flag");
  } finally {
    if (previousDryRun === undefined) delete process.env.npm_config_dry_run;
    else process.env.npm_config_dry_run = previousDryRun;
  }
  const portablePack = packFixtureMetadata();
  const record = {
    schema_version: ACCEPTANCE_SCHEMA_VERSION,
    result: "passed",
    confirmation: PERSISTENT_OWNER_ACTIVATED_CONFIRMATION,
    ...metadata,
    package_content_sha256: canonicalPackageDigest(root, portablePack),
    promotion_content_sha256: computePromotionContentDigest(root, { packRecord: portablePack[0] }),
    accepted_at: "2026-07-18T12:00:00.000Z",
  };
  verifyAcceptanceRecord(record, metadata);
  expectThrow(() => verifyAcceptanceRecord({ ...record, package_content_sha256: "" }, metadata), "portable package-content digest");
  expectThrow(() => verifyAcceptanceRecord({ ...record, promotion_content_sha256: "" }, metadata), "promotion-content digest");
  expectThrow(() => verifyAcceptanceRecord({ ...record, machine_path: "/Users/example/private" }, metadata), "unsupported fields");
  const normalizedRecord = verifyAcceptanceRecord(record, metadata);
  assert(!Object.hasOwn(normalizedRecord, "machine_path"), "acceptance normalization retained undeclared data");
  expectThrow(() => verifyAcceptanceRecord({ ...record, confirmation: OWNER_STARTED_ACCEPTANCE_CONFIRMATION }, metadata), "active verification workflow");
  expectThrow(() => verifyAcceptanceRecord({ ...record, confirmation: LEGACY_ACCEPTANCE_CONFIRMATION }, metadata), "active verification workflow");
  const recordPath = acceptancePath(root, metadata.package_version);
  mkdirSync(dirname(recordPath), { recursive: true });
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);

  const verified = verifyCurrentReleaseAcceptance(root);
  assert(verified.required && verified.metadata.shasum === metadata.shasum, "current package did not match its local acceptance record");
  const candidateDirectory = join(root, ".release-candidate");
  mkdirSync(candidateDirectory);
  copyFileSync(join(output, metadata.filename), join(candidateDirectory, metadata.filename));
  const candidateManifest = {
    schema_version: ACCEPTANCE_SCHEMA_VERSION,
    result: "pending",
    ...metadata,
    promotion_content_sha256: record.promotion_content_sha256,
    prepared_at: "2026-07-18T11:00:00.000Z",
  };
  const candidateManifestPath = join(candidateDirectory, "manifest.json");
  writeFileSync(candidateManifestPath, `${JSON.stringify(candidateManifest, null, 2)}\n`);
  const acceptedCandidate = resolveAcceptedCandidateTarball(root, verified);
  assert(acceptedCandidate.path === join(candidateDirectory, metadata.filename),
    "accepted candidate tarball did not resolve to the exact local artifact");
  const stagedCandidate = stageAcceptedCandidateTarball(root, verified, { tempRoot: root });
  assert(stagedCandidate.path !== acceptedCandidate.path
    && readFileSync(stagedCandidate.path).equals(readFileSync(acceptedCandidate.path)),
  "accepted candidate staging did not preserve the exact verified bytes");
  stagedCandidate.dispose();
  writeFileSync(candidateManifestPath, `${JSON.stringify({ ...candidateManifest, shasum: "f".repeat(40) }, null, 2)}\n`);
  expectThrow(() => resolveAcceptedCandidateTarball(root, verified), "shasum does not match");
  writeFileSync(candidateManifestPath, `${JSON.stringify(candidateManifest, null, 2)}\n`);
  if (process.platform !== "win32") {
    const hardlink = join(candidateDirectory, "candidate-hardlink.tgz");
    linkSync(join(candidateDirectory, metadata.filename), hardlink);
    expectThrow(() => resolveAcceptedCandidateTarball(root, verified), "tarball is not a regular file");
    unlinkSync(hardlink);
  }
  if (process.platform !== "win32") {
    const realRecordPath = `${recordPath}.real`;
    renameSync(recordPath, realRecordPath);
    symlinkSync(realRecordPath, recordPath);
    expectThrow(() => verifyCurrentReleaseAcceptance(root), "must be a regular file");
    unlinkSync(recordPath);
    renameSync(realRecordPath, recordPath);

    const tarballPath = join(output, metadata.filename);
    const tarballLink = join(output, "candidate-link.tgz");
    symlinkSync(tarballPath, tarballLink);
    expectThrow(() => verifyTarball(tarballLink, metadata), "tarball is not a regular file");
    unlinkSync(tarballLink);
  }
  const portable = verifyPortableAcceptance(root, portablePack);
  assert(portable.digest === record.package_content_sha256, "portable acceptance digest did not match the accepted package content");

  writeFileSync(join(root, "index.js"), "export const value = 2;\n");
  expectThrow(() => verifyCurrentReleaseAcceptance(root), "does not match the current npm package");
  git(["add", "index.js"]);
  expectThrow(() => verifyPortableAcceptance(root, packFixtureMetadata()), "content digest does not match");

  writePackage("1.2.9");
  writeFileSync(join(root, "index.js"), "export const value = 3;\n");
  git(["add", "package.json", "index.js"]);
  const ownerStartedMetadata = packProject(root, output);
  const ownerStartedRecord = {
    schema_version: ACCEPTANCE_SCHEMA_VERSION,
    result: "passed",
    confirmation: OWNER_STARTED_ACCEPTANCE_CONFIRMATION,
    ...ownerStartedMetadata,
    package_content_sha256: canonicalPackageDigest(root, packFixtureMetadata()),
    accepted_at: "2026-07-17T18:00:00.000Z",
  };
  verifyAcceptanceRecord(ownerStartedRecord, ownerStartedMetadata);

  writePackage("1.2.8");
  writeFileSync(join(root, "index.js"), "export const value = 4;\n");
  git(["add", "package.json", "index.js"]);
  const legacyMetadata = packProject(root, output);
  const legacyRecord = {
    schema_version: ACCEPTANCE_SCHEMA_VERSION,
    result: "passed",
    confirmation: LEGACY_ACCEPTANCE_CONFIRMATION,
    ...legacyMetadata,
    package_content_sha256: canonicalPackageDigest(root, packFixtureMetadata()),
    accepted_at: "2026-07-17T12:00:00.000Z",
  };
  const legacyPath = acceptancePath(root, legacyMetadata.package_version);
  mkdirSync(dirname(legacyPath), { recursive: true });
  writeFileSync(legacyPath, `${JSON.stringify(legacyRecord, null, 2)}\n`);
  const legacyVerified = verifyCurrentReleaseAcceptance(root);
  assert(legacyVerified.required && legacyVerified.record.confirmation === LEGACY_ACCEPTANCE_CONFIRMATION, "legacy 1.2.8 owner-recorded acceptance was not preserved");

  writePackage("1.2.7");
  const grandfathered = verifyCurrentReleaseAcceptance(root);
  assert(grandfathered.required === false, "pre-policy package unexpectedly required an acceptance record");

  console.log("release acceptance gate test ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}

function writePackage(version) {
  writeFileSync(join(root, "package.json"), `${JSON.stringify({
    name: "machine-bridge-mcp",
    version,
    type: "module",
    files: ["index.js"],
  }, null, 2)}\n`);
}

function packFixtureMetadata() {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  return [{
    name: pkg.name,
    version: pkg.version,
    filename: `${pkg.name}-${pkg.version}.tgz`,
    files: ["index.js", "package.json"].map((path) => ({
      path,
      size: readFileSync(join(root, path)).length,
      mode: 0o644,
    })),
  }];
}

function git(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
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
