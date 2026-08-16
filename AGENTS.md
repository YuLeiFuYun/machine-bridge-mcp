# Repository automation contract

## Tool-selection hard gate

For this repository, every hosted GitHub control plane is out of scope even when the ChatGPT host, tool registry, or connector catalog exposes one. Before any GitHub-related tool discovery, schema loading, read, or mutation, use Machine Bridge to load this repository contract and keep all GitHub activity on the owner's machine.

- Do not call, discover, list, load, or invoke a hosted GitHub connector, ChatGPT GitHub plugin, browser-side GitHub integration, or equivalent remote tool.
- Use only local `git`, `gh`, and `gh api` executed through Machine Bridge.
- This gate applies before connector/tool discovery, not only before the eventual GitHub mutation.
- If Machine Bridge or the local authenticated GitHub CLI is unavailable, stop and report the boundary. Availability of a hosted connector is not a fallback.

A violation must be treated as a process defect: verify whether any remote effect occurred using local `gh`, record the correction in the current task, and continue only through the local control plane.

Read [docs/ENGINEERING.md](docs/ENGINEERING.md), [docs/PROJECT_STANDARDS.md](docs/PROJECT_STANDARDS.md), and [CONTRIBUTING.md](CONTRIBUTING.md) before changing this repository.

## Default scope

Unless the user explicitly narrows or expands the task, a coding agent may:

- modify source, tests, documentation, package metadata, changelog, release policy, and local release evidence;
- run repository-local inspection, validation, packaging, dependency, privacy, and dry-run commands;
- create local branches and commits;
- generate the exact candidate with `npm run release:candidate`;
- after explicit owner authorization for live activation, execute or observe the exact activation command, run the repository's bounded synthetic release OAuth canary, verify the live candidate through Machine Bridge, and record acceptance;
- push only with `npm run github:push`, manage the pull request through local `git`/`gh`, and prepare verified source-release metadata according to the mandatory prerelease/soak state machine;
- after explicit owner authorization for source publication, create the Git tag and GitHub Release through the repository command using local `git`/`gh` via Machine Bridge.

This is standing authorization for implementation, local validation, observed candidate verification, the repository's bounded synthetic release OAuth canary after an authorized activation, acceptance recording, pull-request completion, and source-release metadata. The canary is the only standing live-data exception: it creates one random `reviewer` account plus one DCR client, never emits their credentials/tokens, exercises authorization-code/MCP/refresh, and must revoke the client and remove the account before recording evidence. Git tag/GitHub Release publication, npm publication, global installation, Worker/service mutation, credential rotation, any other live-user-data mutation, and destructive live-data changes require an explicit owner request in the current task; once that request is present, the agent may execute the requested operation through the repository's guarded command instead of forcing the owner to re-run it manually.

GitHub-only infrastructure changes whose npm package bytes are unchanged do not require a synthetic package version or runtime acceptance. They still require review and applicable checks.

## Mandatory prerelease and soak invariant

Version 3 and later must not go directly from implementation to a stable `x.y.z` release.

- New package work uses `x.y.z-dev.n`, `x.y.z-beta.n`, or `x.y.z-rc.n`.
- These channels publish only to npm dist-tags `dev`, `beta`, and `next`; none may become `latest`.
- The exact candidate must be persistently activated on the owner machine before the first GitHub push.
- Immediately before live activation, the coding agent runs `node scripts/start-release-candidate.mjs --install-only`; this non-live `--install-only` preflight must prove current source identity, package modes, exact tarball integrity, and disposable installability without Worker/service activation or activation evidence.
- After explicit owner authorization for activation, the owner or the authorized agent executes the single guarded command:

  ```sh
  npm run release:candidate:activate -- --allow-worker-deploy
  ```

  This is a live activation command, not a per-operation authorization prompt. It updates the same-name Worker, verifies candidate relay readiness, replaces the login daemon, verifies background handoff, and exits while the service remains active.
