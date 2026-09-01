# Project standards

This document defines the repository-wide engineering and collaboration standard. It complements the product and security invariants in [ENGINEERING.md](ENGINEERING.md). A rule is preferred only when it reduces material risk, makes review easier, or can be enforced consistently; ceremony without a credible failure mode is not a quality control.

## 1. Change flow

The repository uses **GitHub Flow**:

1. create a short-lived branch from current `main`;
2. make one coherent change, including tests and documentation;
3. open a pull request and let required checks complete;
4. resolve review conversations and rebase or update the branch when required;
5. squash-merge into `main` and delete the branch.

Permanent `develop`, `feature`, and `release` integration branches are not used. A supported maintenance line may use a temporary `release/x.y` branch only when an older published version must receive fixes independently of `main`.

Branch names use a short category and purpose, for example `feat/browser-downloads`, `fix/relay-timeout`, `docs/release-guide`, or `chore/dependency-policy`.

Direct pushes to `main`, force pushes, and branch deletion are blocked by repository protection. An exception requires an incident record and an explicit owner decision.

### Local repository readiness and release readiness

A review or automation report must state the scope of its readiness claim. `local_repository` readiness means that the current working-tree candidate is bound to its objective revision, has passed every required local and project-native verification stage, has requirement-specific evidence, and has the required reviews. It does not assert that a hosted Worker, browser client, GitHub repository, npm registry, service installation, or production network currently matches that candidate.

`release_ready` is a separate claim. It requires the exact candidate identity plus the applicable independent-environment and independent-authority lifecycle evidence, including hosted CI and security checks, candidate activation where package behavior changed, publication controls, and any required soak. A local simulator, local owner attestation, or absence of a local failure cannot substitute for those external observations.

During a deliberately local-only review, not invoking activation, publication, push, tag, or hosted-mutation commands is evidence that the observed review path did not request those side effects. It is not evidence that external state is healthy or synchronized. Reports must retain that limitation and list missing external stages rather than converting them into local blockers or silently treating them as passed.

### Incident evidence discipline

For production or candidate failures, the defect record must distinguish observed facts, inferences, falsified hypotheses, and unknowns. The exact deployed package/Worker/daemon/workspace identity is established before behavioral changes. Generic UI/connector messages and local simulator success are not causal evidence.

Before changing authentication, persistence, transport, or release semantics, prefer a privacy-bounded stage discriminator or a minimal control experiment that can separate the plausible branches. Change one causal hypothesis at a time when live evidence can distinguish alternatives. If a live observation disproves the hypothesis, remove that patch before finalization unless an independent invariant and regression test justify it; do not accumulate speculative compatibility or security changes merely because each is individually plausible.

Credential rotation, account recreation, security weakening, state deletion, forced deployment, and remote-resource renaming are not diagnostic resets. They require positive evidence at that boundary and must not erase the state needed to explain the incident. When local emulation differs from the hosted runtime, the hosted observation is the acceptance authority for that hosted behavior and the discrepancy becomes an explicit test/residual-risk item.

Verification is run against a frozen tree. Starting a long integration/release check and then editing watched source invalidates the run; a hot reload or concurrent packaged-file write requires a clean rerun after the final edit. The same rule applies to a generated candidate: any packaged-byte change makes the prior candidate and acceptance evidence stale.

### Completion ownership, prerelease activation, and soak

Repository automation owns implementation, local validation, candidate preparation, observed verification, acceptance recording, and pull-request completion. Package work for version 3 or later must use a `dev`, `beta`, or `rc` version before stable promotion. Direct implementation-to-stable release is prohibited.

