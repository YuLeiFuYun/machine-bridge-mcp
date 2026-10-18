// @ts-check
import { isAbsolute, relative, resolve, sep } from "node:path";
import { packageRoot } from "./package-identity.mjs";
import { isCandidateRuntimeDirectoryName } from "./state-root-owned-namespaces.mjs";

export const RELEASE_BROWSER_EXTENSION_DIRECTORY = "browser-extension";

/** @param {string} stateRoot */
export function releaseBrowserExtensionPath(stateRoot) {
  return resolve(String(stateRoot || ""), "release-channels", RELEASE_BROWSER_EXTENSION_DIRECTORY);
}

/** @param {{stateRoot?: string, packageDirectory?: string}} [options] */
export function browserExtensionPathForRuntime({ stateRoot = "", packageDirectory = packageRoot } = {}) {
  const packaged = resolve(packageDirectory, "browser-extension");
  if (!stateRoot) return packaged;
  const runtimes = resolve(stateRoot, "release-channels", "runtimes");
  const runtimeRelative = relative(runtimes, resolve(packageDirectory));
  if (!runtimeRelative || runtimeRelative === ".." || runtimeRelative.startsWith(`..${sep}`) || isAbsolute(runtimeRelative)) {
    return packaged;
  }
  const [runtimeName] = runtimeRelative.split(sep);
  return isCandidateRuntimeDirectoryName(runtimeName) ? releaseBrowserExtensionPath(stateRoot) : packaged;
}
