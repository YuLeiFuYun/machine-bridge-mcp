# Engineering principles and maintenance rules

This document records project-wide decisions that must survive individual fixes, releases, and maintainers. It is normative for repository changes together with [PROJECT_STANDARDS.md](PROJECT_STANDARDS.md). Machine-specific observations belong in the ignored `.project-local/` directory instead.

## Product and security invariants

1. **The default profile is intentionally `full`.** This is an explicit product-owner decision prioritizing usability. It must not be changed to a narrower default as an incidental security cleanup. Documentation must continue to explain the authority and risks clearly.
2. **Named profiles are canonical contracts.** A state labelled `full`, `agent`, `edit`, or `review` must match the complete capability set for that name. Per-capability overrides produce `custom` rather than a misleading named profile.
3. **Machine Bridge authority and host authority are separate.** `full` removes Machine Bridge's own policy, path, shell, and environment restrictions. It cannot override an MCP host, connector gateway, operating system, endpoint-security product, cloud IAM, remote authentication, or `sudo`.
4. **Publication surfaces contain no real environment metadata.** Source, tests, fixtures, examples, release notes, filenames, package contents, tags, and release assets use synthetic identifiers and reserved example domains.
5. **Secrets are never operational log data.** Tool arguments, command text, stdin, stdout, stderr, file content, OAuth bodies, credentials, and local resource values are not logged.
6. **Stable release requires a published prerelease soak.** The owner runs one exact persistent candidate activation command; the coding agent verifies the real Worker and daemon before recording acceptance. Version 3 and later use `dev`, `beta`, or `rc`, publish under non-`latest` tags, and complete the policy minimum soak after registry-verified activation. Stable promotion may change only normalized release metadata and requires an identical promotion-content digest, a tracked soak record, repeated stable-candidate verification, and successful exact-commit CI, CodeQL, Governance, and Scorecard.
7. **Generic local automation is structured, not arbitrary evaluation.** Browser/application features may expose broad user authority under canonical `full`, but must not accept caller-provided JavaScript, AppleScript, JXA, or extension code.
8. **Daily-browser integration uses the existing profile.** The supported primary browser path is the packaged authenticated extension and machine-level loopback broker, preserving current tabs/login state; a separate automation profile is not an equivalent replacement.
9. **Pairing and resource secrets are not conversation or log data.** Tokens and injected local-resource values must not be returned, embedded in URLs, or written to operational logs.
10. **Exclusive claims are complete before visible.** Never create a final lock/PID claim and then populate it. Use the shared exclusive-file primitive, ownership tokens, process-start identity, and snapshot-checked reclamation.
11. **Service and state removal are fail-closed state machines.** Stop the platform provider and every verified daemon before removing definitions or recursive state. An unreadable lock, failed stop, active job, or ambiguous identity retains state for diagnosis.
12. **Read failure is not empty state.** Permission, type, symbolic-link, size, encoding, and I/O errors must propagate. Corrupt backup/reconstruction applies only after a successful read proves that JSON content is invalid.
13. **Protocol eras are explicit and non-overlapping.** Shared metadata advertises modern MCP `2026-07-28` as primary and legacy `2025-11-25` only through a named compatibility adapter. Per-request modern metadata must never enter the legacy session/replay machinery, and legacy state must never be inferred for a modern request. Other obsolete protocol dates, lock formats, and state schemas are not retained.
14. **Security analysis is a failing gate.** CodeQL or Scorecard execution alone is not success. Generated SARIF must contain no unaccepted result, and missing rule metadata fails closed rather than being interpreted as non-security. An intentional or externally constrained finding requires an exact rule/path record with a substantive rationale and an expiry date.
15. **Ambiguous health is not permission to repeat a remote write.** A successful Wrangler deployment is recorded before secondary health verification. Timeout, proxy, TLS, network, and temporary service failures preserve the deployment fingerprint and fail for diagnosis; only bounded evidence of a stale identity/version permits ordinary automatic same-name redeployment. During owner-authorized candidate activation, an explicit cryptographic device-authentication rejection after current-version health is separate positive evidence that deployment secrets did not converge; it permits one same-name redeployment with the unchanged selected identity, never rotation or resource renaming. Changing the Worker name remains an explicit remote-resource transition, not a retry strategy.
16. **Execution continuity and delivery continuity are separate proof obligations.** Legacy transport-surviving work requires authenticated recovery or a durable handle, and fresh requests must remain separate from replay. Modern request-scoped HTTP work instead treats stream closure as cancellation and must not silently continue or enter the legacy replay store.
17. **Remote compound commands are not persistence evidence.** When a remote edit and a long test share one relay call, a transport interruption can obscure whether the edit completed. High-impact writes must be followed by an independent read of stable anchors or a Git diff before tests and conclusions rely on them.
18. **Durable state owners do not retain cross-event terminal Promises or depend on JavaScript timers as durable ownership.** Legacy recoverable stream initiation validates the call, then transactionally persists stream and daemon-call ownership before dispatch; later events converge through one guarded terminal write, with alarms and event-entry sweeps owning deadlines. Its descriptor and hibernatable subscription paths are internal-only. Modern streams are different: one Durable Object fetch owns the direct response, the outer Worker keeps it observable with bounded SSE comments, and a random private capability indexes only the already-active pending call. Public control headers are stripped, cancellation carries no OAuth/DPoP credential, and modern code must never add prepare/subscribe descriptors, terminal-result retention, or a cross-event Promise registry.
19. **Validation cost is part of the input contract.** Schema compilation and runtime validation have independent depth/node/pattern/issue/work budgets. Every traversed array item and own object property consumes work before recursive validation; code must not allocate an unbounded key/value inventory and only then check limits.
20. **A pending release candidate is valid only against the current packaged source.** Candidate start/activation must compare package identity and promotion digest before tarball verification, installation, deployment, or service mutation. Tarball-to-manifest integrity alone is insufficient after later edits.
21. **GitHub publication requires an explicit owner-terminal ceremony and one process owner.** Candidate activation, acceptance, merge, and green CI are evidence, not standing permission to create a tag or Release. Publication must present real TTY streams plus the explicit confirmation flag and hold the repository publication lock through tag/Release synchronization. Background agents and managed jobs may verify state but may not publish. This is a workflow safeguard against accidental or ordinary non-interactive publication, not cryptographic human-presence proof against arbitrary code already running as the same OS user.
22. **Capability routing advises; effective policy authorizes.** The resolver may shortlist tool sets, report ambiguity, and suggest fallbacks, but it must neither hide an allowed escape hatch nor recommend a tool outside the request's effective account/daemon intersection. Canonical full continues to expose direct Bash. A routing fallback is not a safety-policy bypass.
23. **Capability fingerprints reduce repetition, not freshness checks.** A matching client-supplied fingerprint may omit unchanged static instructions, but task-specific ranking, application discovery, and route computation must still run. The fingerprint is not conversation identity, authorization, or a cached execution result.