One complete frozen-tree verification precedes candidate preparation. Its successful `check:full` writes an ignored, short-lived local receipt bound to the exact source generation plus package and runtime identity; starting a later full run invalidates the old receipt before tests begin. `npm run release:candidate` requires that receipt and creates the exact tarball without repeating the same full suite. Before live activation, repository automation runs `node scripts/start-release-candidate.mjs --install-only`; this non-live disposable-install preflight must still match current source/package modes and exact tarball identity, and failure requires candidate regeneration. Once it succeeds, repository automation executes `npm run release:candidate:activate -- --allow-worker-deploy` without another conversational approval; the command installs that tarball under the private state root, updates the same-name Worker, verifies candidate relay readiness, replaces the login daemon, verifies the background handoff, and exits. The coding agent then derives `<activated-runtime-package>` from activation `runtime_entry` and runs `node <activated-runtime-package>/scripts/release-oauth-canary.mjs --allow-live-oauth-canary` as direct argv from the checkout cwd: this candidate-bound release probe executes activated-package code while treating the checkout only as candidate/evidence data, and creates one synthetic temporary reviewer account and DCR client, exercises authorization-code exchange, authenticated MCP, refresh rotation, and refreshed MCP, removes both temporary objects, and records only non-secret candidate/check metadata. The coding agent then performs observed live verification through Machine Bridge and records acceptance only after both the canary and that observed success. No per-operation terminal approval is involved.

The tracked `release-acceptance/v<version>.json` binds npm hashes, a portable package digest, and a version-normalized promotion digest. Any packaged change invalidates acceptance. `npm run github:push`, CI, and source-release commands verify the record. Raw pushes of package branches are prohibited.

The accepted prerelease's Git tag and GitHub Prerelease use `npm run prerelease:release` automatically once exact-commit and publication-integrity gates pass. Publication authority is the tracked acceptance record plus the exact merged source, not an ignored `.release-candidate` directory from whichever worktree prepared the candidate. GitHub/npm publication must rematerialize private staged bytes with the already-established hardened npm CLI and require package identity, SHA-1/SRI, and promotion digest to remain exactly equal to acceptance before any remote mutation. npm publication is the sole explicit owner decision and uses `npm run prerelease:publish -- --owner-confirm`. Exact registry installation/activation then proceeds automatically with `npm run prerelease:install -- --allow-worker-deploy`. Formal soak begins only from this registry-verified activation. Minimum soak is seven days for major, three days for minor, and one day for patch releases. A blocking defect increments the prerelease number and restarts the soak interval.

Stable promotion requires a tracked `release-soak/v<stable>.json` and identical promotion-content digest. Only normalized release metadata may differ from the soaked prerelease. The stable candidate is activated and observed again before automatic Git tag/GitHub Release publication through `npm run release`; npm stable publication remains the explicit owner decision through `npm run stable:publish -- --owner-confirm`.

GitHub-only repository infrastructure changes that do not alter npm package contents do not require a synthetic version, candidate activation, or soak. They still require review and applicable checks.

### Autonomous long-running task continuity

**The user is not a polling clock.** Once Machine Bridge has durably accepted a job, progress toward the result must not require the user to send `continue`, `继续`, or any equivalent message solely to authorize or trigger another status read. The orchestration layer owns bounded follow-up while tool calls continue to be accepted and the current task still needs the result; it must not infer or preempt a host/tool deadline from elapsed wall-clock time.

An MCP Apps-capable hosted `start_job` may advertise `ui_monitor_candidate=true` plus `ui_monitor_render_tool=render_job_monitor`, but that is not ownership transfer: `start_job` remains a data/execution tool and carries no UI template. The model calls `render_job_monitor` once with the exact accepted `job_id` + `recovery_key`; the Worker verifies read authority and returns a fresh random `ui_monitor_id` while mounting the Job Monitor resource. The next model-side `read_job` must carry that same `ui_monitor_id`. Model-side continuation stops only if that exact active read reports `ui_monitor_claimed=true`, `status_polling_mode=ui_monitor`, `host_turn_handoff_recommended=true`, and `follow_up_read_required=false`, proving that the current mounted View completed its handshake, observed `hostCapabilities.serverTools`, and claimed the same monitor instance using the original recovery capability. The monitor remains capability-bound, calls only the existing hosted `read_job` through the host bridge, gains no bare-ID inventory or direct network path, and a stale claim from an older View cannot transfer a new turn because its random monitor ID differs. This ownership transfer avoids consuming an unobservable aggregate host-turn lifetime without guessing elapsed time or branching on a host product name.

