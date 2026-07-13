# Contributing and release discipline

This repository treats every Git-tracked or nonignored repository file as release-relevant, including source code, tests, scripts, examples, documentation, CI configuration, ignore rules, and package metadata.

## Development workflow

Read [docs/PROJECT_STANDARDS.md](docs/PROJECT_STANDARDS.md) and the relevant domain documentation before changing behavior. This repository uses GitHub Flow: branch from current `main`, keep the change coherent, open a pull request, satisfy required checks, squash-merge, and delete the branch. Permanent `develop` or generic release integration branches are not used unless an independently maintained release line creates a concrete need. Repository automation performs GitHub operations only through local `git`, `gh`, and `gh api` commands executed by Machine Bridge; hosted GitHub connectors and ChatGPT GitHub plugins are prohibited for this repository.

Branch names use a category and purpose such as `feat/browser-downloads`, `fix/relay-timeout`, or `chore/dependency-policy`.

Pull-request titles and final commit subjects use Conventional Commits:

```text
<type>[optional scope][optional !]: <imperative description>
```

Accepted types are `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `security`, `release`, and `revert`. Explain the causal problem, why the solution is correct, compatibility/security/privacy risk, verification, and release impact in the pull request. Bug fixes require a regression test for the original failure mechanism.

## Required for every release-relevant change

Before the reviewed code is pushed to `main`:

1. bump `package.json` to a version newer than the latest reachable `v*` tag;
2. add the matching dated section to `CHANGELOG.md`;
3. run `npm run check`, `npm audit`, `npm audit --omit=dev`, and `npm run worker:dry-run`;
4. inspect the complete diff and the npm package manifest;
5. commit and push the reviewed change to GitHub.

The release operator then creates the matching Git tag and GitHub Release and publishes the same version to npm. These release actions are not implicit coding-agent tasks. Unless the user explicitly requests them in the current task, automation must not publish or alter npm versions, create tags or releases, install the CLI globally, deploy the Worker, rotate credentials, mutate live deployment state, or start/stop/install/remove the daemon or autostart service. See [AGENTS.md](AGENTS.md) for the repository automation contract.

After npm publication, the standard machine update is:

```bash
npm install -g --omit=optional --allow-scripts=esbuild,workerd,sharp,fsevents machine-bridge-mcp@latest && machine-mcp
```

The npm command updates the global CLI. Normal `machine-mcp` startup checks the Worker deployment hash, expected version, and health, redeploys when necessary, and reconciles the daemon/autostart flow.

`npm run release-impact:check` enforces the version and changelog parts. It fails when release-relevant files changed after the latest version tag but the package version was not advanced.

A privacy or security correction is always release-relevant. Removing a private identifier only from the current branch is insufficient: publish a replacement npm version, update GitHub, and deprecate or unpublish the affected npm version when policy and authentication permit.

## Privacy

Use only synthetic names, reserved example domains, and generic paths. Maintain private local identifiers in the ignored `.privacy-denylist` and run `npm run privacy:check` before committing.

## Engineering standards

Read [docs/ENGINEERING.md](docs/ENGINEERING.md) before changing architecture, policy, logging, persistence, transport lifecycle, or release behavior. The default `full` profile is an explicit product invariant and must not be narrowed by an unrelated change.

A log change is behavior: test its level, repetition policy, privacy fields, and recovery message. A transport change must distinguish low-level connectivity from authenticated readiness and test timeout/reconnect branches deterministically. Lock, state deletion, service lifecycle, detached process, and credential changes require behavior-level concurrency or fault-injection tests. Review [docs/AUDIT.md](docs/AUDIT.md) before changing those surfaces.

Reusable decisions belong in tracked documentation. Keep only machine-specific observations in the ignored `.project-local/` directory, and never store credentials there.
