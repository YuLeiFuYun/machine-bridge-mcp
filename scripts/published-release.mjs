import { resolveTrustedGithubCli } from "../src/local/trusted-github-cli.mjs";
import { nestedNpmEnvironment } from "../src/local/npm-environment.mjs";
import { githubReleaseByTagEndpoint, normalizeGithubReleaseAsset } from "./github-release-asset.mjs";
import { isTransientNetworkFailure, runNetworkCommand } from "./network-retry.mjs";
import { releaseCommandFailure } from "./release-diagnostic.mjs";

export function readPublishedNpmPrereleaseIfPresent(name, version, distTag, options = {}) {
  try {
    return readPublishedNpmPrerelease(name, version, distTag, options);
  } catch (error) {
    if (error?.code === "npm_version_not_found") return null;
    throw error;
  }
}

export function readPublishedNpmPrerelease(name, version, distTag, options = {}) {
  const run = options.run || ((args) => runNpmView(args, options));
  const actualVersion = run([`${name}@${version}`, "version", "--json"]);
  const integrity = run([`${name}@${version}`, "dist.integrity", "--json"]);
  const shasum = run([`${name}@${version}`, "dist.shasum", "--json"]);
  const tags = run([name, "dist-tags", "--json"]);
  const times = run([name, "time", "--json"]);
  return normalizePublishedNpmPrerelease({
    requestedVersion: version,
    requestedTag: distTag,
    actualVersion,
    integrity,
    shasum,
    tags,
    times,
  });
}

export function normalizePublishedNpmPrerelease(value) {
  const actualVersion = unwrapNpmJsonValue(value.actualVersion);
  const tags = unwrapNpmJsonValue(value.tags);
  const times = unwrapNpmJsonValue(value.times);
  const version = String(actualVersion || "");
  const requestedVersion = String(value.requestedVersion || "");
  const distTag = String(value.requestedTag || "");
  const integrity = String(unwrapNpmJsonValue(value.integrity) || "");
  const shasum = String(unwrapNpmJsonValue(value.shasum) || "");
  const publishedAt = String(times?.[requestedVersion] || "");
  if (version !== requestedVersion) throw publicationMetadataError("npm registry returned another prerelease version", "npm_version_mismatch");
  if (tags?.[distTag] !== requestedVersion) {
    throw publicationMetadataError(`npm dist-tag ${distTag} does not point to ${requestedVersion}`, "npm_dist_tag_mismatch");
  }
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity)) throw publicationMetadataError("npm prerelease integrity is invalid", "npm_integrity_invalid");
  if (!/^[0-9a-f]{40}$/.test(shasum)) throw publicationMetadataError("npm prerelease SHA-1 is invalid", "npm_shasum_invalid");
  if (!Number.isFinite(Date.parse(publishedAt))) {
    throw publicationMetadataError("npm prerelease publication timestamp is invalid", "npm_publication_metadata_incomplete");
  }
  return Object.freeze({ version, integrity, shasum, distTag, publishedAt: new Date(Date.parse(publishedAt)).toISOString() });
}

function publicationMetadataError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function unwrapNpmJsonValue(value) {
  return Array.isArray(value) && value.length === 1 ? value[0] : value;
}

export function readGithubPrerelease(version, options = {}) {
  const run = options.run || runGh;
  const tag = `v${version}`;
  const value = run(["release", "view", tag, "--json", "tagName,isPrerelease,publishedAt,assets"]);
  const normalized = normalizeGithubPrerelease(value, version);
  const expectedSha256 = String(options.expectedArtifactSha256 || "");
  if (!expectedSha256) return normalized;
  const assetRun = options.assetRun || runGh;
  const release = assetRun(["api", githubReleaseByTagEndpoint(tag)]);
  const verifiedAsset = normalizeGithubReleaseAsset(release, {
    tag,
    assetName: normalized.asset.name,
    expectedSha256,
  });
  if (verifiedAsset.size !== normalized.asset.size) {
    throw new Error("GitHub prerelease asset size differs between release metadata and REST digest evidence");
  }
  return Object.freeze({ ...normalized, asset: verifiedAsset });
}

export function normalizeGithubPrerelease(value, version) {
  const tag = String(value?.tagName || "");
  const publishedAt = String(value?.publishedAt || "");
  if (tag !== `v${version}` || value?.isPrerelease !== true) throw new Error("GitHub prerelease is missing or not marked as a prerelease");
  if (!Number.isFinite(Date.parse(publishedAt))) throw new Error("GitHub prerelease publication timestamp is invalid");
  if (!Array.isArray(value?.assets)) throw new Error("GitHub prerelease asset inventory is unavailable");
  const expectedAsset = `machine-bridge-mcp-${version}.tgz`;
  const asset = value.assets.find((entry) => entry && typeof entry === "object" && entry.name === expectedAsset);
  if (!asset) throw new Error(`GitHub prerelease is missing ${expectedAsset}`);
  const size = Number(asset.size);
  if (!Number.isSafeInteger(size) || size < 1) throw new Error("GitHub prerelease package asset size is invalid");
  return Object.freeze({
    tag,
    isPrerelease: true,
    publishedAt: new Date(Date.parse(publishedAt)).toISOString(),
    asset: Object.freeze({ name: expectedAsset, size }),
  });
}

function runNpmView(args, options = {}) {
  const npmCli = options.npmCli || process.env.npm_execpath;
  if (!npmCli) throw new Error("npm registry verification must run through npm");
  const result = runNetworkCommand(process.execPath, [npmCli, "view", "--workspaces=false", "--global=false", ...args], {
    env: nestedNpmEnvironment(options.env || process.env),
    timeoutMs: options.timeoutMs,
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || "");
    const error = new Error(releaseCommandFailure("npm", ["view"], result));
    if (/\bE404\b|is not in this registry/i.test(detail)) error.code = "npm_version_not_found";
    else {
      error.code = "npm_registry_query_failed";
      error.transient = isTransientNetworkFailure(result);
    }
    throw error;
  }
  try { return JSON.parse(result.stdout); } catch { throw new Error(`npm view ${args[0]} returned invalid JSON`); }
}

function runGh(args) {
  const result = runNetworkCommand(resolveTrustedGithubCli({ workspace: process.cwd() }), args, {
    env: process.env,
    timeoutMs: 120_000,
  });
  if (result.error || result.status !== 0) throw new Error(releaseCommandFailure("gh", args, result));
  try { return JSON.parse(result.stdout); } catch { throw new Error("GitHub prerelease query returned invalid JSON"); }
}
