# Repository automation contract

Read [ENGINEERING](docs/ENGINEERING.md), [PROJECT_STANDARDS](docs/PROJECT_STANDARDS.md), and [CONTRIBUTING](CONTRIBUTING.md) before changing code. They define architecture, security, validation and review obligations; [RELEASING](docs/RELEASING.md) is the authoritative release procedure. Preserve unrelated work and existing safety boundaries.

## Tool-selection hard gate

Do not call, discover, list, load, or invoke a hosted GitHub connector, ChatGPT GitHub plugin, browser-side GitHub integration or equivalent remote control plane for this repository. This gate applies before connector/tool discovery. Use only local `git`, `gh`, and `gh api` through Machine Bridge. Availability of a hosted connector is not a fallback. A violation must be treated as a process defect: inspect any remote effect through local `gh`, record the correction and resume locally.

## Checkout identity and coding scope

Verify worktrees, branch, HEAD, package version and tool-schema generation before describing a checkout as current main, online or a candidate. Resolve a named prerelease first with `node <any-worktree-of-this-repository>/scripts/resolve-versioned-worktree.mjs <any-worktree-of-this-repository> <beta.N>`; accept exactly one `status=resolved` with `fallback_used=false`. Directory names and dirty package versions are insufficient routing evidence. Preserve historical dirty worktrees; reconcile missing or ambiguous identities. Compare live `server_info` and the complete host catalog when runtime/schema identity matters.

Source, tests, docs, package metadata, branches, commits, local verification, candidate preparation/activation, Worker and login-daemon replacement, the bounded synthetic OAuth canary, acceptance, guarded push/PR/merge, tags and GitHub Releases are standing-authorized when required by the task and integrity gates pass. Do not add conversational stop points. Default `full` policy, strict schemas, request-scoped MCP `2026-07-28`, shared authority checks, bounded protected file reads, unknown-outcome settlement and privacy-bounded logs remain mandatory. Do not add obsolete protocol compatibility, arbitrary public evaluation tools, speculative security changes, dependency cycles or mechanical file splitting.

## Autonomous long-running work invariant

User interaction must not be used as a scheduler tick. Job polling ownership is not task ownership: the agent must not render the monitor merely to shorten a response while remaining task work needs its terminal result. Keep `job_id` and principal-bound `recovery_key`; cancellation uses its separate `control_key`. A UI monitor claim transfers status polling only. `continuation_mode=task_supervisor` is an owner/caller semantic assertion that the durable reviewed plan already owns all remaining work; never infer that from the monitor alone.

Follow an active known job in the same assistant response with the server-side long-poll: hosted `read_job` defaults to 40 seconds, caps at 60, and coalesces nonterminal progress for at least 30 seconds. Preserve `host_turn_handoff_recommended=false` and `status_polling_mode=bounded_followup` until a real task handoff. Do not infer a host deadline from elapsed time. Interactive process reads retain their one-second output/exit blocking cap, fifteen-second would-block cooldown and pacing inside the cooldown boundary. Unknown acceptance is recovered with the original arguments and idempotency key; never repeat the business side effect blindly.

Prefer one coherent umbrella command or multi-step managed job over many one-step carriers. Frozen `check:full` launched remotely uses `start_job` with a step timeout above 600 seconds; do not impose `run_process`'s 600-second step limit on it. A high-density host tool loop or forced repeated user nudges is a release-blocking continuity defect. Changes to hosted follow-up semantics require a live unchanged-active fixture proving the default bounded wait and a second accepted read in the same assistant response. See [MANAGED_JOBS](docs/MANAGED_JOBS.md) and [CLIENTS](docs/CLIENTS.md).

## GitHub control plane

Before any GitHub read or mutation, apply this contract through Machine Bridge. If the local Machine Bridge control plane is unavailable, stop and report that boundary. Do not mix local `gh`/`git` writes with connector writes. Fetch before mutation, preserve unrelated changes, never push directly to main and use `npm run github:push` rather than raw push for package work. Review, CI and exact-commit integrity remain gates.

## Mandatory prerelease and soak invariant

