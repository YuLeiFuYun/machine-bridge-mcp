// The published package intentionally ships a small, self-contained runtime.
// Repository-only verification scripts are not part of the tarball, so exposing
// them in the installed package.json produces commands that always fail with
// MODULE_NOT_FOUND. The published manifest keeps only scripts whose files ship.
export const PUBLISHED_PACKAGE_SCRIPT_NAMES = Object.freeze(["test", "start", "doctor"]);

export function publishedPackageManifest(pkg) {
  if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) {
    throw new Error("package manifest must be an object");
  }
  const sourceScripts = pkg.scripts && typeof pkg.scripts === "object" && !Array.isArray(pkg.scripts)
    ? pkg.scripts
    : {};
  const scripts = {};
  for (const name of PUBLISHED_PACKAGE_SCRIPT_NAMES) {
    if (typeof sourceScripts[name] === "string") scripts[name] = sourceScripts[name];
  }
  return { ...pkg, scripts };
}

export function publishedPackageJsonText(pkg) {
  return `${JSON.stringify(publishedPackageManifest(pkg), null, 2)}\n`;
}
