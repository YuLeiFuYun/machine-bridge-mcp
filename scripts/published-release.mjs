import { spawnSync } from "node:child_process";
import { resolveTrustedGithubCli } from "../src/local/trusted-github-cli.mjs";

export function readPublishedNpmPrerelease(name, version, distTag, options = {}) {
  const run = options.run || runNpmView;
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
  if (version !== requestedVersion) throw new Error("npm registry returned another prerelease version");
  if (tags?.[distTag] !== requestedVersion) throw new Error(`npm dist-tag ${distTag} does not point to ${requestedVersion}`);
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity)) throw new Error("npm prerelease integrity is invalid");
  if (!/^[0-9a-f]{40}$/.test(shasum)) throw new Error("npm prerelease SHA-1 is invalid");
  if (!Number.isFinite(Date.parse(publishedAt))) throw new Error("npm prerelease publication timestamp is invalid");
  return Object.freeze({ version, integrity, shasum, distTag, publishedAt: new Date(Date.parse(publishedAt)).toISOString() });
}

function unwrapNpmJsonValue(value) {
  return Array.isArray(value) && value.length === 1 ? value[0] : value;
}

export function readGithubPrerelease(version, options = {}) {
  const run = options.run || runGh;
  const value = run(["release", "view", `v${version}`, "--json", "tagName,isPrerelease,publishedAt,assets"]);
  return normalizeGithubPrerelease(value, version);
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

function runNpmView(args) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("npm registry verification must run through npm");
  const result = spawnSync(process.execPath, [npmCli, "view", ...args], {
    encoding: "utf8",
    env: process.env,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm view ${args[0]} failed: ${String(result.stderr || result.stdout).trim()}`);
  try { return JSON.parse(result.stdout); } catch { throw new Error(`npm view ${args[0]} returned invalid JSON`); }
}

function runGh(args) {
  const result = spawnSync(resolveTrustedGithubCli({ workspace: process.cwd() }), args, { encoding: "utf8", env: process.env, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`gh ${args[0]} failed: ${String(result.stderr || result.stdout).trim()}`);
  try { return JSON.parse(result.stdout); } catch { throw new Error("GitHub prerelease query returned invalid JSON"); }
}
