import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readBoundedRegularFileSync } from "../src/local/secure-file.mjs";
import { validateCandidateManifest } from "./release-candidate-manifest.mjs";
import { verifyTarball } from "./release-acceptance.mjs";

const MAX_CANDIDATE_MANIFEST_BYTES = 64 * 1024;

export function resolveAcceptedCandidateTarball(repositoryRoot, acceptance) {
  const inspected = inspectAcceptedCandidate(repositoryRoot, acceptance);
  return Object.freeze({ path: inspected.path, manifest: inspected.manifest });
}

export function stageAcceptedCandidateTarball(repositoryRoot, acceptance, options = {}) {
  const inspected = inspectAcceptedCandidate(repositoryRoot, acceptance);
  const parent = resolve(String(options.tempRoot || tmpdir()));
  const stagingRoot = mkdtempSync(join(parent, "mbm-accepted-candidate-"));
  let disposed = false;
  try {
    const stagedPath = join(stagingRoot, inspected.manifest.filename);
    writeFileSync(stagedPath, inspected.bytes, { flag: "wx", mode: 0o600 });
    verifyTarball(stagedPath, acceptance.metadata);
    return Object.freeze({
      path: stagedPath,
      manifest: inspected.manifest,
      dispose() {
        if (disposed) return;
        rmSync(stagingRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
        disposed = true;
      },
    });
  } catch (error) {
    try { rmSync(stagingRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
    catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "accepted candidate staging failed and temporary cleanup was incomplete");
    }
    throw error;
  }
}

function inspectAcceptedCandidate(repositoryRoot, acceptance) {
  const root = resolve(repositoryRoot);
  if (acceptance?.required !== true || !acceptance.metadata || !acceptance.record) {
    throw new Error("exact npm publication requires current local candidate acceptance");
  }
  const directory = join(root, ".release-candidate");
  const manifest = validateCandidateManifest(readManifest(join(directory, "manifest.json")), {
    packageName: acceptance.metadata.package_name,
    packageVersion: acceptance.metadata.package_version,
  });
  for (const key of ["filename", "shasum", "integrity"]) {
    if (manifest[key] !== acceptance.metadata[key]) {
      throw new Error(`accepted candidate manifest ${key} does not match the acceptance record`);
    }
  }
  if (manifest.promotion_content_sha256 !== acceptance.record.promotion_content_sha256) {
    throw new Error("accepted candidate manifest promotion digest does not match the acceptance record");
  }
  const path = join(directory, manifest.filename);
  const bytes = verifyTarball(path, acceptance.metadata);
  return { path, manifest, bytes };
}

function readManifest(file) {
  let bytes;
  try {
    bytes = readBoundedRegularFileSync(file, MAX_CANDIDATE_MANIFEST_BYTES, "release candidate manifest", {
      verifyPathIdentity: true,
      rejectMultipleLinks: true,
    });
  } catch (error) {
    throw new Error(`release candidate manifest is unavailable or unsafe: ${error?.message || error}`, { cause: error });
  }
  try { return JSON.parse(bytes.toString("utf8")); }
  catch (error) { throw new Error(`release candidate manifest is not valid JSON: ${error.message}`, { cause: error }); }
}
