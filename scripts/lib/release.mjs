import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function tagSyncError({ scope = "local", tag, head, commit }) {
  const label = scope === "remote" ? "remote tag" : "local tag";
  if (!commit) {
    return `${label} ${tag} is missing; run the applicable GitHub release command before npm publish`;
  }
  if (commit !== head) {
    return `${label} ${tag} points to ${commit}, not HEAD ${head}`;
  }
  return "";
}

export function toolCatalogDigest(catalog) {
  return createHash("sha256").update(JSON.stringify(catalog)).digest("hex");
}

export function assertToolSchemaContract(metadata, catalog, baselines) {
  const generation = metadata.toolSchemaGeneration;
  if (!Number.isSafeInteger(generation) || generation < 1 || metadata.toolCatalogSha256 !== toolCatalogDigest(catalog)) {
    throw new Error("tool schema generation or catalog fingerprint is invalid");
  }
  if (!baselines.length) throw new Error("tool schema history baseline is required");
  for (const baseline of baselines) {
    const previous = baseline.metadata.toolSchemaGeneration;
    if (!Number.isSafeInteger(previous) || previous < 1) throw new Error("historical tool schema generation is invalid");
    if (generation < previous) throw new Error("tool schema generation must not decrease");
    if (toolCatalogDigest(catalog) !== toolCatalogDigest(baseline.catalog) && generation <= previous) {
      throw new Error(`changed tool catalog requires a strictly newer schema generation than ${baseline.ref}`);
    }
  }
}

// HEAD protects dirty edits; the previous release also protects already-committed edits in CI.
export function readToolSchemaBaselines(root, version) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete env[key];
  const git = (argv) => execFileSync("git", ["-c", "core.fsmonitor=false", ...argv], {
    cwd: root, env, encoding: "utf8", maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  try {
    const head = git(["rev-parse", "--verify", "HEAD^{commit}"]);
    const release = git(["describe", "--tags", "--abbrev=0", "--match", "v*", "--exclude", `v${version}`, head]);
    const releaseCommit = git(["rev-parse", "--verify", `${release}^{commit}`]);
    return [{ ref: "HEAD", commit: head }, { ref: release, commit: releaseCommit }].map((baseline) => ({
      ...baseline,
      metadata: JSON.parse(git(["show", `${baseline.commit}:src/shared/server-metadata.json`])),
      catalog: JSON.parse(git(["show", `${baseline.commit}:src/shared/tool-catalog.json`])),
    }));
  } catch {
    throw new Error("tool schema history is unavailable; fetch the complete release tags before verification");
  }
}

/**
 * Map verification task names to the per-task timeout declared by the repository
 * workflow bundle.
 *
 * @param {unknown} bundle parsed workflow-bundle.json
 * @param {Record<string, string>} packageScripts package.json scripts
 * @returns {Map<string, number>} task name -> timeout in milliseconds
 */
export function bundleTaskTimeouts(bundle, packageScripts = {}) {
  const stages = Array.isArray(bundle?.lifecycle) ? bundle.lifecycle : [];
  const scripts = packageScripts && typeof packageScripts === "object" ? packageScripts : {};
  const timeouts = new Map();
  for (const stage of stages) {
    const seconds = Number(stage?.command?.timeout_seconds);
    if (!Number.isFinite(seconds) || seconds <= 0) continue;
    const milliseconds = Math.round(seconds * 1000);
    const source = String(stage?.source || "").trim();
    if (!source) continue;
    const scriptName = /^package\.json#scripts\.(.+)$/.exec(source);
    if (scriptName) {
      timeouts.set(scriptName[1], milliseconds);
      continue;
    }
    for (const [task, command] of Object.entries(scripts)) {
      if (String(command).includes(source)) timeouts.set(task, milliseconds);
    }
  }
  return timeouts;
}

/**
 * Read the bundle from a repository root.
 * @param {string} root
 * @param {Record<string, string>} packageScripts
 * @returns {Map<string, number>}
 */
export function readBundleTaskTimeouts(root, packageScripts = {}) {
  try {
    return bundleTaskTimeouts(JSON.parse(readFileSync(resolve(root, "workflow-bundle.json"), "utf8")), packageScripts);
  } catch {
    return new Map();
  }
}
