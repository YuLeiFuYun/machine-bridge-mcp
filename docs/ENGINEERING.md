# Engineering principles and maintenance rules

This document records project-wide decisions that must survive individual fixes, releases, and maintainers. It is normative for repository changes together with [PROJECT_STANDARDS.md](PROJECT_STANDARDS.md). Machine-specific observations belong in the ignored `.project-local/` directory instead.

## Product and security invariants

1. **The default profile is intentionally `full`.** This is an explicit product-owner decision prioritizing usability. It must not be changed to a narrower default as an incidental security cleanup. Documentation must continue to explain the authority and risks clearly.
2. **Named profiles are canonical contracts.** A state labelled `full`, `agent`, `edit`, or `review` must match the complete capability set for that name. Per-capability overrides produce `custom` rather than a misleading named profile.
3. **Machine Bridge authority and host authority are separate.** `full` removes Machine Bridge's own policy, path, shell, and environment restrictions. It cannot override an MCP host, connector gateway, operating system, endpoint-security product, cloud IAM, remote authentication, or `sudo`.
4. **Publication surfaces contain no real environment metadata.** Source, tests, fixtures, examples, release notes, filenames, package contents, tags, and release assets use synthetic identifiers and reserved example domains.
5. **Secrets are never operational log data.** Tool arguments, command text, stdin, stdout, stderr, file content, OAuth bodies, credentials, and local resource values are not logged.
6. **A release is one version with successful cross-platform evidence.** Package metadata, Worker version, browser-extension version/name, Git tag, GitHub Release, npm version, documentation, and deployed health version must agree, and the exact `origin/main` commit must have completed successful push-triggered CI, CodeQL, Governance, and OpenSSF Scorecard runs before a tag or release is created.
7. **Generic local automation is structured, not arbitrary evaluation.** Browser/application features may expose broad user authority under canonical `full`, but must not accept caller-provided JavaScript, AppleScript, JXA, or extension code.
8. **Daily-browser integration uses the existing profile.** The supported primary browser path is the packaged authenticated extension and machine-level loopback broker, preserving current tabs/login state; a separate automation profile is not an equivalent replacement.
9. **Pairing and resource secrets are not conversation or log data.** Tokens and injected local-resource values must not be returned, embedded in URLs, or written to operational logs.
10. **Exclusive claims are complete before visible.** Never create a final lock/PID claim and then populate it. Use the shared exclusive-file primitive, ownership tokens, process-start identity, and snapshot-checked reclamation.
11. **Service and state removal are fail-closed state machines.** Stop the platform provider and every verified daemon before removing definitions or recursive state. An unreadable lock, failed stop, active job, or ambiguous identity retains state for diagnosis.
12. **Read failure is not empty state.** Permission, type, symbolic-link, size, encoding, and I/O errors must propagate. Corrupt backup/reconstruction applies only after a successful read proves that JSON content is invalid.
13. **The public protocol contract is current-only.** Shared metadata advertises only the current MCP protocol version. Compatibility code for obsolete protocol dates, lock formats, or state schemas is not retained in the final runtime; upgrade safety comes from explicit version negotiation, fail-closed state validation, and bounded operator convergence.
14. **Security analysis is a failing gate.** CodeQL or Scorecard execution alone is not success. Generated SARIF must contain no unaccepted result, and missing rule metadata fails closed rather than being interpreted as non-security. An intentional or externally constrained finding requires an exact rule/path record with a substantive rationale and an expiry date.
15. **Ambiguous health is not permission to repeat a remote write.** A successful Wrangler deployment is recorded before secondary health verification. Timeout, proxy, TLS, network, and temporary service failures preserve the deployment fingerprint and fail for diagnosis; only bounded evidence of a stale identity/version permits automatic same-name redeployment. Changing the Worker name is an explicit remote-resource transition, not a retry strategy.

A proposed change that conflicts with an invariant requires an explicit owner decision and corresponding documentation update. It must not be hidden inside an unrelated refactor.

## Change and release-operation ownership

Repository source release completion and live release operations are separate responsibilities. Under the standing repository contract in `AGENTS.md`, coding automation may edit source, tests, documentation, package metadata, and changelog entries; run repository-local checks; commit and push; complete the reviewed pull request through local `git`/`gh`; and create the annotated version tag plus final GitHub Release only after the exact `main` commit passes push-triggered CI. It must not publish, deprecate, or unpublish npm packages; install the package globally; deploy or reconfigure a Cloudflare Worker; rotate credentials; mutate live deployment state; or start/stop/install/remove the daemon or autostart service without explicit user authorization.

The normal handoff is: the repository owner publishes the reviewed npm version, then runs `npm install -g --omit=optional --allow-scripts=esbuild,workerd,sharp,fsevents machine-bridge-mcp@latest && machine-mcp`. The npm command updates the global CLI but cannot hot-reload an existing Node process. The subsequent normal foreground startup validates the Worker deployment hash, expected version, and health, requests shutdown of an active autostart daemon, waits a bounded interval for its lock, redeploys when necessary, and then takes over with the installed version. Live operations require explicit authorization even when they appear to be the obvious next release step.

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
- State transitions are explicit; readiness is not inferred from a lower-level event. For example, an open WebSocket is not an authenticated relay until `hello_ack` is received.
- Every externally controlled input is bounded before expensive allocation, traversal, parsing, storage, or execution.
- Externally controlled string keys must not use prototype-chain membership or truthiness on ordinary objects. Use `Map`, `Set`, `Object.hasOwn`, or null-prototype records for command dispatch, enums, ACLs, form fields, registries, and other key-addressed contracts.
- Repository text must not contain invisible ASCII controls other than tab, CR, and LF; architecture tests enforce this even when JavaScript syntax remains valid.
- Persistent mutations use owner-only files, bounded no-follow reads, flushed atomic replacement, and integrity checks appropriate to the data.
- Exclusive locks use the shared complete-before-visible hard-link claim. Reclamation requires process identity plus a matching file snapshot/token; do not unlink a path merely because an earlier read looked stale.
- Service providers normalize success/failure to one result contract. Definition removal follows the shared platform-stop → verified-daemon-stop → remove order.
- Retry is limited to classified transient failures. Authentication, authorization, validation, integrity, and policy errors fail immediately.
- Cleanup-only catches may be best effort, but primary failures must not be silently discarded.
- New work should not increase an already broad orchestration module when the behavior has an independent lifecycle or test surface. Extract the domain first.

`runtime.mjs` owns local tool semantics. `relay-connection.mjs` owns authenticated relay connection lifecycle. The CLI orchestrates them; it must not become the second implementation of either.

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
- dependency audit, registry signatures/attestations, SBOM, and Worker dry run.

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
