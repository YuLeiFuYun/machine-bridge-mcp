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

The repository owner publishes the reviewed version to npm. After publication, the owner runs:

```bash
npm install -g --allow-scripts=esbuild,workerd,sharp machine-bridge-mcp@latest && machine-mcp
```

The npm command updates the global CLI. The normal `machine-mcp` startup then checks the recorded Worker deployment hash, expected package version, and Worker health; it redeploys when required and reconciles the normal daemon/autostart flow. A coding agent must not preempt this handoff unless the user explicitly requests live release or machine operations.
