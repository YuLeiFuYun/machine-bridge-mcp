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

## Required before pushing an npm-package change

1. bump `package.json` to a version newer than the latest reachable `v*` tag;
2. add the matching dated section to `CHANGELOG.md` and update audit/documentation records;
3. run targeted tests, both dependency audits, `npm run worker:dry-run`, privacy/history review, signature verification, SBOM generation, and package inspection as applicable;
4. inspect the complete diff;
5. run `npm run release:candidate`, which executes the complete suite and creates the exact candidate tarball under ignored `.release-candidate/`;
6. give the repository owner `npm run release:candidate:start -- --allow-worker-deploy`; the owner explicitly authorizes the in-place candidate Worker deployment, starts the exact candidate locally, and leaves it running;
7. verify the live candidate through Machine Bridge, including Worker version/hash, remote health, relay readiness, exact local version, and representative functionality relevant to the change;
8. after observed verification succeeds, have the coding agent run the exact `release:accept` command printed by the candidate tool, creating `release-acceptance/v<version>.json`;
9. commit the acceptance record and push the clean non-`main` branch only with `npm run github:push`.

Automated checks do not authorize step 8. The coding agent may record acceptance only after it has observed the owner-started candidate operating successfully. Any packaged-file change after acceptance changes the npm tarball hash and requires a regenerated candidate and another observed live verification.

After all required pull-request checks pass, repository automation completes the source release: squash-merge, verify the exact `main` push CI, CodeQL, Governance, and Scorecard runs, and run `npm run release`. The helper requires `HEAD === origin/main`; it does not push `main`. It creates or verifies the annotated version tag and final GitHub Release only after the accepted package hash and exact-commit checks match. `release:publish` remains a compatibility alias.

The release operator separately authorizes npm publication and any live machine update. Automation must not publish, deprecate, or unpublish npm packages; install the CLI globally; deploy the Worker; rotate credentials; mutate live deployment state; or start, stop, install, remove, or replace the daemon or autostart service without explicit user authorization.

Supported upgrade and rollback behavior is defined in [docs/UPGRADING.md](docs/UPGRADING.md). Support requests follow [SUPPORT.md](SUPPORT.md), and repository participation follows [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

After npm publication, the standard machine update is:

```bash
npm install -g --omit=optional --allow-scripts=esbuild,workerd,sharp,fsevents machine-bridge-mcp@latest && machine-mcp
```

## Privacy

Use only synthetic names, reserved example domains, and generic paths. Maintain private local identifiers in the ignored `.privacy-denylist` and run `npm run privacy:check` before committing. Local acceptance records contain hashes and a fixed marker only; do not add machine paths, personal names, logs, credentials, endpoint URLs, or user content.

## Engineering standards

Read [docs/ENGINEERING.md](docs/ENGINEERING.md) before changing architecture, policy, logging, persistence, transport lifecycle, or release behavior. The default `full` profile is an explicit product invariant and must not be narrowed by an unrelated change.

A log change is behavior: test its level, repetition policy, privacy fields, and recovery message. A transport change must distinguish low-level connectivity from authenticated readiness and test timeout/reconnect branches deterministically. Lock, state deletion, service lifecycle, detached process, and credential changes require behavior-level concurrency or fault-injection tests. Review [docs/AUDIT.md](docs/AUDIT.md) before changing those surfaces.

Reusable decisions belong in tracked documentation. Keep only machine-specific observations in ignored `.project-local/`, and never store credentials there.
