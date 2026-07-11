# Repository automation contract

Read [docs/ENGINEERING.md](docs/ENGINEERING.md) and [CONTRIBUTING.md](CONTRIBUTING.md) before changing this repository.

## Default scope

Unless the user explicitly expands the scope in the current task, a coding agent may:

- modify source code, tests, documentation, package metadata, and changelog entries;
- run repository-local validation and inspection commands;
- create commits and push the current branch to GitHub.

## Operations that require explicit user authorization

Do not perform any of the following merely because code or a version changed:

- publish, deprecate, or unpublish an npm package;
- create or push a Git tag, or create a GitHub Release;
- install or upgrade the package globally with npm;
- deploy a Cloudflare Worker directly, change Worker secrets, or rotate credentials;
- start, stop, install, remove, or replace the local daemon or autostart service;
- alter live state files to make a deployment appear current.

These are release-operator or machine-operator actions, not implicit parts of a code change.

## Standard release handoff

The release operator performs these steps from a clean `main` worktree:

```bash
npm run release:publish
npm publish --access public
npm install -g --allow-scripts=esbuild,workerd,sharp machine-bridge-mcp@latest && machine-mcp
```

`release:publish` creates or verifies the annotated version tag, pushes it, creates or updates the GitHub Release, and uploads the npm tarball. `npm publish` then passes the fail-closed GitHub synchronization check and publishes the package. The final npm command updates the global CLI. Normal `machine-mcp` startup checks the recorded Worker deployment hash, expected package version, and Worker health; it redeploys when required and reconciles the normal daemon/autostart flow. A coding agent must not preempt this handoff unless the user explicitly requests live release or machine operations.
