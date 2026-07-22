import { validateSoakRecord, soakConfirmationPhrase } from "../scripts/release-soak.mjs";

const activated = Date.parse("2026-07-01T00:00:00.000Z");
const accepted = activated + 7 * 24 * 60 * 60 * 1000;
const record = {
  schema_version: 1,
  result: "passed",
  confirmation: "owner-reported-published-prerelease-soak-passed",
  package_name: "machine-bridge-mcp",
  stable_version: "3.0.0",
  prerelease_version: "3.0.0-beta.2",
  prerelease_channel: "beta",
  prerelease_shasum: "a".repeat(40),
  prerelease_integrity: `sha512-${Buffer.alloc(64, 2).toString("base64")}`,
  promotion_content_sha256: "b".repeat(64),
  activated_at: new Date(activated).toISOString(),
  published_at: new Date(activated - 60_000).toISOString(),
  accepted_at: new Date(accepted).toISOString(),
  minimum_soak_seconds: 7 * 24 * 60 * 60,
  observed_soak_seconds: 7 * 24 * 60 * 60,
  npm_dist_tag: "beta",
  github_prerelease_tag: "v3.0.0-beta.2",
  previous_stable_version: "2.0.0",
  known_blocking_issues: 0,
};
validateSoakRecord(record, { stableVersion: "3.0.0", promotionDigest: "b".repeat(64) });
expectThrow(() => validateSoakRecord({ ...record, observed_soak_seconds: record.minimum_soak_seconds - 1 }), "insufficient");
expectThrow(() => validateSoakRecord({ ...record, known_blocking_issues: 1 }), "known prerelease issues");
expectThrow(() => validateSoakRecord({ ...record, promotion_content_sha256: "c".repeat(64) }, { promotionDigest: "b".repeat(64) }), "differs from the accepted prerelease");
expectThrow(() => validateSoakRecord({ ...record, prerelease_version: "3.0.1-beta.1" }), "unrelated stable version");
expectThrow(() => validateSoakRecord({ ...record, machine_path: "/Users/example/private" }), "unsupported fields");
const normalized = validateSoakRecord(record);
assert(!Object.hasOwn(normalized, "machine_path") && Object.keys(normalized).length === 19, "soak record normalization retained undeclared data");
assert(soakConfirmationPhrase("machine-bridge-mcp", "3.0.0-beta.2", 7 * 24 * 60 * 60).includes("AT LEAST 7d"), "soak confirmation phrase omitted the required duration");
console.log("stable release soak record test ok");
function expectThrow(callback, expected) { try { callback(); } catch (error) { if (String(error?.message || error).includes(expected)) return; throw error; } throw new Error(`expected throw containing: ${expected}`); }
function assert(condition, message) { if (!condition) throw new Error(message); }
