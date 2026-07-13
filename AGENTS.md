# Repository automation contract

Read [docs/ENGINEERING.md](docs/ENGINEERING.md) and [CONTRIBUTING.md](CONTRIBUTING.md) before changing this repository.

## Default scope

Unless the user explicitly expands the scope in the current task, a coding agent may:

- modify source code, tests, documentation, package metadata, and changelog entries;
- run repository-local validation and inspection commands;
- create commits and push the current branch to GitHub.

## GitHub control plane

GitHub operations for this repository must use the local authenticated command-line tools through Machine Bridge:

- use `git` for local history, branches, commits, diffs, fetches, and pushes;
- use `gh` and `gh api` for pull requests, checks, workflow logs, repository settings, releases, and GitHub REST/GraphQL operations;
- never use a hosted GitHub connector, ChatGPT GitHub plugin, or a second remote mutation control plane;
- fetch before writing, preserve unrelated remote work, and verify the resulting branch, pull request, checks, or repository setting after every remote mutation.

Do not mix local `gh`/`git` writes with connector writes on the same branch. One local control plane keeps credentials, audit evidence, branch state, and failure recovery observable in the repository owner's environment.

## Operations that require explicit user authorization

Do not perform any of the following merely because code or a version changed:

- publish, deprecate, or unpublish an npm package;
- create or push a Git tag, or create a GitHub Release;
- install or upgrade the package globally with npm;
- deploy a Cloudflare Worker directly, change Worker secrets, or rotate credentials;
- start, stop, install, remove, or replace the local daemon or autostart service;
- alter live state files to make a deployment appear current.

These are release-operator or machine-operator actions, not implicit parts of a code change.

## Validation expectations

- Run targeted behavior tests while iterating and `npm run check` before committing a release-relevant change.
- Lock, state deletion, service lifecycle, detached process, credential, browser, or application authority changes require concurrent/fault-injection tests; source-string assertions alone are insufficient.
- Run both dependency audits, Worker dry-run, and `npm pack --dry-run` for a versioned release candidate.
- Update tests, documentation, and `CHANGELOG.md` whenever behavior, security, privacy, operations, or public contracts change.
- Inspect the complete diff, Git status, generated package file list/modes, and [docs/AUDIT.md](docs/AUDIT.md) implications before commit or push.

## Standard release handoff

The release operator performs these steps from a clean `main` worktree:

```bash
npm run release:publish
npm publish --access public
npm install -g --omit=optional --allow-scripts=esbuild,workerd,sharp,fsevents machine-bridge-mcp@latest && machine-mcp
```

`release:publish` creates or verifies the annotated version tag, pushes it, creates or updates the GitHub Release, and uploads the npm tarball. `npm publish` then passes the fail-closed GitHub synchronization check and publishes the package. The final npm command updates the global CLI. Normal `machine-mcp` startup checks the recorded Worker deployment hash, expected package version, and Worker health; it redeploys when required and reconciles the normal daemon/autostart flow. A coding agent must not preempt this handoff unless the user explicitly requests live release or machine operations.