For a known hosted managed job whose result is required by the current task and no UI monitor owns continuation, the client must preserve the acceptance `job_id` together with its principal-bound `recovery_key`; an active relay-origin `read_job` uses those credentials, reports `status_polling_mode=bounded_followup` with `host_turn_handoff_recommended=false`, and the client may issue another capability-bound `read_job` in the same assistant response. **Autonomy must not be implemented as a host-side spin loop or as one overlong host call:** active hosted `read_job` uses the advertised 40-second server-side long-poll by default. Terminal settlement returns on the next bounded poll; nonterminal status/phase/dependency progress is coalesced for at least 30 seconds by default, while `current_step`-only churn remains visible in the eventual status but does not wake the host call by itself. `wait_ms=0` is an explicit immediate checkpoint, not the normal wait strategy, while public hosted `wait_ms` is capped at 60 seconds. The default must remain at the empirically safe 40-second interval rather than being raised merely to reduce call count; longer jobs use another paced read of the same `job_id` instead of one overlong host request. Per-call survival and aggregate host-response lifetime are separate constraints: arithmetic such as `duration / wait interval` is useful for estimating interaction density but is **not** evidence that one assistant response can carry every read to terminal state. Process sessions use the corresponding `paced_followup` model: after a blocking read arms the fifteen-second cooldown, another would-block request is paced inside that same MCP call until output/exit or the cooldown boundary rather than returned as a rapid running checkpoint. The managed-job server-side long-poll, nonterminal progress coalescing, remote one-second actual output/exit blocking `read_process` cap, fifteen-second cooldown, `next_blocking_poll_after_ms`, durable ownership, idempotency, and actual request/transport limits are the anti-amplification controls; a mandatory one-read-per-response, rapid immediate-checkpoint loop, later-user-turn boundary, or guessed elapsed-time cutoff is not an acceptable substitute for those controls.

Host-visible tool-event density must also be controlled before polling begins. A coherent non-interactive workflow that requires several local commands should use a repository-native umbrella command where one exists, otherwise one multi-step `start_job` or the smallest practical number of managed jobs. Do not create a fresh one-step `run_process`/`exec_command`/`run_local_command` carrier for every tiny probe merely because each command is short. This is an orchestration-density rule, not a duration limit: it must never be implemented by shortening the task, reducing the six-hour managed-step ceiling, or handing control back to the user after an arbitrary number of minutes.

The transport/runtime must reduce event density structurally as well as through guidance. A hosted one-step process carrier is accepted durably first, then may spend only the documented short initial-settlement window returning a terminal helper result in that same response. If it remains active, the original durable recovery contract wins unchanged. The daemon/local `list_jobs` inventory must prioritize unreadable/active/staged recovery state before terminal helper history, but the hosted Worker projection must expose only aggregate inventory and must not enumerate job IDs, names, or recent recovery handles. Hosted reads/dependencies require the acceptance `recovery_key`, cancellation requires the separate `control_key`, and both capability types must be verified before daemon dispatch and omitted from logs/routing metadata. Owner diagnostics must expose bounded event-density, job-churn, and resource-waiter-reason aggregates so a later interruption can be classified from persisted evidence rather than reconstructed from host-visible prose. None of these mechanisms may become an aggregate task-duration ceiling or a user-driven polling requirement.

Shared browser focus is likewise not hosted request identity. Hosted browser content/action tools that can otherwise default to the active tab must require an explicit `tab_id` selected from current tab inventory, and hosted browser `computer_observe` must bind its snapshot to that explicit target before later snapshot-bound actions. A concurrent hosted conversation changing the active tab must not retarget an already-specified operation.

An active operation may be handed back with its durable recovery identifier only after a real host/tool/runtime boundary is actually observed, external human input/authorization is required, or the user explicitly requested a checkpoint. Elapsed minutes, a guessed host budget, and merely having performed one active status read in the current response are not valid handoff conditions. If a real host/tool boundary ends the response, the next available response must resume the same durable identifier rather than resubmit the underlying operation. A typed `read_job` `not_found` means that Machine Bridge no longer retains that job record; it is not proof that the underlying operation never executed and must never be converted into a blind retry of a side effect. Inventory and diagnostic surfaces such as `list_jobs`, `server_info`, and `diagnose_runtime` are not alternate polling channels and must not be used to evade the authoritative pacing contract.

