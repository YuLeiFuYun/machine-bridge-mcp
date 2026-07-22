const CHANNEL_TAGS = Object.freeze({ dev: "dev", beta: "beta", rc: "next" });
const SOAK_SECONDS = Object.freeze({ major: 7 * 24 * 60 * 60, minor: 3 * 24 * 60 * 60, patch: 24 * 60 * 60 });

export const SOAK_POLICY_VERSION = "3.0.0";
export const SOAK_CONFIRMATION = "owner-reported-published-prerelease-soak-passed";

export function parseReleaseVersion(value) {
  const raw = String(value || "").trim();
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z]+)\.(\d+))?$/.exec(raw);
  if (!match) throw new Error(`release version must use x.y.z or x.y.z-(dev|beta|rc).n: ${raw || "<empty>"}`);
  const channel = match[4] || "";
  if (channel && !Object.hasOwn(CHANNEL_TAGS, channel)) {
    throw new Error(`unsupported prerelease channel ${channel}; use dev, beta, or rc`);
  }
  const sequence = channel ? Number(match[5]) : 0;
  if (channel && (!Number.isSafeInteger(sequence) || sequence < 1)) {
    throw new Error("prerelease sequence must be a positive integer");
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  for (const part of [major, minor, patch]) {
    if (!Number.isSafeInteger(part) || part < 0) throw new Error("release version contains an invalid numeric component");
  }
  return Object.freeze({
    raw,
    major,
    minor,
    patch,
    channel,
    sequence,
    prerelease: Boolean(channel),
    baseVersion: `${major}.${minor}.${patch}`,
    npmTag: channel ? CHANNEL_TAGS[channel] : "latest",
  });
}

export function compareReleaseVersions(leftValue, rightValue) {
  const left = typeof leftValue === "string" ? parseReleaseVersion(leftValue) : leftValue;
  const right = typeof rightValue === "string" ? parseReleaseVersion(rightValue) : rightValue;
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  if (!left.prerelease && !right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  const channelOrder = { dev: 0, beta: 1, rc: 2 };
  if (left.channel !== right.channel) return channelOrder[left.channel] - channelOrder[right.channel];
  return left.sequence - right.sequence;
}

export function requiresSoakForStable(version) {
  const parsed = parseReleaseVersion(version);
  return !parsed.prerelease && compareReleaseVersions(parsed, parseReleaseVersion(SOAK_POLICY_VERSION)) >= 0;
}

export function assertPublishTag(version, requestedTag) {
  const parsed = parseReleaseVersion(version);
  const actual = String(requestedTag || (parsed.prerelease ? "latest" : "latest")).trim().toLowerCase();
  if (actual !== parsed.npmTag) {
    throw new Error(`${parsed.raw} must be published with npm dist-tag ${parsed.npmTag}, not ${actual || "<empty>"}`);
  }
  return parsed.npmTag;
}

export function assertSoakEligiblePrerelease(version) {
  const parsed = parseReleaseVersion(version);
  if (!parsed.prerelease || !["beta", "rc"].includes(parsed.channel)) {
    throw new Error("stable-release soak requires a published beta or rc version");
  }
  return parsed;
}

export function assertStablePromotion(stableVersion, prereleaseVersion) {
  const stable = parseReleaseVersion(stableVersion);
  const prerelease = assertSoakEligiblePrerelease(prereleaseVersion);
  if (stable.prerelease) throw new Error("stable promotion target must not contain a prerelease suffix");
  if (stable.baseVersion !== prerelease.baseVersion) {
    throw new Error(`prerelease ${prerelease.raw} cannot promote to unrelated stable version ${stable.raw}`);
  }
  return { stable, prerelease };
}

export function minimumSoakSeconds(baseVersion, previousStableVersion = "") {
  const target = parseReleaseVersion(baseVersion);
  if (target.prerelease) throw new Error("minimum soak target must be a stable base version");
  if (!previousStableVersion) {
    if (target.minor === 0 && target.patch === 0) return SOAK_SECONDS.major;
    if (target.patch === 0) return SOAK_SECONDS.minor;
    return SOAK_SECONDS.patch;
  }
  const previous = parseReleaseVersion(previousStableVersion);
  if (previous.prerelease) throw new Error("previous stable version must not be a prerelease");
  if (compareReleaseVersions(target, previous) <= 0) throw new Error("target stable version must be newer than the previous stable version");
  if (target.major !== previous.major) return SOAK_SECONDS.major;
  if (target.minor !== previous.minor) return SOAK_SECONDS.minor;
  return SOAK_SECONDS.patch;
}

export function formatSoakDuration(seconds) {
  const value = Number(seconds);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("soak duration must be a non-negative integer");
  if (value % (24 * 60 * 60) === 0) return `${value / (24 * 60 * 60)}d`;
  if (value % (60 * 60) === 0) return `${value / (60 * 60)}h`;
  return `${value}s`;
}
