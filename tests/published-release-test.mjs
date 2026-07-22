import { normalizeGithubPrerelease, normalizePublishedNpmPrerelease } from "../scripts/published-release.mjs";
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
expectThrow(() => normalizePublishedNpmPrerelease({ ...npm, requestedVersion: npm.version, requestedTag: "beta", actualVersion: npm.version, tags: { beta: "3.0.0-beta.2" }, times: { [npm.version]: npm.publishedAt } }), "does not point");
expectThrow(() => normalizeGithubPrerelease({ tagName: "v3.0.0-beta.1", isPrerelease: false, publishedAt: "2026-07-21T10:05:00.000Z", assets: [] }, "3.0.0-beta.1"), "not marked");
expectThrow(() => normalizeGithubPrerelease({ tagName: "v3.0.0-beta.1", isPrerelease: true, publishedAt: "2026-07-21T10:05:00.000Z", assets: [] }, "3.0.0-beta.1"), "missing machine-bridge-mcp-3.0.0-beta.1.tgz");
console.log("published prerelease metadata test ok");
function expectThrow(callback, expected) { try { callback(); } catch (error) { if (String(error?.message || error).includes(expected)) return; throw error; } throw new Error(`expected throw containing: ${expected}`); }
function assert(condition, message) { if (!condition) throw new Error(message); }