A proposed change that conflicts with an invariant requires an explicit owner decision and corresponding documentation update. It must not be hidden inside an unrelated refactor.

## Change and release-operation ownership

Repository implementation, candidate preparation, observed live verification, acceptance recording, and source pull requests are distinct from owner-operated live activation, GitHub tag/Release publication, and npm publication.

For each package change, automation prepares the exact prerelease tarball and stops. The owner executes `npm run release:candidate:activate -- --allow-worker-deploy`. After that command updates the Worker, verifies candidate relay readiness, replaces the login daemon, and verifies service handoff, the coding agent inspects the connected system through Machine Bridge. Only then may it record candidate acceptance and push through `npm run github:push`.

After merge and exact-commit checks, automation may prepare and verify the release state, but GitHub tag/Release publication is an explicit owner-terminal operation: `npm run prerelease:release -- --owner-terminal-confirm`. The command rejects background jobs, MCP calls, CI, redirected sessions, and concurrent publication. The owner separately publishes npm with `npm run prerelease:publish` and activates the registry package with `npm run prerelease:install -- --allow-worker-deploy`. The owner uses the prerelease for the required interval and explicitly reports whether blocking issues remain. Automation must not infer soak success from elapsed time.

Stable promotion is content-preserving. `release:soak:verify` compares the packaged functional digest with the accepted prerelease. A mismatch requires another prerelease and a restarted soak. After stable candidate activation and observed verification, the owner creates the final GitHub tag and Release from an interactive terminal with `npm run release -- --owner-terminal-confirm`; the owner separately authorizes `npm run stable:publish`.

