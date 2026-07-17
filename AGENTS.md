# Repository automation contract

Read [docs/ENGINEERING.md](docs/ENGINEERING.md), [docs/PROJECT_STANDARDS.md](docs/PROJECT_STANDARDS.md), and [CONTRIBUTING.md](CONTRIBUTING.md) before changing this repository.

## Default scope

Unless the user explicitly expands the scope in the current task, a coding agent may:

- modify source code, tests, documentation, package metadata, and changelog entries;
- run repository-local validation and inspection commands;
- create local branches and commits;
- generate an exact release candidate with `npm run release:candidate`;
- after the repository owner records local acceptance for that exact tarball, push the branch only through `npm run github:push`, create or update its pull request, and complete the reviewed pull request;
- after acceptance, merge, and successful exact-commit checks, create the annotated version tag and final GitHub Release through `npm run release:publish`.

This is standing authorization for repository implementation and local validation. It is not standing authorization to assert that the repository owner's local test passed. A coding agent must stop before the first GitHub push of an npm-package change and hand the exact `.release-candidate/*.tgz` artifact to the owner for local testing. The agent must not run `release:accept`, fabricate `release-acceptance/v<version>.json`, infer acceptance from automated checks, or paraphrase an ambiguous response as approval.

GitHub-only repository infrastructure changes whose npm package bytes are unchanged do not require a synthetic npm version or runtime acceptance. They still require review and all applicable checks.

## GitHub control plane

Before any GitHub read or mutation, load and apply this repository contract through Machine Bridge. If the local Machine Bridge control plane is unavailable, stop and report the boundary; do not substitute a hosted connector, plugin, browser integration, or other remote control plane.

GitHub operations for this repository must use the local authenticated command-line tools through Machine Bridge:

- use `git` for local history, branches, commits, diffs, fetches, and accepted pushes;
- use `gh` and `gh api` for pull requests, checks, workflow logs, repository settings, releases, and GitHub REST/GraphQL operations;
- never use a hosted GitHub connector, ChatGPT GitHub plugin, or a second remote mutation control plane;
- never push an npm-package change with raw `git push`; use `npm run github:push` after owner acceptance;
- never push directly to `main`; merge through a reviewed pull request;
- fetch before writing, preserve unrelated remote work, and verify the resulting branch, pull request, checks, or repository setting after every remote mutation.

Do not mix local `gh`/`git` writes with connector writes on the same branch. One local control plane keeps credentials, acceptance evidence, branch state, and failure recovery observable on the repository owner's machine.

## Operations that require explicit user authorization

Do not perform any of the following merely because code or a version changed:

- record the repository owner's local acceptance;
- publish, deprecate, or unpublish an npm package;
- install or upgrade the package globally with npm;
- deploy a Cloudflare Worker directly, change Worker secrets, or rotate credentials;
- start, stop, install, remove, or replace the local daemon or autostart service;
- alter live state files to make a deployment appear current.

These are owner, release-operator, or machine-operator actions, not implicit parts of a code change.

## Validation expectations

- Run targeted behavior tests while iterating and `npm run check` before preparing a release candidate.
- Lock, state deletion, service lifecycle, detached process, credential, browser, or application authority changes require concurrent or fault-injection tests; source-string assertions alone are insufficient.
- Run both dependency audits, Worker dry-run, registry signature verification, SBOM generation, and package inspection for a versioned release candidate.
- Update tests, documentation, `docs/AUDIT.md`, and `CHANGELOG.md` whenever behavior, security, privacy, operations, release policy, or public contracts change.
- Inspect the complete diff, Git status, generated package file list/modes, and privacy history before candidate preparation.
- `npm run release:candidate` must produce the exact tarball the owner tests. Any packaged-file change afterward invalidates acceptance and requires a new candidate and owner test.

## Standard release handoff

For an npm-package change:

1. complete implementation, version, changelog, documentation, audit notes, and local automated validation;
2. run `npm run release:candidate`;
3. report the exact candidate tarball path and the relevant local test procedure to the repository owner, then stop before GitHub push;
4. after the owner personally tests that tarball, the owner runs the exact `npm run release:accept -- --confirm "I TESTED machine-bridge-mcp <version> LOCALLY AND IT WORKS"` command printed by the candidate tool;
5. commit the resulting `release-acceptance/v<version>.json` and push only with `npm run github:push`;
6. create or update the pull request, satisfy all required checks, squash-merge, fetch, and fast-forward local `main`;
7. run `npm run release:publish`; this command requires `HEAD` to equal `origin/main` and does not push `main`;
8. verify that the accepted tarball hash, local and remote annotated tag, final GitHub Release asset, exact-commit checks, and `main` agree.

The release operator separately authorizes npm publication and any live machine update:

```bash
npm publish --access public
npm install -g --omit=optional --allow-scripts=esbuild,workerd,sharp,fsevents machine-bridge-mcp@latest && machine-mcp
```

`release:publish` is conditional repository-source completion after explicit owner acceptance. `npm publish`, Worker deployment, credential changes, global installation, and daemon or service replacement remain explicit live-operation decisions.