New package work uses dev/beta/rc versions and dist-tags `dev`, `beta`, `next`, never `latest`. Finish implementation and targeted checks, then freeze source and run one `npm run check:full`; its matching short-lived receipt is consumed by `npm run release:candidate`. Also complete dependency audits for both locks, Worker dry-run, registry signatures, SBOM, package/diff inspection and privacy/history checks.

Before live mutation run `node scripts/start-release-candidate.mjs --install-only`. It verifies exact source, tarball, package modes and disposable installation. Then execute `npm run release:candidate:activate -- --allow-worker-deploy` through a durable job without another approval. Detached activation must verify Wrangler authentication before service handoff and must never initiate interactive login.

Derive `<activated-runtime-package>` from the activation record's `runtime_entry`; from the checkout cwd run `node <activated-runtime-package>/scripts/release-oauth-canary.mjs --allow-live-oauth-canary`. The exact activated code creates only a synthetic reviewer/DCR client, verifies authorization-code exchange, authenticated MCP, refresh rotation and cleanup, and records no credentials or account/client identifiers. Observe live Worker/hash, relay, daemon/service identity, representative behavior, failure paths and privacy before `npm run release:accept`.

Only the exact persistently activated and accepted candidate may be committed/pushed with `npm run github:push`, reviewed and merged. After exact-commit checks, run `npm run prerelease:release` automatically for the tag and GitHub Prerelease. Source-release readiness, npm publication and soak are separate claims.

## Sole explicit user-authorization boundary

Only npm package publication needs an explicit current-task owner request: `npm run prerelease:publish -- --owner-confirm` or `npm run stable:publish -- --owner-confirm`. TTY presence is not authorization. An npm authentication challenge must be completed in a real owner terminal while that canonical publish process remains running; never relay OTPs, tokens or challenge URLs through automation. Reconcile an ambiguous registry outcome before retrying.

After authorized npm publication, `npm run prerelease:install -- --allow-worker-deploy` automatically installs and activates registry-verified bytes and starts formal soak. Minimum soak: major seven days, minor three days, patch one day; a blocking fix needs a new prerelease and restarts soak. Record successful soak only after the owner's explicit report. Stable promotion permits normalized release metadata only and must preserve `promotion_content_sha256`; run `npm run release:soak:verify`, repeat exact activation/canary/acceptance, then guarded PR and source release. Stable npm publication retains its separate explicit request.

## ChatGPT host-control-plane UI discipline

Task-relevant supported Apps/Plugins/admin refresh is not a separate conversational authorization boundary. Prefer existing runtime/discovery evidence, then in-place refresh/review. Host-side filtered tool/resource search is a routing aid, not authoritative schema-freshness evidence: load the complete `machine-mcp` tool catalog **without a query filter**. A conflicting filtered result can be a stale host query/search-index cache; a stale filtered-search result alone must not block acceptance or trigger UI repair.

An external acceptance blocker exists when the unfiltered full catalog is itself stale, partial, or mixed-generation, or actual invocation behavior contradicts it. Preserve existing apps unless replacement is technically necessary, verify each mutation and never replay an unknown-outcome UI mutation blindly. Internal cache inspection is not release evidence.

## Incident diagnosis and evidence hard gate

Identify exact source, deployed Worker, daemon, workspace and state generation before changing behavior. Separate observed facts, inferences, falsified hypotheses and unknowns. Use content-free stage/error enums and minimal controls before semantic changes; never log bodies, tokens, proofs, account identifiers or raw exceptions. Do not rotate credentials, recreate accounts, delete state or weaken authentication as generic diagnostics.

Test one causal hypothesis at a time. Remove a falsified patch unless it has an independently demonstrated invariant. Evidence binds to a frozen source snapshot: concurrent packaged/test-source writes invalidate validation. Filesystem, lifecycle, locks, credentials and automation changes need behavior, concurrency and fault-injection evidence; text checks alone cannot establish safety. Local simulations establish only exercised behavior. Hosted/provider/OS failures need corresponding live observation when practical; authentication/persistence changes require a deployed-edge canary, including refresh continuity and the relevant TTL boundary when material. Record causal evidence and convert reproducible failures into executable regressions.
