import assert from "node:assert/strict";
import test from "node:test";
import {
  SOAK_CONFIRMATION,
  assertPublishTag,
  assertSoakEligiblePrerelease,
  assertStablePromotion,
  compareReleaseVersions,
  formatSoakDuration,
  minimumSoakSeconds,
  parseReleaseVersion,
  requiresSoakForStable,
} from "../scripts/release-channel.mjs";

test("release channel policy validates versions, tags, soak windows, and stable promotions", () => {
  const beta = parseReleaseVersion("3.0.0-beta.2");
  assert(beta.prerelease && beta.channel === "beta" && beta.sequence === 2 && beta.baseVersion === "3.0.0" && beta.npmTag === "beta", "beta version parsing failed");
  const stable = parseReleaseVersion("3.0.0");
  assert(!stable.prerelease && stable.npmTag === "latest", "stable version parsing failed");
  assert.throws(() => parseReleaseVersion("3.0.0-preview.1"), /unsupported prerelease channel/);
  assert.throws(() => parseReleaseVersion("3.0.0-beta.0"), /positive integer/);
  assert.throws(() => parseReleaseVersion("3.0.0-beta"), /must use/);
  assert(compareReleaseVersions("3.0.0-dev.2", "3.0.0-beta.1") < 0, "dev did not sort before beta");
  assert(compareReleaseVersions("3.0.0-beta.2", "3.0.0-rc.1") < 0, "beta did not sort before rc");
  assert(compareReleaseVersions("3.0.0-rc.2", "3.0.0") < 0, "rc did not sort before stable");
  assert(compareReleaseVersions("3.0.1", "3.0.0") > 0, "patch comparison failed");
  assertPublishTag("3.0.0-beta.1", "beta");
  assertPublishTag("3.0.0-rc.1", "next");
  assertPublishTag("3.0.0", "latest");
  assert.throws(() => assertPublishTag("3.0.0-beta.1", "latest"), /must be published/);
  assertSoakEligiblePrerelease("3.0.0-beta.1");
  assertSoakEligiblePrerelease("3.0.0-rc.1");
  assert.throws(() => assertSoakEligiblePrerelease("3.0.0-dev.1"), /beta or rc/);
  assertStablePromotion("3.0.0", "3.0.0-beta.4");
  assert.throws(() => assertStablePromotion("3.0.1", "3.0.0-beta.4"), /unrelated stable version/);
  assert.equal(minimumSoakSeconds("3.0.0", "2.9.9"), 7 * 24 * 60 * 60);
  assert.equal(minimumSoakSeconds("3.2.0", "3.1.9"), 3 * 24 * 60 * 60);
  assert.equal(minimumSoakSeconds("3.2.1", "3.2.0"), 24 * 60 * 60);
  assert.equal(formatSoakDuration(7 * 24 * 60 * 60), "7d");
  assert(requiresSoakForStable("3.0.0") && !requiresSoakForStable("3.0.0-beta.1") && !requiresSoakForStable("2.9.9"), "stable soak policy activation failed");
  assert.match(SOAK_CONFIRMATION, /soak-passed/, "soak confirmation marker is not explicit");
});
