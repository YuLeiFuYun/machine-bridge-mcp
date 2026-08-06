#!/usr/bin/env node

import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readBoundedRegularFileSync } from "../src/local/secure-file.mjs";
import { replaceFileAtomicallySync } from "../src/local/exclusive-file.mjs";
import { readPrereleaseActivation } from "./prerelease-activation.mjs";
import { computePromotionContentDigest } from "./promotion-digest.mjs";
import {
  SOAK_CONFIRMATION,
  assertSoakEligiblePrerelease,
  assertStablePromotion,
  compareReleaseVersions,
  formatSoakDuration,
  minimumSoakSeconds,
  parseReleaseVersion,
  requiresSoakForStable,
} from "./release-channel.mjs";
import { verifyCurrentReleaseAcceptance } from "./release-acceptance.mjs";
import { resolveTrustedGitExecutable } from "../src/local/trusted-git-executable.mjs";
import { readGithubPrerelease, readPublishedNpmPrerelease } from "./published-release.mjs";
import { createHardenedNpmSession } from "./hardened-npm-session.mjs";
import { releaseCommandFailure, releaseDiagnostic } from "./release-diagnostic.mjs";

export const SOAK_SCHEMA_VERSION = 1;
const MAX_SOAK_RECORD_BYTES = 64 * 1024;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`release soak failed: ${releaseDiagnostic(error?.message || error, 1400)}`);
    process.exitCode = 1;
  });
}

async function main() {
  const mode = process.argv[2] || "--verify";
  if (mode === "--record") {
    await recordCurrentPrereleaseSoak(root, { confirmation: argumentValue("--confirm"), stateRoot: argumentValue("--state-dir") || undefined });
  } else if (mode === "--verify") verifyCurrentStableSoak(root);
  else if (mode === "--status") printStatus(root);
  else throw new Error("usage: node scripts/release-soak.mjs [--record --confirm TEXT [--state-dir DIR]|--verify|--status]");
}

export function soakRecordPath(repositoryRoot, stableVersion) {
  const stable = parseReleaseVersion(stableVersion);
  if (stable.prerelease) throw new Error("soak record path requires a stable version");
  return join(repositoryRoot, "release-soak", `v${stable.raw}.json`);
}

export async function recordCurrentPrereleaseSoak(repositoryRoot, options = {}) {
  const pkg = readPackage(repositoryRoot);
  const prerelease = assertSoakEligiblePrerelease(pkg.version);
  const acceptance = verifyCurrentReleaseAcceptance(repositoryRoot);
  if (!acceptance.required) throw new Error("prerelease package is missing local candidate acceptance policy");
  const activation = readPrereleaseActivation(prerelease.raw, options.stateRoot);
  if (activation.source !== "npm-prerelease") {
    throw new Error("formal soak starts only after installing the published npm beta/rc; a local candidate activation is insufficient");
  }
  if (activation.integrity !== acceptance.metadata.integrity || activation.shasum !== acceptance.metadata.shasum) {
    throw new Error("activated prerelease bytes do not match the locally accepted prerelease package");
  }
  const promotionDigest = computePromotionContentDigest(repositoryRoot);
  if (activation.promotion_content_sha256 !== promotionDigest) {
    throw new Error("activated prerelease promotion digest does not match the current source tree");
  }
  const previousStable = options.previousStableVersion || latestStableTag(repositoryRoot, prerelease.baseVersion);
  const requiredSeconds = minimumSoakSeconds(prerelease.baseVersion, previousStable);
  const activatedAt = Date.parse(activation.activated_at);
  const acceptedAt = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const observedSeconds = Math.floor((acceptedAt - activatedAt) / 1000);
  if (observedSeconds < requiredSeconds) {
    throw new Error(`prerelease soak is incomplete: observed ${formatSoakDuration(Math.max(0, observedSeconds))}, required ${formatSoakDuration(requiredSeconds)}`);
  }
  const expected = soakConfirmationPhrase(pkg.name, prerelease.raw, requiredSeconds);
  if (options.confirmation !== expected) throw new Error(`soak confirmation must exactly match: ${expected}`);

  const published = options.published || await readPublishedWithHardenedNpm(pkg.name, prerelease);
  if (
    published.version !== prerelease.raw
    || published.integrity !== acceptance.metadata.integrity
    || published.shasum !== acceptance.metadata.shasum
    || published.distTag !== prerelease.npmTag
    || published.publishedAt !== activation.published_at
  ) {
    throw new Error("published npm prerelease metadata does not match the accepted and activated package");
  }
  const github = options.github || readGithubPrerelease(prerelease.raw, {
    expectedArtifactSha256: acceptance.artifactSha256,
  });
  if (github.tag !== `v${prerelease.raw}` || github.isPrerelease !== true) {
    throw new Error("GitHub prerelease is missing or not marked as a prerelease");
  }
  const record = validateSoakRecord({
    schema_version: SOAK_SCHEMA_VERSION,
    result: "passed",
    confirmation: SOAK_CONFIRMATION,
    package_name: pkg.name,
    stable_version: prerelease.baseVersion,
    prerelease_version: prerelease.raw,
    prerelease_channel: prerelease.channel,
    prerelease_shasum: acceptance.metadata.shasum,
    prerelease_integrity: acceptance.metadata.integrity,
    promotion_content_sha256: promotionDigest,
    activated_at: activation.activated_at,
    published_at: published.publishedAt,
    accepted_at: new Date(acceptedAt).toISOString(),
    minimum_soak_seconds: requiredSeconds,
    observed_soak_seconds: observedSeconds,
    npm_dist_tag: prerelease.npmTag,
    github_prerelease_tag: github.tag,
    previous_stable_version: previousStable,
    known_blocking_issues: 0,
  });
  const file = soakRecordPath(repositoryRoot, prerelease.baseVersion);
  mkdirSync(dirname(file), { recursive: true });
  replaceFileAtomicallySync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o644 });
  console.log(`Published prerelease soak accepted: ${file}`);
  console.log("Stable promotion may change only synchronized version metadata; any functional package change requires a new prerelease and a new soak window.");
  return record;
}

