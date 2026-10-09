# Changelog

## 3.0.0-beta.200 - 2026-10-09

- Refresh cf, Wrangler, Babel parser, ESLint, globals, Node types, fast-check and ws with synchronized source/private locks and exact native install-script approvals.
- Remove the obsolete cf bundle rewrite and its standalone Undici dependency. Verify the unchanged upstream cf artifact and exercise connector/TLS-option preservation offline before private CLI execution.
- Share one locked toolchain verification lifecycle for cf and Wrangler; deduplicate Miniflare and ws across deployment tooling without expanding the consumer runtime's three direct dependencies.
- Adapt architecture parsing to Babel 8's TypeScript import-type AST so type-only dependency edges remain checked.
- Reject coercible Worker deployment names before toolchain initialization; verify Durable Object and rate-limit binding types and exact rate-limit parameters before deployment callbacks.
- Bound Build Output module count and aggregate bytes, and require every module path to stay within its bundle.
- Preserve build/callback failures alongside private-project cleanup failures, including cleanup after staging permission errors.
- Enforce dependency-node admission before reading values and avoid reflecting unverified package version text in integrity errors.
- Group npm update proposals and monitor the private toolchain manifest, while retaining version, acceptance, audit, signature and release gates.
- Correct the optional verifier configuration: preserve offline sandboxed regressions and run complete native suites with their required loopback, installation, browser and platform access.
- Bind full-verification receipts to deployment configurations, verifier manifests and the Worker type seed; reject stale receipts after content or mode changes.
- Retire the cf compatibility exception and stale transformation documentation; add causal boundary, privacy, budget and cleanup regressions.

## Historical releases

Historical prerelease entries remain available from Git tags and repository history. From a source checkout, inspect the changelog of a prior revision with `git show <revision>:CHANGELOG.md`. This current file intentionally describes only the active candidate and the history location.