GitHub/npm publication, global installation, Worker/service replacement, credential mutation, and unrelated live-state changes remain explicit owner decisions. GitHub release commands never push `main`.

## Default instruction invariant

A new installation must provide useful, conservative agent working agreements without requiring the user to create instruction files. The default context is generated in memory, is bounded and inspectable, writes no home/repository files, exposes no package-script bodies or source contents, and remains lower precedence than explicit user/repository guidance. Repository configuration cannot disable user-global baseline controls. Instructions remain behavioral guidance; hard restrictions belong to policy, permissions, approvals, hooks, or external isolation.

## Architectural boundaries

The preferred dependency direction is:

```text
shared metadata and pure policy
        |
local runtime domain modules        Worker domain modules
        |                                  |
stdio adapter / relay connection     HTTP + OAuth + WebSocket adapter
        |                                  |
CLI, service, release, and deployment orchestration
```

Rules:

- Transport lifecycle, domain execution, persistence, and presentation are separate modules.
- Domain modules must not import CLI, service, stdio, or relay adapters. Architecture tests enforce this dependency direction for agent context, package metadata, default instructions, capability observation, application automation, process sessions, and proxy selection.
- Pure classification and normalization functions are exported and tested directly when practical.
- Adapters may translate data but should not duplicate policy or schemas.
- Every protocol control message emitted by one side must be explicitly accepted, rejected, or version-gated by the other side, with an end-to-end contract test covering the message name and semantics.
- State transitions are explicit; readiness is not inferred from a lower-level event. An open WebSocket is not authenticated until `hello_ack`, and authenticated transport is not service readiness until an end-to-end result probe has returned on the same relay session. Pre-ready work and premature readiness acknowledgements fail closed.
- Every externally controlled input is bounded before expensive allocation, traversal, parsing, storage, or execution. A byte limit constrains bytes actually consumed and duration work, not only the subset retained in memory; once a declared or observed bound is crossed, cancel or close the source immediately.
- Externally controlled string keys must not use prototype-chain membership or truthiness on ordinary objects. Use `Map`, `Set`, `Object.hasOwn`, or null-prototype records for command dispatch, enums, ACLs, form fields, registries, and other key-addressed contracts.
- Repository text must not contain invisible ASCII controls other than tab, CR, and LF; architecture tests enforce this even when JavaScript syntax remains valid.
- Persistent mutations use owner-only files, bounded no-follow reads, flushed atomic replacement, and integrity checks appropriate to the data.
- A transport-surviving operation exposes either authenticated replay or a durable inspection handle. A response stream alone is not durable delivery.
- After a remote mutation, inspect the persisted file/Git anchors in a separate call before treating a subsequent test as evidence for that exact change.
- Exclusive locks use the shared complete-before-visible hard-link claim. Reclamation requires process identity plus a matching file snapshot/token; do not unlink a path merely because an earlier read looked stale.
- Service providers normalize success/failure to one result contract. Definition removal follows the shared platform-stop → verified-daemon-stop → remove order.
- Retry is limited to classified transient failures. Authentication, authorization, validation, integrity, and policy errors fail immediately.
- Cleanup-only catches may be best effort, but primary failures must not be silently discarded. Rollback of newly created credentials, keys, or other sensitive artifacts is part of the primary integrity result: incomplete rollback must be reported explicitly after attempting every cleanup target.
- New work should not increase an already broad orchestration module when the behavior has an independent lifecycle or test surface. Extract the domain first.

`runtime.mjs` owns local tool semantics. `relay-connection.mjs` owns authenticated relay connection lifecycle. The CLI orchestrates them; it must not become the second implementation of either.

## MCP and tool-schema contract

MCP protocol-era selection is an adapter concern. Domain execution must not depend on connection history, an HTTP socket, or a process as conversation identity. Modern requests are interpreted solely from their per-request metadata; legacy session state must stay in legacy modules and may not leak into modern request keys, cancellation, caching, or result framing.

The shared tool catalog is executable schema:

