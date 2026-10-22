// @ts-check
import serverMetadata from "./server-metadata.json" with { type: "json" };

export const HELP_RESOURCES = Object.freeze([
  {
    uri: "machine-bridge://help/managed-jobs",
    name: "Managed Jobs Operational Guide",
    description: "Complete guide for durable jobs, umbrella continuation, and background process management",
    mimeType: "text/markdown",
  },
  {
    uri: "machine-bridge://help/diagnostics-and-relay",
    name: "Runtime Diagnostics and Relay Guide",
    description: "Guide for connection recovery, outages, and runtime diagnostic layers",
    mimeType: "text/markdown",
  },
  {
    uri: "machine-bridge://help/browser-and-apps",
    name: "Browser and Application Automation Guide",
    description: "Guide for paired browser extension, DOM inspection, and accessibility trees",
    mimeType: "text/markdown",
  },
  {
    uri: "machine-bridge://help/security-and-authority",
    name: "Security and Authority Boundaries Guide",
    description: "Guide for sensitive paths, execution policies, and secret file isolation",
    mimeType: "text/markdown",
  },
]);

/**
 * @param {unknown} uri
 * @returns {string | null}
 */
export function readHelpResource(uri) {
  if (typeof uri !== "string") return null;
  const helpMap = /** @type {Record<string, string> | undefined} */ (serverMetadata.helpResources);
  if (helpMap && Object.hasOwn(helpMap, uri)) {
    return helpMap[uri];
  }
  return null;
}
