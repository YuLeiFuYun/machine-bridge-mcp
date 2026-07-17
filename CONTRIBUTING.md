# Contributing and release discipline

Read [docs/PROJECT_STANDARDS.md](docs/PROJECT_STANDARDS.md), [docs/ENGINEERING.md](docs/ENGINEERING.md), [GOVERNANCE.md](GOVERNANCE.md), and the relevant domain documentation before changing behavior.

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
6. have the repository owner test that exact tarball on the maintainer machine through the normal installation/startup path;
7. have the owner record the explicit decision with the exact command printed by the candidate tool, creating `release-acceptance/v<version>.json`;
8. commit the acceptance record and push the clean non-`main` branch only with `npm run github:push`.

Automated checks do not authorize step 7. A coding agent must not record owner acceptance or push the release-relevant branch before the owner has tested it. Any packaged-file change after acceptance changes the npm tarball hash and requires a regenerated candidate and a new owner test.

After all required pull-request checks pass, repository automation may complete the source release: squash-merge, verify the exact `main` push CI, CodeQL, Governance, and Scorecard runs, and run `npm run release:publish`. The publication helper requires `HEAD === origin/main`; it does not push `main`. It creates or verifies the annotated version tag and final GitHub Release only after the accepted package hash and exact-commit checks match.

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