- absent `$schema` means JSON Schema 2020-12;
- only the explicitly implemented bounded keyword set may be used;
- unsupported dialects/keywords fail process/module initialization rather than being ignored;
- external `$ref` values are rejected and never fetched;
- schema depth, total nodes, regular-expression length, and returned issue count are bounded;
- Worker validation occurs before daemon dispatch, and local validation remains defense in depth for every transport;
- validation errors contain paths and constraints, never argument values;
- a schema or validation change requires direct validator tests plus Worker and stdio integration when observable protocol behavior changes.

`structuredContent` is arbitrary JSON, not object-only. Code must distinguish absence from the valid value `null`; truthiness is not a presence check for structured protocol fields.

## Logging contract

Operational logs are a user interface, not a dump of protocol events.

### Default-level rules

- Describe user-relevant state and automatic remediation in plain language.
- Prefer state transitions and recovery summaries over event pairs.
- Suppress brief self-healing transport interruptions from `info` and `warn`.
- Escalate a connection outage only after it remains unresolved for the configured grace period.
- Rate-limit repeated degradation warnings and emit one recovery summary after a visible outage.
- Do not expose WebSocket close codes, empty reason strings, stack traces, raw URLs with credentials, or internal identifiers at default levels.
- Include fields only when they help a user decide what happened or what to do next.

### Level meanings

- `error`: the requested operation or long-lived service cannot continue without intervention.
- `warn`: persistent degradation, rejected protocol data, supersession, or a service problem requiring attention.
- `info`: successful startup, authenticated readiness, deployment, and recovery from a previously visible degradation.
- `debug`: raw transport codes/reasons, retry timing, correlation identifiers, per-tool outcomes, and implementation diagnostics.

A warning must answer at least one of these questions: what is degraded, whether recovery is automatic, and what action is required if recovery fails.

### Review test

Before adding a default-level log, ask:

1. Is this a user-visible state change rather than an implementation callback?
2. Is the severity correct if the system recovers automatically within seconds?
3. Is every field understandable without consulting a protocol specification?
4. Could the message reveal a path, identity, command, content, or credential?
5. Will this line remain useful if the event repeats one hundred times?

See [LOGGING.md](LOGGING.md) for the concrete event policy.

## Complexity and state-machine exceptions

Mechanical routing, option validation, and output formatting should be table-driven or split into named handlers. Catalog-to-handler parity must be executable, not inferred from a switch statement.

A higher branch count is acceptable only when the function is an explicit state machine whose ordering is part of the safety argument, such as patch parsing, detached job execution, or recovery reconciliation. Such functions require focused transition and failure-path tests. Do not fragment them merely to satisfy a numeric complexity threshold; do not use this exception for ordinary command dispatch or mixed responsibilities.

## Error handling and resilience

- Preserve a stable coarse error class for automation and a concise human message for operators.
- Do not retry an operation merely because it failed; retry only when the error is positively classified as transient and the operation is idempotent or server state is checked after ambiguity.
- When a remote write may have succeeded before the response was lost, query authoritative state before repeating it. When the write itself returned success but a later verification read failed, persist the successful write evidence before returning the verification error.
- Duration-based deadlines must use a monotonic clock. Wall time remains appropriate for persisted timestamps, credential expiry, retention, and operator-visible dates, but a system clock correction must not extend or prematurely terminate an in-process wait.
- Timeouts must terminate the relevant process tree. Forced escalation must remain referenced until resistant descendants are handled; do not clear it merely because the direct child exited.
- Half-open connections need liveness detection, not only periodic writes.
- Lock reclamation must consider process liveness, process start time, absolute age, ownership token, and file identity to defend against PID reuse and replacement races.
- State/config recovery may classify only parse/root-shape failures as corrupt content. It must not convert read failures into a new empty state.
- A recovery path must be bounded and converge to a terminal state rather than retry forever.

## Testing rules

Every defect fix includes a regression test that fails for the original reason. Prefer two layers when applicable:

Prototype-shaped strings such as `constructor`, `__proto__`, `hasOwnProperty`, `toString`, and `valueOf` are mandatory negative or ordinary-data cases for any new externally indexed object boundary. Byte-bounded text tests must include non-ASCII input and assert the encoded result size, not only JavaScript string length.

1. a deterministic test of the extracted policy or lifecycle;
2. an integration test proving the adapter uses it correctly.

The required matrix includes:

