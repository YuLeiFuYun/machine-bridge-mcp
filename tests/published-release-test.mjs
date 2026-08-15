import { readGithubPrerelease, normalizeGithubPrerelease, normalizePublishedNpmPrerelease } from "../scripts/published-release.mjs";
import { githubReleaseByTagEndpoint, normalizeGithubReleaseAsset, waitForGithubReleaseAsset } from "../scripts/github-release-asset.mjs";
import { readPublishedNpmPrereleaseIfPresent } from "../scripts/published-release.mjs";
const integrity = `sha512-${Buffer.alloc(64, 3).toString("base64")}`;
const npm = normalizePublishedNpmPrerelease({
  requestedVersion: "3.0.0-beta.1",
  requestedTag: "beta",
  actualVersion: "3.0.0-beta.1",
  integrity,
  shasum: "a".repeat(40),
  tags: { beta: "3.0.0-beta.1" },
  times: { "3.0.0-beta.1": "2026-07-21T10:00:00.000Z" },
});
assert(npm.distTag === "beta" && npm.version === "3.0.0-beta.1", "npm prerelease metadata normalization failed");
const npm12Wrapped = normalizePublishedNpmPrerelease({
  requestedVersion: "3.0.0-beta.1",
  requestedTag: "beta",
  actualVersion: ["3.0.0-beta.1"],
  integrity: [integrity],
  shasum: ["a".repeat(40)],
  tags: [{ latest: "2.0.0", beta: "3.0.0-beta.1" }],
  times: [{ "3.0.0-beta.1": "2026-07-21T10:00:00.000Z" }],
});
assert(npm12Wrapped.distTag === "beta" && npm12Wrapped.version === "3.0.0-beta.1", "npm 12 JSON array wrappers were not normalized");
normalizeGithubPrerelease({ tagName: "v3.0.0-beta.1", isPrerelease: true, publishedAt: "2026-07-21T10:05:00.000Z", assets: [{ name: "machine-bridge-mcp-3.0.0-beta.1.tgz", size: 1234 }] }, "3.0.0-beta.1");

const artifactSha256 = "b".repeat(64);
const restRelease = {
  tag_name: "v3.0.0-beta.1",
  assets: [{ name: "machine-bridge-mcp-3.0.0-beta.1.tgz", size: 1234, digest: `sha256:${artifactSha256}` }],
};
const githubAsset = normalizeGithubReleaseAsset(restRelease, {
  tag: "v3.0.0-beta.1",
  assetName: "machine-bridge-mcp-3.0.0-beta.1.tgz",
  expectedSha256: artifactSha256,
});
assert(githubAsset.sha256 === artifactSha256 && githubAsset.size === 1234, "GitHub release asset digest normalization failed");
let assetReads = 0;
const convergedAsset = await waitForGithubReleaseAsset(() => {
  assetReads += 1;
  return assetReads === 1
    ? { ...restRelease, assets: [{ ...restRelease.assets[0], digest: `sha256:${"c".repeat(64)}` }] }
    : restRelease;
}, {
  tag: "v3.0.0-beta.1",
  assetName: "machine-bridge-mcp-3.0.0-beta.1.tgz",
  expectedSha256: artifactSha256,
  attempts: 2,
  wait: async () => {},
});
assert(convergedAsset.sha256 === artifactSha256 && assetReads === 2,
  "GitHub release asset verifier did not wait for bounded digest convergence");
const verifiedGithub = readGithubPrerelease("3.0.0-beta.1", {
  expectedArtifactSha256: artifactSha256,
  run(args) {
    assert(args[0] === "release" && args[1] === "view", "GitHub prerelease metadata did not use release view");
    return { tagName: "v3.0.0-beta.1", isPrerelease: true, publishedAt: "2026-07-21T10:05:00.000Z", assets: [{ name: "machine-bridge-mcp-3.0.0-beta.1.tgz", size: 1234 }] };
  },
  assetRun(args) {
    assert(args[0] === "api" && args[1].includes("releases/tags/v3.0.0-beta.1"), "GitHub prerelease digest did not use the REST asset endpoint");
    return restRelease;
  },
});
assert(verifiedGithub.asset.sha256 === artifactSha256, "GitHub prerelease did not retain verified asset SHA-256");
expectThrow(() => readGithubPrerelease("3.0.0-beta.1", {
  expectedArtifactSha256: artifactSha256,
  run: () => ({ tagName: "v3.0.0-beta.1", isPrerelease: true, publishedAt: "2026-07-21T10:05:00.000Z", assets: [{ name: "machine-bridge-mcp-3.0.0-beta.1.tgz", size: 999 }] }),
  assetRun: () => restRelease,
}), "size differs");
assert(githubReleaseByTagEndpoint("v3.0.0-beta.1").endsWith("v3.0.0-beta.1"), "GitHub release REST endpoint normalization failed");
assert(readPublishedNpmPrereleaseIfPresent("machine-bridge-mcp", "3.0.0-beta.1", "beta", {
  run() { throw Object.assign(new Error("missing"), { code: "npm_version_not_found" }); },
}) === null, "missing npm version did not normalize to null");
expectThrow(() => readPublishedNpmPrereleaseIfPresent("machine-bridge-mcp", "3.0.0-beta.1", "beta", {
  run() { throw Object.assign(new Error("registry unavailable"), { code: "npm_registry_query_failed" }); },
}), "registry unavailable");
expectThrow(() => normalizeGithubReleaseAsset(restRelease, {
  tag: "v3.0.0-beta.1",
  assetName: "machine-bridge-mcp-3.0.0-beta.1.tgz",
  expectedSha256: "c".repeat(64),
}), "SHA-256 does not match");
expectThrow(() => normalizeGithubReleaseAsset({ ...restRelease, assets: [...restRelease.assets, restRelease.assets[0]] }, {
  tag: "v3.0.0-beta.1",
  assetName: "machine-bridge-mcp-3.0.0-beta.1.tgz",
  expectedSha256: artifactSha256,
}), "exactly one");
expectThrow(() => normalizePublishedNpmPrerelease({ ...npm, requestedVersion: npm.version, requestedTag: "beta", actualVersion: npm.version, tags: { beta: "3.0.0-beta.2" }, times: { [npm.version]: npm.publishedAt } }), "does not point");
expectThrow(() => normalizeGithubPrerelease({ tagName: "v3.0.0-beta.1", isPrerelease: false, publishedAt: "2026-07-21T10:05:00.000Z", assets: [] }, "3.0.0-beta.1"), "not marked");
expectThrow(() => normalizeGithubPrerelease({ tagName: "v3.0.0-beta.1", isPrerelease: true, publishedAt: "2026-07-21T10:05:00.000Z", assets: [] }, "3.0.0-beta.1"), "missing machine-bridge-mcp-3.0.0-beta.1.tgz");
console.log("published prerelease metadata test ok");
function expectThrow(callback, expected) { try { callback(); } catch (error) { if (String(error?.message || error).includes(expected)) return; throw error; } throw new Error(`expected throw containing: ${expected}`); }
function assert(condition, message) { if (!condition) throw new Error(message); }