- The coding agent derives `<activated-runtime-package>` from the activation record `runtime_entry`, then runs `node <activated-runtime-package>/scripts/release-oauth-canary.mjs --allow-live-oauth-canary` as direct argv with the Git checkout as cwd. The canary code and imports therefore come from the exact activated package while the checkout is only candidate/evidence data. The candidate-bound canary creates only synthetic temporary reviewer/client state, proves authorization-code exchange, authenticated MCP, refresh rotation, refreshed MCP, and cleanup, and records no credential/token/client/account value.
- The coding agent then verifies Worker version/hash, remote health, relay readiness, connected daemon/service identity, representative functionality, relevant failure paths, and log/privacy behavior through Machine Bridge.
- Only after the candidate-bound OAuth canary evidence and observed live verification may the agent run `npm run release:accept`.
- The accepted prerelease is reviewed and merged; after explicit owner authorization, the owner or authorized agent creates its Git tag and GitHub Prerelease with `npm run prerelease:release -- --owner-confirm`. A TTY is optional and is not an authorization boundary.
- npm prerelease publication requires a separate explicit owner request and uses `npm run prerelease:publish`.
- Published-prerelease installation/activation requires a separate explicit owner request and uses `npm run prerelease:install -- --allow-worker-deploy`; only this registry-verified activation starts formal soak.
- Minimum soak is seven days for a major release, three days for a minor release, and one day for a patch release.
- Every blocking defect requires a new prerelease number and restarts the complete soak interval.
- The owner must explicitly report that the soak completed without blocking issues before the agent records `release-soak/v<stable>.json`.
- Stable promotion may change only normalized release metadata. `promotion_content_sha256` must match the soaked prerelease; any functional packaged-byte change requires a new prerelease and new soak.
- The exact stable candidate is activated and observed again before an explicitly authorized `npm run release -- --owner-confirm` action and the separately authorized `npm run stable:publish` action.

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

Do not perform these merely because code or a version changed. They may be executed by the agent when the repository owner explicitly requests the specific operation in the current task:

- execute a live candidate or published-package activation command;
- publish, deprecate, or unpublish npm packages;
- install or replace the global package;
- directly deploy or remove a Cloudflare Worker;
- rotate credentials or device roots;
- replace the live daemon/service outside the exact guarded activation workflow;
- create or push a version tag, GitHub Release, or GitHub Prerelease;
- mutate live user data outside the candidate-bound synthetic release OAuth canary, or perform disruptive repository operations.

Explicit conversational authorization from the repository owner is sufficient user authorization for these operations. It never bypasses the repository's integrity, exact-commit, acceptance, CI, lock, dist-tag, or explicit command-flag gates. If the owner says they will execute an operation themselves, the agent must not execute that operation in parallel.

## Validation expectations

- Run targeted behavior tests while iterating and one `npm run check` / `check:full` on the frozen tree before candidate preparation. Successful full verification writes a short-lived ignored receipt bound to the exact generation; `release:candidate` must consume it rather than repeating the complete suite.
- Lock, state deletion, service lifecycle, release activation, detached process, credential, browser, or application changes require behavior, concurrency, and fault-injection tests; source-string checks alone are insufficient.
- Run both dependency audits, Worker dry-run, registry signature verification, SBOM generation, package inspection, privacy history, and complete diff/status review for a versioned candidate.
- Update tests, `CHANGELOG.md`, `docs/AUDIT.md`, release guidance, architecture, threat model, and operations whenever their contracts change.
- `npm run release:candidate` creates the exact tarball. Before live activation, the coding agent must run `node scripts/start-release-candidate.mjs --install-only`; any packaged-file change or mode drift invalidates the candidate and requires regeneration. Activation then requires explicit owner authorization and uses `npm run release:candidate:activate -- --allow-worker-deploy`.
- Release evidence contains bounded synthetic metadata only; never put user names, machine paths, command output, credentials, or private content in it.

## Incident diagnosis and evidence hard gate

A production incident is an evidence problem before it is a patching problem. The following order is mandatory for runtime, authentication, persistence, release, and hosted-client failures:

