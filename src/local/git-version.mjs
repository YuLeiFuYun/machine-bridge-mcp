export function requireGitVersion(output, minimum = { major: 2, minor: 50 }) {
  if (typeof output !== "string") throw new Error("Git version output is invalid");
  const match = /^git version ([0-9]+)\.([0-9]+)(?:\.([0-9]+))?(?:\.windows\.[0-9]+)?(?:\s|$)/.exec(output.trim());
  if (!match) throw new Error("Git version output is invalid");
  const version = { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] || 0) };
  if (!Object.values(version).every(Number.isSafeInteger)) throw new Error("Git version output is invalid");
  const supported = version.major > minimum.major
    || (version.major === minimum.major && version.minor >= minimum.minor);
  if (!supported) throw new Error(`Git ${minimum.major}.${minimum.minor} or later is required`);
  return version;
}