- Linux, macOS, and Windows on the pinned Node/npm baseline;
- current-tree and reachable-history privacy gates, release-impact enforcement, and exact-commit CI/CodeQL/Governance/Scorecard release gating;
- package-manifest and sensitive-artifact inspection;
- generated Worker type checks plus strict opt-in checked-JavaScript contracts for high-risk local policy, lifecycle, configuration, path, protocol, and timing boundaries;
- recursively discovered JavaScript/shell syntax checks and static correctness lint over all production JavaScript, tests, scripts, and browser-extension code;
- a real packed-tarball isolated global installation whose zero-argument CLI startup initializes state and reaches a controlled external Worker-deployment boundary; `--version` or import-only smoke tests are insufficient release evidence;
- concurrent exclusive-lock/atomic-replacement tests, PID-reuse/age tests, and fail-closed service-lifecycle tests;
- real process-tree timeout/cancellation tests with descendants that ignore graceful termination;
- local runtime and real `full` acceptance tests;
- stdio JSON-RPC integration;
- Worker OAuth/WebSocket/MCP integration;
- managed-job integrity, recovery, cancellation, cleanup, and redaction;
- dependency audit, registry signatures/attestations, the first-party `sbom:test` CycloneDX identity/graph/privacy check, and Worker dry run.

Cross-platform tests must not depend on shell syntax, case-sensitive Windows paths, Unix-only executable shims, or timing races when a deterministic scheduler can be injected. Local success cannot substitute for the required Linux/macOS/Windows push CI result used by the release gate.

## Documentation rules

- README explains the supported user path and major risks.
- ARCHITECTURE describes boundaries, trust, and state machines.
- SECURITY states guarantees and explicit non-guarantees.
- LOGGING defines operator-facing event semantics.
- OPERATIONS contains diagnosis and recovery procedures.
- TESTING records executable coverage and regression expectations.
- UPGRADING defines the only supported state/protocol transition and rollback unit.
- SUPPORT defines supported runtimes, diagnostic requirements, and public/private reporting boundaries.
- GOVERNANCE defines accountable ownership, succession, review, and release authority.
- CHANGELOG records externally relevant changes, including documentation and workflow changes.
- PROJECT_STANDARDS defines collaboration, contract, testing, supply-chain, review, and exception policy.
- TOOL_REFERENCE is generated from the shared MCP tool catalog and must never be maintained by hand.

Documentation that claims a guarantee must identify the code or test enforcing it. Do not document an aspirational behavior as implemented.

## Public and local project knowledge

Reusable decisions, invariants, incident lessons, and review rules belong in tracked documentation. Hiding them in local notes causes repeated mistakes.

Use the ignored `.project-local/` directory only for machine-specific material such as:

- local package-manager or service layout;
- temporary release blockers and authentication state;
- private deployment identifiers;
- one-machine recovery steps;
- observations that still require validation before becoming a general rule.

Do not store passwords, tokens, private keys, authorization URLs, or copied secret-bearing logs there. Use `.privacy-denylist` for private vocabulary that the scanner should reject from publication surfaces.

When a local observation becomes generally true, move the sanitized lesson into tracked documentation and delete the stale local note.

The 0.12.0 cross-cutting audit and residual limits are recorded in [AUDIT.md](AUDIT.md).

## Review checklist

A thorough review asks:

- Can the module name and boundary be understood without historical context?
- Is there one authoritative implementation of each policy and schema?
- Are all success, failure, cancellation, timeout, disconnect, restart, and recovery branches bounded and tested?
- Are logs actionable, rate-limited, and privacy-preserving?
- Are persistent files atomic, owner-only, size-bounded, and symlink-aware?
- Can browser/app automation be expressed without arbitrary evaluation, and are pairing/resource values absent from results and logs?
- Can a stale PID, stale socket, duplicate request, partial write, or ambiguous remote response violate integrity?
- Are package, CI, Worker, service, and release behavior tested on every supported platform, and does publication verify every required exact-commit push workflow?
- Does the complete diff contain any real identifier, path, host, account, or credential-shaped value?
- Does the change require a new npm version and deployment?

The goal is not cleverness or minimum line count. The goal is explicit boundaries, small state machines, predictable failure behavior, and tests that make future regressions difficult.