async function readPublishedWithHardenedNpm(packageName, prerelease) {
  const session = await createHardenedNpmSession();
  let result = null;
  let primaryError = null;
  try {
    result = readPublishedNpmPrerelease(packageName, prerelease.raw, prerelease.npmTag, {
      npmCli: session.cli,
      env: process.env,
    });
  } catch (error) {
    primaryError = error;
  }
  let cleanupError = null;
  try { session.dispose(); } catch (error) { cleanupError = error; }
  if (primaryError && cleanupError) {
    throw new AggregateError([primaryError, cleanupError], "npm prerelease verification failed and hardened npm cleanup was incomplete");
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
  return result;
}

export function verifyCurrentStableSoak(repositoryRoot, options = {}) {
  const pkg = readPackage(repositoryRoot);
  if (!requiresSoakForStable(pkg.version)) return { required: false, version: pkg.version };
  const file = soakRecordPath(repositoryRoot, pkg.version);
  const readRecord = options.readBoundedRegularFileSync || readBoundedRegularFileSync;
  let bytes;
  try {
    bytes = readRecord(file, MAX_SOAK_RECORD_BYTES, "release soak record", {
      verifyPathIdentity: true,
      rejectMultipleLinks: true,
    });
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`stable release soak record is missing: ${file}`, { cause: error });
    throw new Error("release soak record is unavailable", { cause: error });
  }
  let parsed;
  try { parsed = JSON.parse(bytes.toString("utf8")); }
  catch (error) { throw new Error("release soak record is invalid", { cause: error }); }
  const promotionDigest = computePromotionContentDigest(repositoryRoot, options);
  const record = validateSoakRecord(parsed, { stableVersion: pkg.version, promotionDigest });
  return { required: true, version: pkg.version, record, promotionDigest };
}

