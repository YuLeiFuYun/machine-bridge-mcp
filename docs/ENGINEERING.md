# Engineering principles and maintenance rules

This document records project-wide decisions, collaboration rules, release-readiness standards, and security invariants that must survive individual fixes, releases, and maintainers. A rule is preferred only when it reduces material risk, makes review easier, or can be enforced consistently; ceremony without a credible failure mode is not a quality control. Machine-specific observations belong in the ignored `.project-local/` directory instead.

## Dependency save policy

Repository npm saves must preserve exact versions (`save-exact=true`). Root production, development, and optional dependencies are architecture-gated to exact semantic versions and installs remain lockfile-driven. Do not add a blanket `min-release-age` project setting: npm applies it as a version-availability filter and can therefore block a newly published security fix. Supply-chain freshness is handled by explicit reviewed upgrades plus lockfile, audit, signature/attestation, lifecycle-script, and consumer-package gates rather than by making recent versions globally ineligible.

## Product and security invariants

1. **The default profile is intentionally `full`.** This is an explicit product-owner decision prioritizing usability. It must not be changed to a narrower default as an incidental security cleanup. Documentation must continue to explain the authority and risks clearly.
2. **Named profiles are canonical contracts.** A state labelled `full`, `agent`, `edit`, or `review` must match the complete capability set for that name. Per-capability overrides produce `custom` rather than a misleading named profile.
3. **Machine Bridge authority and host authority are separate.** `full` removes Machine Bridge's own policy, path, shell, and environment restrictions. It cannot override an MCP host, connector gateway, operating system, endpoint-security product, cloud IAM, remote authentication, or `sudo`.
4. **Publication surfaces contain no real environment metadata.** Source, tests, fixtures, examples, release notes, filenames, package contents, tags, and release assets use synthetic identifiers and reserved example domains.
5. **Secrets are never operational log data.** Tool arguments, command text, stdin, stdout, stderr, file content, OAuth bodies, credentials, and local resource values are not logged.
6. **Stable release requires a published prerelease soak.** Repository automation runs one exact persistent candidate activation command; the coding agent verifies the real Worker and daemon before recording acceptance. Version 3 and later use `dev`, `beta`, or `rc`, publish under non-`latest` tags, and complete the policy minimum soak after registry-verified activation. Stable promotion may change only normalized release metadata and requires an identical promotion-content digest, a tracked soak record, repeated stable-candidate verification, and successful exact-commit CI, CodeQL, Governance, Workflow Policy Gate, and Scorecard.
7. **Generic local automation is structured, not arbitrary evaluation.** Browser/application features may expose broad user authority under canonical `full`, but must not accept caller-provided JavaScript, AppleScript, JXA, or extension code.
8. **Daily-browser integration uses the existing profile.** The supported primary browser path is the packaged authenticated extension and machine-level loopback broker, preserving current tabs/login state; a separate automation profile is not an equivalent replacement.
9. **Pairing and resource secrets are not conversation or log data.** Tokens and injected local-resource values must not be returned, embedded in URLs, or written to operational logs.
10. **Exclusive claims are complete before visible.** Never create a final lock/PID claim and then populate it. Use the shared exclusive-file primitive, ownership tokens, process-start identity, and snapshot-checked reclamation.
11. **Service and state removal are fail-closed state machines.** Stop the platform provider and every verified daemon before removing definitions or recursive state. An unreadable lock, failed stop, active job, or ambiguous identity retains state for diagnosis.
12. **Security, persistence, ownership, and reclamation read failure is not empty state.** Permission, type, symbolic-link, size, encoding, and I/O errors on evidence used to authorize, reclaim, delete, replace, or mutate state must propagate. Corrupt backup/reconstruction applies only after a successful read proves that JSON content is invalid. Documented read-only discovery may conservatively omit unavailable or unsupported optional metadata only when that omission cannot grant authority, justify reclamation/removal, or trigger a mutation.
13. **Stdio and native HTTP `/mcp` use MCP `2026-07-28`.** Both require current request-scoped metadata and reject `initialize`. The isolated `/mcp/gemini` endpoint supports the MCP `2025-11-25` handshake, tool listing and tool calls with a separate OAuth audience. All endpoints remain sessionless and reject replay markers. No option or environment variable can fill missing native metadata.
14. **Security analysis is a failing gate.** CodeQL or Scorecard execution alone is not success. Generated SARIF must contain no unaccepted result, and missing rule metadata fails closed rather than being interpreted as non-security. An intentional or externally constrained finding requires an exact rule/path record with a substantive rationale and an expiry date.
15. **Ambiguous health is not permission to repeat a remote write.** A successful cf deployment is recorded before secondary health verification. Timeout, proxy, TLS, network, and temporary service failures preserve the deployment fingerprint and fail for diagnosis; only bounded evidence of a stale identity/version permits ordinary automatic same-name redeployment. During guarded candidate activation, an explicit cryptographic device-authentication rejection after current-version health is separate positive evidence that deployment secrets did not converge; it permits one same-name redeployment with the unchanged selected identity, never rotation or resource renaming. Changing the Worker name remains an explicit remote-resource transition, not a retry strategy.
16. **Execution continuity and delivery continuity are separate proof obligations.** Current request-scoped HTTP work treats response-stream closure as cancellation and retains no replay record. Same-daemon relay reconnect may rebind an already-dispatched transient call only because the verified daemon still owns that execution; it must never create a client-visible replay/session identity. Work that must survive client delivery loss uses an explicit durable managed-job handle rather than transport replay.
17. **Remote compound commands are not persistence evidence.** When a remote edit and a long test share one relay call, a transport interruption can obscure whether the edit completed. High-impact writes must be followed by an independent read of stable anchors or a Git diff before tests and conclusions rely on them.
18. **MCP delivery state is request-scoped, not durable.** One Durable Object fetch owns the current response, the outer Worker keeps an open SSE response observable with bounded comments, and a random private capability indexes only the already-active transient pending call so public stream closure can request cancellation. Public control headers are stripped and private cancel controls carry no OAuth/DPoP credential. MCP code must not add prepare/subscribe delivery descriptors, terminal-result retention, session stores, recovery GETs, replay IDs, or cross-event terminal Promise registries. Durable execution belongs to the managed-job subsystem, whose persisted state machine and deadlines are independent of MCP transport delivery.
19. **Validation cost is part of the input contract.** Schema compilation and runtime validation have independent depth/node/pattern/issue/work budgets. Every traversed array item and own object property consumes work before recursive validation; code must not allocate an unbounded key/value inventory and only then check limits.
20. **A pending release candidate is valid only against the current packaged source.** Candidate start/activation must compare package identity and promotion digest before tarball verification, installation, deployment, or service mutation. Tarball-to-manifest integrity alone is insufficient after later edits.
21. **GitHub publication is standing-authorized but still serialized and evidence-gated.** Candidate activation, acceptance, merge, and green CI are release evidence; once the exact-commit, digest, remote-state, and publication-lock gates pass, repository automation may create the tag and GitHub Release without a separate conversational approval or `--owner-confirm` flag. One publication process must hold the common-Git-dir lock through tag/Release synchronization, and an agent must not race an operation the owner says they will execute themselves. npm package publication remains a separate authorization boundary.
22. **Capability routing advises; effective policy authorizes.** The resolver may shortlist tool sets, report ambiguity, and suggest fallbacks, but it must neither hide an allowed escape hatch nor recommend a tool outside the request's effective account/daemon intersection. Canonical full continues to expose direct Bash. A routing fallback is not a safety-policy bypass.
23. **Capability fingerprints reduce repetition, not freshness checks.** A matching client-supplied fingerprint may omit unchanged static instructions, but task-specific ranking, application discovery, and route computation must still run. The fingerprint is not conversation identity, authorization, or a cached execution result.
24. **Read-only fan-out may be concurrent only when observable order stays sequential.** Independent metadata/file reads may use a small bounded batch, but scheduling count and externally visible visited count are separate. Results and errors are consumed in canonical walk/enumeration order; work prefetched beyond an already-satisfied output/limit stop cannot retroactively fail the completed result. Cancellation is checked before scheduling and before consuming prefetched results.
25. **Hot read models have semantic output budgets.** A compact/summary projection is computed only after canonical state and authorization decisions. Tests bind required semantic fields, forbidden cold/private fields, absolute size ceilings, and high-cardinality growth behavior. Do not satisfy a size budget by deleting the authority/readiness/inventory facts that make the projection useful.
26. **Diagnose before changing semantics.** Production failures are classified from exact deployed identity plus privacy-bounded stage evidence before speculative behavior changes. Working notes distinguish observed fact, inference, falsified hypothesis, and unresolved external cause. A generic host error, successful compilation, or green local test is not root-cause evidence.
27. **Falsified fixes do not silently accumulate.** A live-disproved hypothesis patch is removed before the final candidate unless an independent invariant and regression test justify retaining it. Security or identity mutations such as password/token/device rotation, authentication weakening, state deletion, forced redeployment, or remote-resource renaming are never generic diagnostic resets.
28. **Hosted-runtime behavior requires hosted-runtime evidence.** Memory fakes and local Wrangler/workerd are necessary regression layers but do not prove deployed-edge storage, request-lifecycle, WebSocket, quota, proxy, or provider behavior. Changes in those domains require a bounded live canary or explicitly documented residual uncertainty before acceptance.
29. **Multi-record authority state commits through one explicit transaction boundary.** OAuth/account/authority mutations that must become visible together write each named record inside one Durable Object storage transaction and fail atomically. Do not reintroduce a convenience bulk-object `put()` at this security boundary merely because the local emulator accepts it; the transaction path is the production-proven contract and its failure stages remain low-cardinality diagnostics.
30. **Persistent-state size and cardinality are budgets, not implementation details.** Every high-cardinality map/queue has a hard count bound, a retention/pruning rule, and a serialized-size or row-budget regression where provider limits matter. Retry-only payload is compacted when its retry window ends; a nominal item-count cap is insufficient when one aggregated value can exceed the backend value limit. OAuth refresh consumed-token replay state therefore persists in 8 fixed hash shards with a 1024-record per-shard ceiling while the main refresh value retains active tokens and family tombstones only; all migration and mutation paths reconstruct the same in-memory state and commit main/shards atomically.
31. **Verification runs require an immutable source snapshot.** A test or release gate that observes a source hot reload, concurrent packaged-file edit, regenerated artifact, or changed candidate identity is invalid evidence even if most tasks passed. Finish writes first, then run the complete gate against the final tree; any later packaged-byte change requires a clean rerun and a new candidate.
32. **OAuth persistence is a deployed acceptance boundary.** Any change to OAuth grant handling, token storage, account/client trust, replay state, or Durable Object persistence must prove an authorization-code exchange, persisted access and refresh credentials, an authenticated MCP request, and successful refresh rotation against the deployed candidate before acceptance. Relevant TTL/soak survival is verified separately rather than inferred from the initial exchange.
33. **Computer Use mutation authority is snapshot-bound and one-shot.** `computer_act` may mutate only from the exact bounded snapshot produced by `computer_observe`; preflight is read-only, and the snapshot generation is atomically consumed before backend mutation handoff. Browser document/frame/ref/backend identity and application process/window identity are private authority evidence, not caller-selected parameters. A snapshot ID alone is not authorization and never bypasses ordinary role/policy checks.
34. **A PID or coercible scalar is never Computer Use authority.** Application snapshots bind PID to the exact public libproc process-birth generation and fail closed when that identity is unavailable or changes. Browser/application actions, coordinates, digests, window IDs/bounds, process generations, resource names, and settlement fields must retain their native producer type; arrays/objects that JavaScript could stringify or numerically coerce are malformed evidence, not alternate encodings.
35. **Ambiguous UI mutation is never replay evidence.** Once a browser mutation has been handed to the extension transport, or a fixed launch/JXA/native helper has started its process, timeout, cancellation, connection loss, malformed response, process error, or missing settlement cannot be treated as definite non-execution. The public result is non-retryable unknown/pending settlement and the caller inspects post-state or observes again. Pre-dispatch validation and pre-spawn failure remain distinct definite failures. Result-size compaction must preserve this settlement and a usable continuation handle where available; it must not turn an already-issued mutation into a generic size error.