Machine Bridge cannot create a new ChatGPT assistant turn after the host has already terminated the current response. That is an external delivery boundary, not a server-side polling primitive that can be repaired by increasing `wait_ms`. The repository must therefore make every pre-boundary acceptance recoverable and every post-boundary state unambiguous: hosted `start_job` requires a caller-held `idempotency_key` before dispatch; an ambiguous acceptance is retried only with the same logical arguments and key; public stream cancellation must remain sticky until the corresponding direct request either observes it or the bounded cancellation-evidence lifetime expires; and loss of completed relay-result evidence blocks transparent replay for the affected call instead of manufacturing non-execution proof. These guarantees reduce interruption amplification but do not claim that MCP can autonomously originate the next product turn.

The execution lifetime must also support the continuity claim below the status layer. Remote one-step process tools remain intentionally capped at 600 seconds; a continuous process that legitimately needs longer must route to a policy-authorized managed-job step. Main/finally steps default to 600 seconds and may explicitly request up to 21,600 seconds (six hours), with cooperative resource admission occurring before that execution timer starts. Do not split a stateful long command merely to work around an orchestration timeout. The local plan validator and all published job schemas must share the same ceiling. Completed one-step process carriers may share the bounded managed-job store, but they are lower-priority terminal retention than explicit managed jobs: when capacity pressure has removable transient helper history, helper churn must reclaim that history before evicting an explicit managed-job recovery result. The durable store is bounded to 512 retained states while `list_jobs` remains a 50-record inventory window. Cross-job ordering must use durable `depends_on` state rather than long shell/file polling when an upstream managed job is the real prerequisite: the dependent job remains pre-execution `queued/dependency_wait`, upstream failure propagates as `dependency_failed`, and referenced retained records stay pinned while an active/staged dependent still needs them. These controls must reduce interruption amplification without reducing aggregate task lifetime or forcing another user turn. The hard retained-state cap and time-based privacy retention remain authoritative.

This rule is a release-blocking continuity invariant. Any change to hosted job/process follow-up semantics requires all of the following evidence before candidate acceptance: contract tests that reject wording or metadata that forces a later user turn after one active read **or after an inferred elapsed-time budget**; behavior tests preserving the wait/cooldown bounds; and live candidate proof for per-call pacing plus the recovery mechanism affected by the change. For managed jobs, use a fixture whose first phase remains unchanged longer than the hosted default: the first parameter-omitting `read_job` must remain inside one MCP call for the advertised server-side long-poll interval, report `bounded_followup`/no handoff and the corresponding wait metadata rather than return an immediate checkpoint, and a second `read_job` in the **same assistant response** must then be accepted and reach further progress or terminal state. A fixed-duration >100-minute live soak is not a universal candidate-acceptance gate. Exercise aggregate recovery with bounded evidence tied to the changed failure mode instead: preserve the same job identifier across any real response/tool or daemon/relay boundary that occurs during the probe, and prove subsequent recovery after representative helper-tool churn when that boundary is part of the change under test. Response-count arithmetic alone does not prove cross-boundary recovery. When process-session semantics change, the live proof must analogously observe `paced_followup` and prove a repeated would-block read is server-paced inside the cooldown rather than returned immediately, while retaining the one-second actual blocking cap.

Verification carriers are not test verdicts. Do not wrap a multi-stage real-host, lifecycle, fault-injection, install, or full verification whose credible worst-case duration exceeds the carrier budget in a shorter `exec_command`/`run_process` timeout and then classify the carrier's SIGTERM as a product failure. Split independently terminal phases into `start_job` steps, choose each step timeout from the suite's documented or observed upper bound with settlement margin, and follow the durable job. A carrier timeout is evidence that the chosen orchestration budget was too small unless the child suite itself had already reported its own timeout/failure condition.