export function validateSoakRecord(value, options = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("release soak record must be an object");
  const allowed = new Set([
    "schema_version", "result", "confirmation", "package_name", "stable_version", "prerelease_version",
    "prerelease_channel", "prerelease_shasum", "prerelease_integrity", "promotion_content_sha256",
    "activated_at", "published_at", "accepted_at", "minimum_soak_seconds", "observed_soak_seconds",
    "npm_dist_tag", "github_prerelease_tag", "previous_stable_version", "known_blocking_issues",
  ]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`release soak record contains unsupported fields: ${unknown.join(", ")}`);
  if (value.schema_version !== SOAK_SCHEMA_VERSION) throw new Error("unsupported release soak schema");
  if (value.result !== "passed" || value.confirmation !== SOAK_CONFIRMATION) throw new Error("release soak is not accepted");
  if (value.package_name !== "machine-bridge-mcp") throw new Error("release soak package name is invalid");
  const { stable, prerelease } = assertStablePromotion(value.stable_version, value.prerelease_version);
  if (value.prerelease_channel !== prerelease.channel) throw new Error("release soak prerelease channel is inconsistent");
  if (value.npm_dist_tag !== prerelease.npmTag) throw new Error("release soak npm dist-tag is inconsistent");
  if (value.github_prerelease_tag !== `v${prerelease.raw}`) throw new Error("release soak GitHub prerelease tag is inconsistent");
  if (!/^[0-9a-f]{40}$/.test(String(value.prerelease_shasum || ""))) throw new Error("release soak prerelease SHA-1 is invalid");
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(String(value.prerelease_integrity || ""))) throw new Error("release soak prerelease integrity is invalid");
  if (!/^[0-9a-f]{64}$/.test(String(value.promotion_content_sha256 || ""))) throw new Error("release soak promotion digest is invalid");
  const activatedAt = Date.parse(String(value.activated_at || ""));
  const publishedAt = Date.parse(String(value.published_at || ""));
  const acceptedAt = Date.parse(String(value.accepted_at || ""));
  if (![activatedAt, publishedAt, acceptedAt].every(Number.isFinite)) throw new Error("release soak timestamps are invalid");
  if (publishedAt > activatedAt + 5 * 60 * 1000 || activatedAt > acceptedAt) throw new Error("release soak timestamp ordering is invalid");
  if (!Number.isSafeInteger(value.minimum_soak_seconds) || value.minimum_soak_seconds < 60) throw new Error("release soak minimum duration is invalid");
  if (!Number.isSafeInteger(value.observed_soak_seconds) || value.observed_soak_seconds < value.minimum_soak_seconds) throw new Error("release soak observed duration is insufficient");
  const elapsed = Math.floor((acceptedAt - activatedAt) / 1000);
  if (value.observed_soak_seconds > elapsed + 5 || value.observed_soak_seconds < elapsed - 5) throw new Error("release soak observed duration does not match its timestamps");
  if (value.known_blocking_issues !== 0) throw new Error("stable release is blocked by known prerelease issues");
  const previous = parseReleaseVersion(value.previous_stable_version);
  if (previous.prerelease || compareReleaseVersions(stable, previous) <= 0) throw new Error("release soak previous stable version is invalid");
  const expectedMinimum = minimumSoakSeconds(stable.raw, previous.raw);
  if (value.minimum_soak_seconds < expectedMinimum) throw new Error("release soak duration is below the active policy minimum");
  if (options.stableVersion && stable.raw !== parseReleaseVersion(options.stableVersion).raw) throw new Error("release soak record targets another stable version");
  if (options.promotionDigest && value.promotion_content_sha256 !== options.promotionDigest) {
    throw new Error("stable package content differs from the accepted prerelease; publish a new prerelease and restart soak");
  }
  return Object.freeze({
    schema_version: SOAK_SCHEMA_VERSION,
    result: "passed",
    confirmation: SOAK_CONFIRMATION,
    package_name: "machine-bridge-mcp",
    stable_version: stable.raw,
    prerelease_version: prerelease.raw,
    prerelease_channel: prerelease.channel,
    prerelease_shasum: String(value.prerelease_shasum),
    prerelease_integrity: String(value.prerelease_integrity),
    promotion_content_sha256: String(value.promotion_content_sha256),
    activated_at: new Date(activatedAt).toISOString(),
    published_at: new Date(publishedAt).toISOString(),
    accepted_at: new Date(acceptedAt).toISOString(),
    minimum_soak_seconds: Number(value.minimum_soak_seconds),
    observed_soak_seconds: Number(value.observed_soak_seconds),
    npm_dist_tag: prerelease.npmTag,
    github_prerelease_tag: `v${prerelease.raw}`,
    previous_stable_version: previous.raw,
    known_blocking_issues: 0,
  });
}

export function soakConfirmationPhrase(name, prereleaseVersion, requiredSeconds) {
  return `I SOAK-TESTED ${name} ${prereleaseVersion} FOR AT LEAST ${formatSoakDuration(requiredSeconds)} WITH NO BLOCKING ISSUES`;
}

function latestStableTag(repositoryRoot, targetBaseVersion) {
  const target = parseReleaseVersion(targetBaseVersion);
  const git = resolveTrustedGitExecutable({ workspace: repositoryRoot });
  const result = run(git, ["tag", "--list", "v*"], { cwd: repositoryRoot });
  const versions = result.stdout.split(/\r?\n/).map((tag) => tag.trim().replace(/^v/, "")).filter(Boolean)
    .map((value) => { try { return parseReleaseVersion(value); } catch { return null; } })
    .filter((value) => value && !value.prerelease && compareReleaseVersions(value, target) < 0)
    .sort(compareReleaseVersions);
  const previous = versions.at(-1);
  if (!previous) throw new Error(`could not determine the previous stable version before ${target.raw}`);
  return previous.raw;
}

function printStatus(repositoryRoot) {
  const pkg = readPackage(repositoryRoot);
  const parsed = parseReleaseVersion(pkg.version);
  if (parsed.prerelease) {
    console.log(JSON.stringify({ version: parsed.raw, channel: parsed.channel, stable_target: parsed.baseVersion, soak_record: soakRecordPath(repositoryRoot, parsed.baseVersion) }, null, 2));
    return;
  }
  const result = verifyCurrentStableSoak(repositoryRoot);
  console.log(JSON.stringify(result, null, 2));
}

function readPackage(repositoryRoot) {
  const value = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
  if (value.name !== "machine-bridge-mcp") throw new Error("unexpected package name");
  parseReleaseVersion(value.version);
  return value;
}

function run(file, args, options = {}) {
  const result = spawnSync(file, args, {
    cwd: options.cwd || root,
    encoding: "utf8",
    env: process.env,
    timeout: 30_000,
    killSignal: "SIGKILL",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error(releaseCommandFailure(file, args, result));
  return result;
}

function argumentValue(name) {
  const exact = process.argv.find((value) => value.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}
