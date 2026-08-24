# Contributing and release discipline

Read [docs/PROJECT_STANDARDS.md](docs/PROJECT_STANDARDS.md), [docs/ENGINEERING.md](docs/ENGINEERING.md), [GOVERNANCE.md](GOVERNANCE.md), and the relevant domain documentation before changing behavior.

## First 30 minutes

1. Use Node.js 26 and npm 12, then run `npm ci`.
2. Read [System overview](docs/OVERVIEW.md), [Engineering](docs/ENGINEERING.md), and the domain document for the code being changed.
3. Run `npm run check:fast` before editing to establish a clean local baseline.
4. Make one responsibility-focused change and run its nearest behavior test while iterating.
5. Run `npm run check` before declaring a package-affecting change complete.

Do not begin by raising a module line cap, weakening a coverage threshold, or adding a parallel policy/protocol shape. First identify the responsibility that belongs in a focused module or the shared contract that should own the rule. Source-shape architecture assertions are supplementary; security and lifecycle changes require behavior, denial, race, or fault-injection coverage for the underlying mechanism.

## Development workflow

The repository uses GitHub Flow: branch from current `main`, keep one coherent change, validate it locally, open a pull request, satisfy required checks, squash-merge, and delete the branch. Permanent `develop` or generic release integration branches are not used unless an independently maintained release line creates a concrete need.

Repository automation performs GitHub operations only through local `git`, `gh`, and `gh api` commands executed by Machine Bridge. Hosted GitHub connectors and ChatGPT GitHub plugins are prohibited for this repository. Direct pushes to `main` and force pushes are prohibited.

Branch names use a category and purpose such as `feat/browser-downloads`, `fix/relay-timeout`, or `chore/dependency-policy`.

Pull-request titles and final commit subjects use Conventional Commits:

```text
<type>[optional scope][optional !]: <imperative description>
```

Accepted types are `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `security`, `release`, and `revert`. Explain the causal problem, why the solution is correct, compatibility/security/privacy risk, verification, and release impact. Bug fixes require a regression test for the original failure mechanism.

## Package impact

An npm version is required when a change affects `package.json`, `package-lock.json`, or any path included by the package `files` manifest. This includes runtime source, executable scripts, browser-extension files, shared contracts, and shipped documentation. `npm run release-impact:check` derives the decision from the package manifest.

Repository-only infrastructure changes, such as a `.github/` workflow update, do not require a synthetic npm version when package bytes are unchanged. They still require review and all applicable CI, dependency-review, CodeQL, governance, and Scorecard checks.

Repository tests are verification inputs, not npm tarball entries under the current `package.json.files` manifest. A `tests/**`-only change therefore does not itself change package bytes; if a bug fix also changes shipped source, scripts, metadata, or documentation, that packaged change still requires the prerelease/version flow and the regression test remains mandatory verification evidence.

## Required prerelease flow for an npm-package change

1. choose a `dev`, `beta`, or `rc` version; version 3 and later must not begin as stable;
2. update changelog, audit notes, and documentation;
3. run targeted and one complete frozen-tree check, dependency audits, Worker dry-run, privacy review, `npm run sbom:test`, and package inspection; the successful full check writes a short-lived exact-generation receipt under ignored `.project-local/`;
4. inspect the complete diff and run `npm run release:candidate`; it must consume that matching receipt and does not repeat the complete suite;
5. run `node scripts/start-release-candidate.mjs --install-only`; this non-live preflight must still match current source/package modes and install the exact tarball disposably, otherwise repair and regenerate the candidate;
6. run `npm run release:candidate:activate -- --allow-worker-deploy` through the local control plane after the install-only preflight succeeds; no additional conversational approval is required;
7. after activation, derive `<activated-runtime-package>` from activation `runtime_entry`, run `node <activated-runtime-package>/scripts/release-oauth-canary.mjs --allow-live-oauth-canary` as direct argv from the checkout cwd, then verify the Worker, candidate relay, verified service daemon, exact version, representative behavior, and relevant failure paths through Machine Bridge;
8. only after the candidate-bound canary and observed live verification both succeed, record exact candidate acceptance;
9. commit and push only with `npm run github:push`, then complete review and required checks;
10. create the GitHub Prerelease with `npm run prerelease:release` once exact-commit and release-integrity gates pass;
11. stop only for npm publication authorization; when explicitly authorized, run `npm run prerelease:publish -- --owner-confirm`, then continue automatically with `npm run prerelease:install -- --allow-worker-deploy`;
12. use the published prerelease for at least seven days for a major, three days for a minor, or one day for a patch;
13. every blocking defect increments the prerelease number and restarts the interval;
14. after explicit owner confirmation, record the soak result; stable promotion must pass `npm run release:soak:verify` and preserve the functional promotion digest;
15. activate and observe the exact stable candidate, repeat acceptance and review, then run `npm run release` automatically; `npm run stable:publish -- --owner-confirm` remains the separately authorized npm-publication operation.

Automated checks do not prove candidate acceptance or soak success. The agent observes the live candidate; the owner reports the real soak outcome. Release evidence contains bounded release metadata only and no private user content. npm package publication is the sole operation that requires a separate current-task conversational authorization; other task-relevant release operations proceed under standing repository authority when their technical gates pass.

Repository-only infrastructure changes whose package bytes are unchanged skip candidate activation and soak but still require review and applicable checks. The complete state machine is in [docs/RELEASING.md](docs/RELEASING.md).

## Privacy

Use only synthetic names, reserved example domains, and generic paths. Maintain private local identifiers in the ignored `.privacy-denylist` and run `npm run privacy:check` before committing. Local acceptance records contain hashes and a fixed marker only; do not add machine paths, personal names, logs, credentials, endpoint URLs, or user content.

## Engineering standards

Read [docs/ENGINEERING.md](docs/ENGINEERING.md) before changing architecture, policy, logging, persistence, transport lifecycle, or release behavior. The default `full` profile is an explicit product invariant and must not be narrowed by an unrelated change.

A log change is behavior: test its level, repetition policy, privacy fields, and recovery message. A transport change must distinguish low-level connectivity from authenticated readiness and test timeout/reconnect branches deterministically. Lock, state deletion, service lifecycle, detached process, and credential changes require behavior-level concurrency or fault-injection tests. Review [docs/AUDIT.md](docs/AUDIT.md) before changing those surfaces.

Reusable decisions belong in tracked documentation. Keep only machine-specific observations in ignored `.project-local/`, and never store credentials there.