Hosted tool descriptions can exist in several independent host-owned layers, not merely in Machine Bridge documentation. A release that changes tool semantics or descriptions must make freshness observable and must verify more than the daemon backend after activation. Current MCP 2026-07-28 remote discovery must advertise `tools.listChanged=true`, and a client subscription for `toolsListChanged` must receive the supported-subset acknowledgement plus `notifications/tools/list_changed` so it can re-fetch `tools/list`; initialization-era 2025 compatibility retains `listChanged=false`. When ChatGPT workspace governance freezes an approved action snapshot, that **Workspace Action control snapshot** is the product-level publication evidence: automation may perform the supported refresh/review path without a separate approval, then requires the expected action count and current generation/semantics there. Separately require the live `server_info` generation/version/TTL contract and harmless invocation-validator or behavior probes that reach the activated runtime. Opaque ChatGPT-internal cache inspection is intentionally outside the release process: do not query or compare internal host cache generations as release evidence and do not use them to trigger reconnect, recreation, republication, or other product remediation. A product-level schema blocker requires the governed Workspace approved snapshot itself to remain stale, partial, or mixed after the supported refresh/review path, or an actual invocation-validator/behavior probe to contradict the current runtime contract. Versioned runtime results alone still do not prove product publication.

ChatGPT host-control-plane UI is not a separate conversational authorization boundary from Machine Bridge runtime verification. Automation may inspect and operate the supported Apps/Plugins/admin refresh/review flow when a governed Workspace Action control snapshot is a genuine release or diagnosis dependency. Prefer passive existing MCP discovery and harmless invocation-validator probes first, use in-place refresh/review before recreation or republication, preserve existing app identity where possible, verify settlement after each mutation, and never replay an unknown-outcome UI mutation blindly. Host-internal cache inspection must not be introduced as an alternate release-diagnosis path.

The beta.104/beta.106 sequence is the canonical regression for this invariant. Beta.104 correctly identified a real same-turn polling amplifier, but it over-corrected with a one-checkpoint-per-assistant-response policy that forced the owner to repeatedly send `继续`. Beta.106 restored same-turn autonomy but initially left durable `read_job` as an immediate checkpoint, so autonomy could again become a high-density host tool loop. Future anti-busy-loop work must solve both failure modes at once: wait/pacing belongs inside Machine Bridge while user interaction never becomes the scheduler tick.

### Local GitHub control plane

Before any GitHub read or mutation, repository automation must load the effective project instructions through Machine Bridge. It must then use local `git`, `gh`, and `gh api` commands executed through Machine Bridge for every GitHub read or mutation. A hosted GitHub connector, ChatGPT GitHub plugin, browser-side GitHub integration, or second remote control plane must not be used. If Machine Bridge or the local authenticated CLI is unavailable, the operation stops and reports that boundary rather than falling back. Mixing control planes can produce stale refs, unreviewed remote-only commits, ambiguous credentials, and recovery paths that cannot be reproduced from the maintainer's machine. Fetch before mutation and verify the remote result afterward.

## 2. Commits and pull requests

Commit and squash-merge subjects follow Conventional Commits:

```text
<type>[optional scope][optional !]: <imperative description>
```

