export const FAST_CHECK_TASKS = Object.freeze([
  "privacy:check",
  "release-impact:check",
  "test:docs",
  "test:shared",
  "test:checks",
  "test:mcp",
  "test:policy",
  "test:security",
  "test:files-git",
  "test:process-resource",
  "test:runtime",
  "test:worker-unit",
  "test:browser-unit",
  "test:apps-computer",
  "test:agent",
  "test:toolchain",
  "test:release-unit",
  "release:acceptance:test",
  "hardened-npm:test",
  "worker-oauth-controller:test",
  "cli-entrypoint:test",
  "architecture:test",
  "catalog:test",
  "agent-audit:test",
  "lint:test",
  "lint",
  "typecheck",
  "syntax",
  "policy-docs:check",
  "tool-docs:check",
  "tool-output-schemas:check",
  "components-doc:check",
  "help-resources:check",
  "workflow-policy:test",
  "ci-bootstrap:test",
  "wrangler-toolchain:test",
  "cf-network:test",
  "cf-build:test",
]);

export const SERIAL_FAST_CHECK_TASKS = Object.freeze([
  "release:acceptance:test",
  "hardened-npm:test",
  "worker-oauth-controller:test",
  "cli-entrypoint:test",
  "lint",
  "typecheck",
  "syntax",
]);

// Developer feedback loop. The release gate remains check:fast; this plan is
// intentionally small enough to run before every edit.
export const QUICK_CHECK_TASKS = Object.freeze([
  "privacy:check",
  "architecture:test",
  "lint",
  "typecheck",
  "syntax",
  "catalog:test",
  "test:shared",
  "test:docs",
  "test:checks",
  "test:mcp",
  "test:policy",
]);

export const PLATFORM_ONLY_CHECK_TASKS = Object.freeze([
  "test:platform-unit",
  "security-properties:test",
  "service-platform:test",
  "self-test",
  "full-access:test",
  "managed-jobs:test",
  "browser-page-automation:test",
]);

export const FULL_PREFLIGHT_CHECK_TASKS = Object.freeze([
  "sbom:test",
]);

export const FULL_POST_PLATFORM_CHECK_TASKS = Object.freeze([
  "cf-project:test",
  "coverage:test",
  "browser-bridge:test",
  "package:test",
  "install:test",
  "stdio:integration-test",
  "worker:integration-test",
  "oauth-browser:test",
]);

export const FULL_ONLY_CHECK_TASKS = Object.freeze([
  ...FULL_PREFLIGHT_CHECK_TASKS,
  ...FULL_POST_PLATFORM_CHECK_TASKS,
]);

export const PLATFORM_CHECK_TASKS = Object.freeze([
  ...FAST_CHECK_TASKS,
  ...PLATFORM_ONLY_CHECK_TASKS,
]);

export const FULL_CHECK_TASKS = Object.freeze([
  ...FULL_PREFLIGHT_CHECK_TASKS,
  ...FAST_CHECK_TASKS,
  ...PLATFORM_ONLY_CHECK_TASKS,
  ...FULL_POST_PLATFORM_CHECK_TASKS,
]);

export function checkTasks(mode) {
  if (mode === "quick") return QUICK_CHECK_TASKS;
  if (mode === "fast") return FAST_CHECK_TASKS;
  if (mode === "platform") return PLATFORM_CHECK_TASKS;
  if (mode === "full") return FULL_CHECK_TASKS;
  throw new Error(`unknown check mode: ${mode}`);
}
