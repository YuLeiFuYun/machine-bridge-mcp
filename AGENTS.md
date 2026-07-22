# Repository automation contract

Read [docs/ENGINEERING.md](docs/ENGINEERING.md), [docs/PROJECT_STANDARDS.md](docs/PROJECT_STANDARDS.md), and [CONTRIBUTING.md](CONTRIBUTING.md) before changing this repository.

## Default scope

Unless the user explicitly narrows or expands the task, a coding agent may:

- modify source, tests, documentation, package metadata, changelog, release policy, and local release evidence;
- run repository-local inspection, validation, packaging, dependency, privacy, and dry-run commands;
- create local branches and commits;
- generate the exact candidate with `npm run release:candidate`;
- after explicit owner authorization and owner execution of the printed activation command, verify the live candidate through Machine Bridge and record acceptance;
- push only with `npm run github:push`, manage the pull request through local `git`/`gh`, and complete the reviewed source release according to the mandatory prerelease/soak state machine.

This is standing authorization for implementation, local validation, observed candidate verification, acceptance recording, pull-request completion, and source-release metadata. It is not standing authorization for npm publication, global installation, Worker/service mutation, credential rotation, or destructive live-data changes.

GitHub-only infrastructure changes whose npm package bytes are unchanged do not require a synthetic package version or runtime acceptance. They still require review and applicable checks.

## Mandatory prerelease and soak invariant

Version 3 and later must not go directly from implementation to a stable `x.y.z` release.

- New package work uses `x.y.z-dev.n`, `x.y.z-beta.n`, or `x.y.z-rc.n`.
- These channels publish only to npm dist-tags `dev`, `beta`, and `next`; none may become `latest`.
- The exact candidate must be persistently activated on the owner machine before the first GitHub push.
- The owner executes the single printed command:

  ```sh
  npm run release:candidate:activate -- --allow-worker-deploy
  ```

  This is a live activation command, not a per-operation authorization prompt. It updates the same-name Worker, verifies candidate relay readiness, replaces the login daemon, verifies background handoff, and exits while the service remains active.
- The coding agent then verifies Worker version/hash, remote health, relay readiness, connected daemon/service identity, representative functionality, relevant failure paths, and log/privacy behavior through Machine Bridge.
- Only after observed live verification may the agent run `npm run release:accept`.
- The accepted prerelease is reviewed and merged, then released with `npm run prerelease:release`.
- npm prerelease publication is an explicit owner/release-operator action using `npm run prerelease:publish`.
- The owner installs and activates the published prerelease with `npm run prerelease:install -- --allow-worker-deploy`; only this registry-verified activation starts formal soak.
- Minimum soak is seven days for a major release, three days for a minor release, and one day for a patch release.
- Every blocking defect requires a new prerelease number and restarts the complete soak interval.
- The owner must explicitly report that the soak completed without blocking issues before the agent records `release-soak/v<stable>.json`.
- Stable promotion may change only normalized release metadata. `promotion_content_sha256` must match the soaked prerelease; any functional packaged-byte change requires a new prerelease and new soak.
- The exact stable candidate is activated and observed again before `npm run release` and the explicit `npm run stable:publish` action.

This workflow is a hard repository contract, not a conversational preference. Do not replace it with direct stable publication, an unobserved process, a transient foreground-only candidate, or an external signing prerequisite that is not part of this self-hosted flow.

## GitHub control plane

Before any GitHub read or mutation, load and apply this repository contract through Machine Bridge. If the local Machine Bridge control plane is unavailable, stop and report the boundary; do not substitute a hosted GitHub connector, ChatGPT GitHub plugin, browser-side GitHub integration, or another remote control plane.

- Use local `git` for history, branches, commits, diffs, fetches, and accepted pushes.
- Use local `gh` and `gh api` for pull requests, checks, workflow logs, repository settings, tags, and GitHub Releases.
- Do not mix local `gh`/`git` writes with connector writes.
- Never use raw `git push` for an npm-package branch; use `npm run github:push`.
- Never push directly to `main`; merge through a reviewed pull request.
- Fetch before mutation, preserve unrelated work, and verify every remote result.

## Operations requiring explicit user authorization

Do not perform these merely because code or a version changed:

- execute the owner-side live activation command on the owner's behalf;
- publish, deprecate, or unpublish npm packages;
- install or replace the global package;
- directly deploy or remove a Cloudflare Worker;
- rotate credentials or device roots;
- replace the live daemon/service outside the exact owner-executed activation workflow;
- mutate live user data or perform disruptive repository operations.

The coding agent prepares and prints the exact command. The owner runs live activation/publication commands unless the user explicitly directs otherwise in the active conversation.

## Validation expectations

- Run targeted behavior tests while iterating and `npm run check` before candidate preparation.
- Lock, state deletion, service lifecycle, release activation, detached process, credential, browser, or application changes require behavior, concurrency, and fault-injection tests; source-string checks alone are insufficient.
- Run both dependency audits, Worker dry-run, registry signature verification, SBOM generation, package inspection, privacy history, and complete diff/status review for a versioned candidate.
- Update tests, `CHANGELOG.md`, `docs/AUDIT.md`, release guidance, architecture, threat model, and operations whenever their contracts change.
- `npm run release:candidate` creates the exact tarball consumed by `npm run release:candidate:activate -- --allow-worker-deploy`. Any packaged-file change invalidates acceptance.
- Release evidence contains bounded synthetic metadata only; never put user names, machine paths, command output, credentials, or private content in it.

## Standard handoff

### Prerelease

1. Finish implementation and review; use a `dev`, `beta`, or `rc` version.
2. Run complete verification and `npm run release:candidate`.
3. Present `npm run release:candidate:activate -- --allow-worker-deploy` to the owner and stop.
4. After the owner runs it, verify the live candidate through Machine Bridge.
5. Record exact candidate acceptance, commit, and push only through `npm run github:push`.
6. Complete the pull request and exact-commit checks.
7. Run `npm run prerelease:release`.
8. The owner runs `npm run prerelease:publish` and `npm run prerelease:install -- --allow-worker-deploy`.
9. Wait for real use. Do not assume successful soak; the owner reports the outcome.
10. After explicit successful soak feedback, record the exact `prerelease:soak:accept` phrase.

### Stable promotion

1. Promote the same base version without functional package changes.
2. Run `npm run release:soak:verify`, complete checks, and prepare a stable candidate.
3. Present the same persistent candidate activation command to the owner.
4. Verify the live stable candidate and record exact acceptance.
5. Push/review/merge through the guarded flow.
6. Run `npm run release` only after soak and exact-commit gates pass.
7. The owner explicitly runs `npm run stable:publish`.

The complete procedure and rollback boundaries are in [docs/RELEASING.md](docs/RELEASING.md).
