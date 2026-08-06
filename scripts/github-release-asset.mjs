export function githubReleaseByTagEndpoint(tag) {
  const value = String(tag || "");
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error("GitHub release asset lookup requires a valid version tag");
  }
  return `repos/{owner}/{repo}/releases/tags/${encodeURIComponent(value)}`;
}

export function normalizeGithubReleaseAsset(value, options = {}) {
  const tag = String(options.tag || "");
  const assetName = String(options.assetName || "");
  const expectedSha256 = String(options.expectedSha256 || "");
  if (!tag || !assetName || !/^[0-9a-f]{64}$/.test(expectedSha256)) {
    throw new Error("GitHub release asset verification requires tag, asset name, and SHA-256");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("GitHub release asset response is invalid");
  }
  if (String(value.tag_name || "") !== tag) throw new Error(`GitHub release response does not match ${tag}`);
  if (!Array.isArray(value.assets)) throw new Error("GitHub release asset inventory is unavailable");
  const matches = value.assets.filter((entry) => entry && typeof entry === "object" && entry.name === assetName);
  if (matches.length !== 1) throw new Error(`GitHub release must contain exactly one ${assetName} asset`);
  const asset = matches[0];
  const size = Number(asset.size);
  if (!Number.isSafeInteger(size) || size < 1) throw new Error("GitHub release package asset size is invalid");
  const digest = String(asset.digest || "");
  const expectedDigest = `sha256:${expectedSha256}`;
  if (digest !== expectedDigest) throw new Error("GitHub release package asset SHA-256 does not match the accepted candidate");
  return Object.freeze({
    name: assetName,
    size,
    digest,
    sha256: expectedSha256,
  });
}

export async function waitForGithubReleaseAsset(readRelease, options = {}) {
  if (typeof readRelease !== "function") throw new TypeError("GitHub release asset convergence requires a release reader");
  const attempts = Number.isSafeInteger(Number(options.attempts))
    ? Math.min(Math.max(Number(options.attempts), 1), 10)
    : 5;
  const wait = typeof options.wait === "function" ? options.wait : defaultAssetWait;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const release = await readRelease();
      return normalizeGithubReleaseAsset(release, options);
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) await wait(attempt);
  }
  throw lastError || new Error("GitHub release asset did not converge");
}

function defaultAssetWait(attempt) {
  return new Promise((resolvePromise) => { setTimeout(resolvePromise, Math.min(4_000, attempt * 1_000)); });
}
