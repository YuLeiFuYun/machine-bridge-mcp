import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Map verification task names to the per-task timeout declared by the repository
 * workflow bundle.
 *
 * The bundle is the declared lifecycle authority, but until now nothing read it: the
 * runner kept a second, hardcoded timeout table. This module makes the bundle an actual
 * input so a task's budget has one owner instead of two.
 *
 * @param {unknown} bundle parsed workflow-bundle.json
 * @param {Record<string, string>} packageScripts package.json scripts
 * @returns {Map<string, number>} task name -> timeout in milliseconds
 */
export function bundleTaskTimeouts(bundle, packageScripts = {}) {
  const stages = Array.isArray(bundle?.lifecycle) ? bundle.lifecycle : [];
  const scripts = packageScripts && typeof packageScripts === "object" ? packageScripts : {};
  const timeouts = new Map();
  for (const stage of stages) {
    const seconds = Number(stage?.command?.timeout_seconds);
    if (!Number.isFinite(seconds) || seconds <= 0) continue;
    const milliseconds = Math.round(seconds * 1000);
    const source = String(stage?.source || "").trim();
    if (!source) continue;
    const scriptName = /^package\.json#scripts\.(.+)$/.exec(source);
    if (scriptName) {
      timeouts.set(scriptName[1], milliseconds);
      continue;
    }
    // File-based stages name the test entrypoint instead of a package script; resolve them
    // to every task whose script runs that file.
    for (const [task, command] of Object.entries(scripts)) {
      if (String(command).includes(source)) timeouts.set(task, milliseconds);
    }
  }
  return timeouts;
}

/**
 * Read the bundle from a repository root. A missing or malformed bundle yields no
 * overrides so the runner falls back to its built-in budgets instead of failing a plan.
 * @param {string} root
 * @param {Record<string, string>} packageScripts
 * @returns {Map<string, number>}
 */
export function readBundleTaskTimeouts(root, packageScripts = {}) {
  try {
    return bundleTaskTimeouts(JSON.parse(readFileSync(resolve(root, "workflow-bundle.json"), "utf8")), packageScripts);
  } catch {
    return new Map();
  }
}