A proposed change that conflicts with an invariant requires an explicit owner decision and corresponding documentation update. It must not be hidden inside an unrelated refactor.

## Change and release-operation ownership

Implementation, frozen local verification, candidate preparation, activation, acceptance, GitHub publication, npm publication and soak have distinct evidence boundaries. The canonical sequence, exact commands, integrity gates and rollback rules are maintained in [RELEASING.md](RELEASING.md); do not maintain another complete procedure here.

Repository automation proceeds under the standing authority in [the repository contract](../AGENTS.md). npm package publication is the sole explicit current-task owner authorization boundary and uses `--owner-confirm`. Local review readiness does not imply external release readiness, as defined in [Local repository readiness and release readiness](#local-repository-readiness-and-release-readiness).

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
- Static package identity stays outside persistence ownership: `src/local/core/timing.mjs` is the single source for installed package name/version/root and the shared server name. State-root/profile/workspace path and hash semantics remain in `src/local/state/state.mjs` because they depend on platform/environment injection, canonical workspace identity, and case-folding rules used by persistence and locks. Do not create a parallel path helper unless real consumers migrate to it and parity tests bind it to the live persistence contract.
- Pure classification and normalization functions are exported and tested directly when practical.
- Adapters may translate data but should not duplicate policy or schemas.
- Every protocol control message emitted by one side must be explicitly accepted, rejected, or version-gated by the other side, with an end-to-end contract test covering the message name and semantics.
- State transitions are explicit; readiness is not inferred from a lower-level event. An open WebSocket is not authenticated until `hello_ack`, and authenticated transport is not service readiness until an end-to-end result probe has returned on the same relay session. Pre-ready work and premature readiness acknowledgements fail closed.
- Every externally controlled input is bounded before expensive allocation, traversal, parsing, storage, or execution. A byte limit constrains bytes actually consumed and duration work, not only the subset retained in memory; once a declared or observed bound is crossed, cancel or close the source immediately.
- Externally controlled string keys must not use prototype-chain membership or truthiness on ordinary objects. Use `Map`, `Set`, `Object.hasOwn`, or null-prototype records for command dispatch, enums, ACLs, form fields, registries, and other key-addressed contracts.
- Repository text must not contain invisible ASCII controls other than tab, CR, and LF; architecture tests enforce this even when JavaScript syntax remains valid.
- Validate authority and object identity before mutation. If a multi-step operation must compensate after partial success, rollback must act on a transaction token, descriptor/snapshot identity, or other object-specific proof; a pathname plus the fact that an earlier step succeeded is not deletion authority. State read-modify-write operations must load their authoritative state after acquiring the mutation lock rather than saving a snapshot read while waiting for the lock. Machine-global service definition/owner/environment mutation must additionally hold the machine-service lock at the actual mutation point; a prior takeover check does not authorize a later unlocked install after network work.
- Complete-before-visible exclusive publication uses a flushed staging inode plus a no-replace hard link, so a legitimate competing reader can briefly observe the publisher's own second link before staging cleanup. Only readers explicitly coupled to this protocol may retry `MBM_MULTIPLE_HARD_LINKS` for the shared fixed four-attempt/1 ms budget. If the publisher crashed after link commit, those readers may continue only after the shared residue verifier opens the canonical target and the sole reserved internal staging alias, proves the same exact two-link filesystem generation through both descriptors, and returns that identity as a one-read token. The verifier never deletes the alias by pathname. Persistent or external hard links remain invalid ownership evidence; ordinary readers and callers without the exact token retain strict multiple-link rejection.
- Persistent mutations use owner-only files, bounded no-follow reads, flushed atomic/no-overwrite publication, and integrity checks appropriate to the data. Filesystem device/inode identity is never routed through an unsafe JavaScript Number: security-sensitive comparisons use the shared lossless identity boundary with BigInt default observations, retain exact change-time generation when the platform exposes it, and fail closed when injected metadata cannot be represented exactly. Same `(dev, ino)` after unlink/recreate is not sufficient identity evidence when a generation is known.
- A transport-surviving operation exposes either authenticated replay or a durable inspection handle. A response stream alone is not durable delivery.
- After a remote mutation, inspect the persisted file/Git anchors in a separate call before treating a subsequent test as evidence for that exact change.
- Exclusive locks use the shared complete-before-visible hard-link claim. Ownership bytes plus device/inode/change-time/size/mtime evidence come from one opened descriptor snapshot. Multiple links are rejected unless an explicitly coupled reader presents the exact descriptor-verified internal-publication residue token; stale-owner reclamation may then remove only the canonical target after owner/token/generation rechecks, never the staging alias pathname. Do not combine bytes from one open with identity from a prior path stat, treat an inode number as a permanent generation, or delete an internal alias merely because an earlier read matched it.
- Lock/recovery and destructive-inventory readers distinguish absence, successfully read malformed metadata, and storage failure. Only ENOENT is absence; only bytes that were successfully read and then proved malformed may enter a documented stale-corruption policy. Size, permission, I/O, descriptor, hard-link, and identity failures must propagate and must never become evidence that an owner is absent, reclaimable, or safe to delete. A read path with a legitimate concurrent atomic publisher may explicitly retry the stable `MBM_IDENTITY_CHANGED` condition, but only with a fixed small attempt budget and only when the final stable snapshot is the intended authority; destructive pre-action snapshots must not silently slide to a later object generation.
- Service providers normalize success/failure to one result contract. Definition removal follows the shared platform-stop → verified-daemon-stop → remove order. Destructive provider cleanup is decided from exit status plus structured pre/post provider state, never by matching localized stderr prose; a missing local definition is not evidence that an in-memory provider process is inactive.
- Retry is limited to classified transient failures. Authentication, authorization, validation, integrity, and policy errors fail immediately.
- Cleanup-only catches may be best effort only after the primary result is already unambiguous. Before commit, cleanup failure must preserve the primary failure and every relevant cleanup cause. After commit, cleanup failure must not retroactively report the side effect as failed; surface fixed bounded cleanup evidence instead, and fail closed before continuing whenever the leftover artifact can contain credentials, keys, or other sensitive bytes. Rollback of newly created credentials, keys, or other sensitive artifacts is part of the primary integrity result and must attempt every cleanup target.
- New work should not increase an already broad orchestration module when the behavior has an independent lifecycle or test surface. Extract the domain first.

`runtime.mjs` owns local tool orchestration, not filesystem lock mechanics. A tool handler returning successfully is the local settlement point: cancellation must be observed at explicit safe/cancellable checkpoints before that point, not used afterward to retroactively replace a completed result. Relay/result ownership may still suppress delivery when a remote caller has stopped waiting; that transport fact is separate from whether local work committed.  File mutations coordinate on already-resolved canonical paths: the same path is serialized, independent paths may proceed concurrently, and a multi-path transaction must reserve every source/destination before awaiting any prior reservation. A cancellation signal must not release a reservation while an already-started filesystem operation can still settle. `relay-connection.mjs` owns authenticated relay connection lifecycle, while `src/local/transport/relay-classification.mjs` owns close/error classification, handshake/readiness validation, user-facing relay causes, and reconnect backoff. The CLI orchestrates them; it must not become the second implementation of either.

## MCP and tool-schema contract

MCP protocol identity is request-scoped. Domain execution must not depend on connection history, an HTTP socket, or a process as conversation identity. Both transports interpret requests solely from current per-request metadata and reject removed initialization/session shapes without creating protocol state.

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
- `warn`: persistent degradation, rejected protocol data, supersession, or a service problem requiring attention. A relay outage already reported at this level also has one recovery summary at the same level, closing the incident in warning-level service logs.
- `info`: successful startup, initial authenticated readiness, and deployment.
- `debug`: bounded transport codes and fixed classifications, retry timing, shortened correlation identifiers, per-tool outcomes, and sanitized implementation diagnostics. Peer-supplied close-reason text is not a log field.

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
- ENGINEERING defines engineering invariants, collaboration, contract, testing, supply-chain, review, and exception policy.
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

Current audit conclusions and residual limits are recorded in [AUDIT.md](AUDIT.md); historical reviews remain in Git history and tags. Normative behavior remains defined by this guide, `SECURITY.md`, and executable test contracts.

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

### Validation-before-allocation and validation-before-destruction

Security-sensitive state transitions follow two related ordering rules. First, prove authority before allocating scarce state: browser HMAC authentication validates a client init proof before reserving a pending challenge slot, and identical retries are idempotent. Second, validate ownership before destructive mutation: file/service/SSH rollback paths bind deletion to descriptor/generation identity rather than pathname alone. Do not move validation after pending-state insertion, unlink, rename, chmod, or other externally visible mutation merely to simplify control flow.

Approval and authorization parsers also distinguish omission from malformed explicit input. Optional fields may receive documented defaults only when absent; a provided value of the wrong type or unsupported enum must be rejected rather than silently coerced. Persisted security/recovery markers whose `false` value relaxes a safety gate must be type-checked explicitly instead of normalized with `=== true`.

### Cloudflare toolchain integrity

The private toolchain verifies the unchanged cf upstream bundle using `cf-network-integrity.mjs` under the same owner lock as manifest/dependency verification and audit refresh. Exact artifact version/hash, contained real paths, single-link regular files and non-writable modes are required. Registry SRI, zero-vulnerability audits and signatures remain separate gates. Consumer installations omit the deployment tools and have no postinstall hook. The removed third-party transformation is historical; an external dependency override cannot establish the safety of code already bundled into a CLI.

`cf-network:test` proves connector and TLS-verifier preservation in the pinned upstream network factory without requests. `tests/cf-project-test.mjs` proves exact Worker identity and rate-limit bindings, bundle-contained module paths, the 256-module/32 MiB aggregate/16 MiB individual ceilings, and primary-plus-cleanup failure preservation. The private dependency traversal checks its node budget before reading a node and never reflects unverified version text in integrity errors.

Dependency proposals for root and private manifests must be reconciled into one reviewed package candidate: synchronize exact pins, locks, native script approvals, runtime type seed, version anchors and changelog, then complete the existing verification and live-acceptance sequence. Grouping updates does not waive those gates.

## Change flow

The repository uses **GitHub Flow**:

1. create a short-lived branch from current `main`;
2. make one coherent change, including tests and documentation;
3. open a pull request and let required checks complete;
4. resolve review conversations and rebase or update the branch when required;
5. squash-merge into `main` and delete the branch.

Permanent `develop`, `feature`, and `release` integration branches are not used. A supported maintenance line may use a temporary `release/x.y` branch only when an older published version must receive fixes independently of `main`.

Branch names use a short category and purpose, for example `feat/browser-downloads`, `fix/relay-timeout`, or `chore/dependency-policy`.

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

**Job polling ownership is not task ownership.** An MCP Apps-capable hosted `start_job` may advertise `ui_monitor_candidate=true` plus `ui_monitor_render_tool=render_job_monitor` and a fresh random `ui_monitor_id`, but that is only an optional status surface: `start_job` remains a data/execution tool and carries no UI template. The model must not render the monitor merely to shorten a response, avoid waiting, or manufacture a handoff while the current task still has work that depends on the managed job's terminal result. In that case the model preserves `job_id` + `recovery_key` and continues bounded server-paced `read_job` calls in the same response while calls are accepted. The monitor is eligible only when the current task can deliberately transfer that job's status polling without needing its terminal result for remaining same-response work.

When intentionally used, the model preserves the pre-issued ID, calls `render_job_monitor` once with the exact accepted `job_id` + `recovery_key` + `ui_monitor_id`, and then calls model-side `read_job` once with the same ID without depending on either structured or text render output. A matching current View claim on an ordinary job reports `ui_monitor_claimed=true`, `status_polling_mode=ui_monitor`, `host_turn_handoff_recommended=false`, and `follow_up_read_required=false`: that suppresses duplicate model polling of this job only and never instructs the assistant to abandon unrelated or still-actionable work.

The only permitted host-turn exception is an explicitly persisted `continuation_mode=task_supervisor` whose reviewed durable plan already encapsulates every remaining noninteractive task action; a later active claimed read may then report `host_turn_handoff_recommended=true` because the supervisor job owns the remaining execution lifecycle. Machine Bridge can validate the persisted declaration, active state, and current monitor claim but cannot infer conversation-level completeness; that completeness remains an owner/caller semantic assertion. The monitor itself remains status-only and receives no execution or capability authority.

The Worker verifies read authority, activates the pre-issued monitor record, and mounts the Job Monitor resource. New issuance is latest-wins for the same job/principal, so older monitor instances stop being current. Issued/active/claimed monitor metadata must be transactionally persisted in the BridgeRoom Durable Object, not kept only in isolate-local memory; persistence is metadata-only and must never include the recovery capability or job result. An issued ID is not claimable before render activation.

After a matching claim, the monitor remains capability-bound and continues through the app-only `read_job_monitor` host bridge, which verifies the original `recovery_key`, requires the monitor ID to identify the latest claimed View, refreshes its five-minute handoff-freshness lease, strips recovery/correlation material before delegating to a fixed 40-second daemon `read_job`, and gains no bare-ID inventory or direct network path. Expired handoff freshness cannot transfer task ownership, but a still-latest View may resume app polling after host suspension or machine sleep; a replacement issuance removes the older record and prevents that older View from resuming. A transient app-origin client-to-Worker read failure is retried by the View with bounded backoff against the same durable job rather than pausing for a user turn or resubmitting execution. A read already dispatched before replacement may finish, but no later read from that replaced View is admitted.

The app-only monitor is a minimum-status continuation surface, not another managed-job result API. After the Worker checks the recovery capability and obtains the daemon `read_job` result, it must project only bounded lifecycle fields before returning to the View; stdout/stderr, step/nested result objects, command text, paths, recovery/control capabilities, and unknown fields must not cross that boundary. The View may retain the render-input `recovery_key` only as its live read authority, must bind that complete render input once rather than accepting ambient tool-result state, must not reflect raw host/runtime exceptions into UI text, and must clear capability/correlation values plus pending response timers on teardown. Durable monitor metadata remains auxiliary: a storage failure during optional issuance or claim probing after the core managed-job result exists must degrade to ordinary model-side continuation, and cleanup failure must not prevent authority revocation. Observability for those failures is limited to a fixed operation class plus sanitized error class. Persistent monitor records must remain schema-bounded and reject duplicate IDs/order sequences or impossible generation ordering.

For a known hosted managed job whose result is required by the current task and no UI monitor owns continuation, the client must preserve the acceptance `job_id` together with its principal-bound `recovery_key`; an active relay-origin `read_job` uses those credentials, reports `status_polling_mode=bounded_followup` with `host_turn_handoff_recommended=false`, and the client may issue another capability-bound `read_job` in the same assistant response. **Autonomy must not be implemented as a host-side spin loop or as one overlong host call:** active hosted `read_job` uses the advertised 40-second server-side long-poll by default. Terminal settlement returns on the next bounded poll; nonterminal status/phase/dependency progress is coalesced for at least 30 seconds by default, while `current_step`-only churn remains visible in the eventual status but does not wake the host call by itself. `wait_ms=0` is an explicit immediate checkpoint, not the normal wait strategy, while public hosted `wait_ms` is capped at 60 seconds. The default must remain at the empirically safe 40-second interval rather than being raised merely to reduce call count; longer jobs use another paced read of the same `job_id` instead of one overlong host request. Per-call survival and aggregate host-response lifetime are separate constraints: arithmetic such as `duration / wait interval` is useful for estimating interaction density but is **not** evidence that one assistant response can carry every read to terminal state. Process sessions use the corresponding `paced_followup` model: after a blocking read arms the fifteen-second cooldown, another would-block request is paced inside that same MCP call until output/exit or the cooldown boundary rather than returned as a rapid running checkpoint. The managed-job server-side long-poll, nonterminal progress coalescing, remote one-second actual output/exit blocking `read_process` cap, fifteen-second cooldown, `next_blocking_poll_after_ms`, durable ownership, idempotency, and actual request/transport limits are the anti-amplification controls; a mandatory one-read-per-response, rapid immediate-checkpoint loop, later-user-turn boundary, or guessed elapsed-time cutoff is not an acceptable substitute for those controls.

Host-visible tool-event density must also be controlled before polling begins. A coherent non-interactive workflow that requires several local commands should use a repository-native umbrella command where one exists, otherwise one multi-step `start_job` or the smallest practical number of managed jobs. Do not create a fresh one-step `run_process`/`exec_command`/`run_local_command` carrier for every tiny probe merely because each command is short. This is an orchestration-density rule, not a duration limit: it must never be implemented by shortening the task, reducing the six-hour managed-step ceiling, or handing control back to the user after an arbitrary number of minutes.

The transport/runtime must reduce event density structurally as well as through guidance. A hosted one-step process carrier is accepted durably first, then may spend only the documented short initial-settlement window returning a terminal helper result in that same response. If it remains active, the original durable recovery contract wins unchanged. The daemon/local `list_jobs` inventory must prioritize unreadable/active/staged recovery state before terminal helper history, but the hosted Worker projection must expose only aggregate inventory and must not enumerate job IDs, names, or recent recovery handles. Hosted reads/dependencies require the acceptance `recovery_key`, cancellation requires the separate `control_key`, and both capability types must be verified before daemon dispatch and omitted from logs/routing metadata. Owner diagnostics must expose bounded event-density, job-churn, and resource-waiter-reason aggregates so a later interruption can be classified from persisted evidence rather than reconstructed from host-visible prose. None of these mechanisms may become an aggregate task-duration ceiling or a user-driven polling requirement.

Shared browser focus is likewise not hosted request identity. Hosted browser content/action tools that can otherwise default to the active tab must require an explicit `tab_id` selected from current tab inventory, and hosted browser `computer_observe` must bind its snapshot to that explicit target before later snapshot-bound actions. A concurrent hosted conversation changing the active tab must not retarget an already-specified operation.

An active operation may be handed back with its durable recovery identifier only after a real host/tool/runtime boundary is actually observed, external human input/authorization is required, or the user explicitly requested a checkpoint. Elapsed minutes, a guessed host budget, and merely having performed one active status read in the current response are not valid handoff conditions. If a real host/tool boundary ends the response, the next available response must resume the same durable identifier rather than resubmit the underlying operation. A typed `read_job` `not_found` means that Machine Bridge no longer retains that job record; it is not proof that the underlying operation never executed and must never be converted into a blind retry of a side effect. Inventory and diagnostic surfaces such as `list_jobs`, `server_info`, and `diagnose_runtime` are not alternate polling channels and must not be used to evade the authoritative pacing contract.

Machine Bridge cannot create a new ChatGPT assistant turn after the host has already terminated the current response. That is an external delivery boundary, not a server-side polling primitive that can be repaired by increasing `wait_ms`. The repository must therefore make every pre-boundary acceptance recoverable and every post-boundary state unambiguous: hosted `start_job` requires a caller-held `idempotency_key` before dispatch; an ambiguous acceptance is retried only with the same logical arguments and key; public stream cancellation must remain sticky until the corresponding direct request either observes it or the bounded cancellation-evidence lifetime expires; and loss of completed relay-result evidence blocks transparent replay for the affected call instead of manufacturing non-execution proof. These guarantees reduce interruption amplification but do not claim that MCP can autonomously originate the next product turn.

The execution lifetime must also support the continuity claim below the status layer. Remote one-step process tools remain intentionally capped at 600 seconds; a continuous process that legitimately needs longer must route to a policy-authorized managed-job step. Main/finally steps default to 600 seconds and may explicitly request up to 21,600 seconds (six hours), with cooperative resource admission occurring before that execution timer starts. Do not split a stateful long command merely to work around an orchestration timeout. The local plan validator and all published job schemas must share the same ceiling. Completed one-step process carriers may share the bounded managed-job store, but they are lower-priority terminal retention than explicit managed jobs: when capacity pressure has removable transient helper history, helper churn must reclaim that history before evicting an explicit managed-job recovery result. The durable store is bounded to 512 retained states while `list_jobs` remains a 50-record inventory window. Cross-job ordering must use durable `depends_on` state rather than long shell/file polling when an upstream managed job is the real prerequisite: the dependent job remains pre-execution `queued/dependency_wait`, upstream failure propagates as `dependency_failed`, and referenced retained records stay pinned while an active/staged dependent still needs them. These controls must reduce interruption amplification without reducing aggregate task lifetime or forcing another user turn. The hard retained-state cap and time-based privacy retention remain authoritative.

This rule is a release-blocking continuity invariant. Any change to hosted job/process follow-up semantics requires all of the following evidence before candidate acceptance: contract tests that reject wording or metadata that forces a later user turn after one active read **or after an inferred elapsed-time budget**; behavior tests preserving the wait/cooldown bounds; and live candidate proof for per-call pacing plus the recovery mechanism affected by the change. For managed jobs, use a fixture whose first phase remains unchanged longer than the hosted default: the first parameter-omitting `read_job` must remain inside one MCP call for the advertised server-side long-poll interval, report `bounded_followup`/no handoff and the corresponding wait metadata rather than return an immediate checkpoint, and a second `read_job` in the **same assistant response** must then be accepted and reach further progress or terminal state. A fixed-duration >100-minute live soak is not a universal candidate-acceptance gate. Exercise aggregate recovery with bounded evidence tied to the changed failure mode instead: preserve the same job identifier across any real response/tool or daemon/relay boundary that occurs during the probe, and prove subsequent recovery after representative helper-tool churn when that boundary is part of the change under test. Response-count arithmetic alone does not prove cross-boundary recovery. When process-session semantics change, the live proof must analogously observe `paced_followup` and prove a repeated would-block read is server-paced inside the cooldown rather than returned immediately, while retaining the one-second actual blocking cap.

Verification carriers are not test verdicts. Do not wrap a multi-stage real-host, lifecycle, fault-injection, install, or full verification whose credible worst-case duration exceeds the carrier budget in a shorter `exec_command`/`run_process` timeout and then classify the carrier's SIGTERM as a product failure. Split independently terminal phases into `start_job` steps, choose each step timeout from the suite's documented or observed upper bound with settlement margin, and follow the durable job. A carrier timeout is evidence that the chosen orchestration budget was too small unless the child suite itself had already reported its own timeout/failure condition.

Hosted tool descriptions can exist in several independent host-owned layers, not merely in Machine Bridge documentation. A release that changes tool semantics or descriptions must make freshness observable and must verify more than the daemon backend after activation. Current MCP 2026-07-28 remote discovery must advertise `tools.listChanged=true`, and a client subscription for `toolsListChanged` must receive the supported-subset acknowledgement plus `notifications/tools/list_changed` so it can re-fetch `tools/list`; stdio retains `listChanged=false`. When ChatGPT workspace governance freezes an approved action snapshot, that **Workspace Action control snapshot** is the product-level publication evidence: automation may perform the supported refresh/review path without a separate approval, then requires the expected action count and current generation/semantics there. Separately require the live `server_info` generation/version/TTL contract and harmless invocation-validator or behavior probes that reach the activated runtime. Opaque ChatGPT-internal cache inspection is intentionally outside the release process: do not query or compare internal host cache generations as release evidence and do not use them to trigger reconnect, recreation, republication, or other product remediation. A product-level schema blocker requires the governed Workspace approved snapshot itself to remain stale, partial, or mixed after the supported refresh/review path, or an actual invocation-validator/behavior probe to contradict the current runtime contract. Versioned runtime results alone still do not prove product publication.

ChatGPT host-control-plane UI is not a separate conversational authorization boundary from Machine Bridge runtime verification. Automation may inspect and operate the supported Apps/Plugins/admin refresh/review flow when a governed Workspace Action control snapshot is a genuine release or diagnosis dependency. Prefer passive existing MCP discovery and harmless invocation-validator probes first, use in-place refresh/review before recreation or republication, preserve existing app identity where possible, verify settlement after each mutation, and never replay an unknown-outcome UI mutation blindly. Host-internal cache inspection must not be introduced as an alternate release-diagnosis path.

The beta.104/beta.106 sequence is the canonical regression for this invariant. Beta.104 correctly identified a real same-turn polling amplifier, but it over-corrected with a one-checkpoint-per-assistant-response policy that forced the owner to repeatedly send `继续`. Beta.106 restored same-turn autonomy but initially left durable `read_job` as an immediate checkpoint, so autonomy could again become a high-density host tool loop. Future anti-busy-loop work must solve both failure modes at once: wait/pacing belongs inside Machine Bridge while user interaction never becomes the scheduler tick.

### Local GitHub control plane

Before any GitHub read or mutation, repository automation must load the effective project instructions through Machine Bridge. It must then use local `git`, `gh`, and `gh api` commands executed through Machine Bridge for every GitHub read or mutation. A hosted GitHub connector, ChatGPT GitHub plugin, browser-side GitHub integration, or second remote control plane must not be used. If Machine Bridge or the local authenticated CLI is unavailable, the operation stops and reports that boundary rather than falling back. Mixing control planes can produce stale refs, unreviewed remote-only commits, ambiguous credentials, and recovery paths that cannot be reproduced from the maintainer's machine. Fetch before mutation and verify the remote result afterward.

## Commits and pull requests

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

## Architecture and dependency rules

The architectural dependency direction above is normative. In addition:

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

## Public contracts and generated documentation

The MCP tool catalog in `src/shared/tool-catalog.json` is the authoritative base API description for names, daemon availability, annotations, and local/stdio JSON input schemas. The authenticated Worker may deliberately narrow or extend hosted schemas at that boundary; those projections must live in focused Worker helpers, be covered by actual `tools/list`/validator tests, and be documented as hosted-only requirements rather than copied back into the local base schema. The base catalog is rendered into [TOOL_REFERENCE.md](TOOL_REFERENCE.md); CI rejects stale generated documentation.

Swagger/OpenAPI is required only if the project later exposes a user-facing HTTP REST API. It is not a substitute for MCP tool schemas or end-to-end MCP protocol tests. Hand-maintained copies of generated contracts are prohibited.

A public contract change must address:

- backward and forward compatibility;
- bounded input and output behavior;
- authorization and destructive-operation annotations;
- stable error classification;
- protocol negotiation or versioning when peers may differ;
- documentation, tests, changelog, and semantic-version impact.

## Testing and quality gates

Tests follow risk rather than a repository-wide aggregate percentage:

- Every defect fix includes a regression test that fails for the original causal reason.
- Pure policy and normalization logic is tested directly; adapters receive integration coverage proving that they use the policy correctly.
- Permission expansion includes denial tests. Bounded resources include over-limit tests. Multi-stage mutations include partial-failure and rollback tests.
- Concurrency, locking, process trees, persistence, cancellation, retry, and recovery require behavior-level or fault-injection coverage.
- Protocol changes include producer-consumer contract tests and malformed-input tests.
- Hosted-runtime boundaries such as deployed Durable Object persistence, edge request cancellation, browser integration, and provider lifecycle receive deployed/live canaries when local workerd, emulators, or OS fakes cannot prove equivalent semantics. OAuth/token persistence changes require deployed authorization-code exchange, access/refresh persistence, one authenticated MCP request, and refresh rotation before acceptance.
- Supported operating systems run the required suite in CI.
- Critical modules have explicit function and branch baselines. Thresholds may rise after better tests or extraction; lowering one requires an audit note explaining why the old measurement was misleading.
- New security and architectural assertions must provide mutation evidence proving they fail when the guarded invariant is violated; an assertion that cannot fail under mutation is considered unimplemented.
- High-risk JavaScript contract modules opt into strict TypeScript checking through `tsconfig.local.json`; implicit `any`, `@ts-ignore`, and untyped duplicate protocol/configuration shapes are not acceptable substitutes for a defined boundary.

An 80% aggregate coverage target is not a repository requirement: it can hide untested critical branches behind trivial files. New or materially changed pure business modules should normally achieve at least 80% function coverage and meaningful branch coverage, but risk-specific tests remain the acceptance criterion.

Flaky tests are defects. A retry may diagnose environmental instability but may not be used to make a nondeterministic test appear healthy.

## Error, retry, and log standards

- Expected operational failures use typed stable error codes and concise operator messages.
- Unexpected programming errors remain distinguishable from ordinary unavailability.
- Request boundaries normalize errors once. Lower layers preserve causes and do not repeatedly translate them.
- Cleanup catches may be best effort only when the primary failure is retained and cleanup failure is observable where useful.
- Empty catches and catch-and-continue behavior are prohibited unless a comment explains why the event is intentionally irrelevant.
- Retries require positive transient classification, bounded attempts, backoff, and idempotency or authoritative state reconciliation.
- Unhandled process-level exceptions are logged with redaction and cause controlled termination; continuing in an unknown state is not a recovery strategy.
- Operational logs follow [LOGGING.md](LOGGING.md), remain structured, bounded, actionable, and free of secrets or user content.

## Security and software supply chain

- GitHub workflow permissions default to read-only and are expanded per job only when required.
- Third-party Actions are pinned to immutable commit SHAs and reviewed when Dependabot updates them. GitHub Action updates are grouped into one atomic pull request so coupled suites such as CodeQL cannot be split across incompatible versions.
- npm dependencies use exact versions and a committed lockfile. Source bootstrap uses `npm ci`; the CI npm baseline itself is downloaded from an exact URL and verified against a pinned SHA-512 SRI before use. Registry signatures and attestations are verified in CI.
- Dependency review blocks newly introduced vulnerable dependencies. CodeQL performs JavaScript/TypeScript and workflow analysis. OpenSSF Scorecard audits supply-chain posture, and both SARIF streams are failing gates with exact, expiring exceptions rather than advisory-only uploads.
- CI generates and validates a CycloneDX SBOM. Release artifacts must match the repository-owner-tested tarball hash, be reproducible from a reviewed commit, and be tied to successful exact-commit CI, CodeQL, Governance, Workflow Policy Gate, and Scorecard evidence.
- Secret scanning and push protection are enabled. Repository examples use synthetic identities and reserved domains; reachable history is scanned before release.
- Long-lived publication tokens should be replaced by npm trusted publishing with GitHub OIDC. Until that external registry configuration is completed, release credentials remain an explicit operator responsibility and must never be stored in the repository.
- Security reports follow [SECURITY.md](../SECURITY.md), not public issue templates.

## Review, ownership, and exceptions

`CODEOWNERS` identifies responsible areas and requests informed review. It does not prove independent review when author and owner are the same person. Review examines correctness, causal completeness, security/privacy boundaries, compatibility, failure paths, observability, test evidence, and maintainability. Style preferences do not override a simpler correct design without a documented project rule.

This repository currently has one human maintainer. Requiring one independent approval would deadlock maintenance and therefore is not enabled. [GOVERNANCE.md](../GOVERNANCE.md) defines admission, succession, release authority, and the first mandatory control after another active maintainer is added: one non-author approval plus last-push approval for security-sensitive, release, policy, Worker, browser, state, and execution changes.

A standard may be changed when evidence shows that it creates more risk or cost than it removes. The change must update this document, relevant automation, and the changelog together. Silent exceptions and permanently waived failing checks are prohibited.