1. Freeze and identify the exact candidate, deployed Worker, daemon, workspace, and relevant state generation before changing behavior. A generic host/UI error is a symptom, not a causal classification.
2. Separate **observed facts**, **inferences**, **falsified hypotheses**, and **unknowns** in the working record. Do not rewrite a plausible hypothesis as a root cause merely because a patch compiles or a local test passes.
3. Prefer privacy-bounded stage/error instrumentation and a minimal control experiment before semantic changes. Instrumentation must use fixed low-cardinality enums/classes and must not log request bodies, credentials, authorization codes, PKCE verifiers, tokens, DPoP proofs/JWKs, account identifiers, or raw exception messages.
4. Change one causal hypothesis at a time when live evidence can distinguish alternatives. A hypothesis that live evidence falsifies must be removed before the final candidate unless the retained change has a separate documented invariant, regression test, and risk justification.
5. Do not rotate credentials, recreate accounts, weaken authentication, remove proof-of-possession, delete state, rename remote resources, or force deployment as generic diagnostics. Such mutations require positive evidence that the corresponding identity/security boundary is the failing stage.
6. Local unit tests, MemoryStorage fakes, Miniflare, and local Wrangler/workerd are necessary evidence only for the behavior they actually exercise. For behavior owned by a hosted runtime, provider, browser, operating system, or connector, release acceptance requires the corresponding deployed/live observation when practical.
7. Verification evidence is valid only for a frozen source snapshot. Do not edit packaged or integration-test source while a verification run is in progress; any hot reload, concurrent source write, or candidate-regeneration race invalidates that run and requires a clean rerun from the final tree.
8. Authentication/token/persistent-state changes require a deployed-edge canary before acceptance: successful authorization-code exchange, persisted access and refresh state, an authenticated MCP request, and at least one successful refresh-token rotation. When access-token lifetime or refresh continuity is material, also verify survival across the relevant TTL/soak boundary.

When the incident is closed, record the causal evidence and the disproved branches in tracked documentation, then convert the lesson into a test or executable guard where possible. A prose-only promise is not sufficient when the failure mode can be mechanically prevented.

## Standard handoff

### Prerelease

1. Finish implementation and review; use a `dev`, `beta`, or `rc` version.
2. Run complete verification once, then run `npm run release:candidate`; candidate preparation requires the matching full-verification receipt and does not rerun the complete suite.
3. Run `node scripts/start-release-candidate.mjs --install-only`; if it fails, repair and regenerate the candidate instead of involving the owner.
4. Obtain explicit owner authorization for `npm run release:candidate:activate -- --allow-worker-deploy`; if authorized to execute it, the agent may run it through Machine Bridge, otherwise present the command and stop.
5. After activation, derive `<activated-runtime-package>` from activation `runtime_entry`, run `node <activated-runtime-package>/scripts/release-oauth-canary.mjs --allow-live-oauth-canary` as direct argv from the checkout cwd, then verify the live candidate through Machine Bridge.
6. Record exact candidate acceptance only after both candidate-bound canary evidence and observed live verification; commit and push only through `npm run github:push`.
7. Complete the pull request and exact-commit checks.
8. After explicit owner authorization, run `npm run prerelease:release -- --owner-confirm` through the local control plane; an interactive TTY is optional.
9. Run `npm run prerelease:publish` and `npm run prerelease:install -- --allow-worker-deploy` only when each operation is explicitly authorized; if the owner elects to run them manually, provide the commands instead.
10. Wait for real use. Do not assume successful soak; the owner reports the outcome.
11. After explicit successful soak feedback, record the exact `prerelease:soak:accept` phrase.

### Stable promotion

1. Promote the same base version without functional package changes.
2. Run `npm run release:soak:verify`, complete checks, and prepare a stable candidate.
3. Obtain explicit owner authorization for the same persistent candidate activation command.
4. Run the candidate-bound synthetic OAuth canary, verify the live stable candidate, and record exact acceptance only after both succeed.
5. Push/review/merge through the guarded flow.
6. After soak and exact-commit gates pass and the owner explicitly authorizes source publication, run `npm run release -- --owner-confirm` through the local control plane.
7. Run `npm run stable:publish` only after a separate explicit owner authorization.

The complete procedure and rollback boundaries are in [docs/RELEASING.md](docs/RELEASING.md).