Allowed types are `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `security`, `release`, and `revert`. `feat` and `fix` carry their normal semantic-version meaning. A breaking change uses `!` and explains upgrade impact in the body or a `BREAKING CHANGE:` footer.

A good change explains both **what changed and why**. Commits should be logically coherent, but intermediate branch history may be amended because the final pull request is squash-merged. Pull-request titles must satisfy the same format because they become the `main` commit subject.

Pull requests must state:

- the problem and causal mechanism;
- the chosen solution and important rejected alternatives;
- user-visible, compatibility, security, privacy, and operational risk;
- tests and manual verification performed;
- documentation, release, and rollback consequences.

Keep a pull request small enough to review as one argument. Generated files, mechanical renames, or dependency lockfile changes should be isolated when they obscure substantive behavior. Large changes should be split by a stable contract, not into dependent fragments that cannot be evaluated independently.

## 3. Architecture and dependency direction

The architectural dependency direction in [ENGINEERING.md](ENGINEERING.md) is normative. In addition:

- A module owns one coherent reason to change. Related state-machine transitions may stay together when ordering is part of the safety argument.
- Domain modules do not import CLI, transport, service, presentation, or deployment adapters.
- Cross-layer calls go through an explicit interface or orchestration boundary; no adapter reaches through another layer to mutate its internals.
- Policy, schemas, error codes, protocol metadata, and capability inventories have one authoritative source. Adapters translate them but do not maintain parallel copies.
- Side effects are isolated behind small interfaces so policy and lifecycle behavior can be tested deterministically.
- Dependency cycles are prohibited. Hidden global state and import-time operational side effects are avoided.
- Line-count and complexity thresholds are diagnostic guardrails, not design goals. A threshold may not be satisfied by moving incoherent code into a generic utility module.
- **High cohesion and low coupling:** one source file or function owns one coherent responsibility and reason to change; collaboration occurs through narrow explicit contracts rather than cross-layer reach-through.
- **KISS:** prefer the simplest explicit implementation that satisfies current requirements. Do not introduce factories, registries, inheritance, generic frameworks, or configuration layers without an observed variation that needs them.
- **DRY:** extract repeated business rules, validation, security boundaries, or lifecycle logic into one authoritative implementation. Do not merge merely similar code when its semantics or failure policy differ.
- **Exact key membership:** external string keys used for dispatch, enums, ACLs, forms, or registries use `Map`, `Set`, `Object.hasOwn`, or null-prototype records. Prototype-chain membership and truthy ordinary-object lookup are not contract validation.
- Design patterns are used only when they remove an observed variation or coupling. A direct function or small module is preferred over speculative abstractions.

Any deliberate boundary exception must document the dependency, reason, owner, test coverage, and removal condition.

## 4. Public contracts and generated documentation

The MCP tool catalog in `src/shared/tool-catalog.json` is the authoritative base API description for names, daemon availability, annotations, and local/stdio JSON input schemas. The authenticated Worker may deliberately narrow or extend hosted schemas at that boundary; those projections must live in focused Worker helpers, be covered by actual `tools/list`/validator tests, and be documented as hosted-only requirements rather than copied back into the local base schema. The base catalog is rendered into [TOOL_REFERENCE.md](TOOL_REFERENCE.md); CI rejects stale generated documentation.

Swagger/OpenAPI is required only if the project later exposes a user-facing HTTP REST API. It is not a substitute for MCP tool schemas or end-to-end MCP protocol tests. Hand-maintained copies of generated contracts are prohibited.

A public contract change must address:

- backward and forward compatibility;
- bounded input and output behavior;
- authorization and destructive-operation annotations;
- stable error classification;
- protocol negotiation or versioning when peers may differ;
- documentation, tests, changelog, and semantic-version impact.

## 5. Testing and quality gates

Tests follow risk rather than a repository-wide aggregate percentage:

- Every defect fix includes a regression test that fails for the original causal reason.
- Pure policy and normalization logic is tested directly; adapters receive integration coverage proving that they use the policy correctly.
- Permission expansion includes denial tests. Bounded resources include over-limit tests. Multi-stage mutations include partial-failure and rollback tests.
- Concurrency, locking, process trees, persistence, cancellation, retry, and recovery require behavior-level or fault-injection coverage.
- Protocol changes include producer-consumer contract tests and malformed-input tests.
- Hosted-runtime boundaries such as deployed Durable Object persistence, edge request cancellation, browser integration, and provider lifecycle receive deployed/live canaries when local workerd, emulators, or OS fakes cannot prove equivalent semantics. OAuth/token persistence changes require deployed authorization-code exchange, access/refresh persistence, one authenticated MCP request, and refresh rotation before acceptance.
- Supported operating systems run the required suite in CI.
- Critical modules have explicit function and branch baselines. Thresholds may rise after better tests or extraction; lowering one requires an audit note explaining why the old measurement was misleading.
- High-risk JavaScript contract modules opt into strict TypeScript checking through `tsconfig.local.json`; implicit `any`, `@ts-ignore`, and untyped duplicate protocol/configuration shapes are not acceptable substitutes for a defined boundary.

An 80% aggregate coverage target is not a repository requirement: it can hide untested critical branches behind trivial files. New or materially changed pure business modules should normally achieve at least 80% function coverage and meaningful branch coverage, but risk-specific tests remain the acceptance criterion.

Flaky tests are defects. A retry may diagnose environmental instability but may not be used to make a nondeterministic test appear healthy.

## 6. Errors, retries, and logs

- Expected operational failures use typed stable error codes and concise operator messages.
- Unexpected programming errors remain distinguishable from ordinary unavailability.
- Request boundaries normalize errors once. Lower layers preserve causes and do not repeatedly translate them.
- Cleanup catches may be best effort only when the primary failure is retained and cleanup failure is observable where useful.
- Empty catches and catch-and-continue behavior are prohibited unless a comment explains why the event is intentionally irrelevant.
- Retries require positive transient classification, bounded attempts, backoff, and idempotency or authoritative state reconciliation.
- Unhandled process-level exceptions are logged with redaction and cause controlled termination; continuing in an unknown state is not a recovery strategy.
- Operational logs follow [LOGGING.md](LOGGING.md), remain structured, bounded, actionable, and free of secrets or user content.

## 7. Security and software supply chain

- GitHub workflow permissions default to read-only and are expanded per job only when required.
- Third-party Actions are pinned to immutable commit SHAs and reviewed when Dependabot updates them. GitHub Action updates are grouped into one atomic pull request so coupled suites such as CodeQL cannot be split across incompatible versions.
- npm dependencies use exact versions and a committed lockfile. Source bootstrap uses `npm ci`; the CI npm baseline itself is downloaded from an exact URL and verified against a pinned SHA-512 SRI before use. Registry signatures and attestations are verified in CI.
- Dependency review blocks newly introduced vulnerable dependencies. CodeQL performs JavaScript/TypeScript and workflow analysis. OpenSSF Scorecard audits supply-chain posture, and both SARIF streams are failing gates with exact, expiring exceptions rather than advisory-only uploads.
- CI generates and validates a CycloneDX SBOM. Release artifacts must match the repository-owner-tested tarball hash, be reproducible from a reviewed commit, and be tied to successful exact-commit CI, CodeQL, Governance, Workflow Policy Gate, and Scorecard evidence.
- Secret scanning and push protection are enabled. Repository examples use synthetic identities and reserved domains; reachable history is scanned before release.
- Long-lived publication tokens should be replaced by npm trusted publishing with GitHub OIDC. Until that external registry configuration is completed, release credentials remain an explicit operator responsibility and must never be stored in the repository.
- Security reports follow [SECURITY.md](../SECURITY.md), not public issue templates.

## 8. Documentation and comments

- README covers supported setup, operation, major capabilities, limitations, and risk.
- Architecture, security, testing, operations, logging, policy, upgrade, support, governance, and release documents each own their designated concern; avoid repeating whole procedures across files.
- Documentation claims a guarantee only when code, configuration, or a test enforces it.
- Public behavior changes update the changelog and relevant user documentation in the same pull request.
- Comments explain non-obvious **why**, invariants, external constraints, and safety ordering. They do not narrate self-explanatory syntax.
- Temporary workarounds state the triggering condition and removal criterion; use an issue reference when one exists.

## 9. Review and ownership

`CODEOWNERS` identifies responsible areas and requests informed review. It does not prove independent review when author and owner are the same person.

Review examines correctness, causal completeness, security/privacy boundaries, compatibility, failure paths, observability, test evidence, and maintainability. Style preferences do not override a simpler correct design without a documented project rule.

This repository currently has one human maintainer. Requiring one independent approval would deadlock maintenance and therefore is not enabled. [GOVERNANCE.md](../GOVERNANCE.md) defines admission, succession, release authority, and the first mandatory control after another active maintainer is added: one non-author approval plus last-push approval for security-sensitive, release, policy, Worker, browser, state, and execution changes.

## 10. Exceptions and evolution

A standard may be changed when evidence shows that it creates more risk or cost than it removes. The change must update this document, relevant automation, and the changelog together. Silent exceptions and permanently waived failing checks are prohibited.
