# Changelog

## 3.0.0-beta.20 - 2026-07-26

### Fixed

- Rewrite the bounded Worker error-cause traversal with an explicit object type guard and `WeakSet<object>` cycle tracking. This preserves the eight-level/cycle-safe classification behavior while eliminating the CodeQL `js/comparison-between-incompatible-types` finding; the existing cyclic-cause regression test continues to enforce non-duplication.

## 3.0.0-beta.19 - 2026-07-26

### Fixed

- Restore the documented `account revoke-client CLIENT_ID` CLI command. The action was implemented end to end, but its positional-argument limit was omitted, so every valid client ID was rejected as an extra positional argument before the signed administration request could be sent. Add direct parser regression coverage for both `account clients` and `account revoke-client`.

## 3.0.0-beta.18 - 2026-07-26

### Fixed

- Prevent intermittent hosted-client account loss during refresh-token rotation. A consumed refresh token may now recover at most two same-client, same-resource, same-scope, same-DPoP retries inside a 30-second concurrency window. Both retries reproduce the original deployment-keyed HMAC replacement pair without creating another credential branch or extending expiration; retries beyond that bound return `temporarily_unavailable`, while replay after the window still revokes the complete family. Schema-2 refresh state migrates in place to schema 3.
- Normalize unexpected outer-Worker failures to a structured retryable `502 worker_gateway_error` instead of allowing `scriptThrewException`/Cloudflare 1101 to surface as a generic account connection failure. Logged error classes contain only error names/codes, never exception messages.
- Retry an internal terminal WebSocket subscription with bounded delays after transport closure or retryable 429/5xx responses. Normal streamed calls retain the fixed two-request Durable Object path; failure recovery is capped at three subscription attempts.
- Stop reading request bodies immediately after a declared or observed size violation instead of draining attacker-controlled bytes. Permission and I/O failures during write-path and workspace traversal checks now propagate rather than being misclassified as missing files.
- Make partial application and skill discovery explicit through bounded path-projected warnings and coarse error classes. Optional `session_bootstrap` failure remains non-fatal but is now visible in Worker observability.
- Bound account-administration responses to one MiB, cancel oversized bodies, and require successful replies to be JSON objects. Generated SSH key registration now attempts both cleanup targets and reports incomplete rollback instead of silently leaving an unregistered private key.
- Add a fixed browser-extension error boundary, remove raw debugger details from successful fallback results, and enforce the 32-operation concurrency ceiling independently inside the extension. Error-cause inspection is cycle-aware and capped at eight levels.

### Quota and deployment hardening

- Serve all public discovery metadata and unknown-path 404 responses in the outer Worker. Only an exact stateful route-and-method allowlist can reach the rate limiter and Durable Object; invalid methods are rejected at the stateless edge.
- Add a Cloudflare Rate Limiting binding before Durable Object dispatch. Binding failure is fail-open because it is a quota guard rather than an authorization boundary; OAuth, session, and role checks remain inside the Durable Object.
- Coalesce Durable Object alarms: an already scheduled earlier alarm is reused instead of being rewritten on every daemon heartbeat, and empty alarm state avoids redundant deletes.
- Report refresh outcomes, estimated resumable-stream row writes, and alarm set/delete/no-op counters in Worker observability. Regression tests hold a normal stream to four storage-row writes before expiry cleanup.
- Rate-limit repeated edge degradation logs and report suppressed-event counts, while redacting sensitive field names. Remove duplicate `waitUntil` registration for one streamed terminal operation.
- Add hard critical-coverage thresholds for every new OAuth, stream, metadata, quota, edge-logging, and filesystem-state module rather than relying only on line-count architecture checks.
- Split OAuth refresh exchange, token issuance, terminal subscription, public metadata, and edge quota guards into focused modules rather than raising architecture limits.

## 3.0.0-beta.17 - 2026-07-26

### Fixed

- Serve `/healthz`, `/`, and CORS preflight from the outer Worker so activation and doctor checks no longer consume Durable Object free-tier request volume. Durable Object free-tier exhaustion now returns a structured `503 durable_object_quota_exceeded` instead of Cloudflare error 1101.

### Durable Object stream request amplification fix

- Replace the outer Worker's time-proportional internal Durable Object poll loop with a fixed two-request terminal path: one authenticated descriptor `prepare`, then one hibernatable WebSocket `subscribe`.
- Add `mcp-stream-channel.ts` so `BridgeRoom` accepts a single stream subscriber through `DurableObjectState.acceptWebSocket()`, replaces stale resume subscribers, rechecks storage after registration to close the completion race, and pushes exactly one terminal JSON-RPC message.
- Persist-ready notifications are fire-and-forget from `McpResumptionStore`; if persistence fails, the current online subscriber can still receive the transient terminal result while recovery storage keeps failure semantics.
- Keep daemon candidate cleanup from treating stream-subscriber sockets as daemon candidates, and reject client-to-DO data on receive-only stream subscribers.
- Fix the outer subscription waiter so invalid terminal payloads reject instead of leaving the SSE completion Promise permanently unsettled.
- Extend deterministic infrastructure coverage for the fixed two-request budget, obsolete poll-mode rejection, subscriber replacement, registration races, immediate-completion paths, protocol errors, and non-daemon socket isolation. Update architecture, engineering, testing, audit, and operations contracts to describe subscribe push delivery instead of short pending/terminal polls.

## 3.0.0-beta.16 - 2026-07-25

### Pending-call recovery and verified handover

- Separate the upstream MCP host/connector shard-mapper incident from Machine Bridge evidence. The exact temporary-keyspace error never appeared in Worker or daemon diagnostics and did not increment Worker server-error counters, so it is documented as an external boundary failure with unknown platform ownership rather than misclassified as a local daemon, OAuth, Git, or Cloudflare defect.
- Close the Machine Bridge failure-amplification path discovered after recovery. Pending calls now retain monotonic operation and reconnect deadlines, schedule the earliest deadline through the Durable Object alarm, and run a compensating overdue sweep on every HTTP/WebSocket event. In-memory timers remain the fast path; a transient alarm-storage error is observable without converting already-dispatched work into a false terminal failure.
- Make verified same-instance daemon handover atomic with respect to in-flight calls. Both attached and detached records move to the replacement before the incumbent closes, the complete `resume_calls` set is sent, remaining operation timeout is preserved, and failed replacement acknowledgement restores ownership to a still-open incumbent.
- Add deterministic disabled-timer deadline tests, direct runtime-alarm scheduling/failure tests, and a real Wrangler/workerd race regression that connects a same-instance replacement while the incumbent still owns an active call. The call remains active rather than detached and completes through the verified replacement.
- Use null-prototype dictionaries for managed-job `env` and `env_resources`, so valid variable names such as `__proto__`, `constructor`, `toString`, and `valueOf` remain ordinary own data instead of mutating JavaScript object prototypes. Add behavior coverage without weakening duplicate-variable rejection.
- Correct architecture and operations documentation that still described Durable Object `waitUntil` ownership or direct rejection during socket replacement. Document the three deadline enforcement paths, stale-pending diagnosis, host/connector internal-storage error triage, and the exact test evidence.

## 3.0.0-beta.15 - 2026-07-25

### Event-driven streamed-call settlement

- Block `3.0.0-beta.14` after exact owner-machine activation and repeated production verification. Version, launchd identity, private candidate runtime, status, doctor, sequence-zero delivery, session isolation, disconnect recovery, and terminal acknowledgement all converged, but a concurrent `server_info` still timed out while the original SSE remained open; session-scoped cancellation therefore could not enter. Beta.14 has no acceptance record and must not be pushed, published, or promoted.
- Remove the last cross-event terminal Promise from streamed `tools/call` initiation. `BridgeRoom` now commits the recovery record, registers an event-settled pending call, sends the daemon envelope, and returns the descriptor without retaining a Promise for the daemon result. The later daemon WebSocket `tool_result`, explicit cancellation request, timeout, send failure, or reconnect-grace expiry owns terminal settlement and persistence.
- Preserve ordinary JSON-only calls with the existing Promise-based request path while adding a separate event settlement mode to `PendingCallRegistry`. Same-instance daemon reconnect still detaches and rebinds both modes; terminal settlement removes request keys, closes observability, and writes exactly one resumable JSON-RPC result.
- Replace the resumption store's live Promise map with an active-stream set plus a bounded transient terminal map used only when persistence fails. A pending persisted record without matching active state still produces the existing restart-ambiguity error instead of inventing completion.
- Add deterministic event-lifecycle regressions that prove stream initiation returns before any terminal event, then exercise success, daemon rejection, cancellation, timeout, send failure, result transformation, persistence failure, and same-instance reconnect. Architecture checks forbid `dispatchJsonRpc` terminal Promises, `resumption.attach`, and Durable Object `waitUntil` from returning to the stream initiation path.

## 3.0.0-beta.14 - 2026-07-25

### Concurrent MCP control during streamed delivery

- Block `3.0.0-beta.13` after exact owner-machine activation. Live recovery itself succeeded—sequence zero, session isolation, disconnect recovery, and one-time terminal acknowledgement all worked—but a production Cloudflare Durable Object that directly owned the open SSE response did not accept concurrent `server_info` or `notifications/cancelled` requests until that stream ended. Beta.13 has no acceptance record and must not be published or promoted.
- Move public SSE ownership to the stateless outer Worker. `BridgeRoom` now authenticates and binds the request, commits the resumable record, dispatches local work, and returns only a bounded internal descriptor. The outer Worker emits sequence zero/keepalives/sequence one and polls the Durable Object with short immediate requests for pending or terminal state, so no Durable Object request remains open while a client stream is active.
- Strip all internal stream-control headers from public requests before forwarding, then add them only on the trusted service-binding path. OAuth/DPoP, signed MCP-session, token/session replay isolation, explicit cancellation, bounded persistence, and acknowledged-terminal suppression remain enforced by `BridgeRoom`.
- Extend real Wrangler integration to hold an SSE call open while a concurrent `server_info` succeeds and a session-scoped cancellation reaches the exact daemon call. Transport tests now parse complete SSE events rather than assuming one network chunk equals one event.

## 3.0.0-beta.13 - 2026-07-25

### Resumable MCP result delivery and outage closure

- Complete the Streamable HTTP recovery contract. Every streamed `tools/call` now emits a sequence-zero SSE event identifier before local execution can complete, persists a token- and MCP-session-bound delivery record, emits the terminal result as sequence one, and accepts authenticated `GET /mcp` recovery with `Last-Event-ID`. Reusing sequence one returns an empty completed stream instead of delivering the terminal response twice.
- Separate execution continuity from result-delivery continuity. An HTTP/SSE disconnect does not cancel the daemon call; only session-scoped `notifications/cancelled` does. A new POST always starts a new request, while GET only resumes a previously issued stream identifier, preventing retry semantics from being conflated with replay.
- Bound Durable Object recovery state to 64 streams, two minutes, and 1.5 MiB per persisted terminal message. A compact metadata index avoids scanning stored result bodies. Result records carry SHA-256 integrity metadata, are isolated by OAuth token and MCP session, evict expired or oldest completed entries first, and return explicit errors for oversized replay data, lost in-memory execution after Worker restart, or stored-result corruption.
- Preserve online delivery when persistence fails transiently, fail before side effects when a new recovery record cannot be admitted, and allow browser DPoP/resumption preflights by advertising both `DPoP` and `Last-Event-ID` in CORS.
- Promote the recovery summary for an already-warned relay outage to `warn`, while brief self-healing interruptions remain debug-only. Default background-service logs now contain both outage start and recovery closure without exposing raw close reasons.
- Add direct store fault/tamper/capacity tests, SSE framing tests, and live Wrangler integration that disconnects after sequence zero, completes the daemon call, rejects another session, recovers through GET, and proves the acknowledged terminal event is not duplicated.
- Refresh the locked development-only `brace-expansion` transitive dependency from 5.0.7 to 5.0.8 after the mandatory pre-candidate registry audit reported GHSA-mh99-v99m-4gvg. Both complete and production-only audits must be clean before beta.13 candidate preparation.
- Integrate Dependabot PR #56 into the complete beta.13 candidate rather than merging its incomplete two-file update. Wrangler advances to 4.114.0, Miniflare/workerd to the 2026-07-22 build, the exact `workerd@1.20260722.1` postinstall approval is reviewed and updated, and the existing patched `sharp@0.35.3` override remains authoritative.

## 3.0.0-beta.12 - 2026-07-23

### ChatGPT Streamable HTTP task continuity

- Fix remote `tools/call` handling so an HTTP/SSE connection closing is no longer interpreted as MCP cancellation. Only an explicit session-scoped `notifications/cancelled` request may remove the pending request key and send `cancel_call` to the daemon.
- Negotiate `text/event-stream` for clients that advertise it, prime the response immediately, send a bounded ten-second keepalive comment while work is active, and deliver the terminal JSON-RPC result as an SSE message. This prevents a long-running local operation from leaving the ChatGPT-to-Worker HTTP path completely idle.
- Preserve the underlying Durable Object operation with `waitUntil` when the response stream is no longer writable, so transport disposal cannot silently terminate local work. JSON-only clients retain the existing single-response behavior.
- Replace duplicated relay timing literals with one shared contract. Same-daemon reconnect recovery is extended from thirty seconds to two minutes, and the Worker pauses only the remaining normal call deadline while detached, avoiding both premature expiry during recovery and inflated timeouts while the daemon is healthy.
- Add deterministic and live Worker regressions for SSE negotiation, immediate priming, keepalives, terminal result delivery, HTTP abort without cancellation, explicit cancellation after disconnect, shared timeout ceilings, and same-instance recovery timing.

## 3.0.0-beta.11 - 2026-07-23

### External-review verification and observability hardening

- Share one portable content-redaction implementation between local and Worker logs. Worker string fields now redact embedded bearer/API tokens, credential URLs, email addresses, private-key headers, and user-home paths even when the field name itself is not sensitive.
- Prevent caller-supplied local or Worker fields from replacing authoritative `timestamp`, `level`, `component`, `message`, or `event` metadata, and add regression coverage for both value leakage and metadata forgery.
- Make the automatic execution model explicit in authenticated `server_info` authority snapshots and `machine-mcp doctor`: operations inside effective authority do not use per-operation prompts, and remote owner shell/browser/application actions have the daemon OS user's ambient authority.
- Extract local-resource reads and SSH-resource registration into `runtime-resource-service.mjs`, reducing `LocalRuntime` from 697 to 653 lines while retaining the existing zero-extra-step browser/application resource path and public result contract.
- Re-verify review claims against the repository invariants. The default `full` profile, single-maintainer release controls, Node 26/npm 12 baseline, packaged deployment/release helpers, systemd-user support, and cross-platform behavior suites remain intentional; none is weakened or removed merely to reduce surface area or ceremony.
- Refresh the exact Wrangler runtime from 4.112.0 to 4.113.0 and advance the reviewed npm install-script allowlist to its exact `workerd 1.20260721.1`; a clean install must not depend on an unreviewed or locally cached postinstall.

## 3.0.0-beta.10 - 2026-07-22

### Published prerelease activation repair

- normalize npm 12 single-result JSON arrays for version, integrity, SHA-1, dist-tags, and publication timestamps;
- unblock exact registry-backed prerelease installation and soak activation without weakening integrity or dist-tag verification;
- add a regression fixture matching the real npm 12 response shape that blocked beta.9 activation.

## 3.0.0-beta.9 - 2026-07-22

### Cross-platform release-gate repair

- Block `3.0.0-beta.8` after owner activation and acceptance because pull-request CI found three release-blocking defects that local macOS verification could not establish: the Windows trusted-Git regression forced Linux permission semantics onto NTFS, Ubuntu coverage did not execute the macOS delegated-sandbox behavior probe, and CodeQL rejected an unused cleanup-path assignment.
- Make trusted-Git regression coverage use the actual host platform while retaining POSIX group-writable rejection on Unix. Make macOS sandbox availability accept explicit platform and executable-presence probes for deterministic cross-platform tests, and exercise the complete read/write/outside-path/Keychain behavior matrix with a synthetic process boundary.
- Remove the unused activation cleanup assignment rather than adding a CodeQL exception. These changes require a new exact candidate, live activation, acceptance, and full prerelease gate.

## 3.0.0-beta.8 - 2026-07-22

### Candidate repository hygiene correction

- Block `3.0.0-beta.7` after owner-machine acceptance. A full staged-tree `git diff --cached --check` exposed an extra blank line at EOF in the newly added Worker device-session verifier; the earlier working-tree-only check did not inspect that untracked file, so the reported hygiene result was incomplete.
- Remove only the extraneous EOF blank line. Runtime behavior, protocol behavior, activation logic, and the beta.7 live conclusions are unchanged.
- Assign a new prerelease version and regenerate the exact candidate because even this packaged-source change invalidates the accepted beta.7 package and promotion digests.

## 3.0.0-beta.7 - 2026-07-22

### Nested npm lifecycle PATH normalization

- Block `3.0.0-beta.6`. Its exact Worker and daemon activated successfully, but live launchd inspection still found repository `node_modules/.bin` entries and npm's private `node-gyp-bin`. The packaged beta.6 function was present and produced a clean PATH when called directly; the failure was caused by nested activation: the existing daemon PATH already contained one npm run-script prefix, and invoking `npm run release:candidate:activate` prepended a second. Beta.6 removed only through the first marker and therefore persisted the complete inner prefix.
- Normalize through the last npm run-script marker, removing every nested lifecycle prefix while retaining the current Node/package directories, the operator PATH after the innermost marker, and platform defaults. Inactive candidate-runtime entries remain excluded.
- Expand Unix and synthetic Windows regressions to two complete npm prefix/marker layers followed by a stale candidate and a user bin. Both layers must be removed; ordinary non-lifecycle `node_modules/.bin` entries remain supported.

## 3.0.0-beta.6 - 2026-07-22

### Reproducible background service environment

- Block `3.0.0-beta.5`. Its exact candidate activated successfully on the owner machine: the same-version Worker and single launchd daemon reached readiness, `project_overview` reported distinct effective and daemon-ceiling authority, fixed Git metadata succeeded, `service start` preserved the existing PID, and detached `service restart` replaced the PID and returned to readiness with no pending calls. Post-activation inspection nevertheless found that the launchd `PATH` captured npm lifecycle injection from the activation command, including project `node_modules/.bin` prefixes, npm's private `node-gyp-bin`, and the beta.4 candidate runtime that activation immediately pruned.
- Make service `PATH` construction reproducible across ordinary installation and prerelease activation. The current Node directory and current package bin are always added explicitly. When npm's `@npmcli/run-script` marker is present, the lifecycle-injected prefix is removed before inheriting the operator PATH. Any other entry below the candidate runtime store is rejected while the current candidate bin remains available. Ordinary user-supplied `node_modules/.bin` entries are retained when they were not injected by an npm lifecycle.
- Add a cross-platform regression that reproduces the exact activation topology: npm project bins before the lifecycle marker, a stale prior candidate runtime after the marker, an inherited user bin, and the current runtime entry. The service definition must retain Node/current runtime/user tools, reject npm-private and stale candidate entries, preserve absolute-only deduplication, and continue to embed the sanitized value in launchd and systemd definitions.

## 3.0.0-beta.5 - 2026-07-22

### Relay resilience, lifecycle correctness, and fail-closed state hardening

- Block `3.0.0-beta.4`. Live observation showed that the daemon process and launchd job could remain healthy while the authenticated WebSocket disappeared and later recovered with the same PID. The affected route was carried through the machine's system VPN/TUN; Machine Bridge cannot prove which internal VPN hop failed, but it can now distinguish application-level proxy selection from the operating-system network stack instead of reporting the misleading label `direct`.
- Cap relay reconnect backoff at 15 seconds instead of 60 seconds. Add bounded outage count/start/duration, last close category/code, transport error class, last disconnect/ready timestamps, ready duration, and next-retry timing to `server_info` and `diagnose_runtime`. Emit timestamped `relay.outage.active` and `relay.outage.recovered` events without exposing close reasons, proxy endpoints, page data, tool arguments, or results.
- Make `service start` idempotently ensure a running service and reserve explicit replacement for `service restart`. Require verified state/workspace ownership before touching the machine-global service, use detached restart handoff where behavior is verified, and fail closed on in-process Windows restart rather than risking a Task Scheduler `/End` operation that also kills the restart helper.
- Replace raw launchd/systemd status dumps with structured summaries. Service status no longer exposes the user's home path, complete PATH, SSH agent socket, environment, or provider diagnostics. Autostart log schema migration now validates both owner-only log files before mutation, rejects symbolic or multiple-hard-link paths, writes schema 4 strictly, and aborts startup on incomplete migration instead of mixing text and NDJSON.
- Treat a tool result, public error, Worker pong/welcome, browser response, and extension keepalive as explicit serialization/delivery boundaries. Circular values, BigInt, oversized structures, half-closed sockets, and send failures terminate only the affected request or transport and no longer crash or silently strand the whole relay.
- Prevent delayed process-tree escalation from signaling a reused PID or process group while still cleaning descendants that survive their parent. Snapshot process identity before graceful termination, verify it before SIGKILL, bind escalation timers to tracker/session lifecycle, and cover parent-exits-first and resistant-descendant cases.
- Pin implementation-owned Git and release-control commands to absolute, executable, non-group-writable binaries outside the workspace, state root, runtime root, and user home. Fixed metadata probes remain no-shell and minimal-environment; npm lifecycle PATH and workspace shims cannot replace `git` or `gh` in security/release decisions.
- Pin the browser broker to the repository extension ID derived from `manifest.key`, verify both WebSocket Origin and `chrome.runtime.id`, split extension and runtime credentials, and migrate legacy pairing state under the maintenance lock. The extension now cleans per-socket keepalive timers and active requests on replacement, disables stale reconnect, rejects duplicate request IDs, and closes half-dead sockets on response-delivery failure.
- Make corrupt workspace trust state persistently fail closed. Only a current-schema state envelope with matching workspace hash, canonical state-root/profile/state paths, and required policy/worker/resource objects can clear `recovery-required`; recovery markers are read once and strictly validate their bounded backup name and timestamp.
- Make managed-job terminal persistence recoverable. Result, terminal status, private runtime/plan/PID/cancel cleanup, and cleanup confirmation form an ordered protocol. Result-write, status-write, and artifact-cleanup failures remain visible; status reconstruction from a valid terminal result prevents duplicate finally execution, while leftover secret/resource copies are retried by read/list/prune.
- Give security-audit and legacy authorization state true cross-process locks. State removal also detects those locks plus managed-job transition/recovery locks, preventing uninstall from deleting a profile during an active mutation. Concurrent audit writers retain every event and a continuous hash chain.
- Reject multiple-hard-link inodes at owner-only state, autostart logs, runner diagnostics, and path-based existing-file reads. Atomic overwrite remains safe because it replaces the workspace directory entry rather than modifying a shared inode.
- Upgrade delegated macOS sandbox enablement from executable-presence testing to a behavior matrix that proves workspace access and denies outside reads/writes. Current hosts where the matrix fails remain fail closed; Keychain isolation is no longer claimed without an independently verified boundary.
- Bound detached managed-job credentials and staging lifetime. Minimal plans launch the runner with a minimal control environment, explicit full-environment plans retain that choice, and unexecuted sensitive plans expire after 24 hours instead of remaining for the seven-day result-retention period.
- Preserve both primary and cleanup failures for Secure Enclave enrollment and persistent candidate activation. Local cleanup failure is returned as an `AggregateError`; transactional rollback of an already updated Cloudflare Worker and local service definition remains an explicit operational residual rather than a false guarantee.
- Add explicit 32-call stdio admission control, refresh-family revocation before replay-marker capacity eviction, constant-memory unauthorized-request body draining before rejection, trusted Windows PowerShell literal tests, browser broker load counters, function-complexity/module-size gates, and risk-directed coverage for every new boundary.

## 3.0.0-beta.4 - 2026-07-22

### Explicit daemon-ceiling reporting and fixed internal metadata execution

- Mark `3.0.0-beta.3` as blocked. Its owner activation, persistent daemon handoff, relay readiness, service restart, and ordinary owner tool calls succeeded, but live verification exposed two delegated-account defects before publication: `project_overview` could report the request-effective `custom` policy as the daemon ceiling, and reviewer/editor Git metadata calls were routed through the arbitrary-process sandbox boundary.
- Return request-effective `policy`/`tools` and daemon-ceiling `daemonPolicy`/`daemonTools` as separate local fields. The Worker now consumes the explicit ceiling fields and retains a compatibility fallback for older daemon responses, preventing a second interpretation of an already-intersected policy.
- Add a fixed internal process path for bounded implementation-owned metadata probes. It uses validated argv, no shell, an isolated minimal environment, the existing timeout/output/cancellation/process-tree accounting, and never inherits the daemon full environment. Git status, diff, log, show, and project-root detection use this path; user-selected `run_process`, registered commands, and `exec_command` remain subject to the delegated sandbox and ordinary role ceilings.
- Add real `LocalRuntime` regressions for editor project snapshots and reviewer Git metadata, a process-layer regression proving the internal path is not wrapped as delegated arbitrary execution, and Worker integration coverage that supplies distinct effective and daemon fields.
- Prevent foreground startup in an unrelated workspace or isolated state root from unloading the machine-global autostart service. Platform service control now requires a live, verified `service` daemon lock for the exact state/workspace; the installed-package smoke test traps service-manager calls and proves zero-argument startup cannot stop the operator's real daemon. This fixes the repeated relay outages observed when the full verification plan reached `install:test`.
- Make `--log-format json` authoritative for the complete logger surface. Direct `debug`/`info`/`success`/`warn`/`error` calls and persistent daemon readiness now emit one timestamped, redacted JSON object per line instead of silently falling back to unstructured text. Add regressions for stream routing, normalized levels, timestamps, and sensitive/path field redaction.
- Override Wrangler/Miniflare’s transitive `sharp` dependency from vulnerable 0.34.5 to patched 0.35.3 after GHSA-f88m-g3jw-g9cj entered the audit database. Keep Wrangler itself pinned, update the npm script allowlist, and require full Worker/Miniflare integration plus zero-high-severity audit evidence for the override.

## 3.0.0-beta.3 - 2026-07-21

### Provisioned Secure Enclave broker boundary

- Mark `3.0.0-beta.2` as blocked. Its live activation restored version 2 device-ID compatibility, but then attempted to create a persistent Secure Enclave key from a runtime-compiled, ad-hoc-signed command-line helper. Modern macOS routes Secure Enclave keys through the data-protection Keychain and rejected that helper with `errSecMissingEntitlement` (`-34018`) before Worker deployment or daemon handoff.
- Stop treating a source-built ad-hoc helper as a production trust anchor. Without an explicitly configured provisioned broker, macOS retains or creates the owner-only portable P-256 root, performs no Keychain operation, requests no user-presence prompt, and proceeds with the coordinated version 3 upgrade.
- Add opt-in Secure Enclave enrollment through `MBM_MACOS_TRUST_BROKER`. The configured absolute path must resolve to a regular executable that is not group/other writable, has a strict valid Apple code signature, carries a stable signing identifier and Team ID, and passes an end-to-end probe that creates and deletes a temporary Secure Enclave key. The enrolled root binds the canonical broker path, signing identifier, Team ID, protocol version, key tag, and public key; every later public-key check or signature revalidates that binding.
- Keep the packaged Swift source and ad-hoc build only as a development and protocol-conformance fixture. It is intentionally rejected by the production broker validator. Add cross-platform provider-selection tests, macOS signature/binding/probe regressions, and truthful `server_info` provider metadata.

## 3.0.0-beta.2 - 2026-07-21

### Version 2 device-identity compatibility

- Restore the stable RFC-style P-256 JWK member order (`crv`, `kty`, `x`, `y`) used by version 2 device identifiers. The initial beta accidentally reordered those members through a new shared canonicalization helper, causing an intact version 2 portable identity to fail before Worker or daemon handoff.
- Add an explicit backward-compatibility regression that validates a persisted version 2 identifier and rejects the incorrect beta.1 ordering. Beta.1 is blocked and must not be activated or promoted.

## 3.0.0-beta.1 - 2026-07-21

### Request-scoped authority, trusted clients, and zero-routine-prompt security

- Replace delegated terminal approval IDs and broad capability leases with a request-scoped authority intersection. Every remote request now evaluates the daemon capability ceiling, the authenticated account role ceiling, the OAuth client and refresh-token family, automatic safety invariants, and object ownership. A grant can no longer expand a reviewer, editor, or operator beyond its canonical role. Owner/full automation remains uninterrupted, but owner requests are still risk-classified and audited.
- Bind retained process output, interactive process sessions, and managed jobs to account ID, account version, OAuth client, and refresh-token family. Cross-account or stale-session reads, input, cancellation, and output access fail closed. Protected local resources cannot be smuggled into delegated managed jobs, and non-owner accounts cannot create durable execution plans.
- Enforce request-specific path visibility, unrestricted-path authority, absolute-path disclosure, and child-process environment selection throughout file, Git, Agent-context, process, and job services. Generic path-based file tools cannot read or write Machine Bridge control-plane state even under owner/full; arbitrary owner shell execution remains equivalent to the OS user and is documented as a residual risk. Delegated process execution requires a behavior-verified OS workspace sandbox; platforms where the sandbox merely exists but fails a deny-default launch probe reject delegated execution rather than silently running with local-user authority. Owner execution is unchanged.
- Remove terminal-based operation authorization from the normal CLI and runtime. OAuth client authorization is the low-frequency trust event; ordinary operations run automatically within the account ceiling. Legacy leases are ignored by runtime and remain visible only for incident-response revocation. Trusted clients bind to one account and can be listed or revoked independently without rotating every account credential.
- Propagate refresh-token family identity to the local daemon and reject relay envelopes without it. Access tokens remain fifteen minutes and rotating refresh families remain bounded. Client trust, account version, role, and family identity participate in authorization and object ownership.
- Add a privacy-preserving chained security audit. It records tool, coarse risk category, result, duration, byte counts, target digest, and keyed principal references without storing command text, paths, file contents, form values, or output. Hash-chain verification detects local corruption or alteration and is exposed through runtime diagnostics without blocking ordinary work when the audit sink is unavailable.
- Stop nonce-capacity handling from evicting live replay markers. A full replay cache now rejects new signed requests until entries expire instead of reopening the replay window.
- Replace the long-lived file-backed device signer with a root-certified ephemeral session hierarchy. macOS prefers a non-exportable Secure Enclave P-256 root protected by user presence; one root signature per daemon start certifies a 24-hour in-memory session key used for preflight, challenge authentication, reconnect, and account administration. Root migration and rotation are two-phase: a pending public key is deployed and health-verified before local promotion.
- Remove `ACCOUNT_ADMIN_SECRET` from local state and Worker secrets. Account/client administration now uses the same root-certified ephemeral P-256 session, with each request bound to origin, method, path, body hash, key ID, timestamp, and nonce. Add optional DPoP ES256 token binding for compatible clients while preserving Bearer interoperability. DPoP proof verification no longer consumes replay capacity before OAuth credential validation, preventing unauthenticated cache exhaustion; unsupported critical JWS headers are rejected.
- Remove the terminal `job approve` execution path. `stage_job` remains a validated non-running draft; execution requires trusted owner `start_job` authority or an explicit local `machine-mcp job submit PLAN.json` action.
- Add behavior-level regressions for canonical-full daemon versus delegated-role boundaries, cross-account process/job ownership, control-plane path protection, token-family binding, nonce saturation, chained audit tampering, and delegated sandbox capability probing. Expand critical-module coverage and rewrite authorization, operations, upgrade, security, and threat-model documentation around the zero-routine-prompt model.
- This is a coordinated Worker, daemon, state, and browser-extension protocol upgrade. Version 3 components must converge together; existing remote clients must authorize once again because the relay principal now requires refresh-family and trusted-client binding.
- Replace the direct-to-stable release path with mandatory `dev`/`beta`/`rc` channels, registry-verified soak, and content-preserving stable promotion. Major, minor, and patch releases require at least seven days, three days, and one day respectively. A blocking fix increments the prerelease and restarts the interval.
- Add one persistent candidate activation command that verifies the exact tarball, updates the same-name Worker, proves candidate relay readiness, hands off to the login daemon, verifies the background version, and exits while the service remains active. Add exact prerelease npm/GitHub channel checks, published-package activation records, tracked soak evidence, promotion-content digests, and stable push/release/publication gates.
- Remove the remaining internal APIs that could create version 2 capability leases. Only migration cleanup (`list`, `revoke`, `clear`) remains.

## 2.0.0 - 2026-07-21

### Device identity and usable local transaction authorization

- Replace the long-lived daemon bearer secret with an enrolled P-256 device identity. Every WebSocket upgrade now requires a signed short-lived preflight bound to Worker origin, package version, nonce, and timestamp. Its nonce is consumed once through bounded transactional state, preventing both unauthenticated candidate churn and replay of a captured preflight. The Worker then issues a fresh challenge whose signature also binds the daemon instance before tools may be advertised or a verified incumbent may be replaced.
- Fix Windows authorization tests to avoid asserting POSIX mode bits on NTFS, and record the exact expiring CodeQL assessment for the mandatory 256-bit machine-generated account credential verifier.
- Let authenticated owner sessions execute directly within the daemon policy ceiling without terminal approval, while retaining local capability leases for high-impact operations from delegated non-owner accounts. The canonical `full` profile is unchanged. Workspace-contained reads and ordinary edits, project inspection, Git, and diagnostics remain automatic. Because the extension controls an existing logged-in browser profile, one `browser-session` lease covers profile reads and actions instead of prompting per click; registered-resource input and file upload retain an independent `data-export` boundary. Compound operations must satisfy every applicable scope, so browser uploads require both scopes and protected-resource desktop input requires both application control and data export. Remote process control and continuation, outside-workspace or sensitive reads/writes, managed-job listing/output/mutation, credential operations, and application inspection/control run uninterrupted once the bound account and OAuth client hold the required time-bounded scopes. The CLI supports scoped leases and an explicit at-most-eight-hour `--full` automation window.
- Store only bounded identity/scope/time metadata and SHA-256 target digests in owner-only approval state; validate every persisted record and fail closed on malformed state. Canonicalize every patch destination, including `Move to` and symbolic-link ancestors, before classifying it, and reject final symbolic-link overwrites so classification and execution share the real target. Serialize daemon and CLI approval mutations with an owner-only process-identity lock so concurrent pending, grant, approval, revocation, and clear operations cannot silently overwrite one another. A catalog-completeness test forces every current and future tool through explicit risk review. Relay authorization now carries the authenticated OAuth client identity so leases cannot cross clients.
- Reduce access-token lifetime from 30 days to 15 minutes. Refresh tokens now have a 14-day idle limit and a 30-day family limit; reuse of a rotated refresh token revokes the complete family, including active access tokens. Consumed-token and revoked-family replay records are hard-bounded, oldest-first pruned, and record-schema validated. The first device enrollment also rotates the deployment token version so pre-2.0 credentials cannot survive the upgrade.
- Replace the account-management network bearer with per-request HMAC-SHA-256 authentication bound to Worker origin, HTTP method, path, body hash, timestamp, and random nonce. Transactional Durable Object nonce state rejects replay and fails closed when malformed; the local CLI workflow is unchanged.
- Split operation-risk classification, lease persistence, daemon authentication, refresh-family persistence, and administration authentication into focused domain modules with behavior-level tests. Document capability ceilings, transaction authorization, upgrade/rollback boundaries, residual same-user risk, and the controls deliberately left external.
- This is a coordinated Worker/daemon protocol upgrade. Version 2.0.0 components must be deployed and run together; the removed daemon bearer protocol is not retained as a compatibility bypass.

## 1.2.11 - 2026-07-20

### Bounded output continuation and repository backlog gate

- Stop large one-shot process responses from overwhelming MCP hosts. `run_process`, `run_local_command`, and `exec_command` now inline only a bounded stdout/stderr preview, retain up to 1 MiB per stream in a temporary completed process session, and return an `output_session_id` for paged `read_process` continuation. Nonzero exits keep their human error message bounded while preserving structured continuation details.
- Avoid protocol-level payload duplication by replacing the text mirror of large object results with a compact field summary while retaining the authoritative object in `structuredContent`. The fast/platform/full check runner suppresses successful child noise, preserves bounded head/tail diagnostics on failure, and supports explicit `MBM_CHECK_VERBOSE=1` streaming. Coverage cleanup now retries concurrent late V8 coverage-file writes instead of failing after the thresholds already passed.
- Resolve the release-acceptance file race by opening no-follow descriptors first, checking descriptor/path identity, and reading acceptance records and tarballs through bounded descriptors. Remove the temporary CodeQL exception and add deterministic path-replacement and symbolic-link regressions.
- Add a guarded GitHub backlog pre-push check. `npm run github:push` now blocks unrelated open pull requests and open issues not covered by a standard closing keyword in the current branch commits; the current branch PR remains updateable. Add unit and integration coverage for output paging, compact MCP projection, bounded check diagnostics, and backlog enforcement.

## 1.2.10 - 2026-07-20

### Relay interruption recovery

- Preserve an in-flight MCP tool call across a brief daemon WebSocket interruption instead of converting every transient proxy or network reset into an immediate cancellation. The Worker now detaches pending calls for a bounded 30-second grace period and rebinds them only when the same local daemon process instance completes the full authenticated readiness probe on its replacement socket.
- Keep the local operation running during that grace period and queue a completed result until the relay is ready again. Before `ready_ack`, the Worker sends an authoritative `resume_calls` set so the runtime cancels work whose client disappeared during the outage; results are replayed only for same-instance calls that still have a receiver. A different daemon instance cannot claim them, and an unrecovered outage cancels ordinary calls and process trees when the grace period expires.
- Add deterministic registry/runtime regressions and a real Worker/OAuth/MCP fault-injection test that starts a tool call, forcibly drops the daemon WebSocket, reconnects the same daemon instance, and proves the original HTTP request completes. Expose the bounded `pending_calls.detached` count for diagnosis, require a validated ephemeral daemon instance identifier in the current-version hello contract, and update architecture, logging, operations, audit, and multi-account documentation.

## 1.2.9 - 2026-07-18

- Repair cross-platform release infrastructure found by PR CI: the layered check runner now invokes the pinned npm CLI through Node instead of spawning `npm.cmd`, and `release:accept` computes and locally validates the portable Git-content digest through a temporary index so CI can verify accepted package content across merge commits without mutating the maintainer index.
- Correct the release handoff: add `npm run release:candidate:start -- --allow-worker-deploy` for an isolated local installation plus explicitly authorized in-place candidate Worker deployment, require owner-authorized and agent-operated live verification before acceptance, allow the coding agent to record acceptance and complete commit/push/tag/GitHub Release work, and add `npm run release` as the canonical source-release command. npm publication and Worker deployment remain owner-operated.

### Architecture headroom, verification feedback, and threat model

- Split tool registration, relay adaptation, path redaction, Agent-context projection/rendering, bounded skill discovery and text reading, browser request lifecycle, runtime-client broker routing, authenticated loopback server setup, browser HTTP handling, Windows launcher quoting, managed-job transition locks, runner identity, private storage, public projections, Worker OAuth authorization-page rendering, JSON-RPC framing, and WebSocket protocol cleanup out of near-limit orchestration modules. Tighten architecture budgets around the new boundaries so `runtime`, Agent context, browser broker, Windows service, managed jobs, and `BridgeRoom` retain explicit headroom instead of treating their previous line caps as targets.
- Replace the monolithic package-script chain with audited `check:fast`, `check:platform`, and `check:full` plans while keeping `npm run check` as the complete gate. Each task reports elapsed time; macOS and Windows CI run the cross-platform behavior plan plus installed-package smoke coverage, while Ubuntu runs the full coverage, browser, package, stdio, Worker/OAuth, and real-browser suites.
- Expand critical-module coverage gates to state persistence, relay lifecycle, managed jobs, runtime path redaction, Agent-context projection, browser broker/request routing, Worker OAuth, JSON-RPC framing, and WebSocket protocol helpers. Add strict checked-JavaScript coverage for the runtime path/redaction, Agent-context projection, skill-discovery, and bounded text-file boundaries. Repair a detached-process self-test race by waiting monotonically for the child PID handoff file, and remove fixed CI-job-count and implementation-location assumptions from source-shape tests.
- Replace the oversized README with a decision-oriented entry path, add a component overview and explicit threat model, document the Node 26/npm 12 support trade-off, and add a contributor first-30-minutes workflow. Security objectives, attacker classes, non-goals, and external governance gaps are now stated separately from incident and release audit history.

## 1.2.8 - 2026-07-17

### Owner-tested release gate and dependency workflow repair

- Replace the previous automation-only release assumption with an explicit repository-owner local acceptance boundary. `npm run release:candidate` runs the complete suite and creates the exact npm tarball under ignored local state; `npm run release:accept` records the owner decision only when a second pack is byte-identical. The tracked acceptance record contains package identity, SHA-1, SHA-512 integrity, timestamp, and a fixed confirmation marker, while excluding personal identity, machine paths, logs, credentials, and user content.
- Add `npm run github:push`, which rejects dirty trees, detached HEAD, direct `main` pushes, untracked acceptance records, or package-hash drift before pushing a release-relevant branch. Pull-request CI and `release:publish` independently rebuild and verify the accepted package. `release:publish` no longer pushes `main`; it requires the accepted branch to have been reviewed and merged so local `HEAD` already equals `origin/main`.
- Distinguish npm-package changes from GitHub-only repository infrastructure. The release-impact gate now derives package relevance from `package.json.files`, so Action-only Dependabot PRs no longer deadlock on an unrelated npm version bump while source, scripts, browser extension, package metadata, and shipped documentation remain versioned.
- Consolidate the five pending GitHub Action updates atomically: CodeQL `init`, `analyze`, and `upload-sarif` now use the same 4.37.1 commit; `actions/setup-node` advances to 7.0.0; and `actions/upload-artifact` advances to 7.0.1. Dependabot now groups all GitHub Action updates so coupled action families cannot be split into incompatible PRs.
- Update Wrangler from 4.111.0 to 4.112.0 and advance the exact reviewed `workerd` install-script allowlist to 1.20260714.1. Complete and production dependency audits remain at zero known vulnerabilities.
- Rewrite the release, contribution, automation, engineering, architecture, testing, and audit contracts around the owner-tested artifact boundary. Add executable regression coverage for package-impact classification, package-hash acceptance, workflow grouping, CI verification, no automatic `main` push, and package-manifest inclusion of every new helper.

## 1.2.7 - 2026-07-17

### Process supervision, lifecycle, and isolation audit

- Separate argv validation, execution limits, process-tree supervision, one-shot execution, and interactive process sessions into explicit modules. Shell helpers, managed jobs, call cancellation, runtime shutdown, and process sessions now share one graceful `SIGTERM` followed by forced tree-termination contract instead of importing session internals or maintaining duplicate platform branches.
- Reclaim an unresponsive detached service daemon only after revalidating PID, process start time, entrypoint, command line, daemon mode, workspace, and state root immediately before `SIGKILL`. PID reuse, identity drift, foreground ownership, and ambiguous records remain fail closed. Process-session termination now also escalates after a bounded grace period.
- Add a machine-readable `server_info.runtime.execution_guardrails` contract for tool-call concurrency, process timeout/stdin/output limits, process-session limits, and cleanup semantics. CPU quota, memory quota, and network isolation are reported explicitly as `not-enforced`; hard isolation still requires a dedicated account, container, or VM.
- Make browser-broker startup generation-aware so `stop()` cannot race an asynchronous listen/proxy connection and leave a listener alive. Pending proxy routes now receive a terminal error during shutdown, broker recovery failures emit structured debug events, and the local browser-health probe uses bounded direct `127.0.0.1` HTTP instead of environment-routed `fetch`.
- Reject detached managed-job launch when no process ID was obtained, attach an asynchronous child-error observer, make `shell: false` explicit, and remove duplicate plan-scrubbing logic. Correct stale relay-readiness and runtime-observability documentation, and add fault-path tests for resistant descendants, forced daemon reclamation, startup cancellation, proxy-bypassed loopback health, runner spawn failure, and honest OS-enforcement reporting.

## 1.2.6 - 2026-07-17

### Relay ready-context and implicit service-daemon takeover

- Keep end-to-end readiness fail-closed, but stop treating an incomplete inbound relay context that only carries `sessionId` as permanently unready. After a verified ready connection, the runtime consults live relay status when the per-message snapshot omits `ready`; an explicit `ready: false` snapshot still rejects tool calls. `RelayConnection` now always forwards boolean `authenticated` and `ready` with the session generation.
- Recognize managed service daemons started with only `--daemon-only` (no explicit `--workspace` / `--state-dir` on the process argv) when the lock owner already matches the active workspace state. Partial identity (one of the two path flags) remains rejected so foreign processes cannot be taken over. This allows recovery of source-tree recovery daemons that previously stayed orphaned across CLI upgrades.
- Add regression coverage for pre-ready vs ready inbound message contexts, sessionId-only dispatch after readiness, explicit `ready: false` fail-closed behavior, and implicit daemon-only stop/takeover.

## 1.2.5 - 2026-07-17

### End-to-end relay readiness and safe daemon handover

- Separate authenticated WebSocket transport from verified service readiness. A daemon now becomes externally usable only after the Worker sends a random readiness probe and receives its result through the same local message dispatch, relay-session binding, and `tool_result` delivery path used by real calls. `hello_ack` and heartbeats alone can no longer produce `daemon.connected=true` when result delivery is broken. The local runtime also rejects pre-ready tool calls and a premature `ready_ack` that was not preceded by a successfully delivered probe result.
- Keep the incumbent verified daemon active while a replacement is authenticated and probed. A failed, malformed, silent, or incompatible candidate is closed without displacing the working connection; only a successful `ready_ack` handover replaces the incumbent. Candidate hello, readiness, and steady-state liveness have independent bounded deadlines enforced by Durable Object alarms.
- Extract daemon attachment/state transitions into `DaemonSocketRegistry`, expose authenticated/probing/ready counts and readiness timestamps through `server_info`, and add fault-injection coverage for missing acknowledgements, invalid probe results, replacement races, reconnect backoff, session-generation propagation, and full OAuth/MCP/WebSocket routing.
- Correct capability ranking after the local research-skill rename: generic identity tokens such as `web`, `cli`, and `tool` no longer dominate selection, while concrete Chinese research/search intent maps to `research`, `search`, and `find`. This prevents a browser-form task from selecting a web-research skill without weakening explicit research requests.
- Remove a duplicate Worker route guard, require awaited alarm rescheduling after inbound activity, retain zero production dependency vulnerabilities, and refresh architecture, operations, logging, testing, upgrade, and audit documentation. State schema 6 and policy revision 5 remain unchanged.

## 1.2.4 - 2026-07-17

### Relay tool_result session context regression

- Pass the authenticated relay session generation into every inbound WebSocket `onMessage` callback. The 1.2.2 session-binding change discarded every `tool_result` with `session_ended` because handlers received `sessionId=0` even while heartbeats kept the socket live, so MCP tools timed out despite `daemon.connected=true`.
- Emit an explicit error when a tool result is discarded because the inbound call context lacked a session id, and include both expected and active session ids in the structured event.
- Add a regression that proves message dispatch attaches the current authenticated session generation.

## 1.2.3 - 2026-07-17

### Worker daemon false-online liveness

- Treat authenticated daemon sockets as live only when inbound traffic is recent. `role=daemon` plus `readyState=OPEN` is no longer enough after Durable Object hibernation or a half-closed transport, which previously left `daemon.connected=true` while every `tool_call` timed out.
- Persist `lastSeenAt` on daemon attachments, refresh it on `hello`, heartbeats, and `tool_result`, and reclaim silent sockets through the Durable Object alarm as well as on tool send failure or prolonged silence during a timed-out call.
- Report `daemon.last_seen_at`, `daemon.liveness_timeout_ms`, and `worker.sockets_live` from `server_info` so control-plane counters that reset on DO wake are not mistaken for live authenticated sockets.
- Add pure liveness helpers and regression coverage for fresh, silent, candidate, and legacy attachments without `lastSeenAt`.

## 1.2.2 - 2026-07-17

### Relay result lifecycle and human-readable diagnostics

- Bind every local `tool_result` to the authenticated relay session that delivered its `tool_call`. A result from a disconnected or replaced socket is discarded instead of being sent over a newer connection, and a caller cancellation marks the eventual local result as intentionally undeliverable. Routine late-result races are debug-only rather than repeated `relay.tool_result.delivery_failed` warnings; an actual synchronous WebSocket send failure still invalidates the ambiguous transport.
- Propagate MCP HTTP cancellation into the Worker pending-call registry. Incoming request cancellation removes both internal and session request-key indexes, sends a best-effort daemon cancellation, and records the call as cancelled. The Worker deployment now explicitly enables Cloudflare request-signal delivery and passthrough to the Durable Object.
- Add an `unmatched_results` Worker metric for results that arrive after their pending record was removed. Human log mode uses natural-language event messages and omits the redundant machine event key, while JSON mode retains stable event names and bounded structured fields.
- Add regression coverage for relay-session replacement, stale-result suppression, request-signal cleanup, human log rendering, compatibility flags, and unmatched-result observability. Local Wrangler integration continues to cover the complete OAuth/MCP/WebSocket flow and explicit MCP cancellation.

## 1.2.1 - 2026-07-16

### Fail-closed input contracts and bounded CLI adapters

- Eliminate prototype-chain lookup from externally controlled command, action, account-role, policy-profile, form-field, keyboard, and local-resource keys. Dispatch and enumerations now use `Map`, `Set`, `Object.hasOwn`, or null-prototype records; names such as `constructor` and `__proto__` can no longer become inherited handlers or unauthorized enum members. A malformed current-schema OAuth account role is repaired in place to a disabled reviewer account, its version is advanced, and every existing authorization code and token is revoked so an affected installation remains administrable without granting authority.
- Make Worker deployment output parsing and health verification share one canonical `workers.dev` origin validator. Wrangler output containing unrelated `/mcp`, `/healthz`, path-bearing, or wrong-name URLs is no longer accepted as deployment evidence and cannot poison the persisted URL or deployment fingerprint.
- Preserve the exact browser `maxBytes` contract for non-ASCII page source. The DOM serializer now backs off to a complete UTF-8 prefix instead of decoding a split code point into a replacement character whose encoded size exceeds the reported budget; regressions cover emoji and Chinese text at every partial-byte boundary.
- Replace ordinary browser and service CLI branch trees with named, map-driven adapters. The service adapter is independently injectable and reaches 100% function and over 90% branch coverage; architecture checks are split into module boundaries, repository hygiene, browser/security structure, and release/documentation contracts so source-shape guards remain supplemental to executable behavior tests.
- Keep local state schema 6, policy revision 5, browser pairing, resources, jobs, and Worker identity unchanged for an in-place upgrade from 1.2.0. Normal startup still converges the versioned Worker and the unpacked extension must be reloaded; no live deployment, credential rotation, daemon replacement, global installation, or npm publication is performed by this source change.

## 1.2.0 - 2026-07-16

### Typed evolution boundaries and project governance

- Split the highest-change orchestration modules along real lifecycle boundaries. Worker OAuth storage, registration, authorization, account administration, token verification, and mutation serialization now live in `OAuthController`; local runtime reporting, fixed diagnostics, and capability composition have dedicated services; Agent configuration/path validation and browser MCP operation semantics no longer share files with discovery or loopback broker transport. Persisted state schema 6, policy revision 5, token records, browser pairing, resources, and managed-job data remain unchanged for an in-place upgrade from 1.1.5.
- Make Worker TypeScript imports explicit and directly executable under Node 26, including `.ts` specifiers and JSON import attributes. Add a focused OAuth-controller state-machine suite covering registration throttling, authorization failure/success, resource-bound access tokens, expiry pruning, schema mismatch, and missing identity keys while retaining the real workerd OAuth/MCP integration.
- Add a strict checked-JavaScript contract gate for local policy, call lifecycle, Agent configuration and path containment, browser handshake parsing, capability ranking, monotonic deadlines, record/number normalization, and bounded metadata reads. Expand correctness linting to reject async Promise executors, returned Promise-executor values, unsafe `finally`, useless catches, invalid `typeof`, self-assignment, and invalid NaN comparisons, and unused imports/variables; fix every newly detected occurrence rather than waiving the rules.
- Raise risk-directed coverage gates and include Agent, browser, runtime-boundary, and OAuth-controller fixtures. Worker pending-call and policy modules now have branch floors; the extracted runtime reporting, diagnostics, capability, browser operation, browser protocol, Agent contract, and capability-ranking modules have independent function and branch minima. Lower architecture line caps prevent the orchestration modules from regaining the extracted responsibilities.
- Add a five-minute README path, explicit Node 26/npm 12 support boundaries, a current-only upgrade and rollback contract, support/reporting guidance, project governance and succession rules, and a code of conduct. The first control required after a second active maintainer joins is non-author and last-push approval for security-sensitive code and release surfaces.
- Preserve release and supply-chain behavior: no live npm publication, Worker deployment, secret rotation, or daemon/service replacement is performed by this source release. Trusted npm publishing with GitHub OIDC still requires the external package-owner trust relationship and remains the next publication-control improvement.

## 1.1.5 - 2026-07-16

### Windows autostart and persisted network environment

- Replace the oversized Windows Scheduled Task `/TR` invocation with a short private launcher. The launcher contains the full quoted Node/CLI/workspace argv, routes output to the normal service logs, exits on success, and restarts nonzero daemon exits after five seconds. Register it for current-user logon at `LIMITED` run level, and reject a custom state path when even the short action exceeds Task Scheduler's 262-character boundary.
- Query Windows task state and last result through fixed PowerShell object properties instead of localized `schtasks` text. Creation, start, stop, and removal are verified against observed state; an installed `Ready` task is no longer reported as active, and localized nonzero stop/delete output cannot create a false failure after the requested state is reached. Default reboot recovery occurs after that Windows user signs in, not before login or as `SYSTEM`.
- Persist an owner-only allowlist of proxy and custom-CA environment variables for autostart daemons. Session-only PowerShell proxy settings now survive logon/reboot, environment-free later starts do not erase them, explicit case-insensitive replacements remove stale variants, and status/logging expose only configured key names. Unrelated environment secrets, oversized values, and control characters are rejected.
- Extend Worker idempotency coverage through a real disk-state reload to prove that a successful Wrangler upload followed by health timeout is not repeated by a new process. Clarify that a different canonical `--workspace` intentionally selects a different profile and Worker, and add terminal guidance to rotate any one-time account password exposed in shared output.
- Refresh the exact `ws` and Wrangler pins. The `ws` patch tightens fragment buffering limits, while Wrangler advances its bundled `workerd`; update the reviewed install-script allowlist to the exact new `workerd` version and retain zero high-severity or production audit findings.

## 1.1.4 - 2026-07-15

### File integrity and contract corrections

- Preserve exact UTF-8 line endings in `read_file` whole-file and line-range results. CRLF files no longer return LF-normalized content paired with a SHA-256 value for different text.
- Flush workspace write and patch staging files through their open descriptors before atomic commit, remove partial staging files after failed writes, and report incomplete staging cleanup instead of leaving hidden residual data silently. This aligns `write_file`, `edit_file`, and `apply_patch` with the documented durability contract while retaining exact POSIX mode application.
- Surface incomplete `apply_patch` rollback as an explicit recovery error, and return a warning when a committed transaction cannot remove an internal staging or backup artifact instead of silently hiding residual workspace state.
- Enforce the documented 3-64 character account-name rule for newly created accounts in both the local administration client and Worker. Existing one-character accounts created by older versions remain discoverable for login and administration.
- Correct CLI `--json` guidance to state that a newly generated account password is intentionally included once during initial creation or rotation; stored administration, daemon, and token-version secrets remain omitted.

## 1.1.3 - 2026-07-15

### Copilot Studio final OAuth callback

- Complete the Power Platform browser callback chain by allowing `https://copilotstudio.microsoft.com` only when the already validated OAuth redirect URI belongs to Microsoft's HTTPS `consent.azure-apim.net` domain. Copilot Studio redirects global consent to a regional consent endpoint and then to its own `/connection/oauth/redirect` page; Chromium applies the originating authorization page's `form-action` policy across every hop.
- Preserve the narrow security boundary: ordinary OAuth clients still receive only `'self'` plus their exact validated redirect origin, Microsoft consent callbacks retain the consent-subdomain allowance, and lookalike domains receive neither the regional nor Copilot Studio exception.
- Extend the real Chrome regression to prove four policy states: self-only blocks the first callback, global-only blocks the regional handoff, global-plus-regional blocks the final Studio handoff, and the complete policy preserves `code` and `state` through the entire chain.

## 1.1.2 - 2026-07-15

### Copilot Studio regional OAuth callback

- Allow a validated Microsoft `consent.azure-apim.net` OAuth callback to continue through Power Platform's HTTPS regional consent subdomains. Chromium applies the authorization page's `form-action` policy across redirects; the previous exact-global-origin policy let the Worker issue a valid authorization code but blocked Microsoft's `global` to `asia-001` handoff before token exchange, leaving Copilot Studio disconnected.
- Keep the exception narrow: every authorization page still allows only `'self'` and its exact validated redirect origin, and only callbacks already validated on the Microsoft consent domain receive `https://*.consent.azure-apim.net`. Other OAuth clients, CORS rules, redirect binding, PKCE, account authentication, and token validation are unchanged.
- Add Worker integration coverage for the Copilot Studio CSP and a real headless-Chrome three-stage regression proving that self-only policy blocks the first callback, exact-first-hop policy blocks the regional redirect, and the completed policy preserves `code` and `state` through the two-hop chain.

## 1.1.1 - 2026-07-15

### Windows Worker deployment convergence

- Make Worker health probes use the same standard `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` routing model as the relay. The previous direct `fetch` probe could time out on Windows or managed networks after Wrangler had already completed a valid deployment. Restrict probes to the recorded HTTPS `workers.dev` origin and reject redirects so persisted state cannot redirect the verifier to an arbitrary network target.
- Persist the successful Wrangler deployment URL, content/secret fingerprint, and deployed package version before the secondary health probe. A timeout, proxy failure, TLS failure, network failure, or temporary HTTP 5xx response now stops with corrective guidance and a later start verifies the same Worker instead of uploading it again; only bounded, definitive stale-version/identity evidence triggers automatic same-name redeployment.
- Prevent accidental Worker proliferation by rejecting a changed `--worker-name` for an initialized workspace unless `--force-worker` explicitly authorizes the replacement. Retain prior names in local inventory so full uninstall can delete intentionally replaced Workers. Add a real local CONNECT-proxy regression, deployment ambiguity/idempotency tests, worker-name replacement tests, expanded CLI/state coverage, and higher critical-module coverage floors.

## 1.1.0 - 2026-07-15

### Claude and Microsoft Copilot Studio remote MCP

- Add hosted-client OAuth interoperability for Claude custom connectors and Microsoft Copilot Studio while preserving the existing Streamable HTTP transport and current MCP protocol contract. Authorization-server and protected-resource discovery now advertise `offline_access` and the refresh-token grant; dynamic client registration declares both authorization-code and refresh-token grants.
- Issue hashed access and refresh-token records from authorization-code exchange. Public-client refresh requests are form-encoded, bound to the original client/account/version/role/scope/resource, and rotate the refresh token atomically. Reuse, expiry, account changes, or deployment token-version changes return `invalid_grant`. Refresh state uses a separate versioned Durable Object key, so existing primary OAuth state does not require migration. The per-source DCR throttle now counts only registrations that have not completed authorization, preventing legitimate Claude or Copilot reconnections from consuming the abuse quota while retaining the deployment-wide client cap.
- Exercise the exact hosted Claude callback, the unauthenticated `resource_metadata` challenge, discovery/DCR metadata, refreshed MCP access, refresh replay rejection, and account-targeted refresh revocation in the real Worker integration. Document Claude and Copilot Studio setup, and retain the narrow ChatGPT/Grok browser CORS set because Claude and Copilot Studio connect through cloud-side infrastructure rather than browser-origin response sharing.

## 1.0.8 - 2026-07-14

### Effective account authority reporting

- Separate the authenticated account authority from the local daemon capability ceiling in remote diagnostics. `server_info.authorization.effective_policy` and `effective_tools` are now the authoritative account fields, while `daemon.policy` and `daemon.tools` are explicitly scoped as pre-role ceilings. The response also includes a deterministic authority summary and scope labels so clients cannot reasonably equate an `editor` account with a `full` daemon.
- Make remote `project_overview` return the role-intersected policy and tools at its existing top-level fields, while preserving the daemon values separately as `daemonPolicy` and `daemonTools`. Add a Worker integration regression that authorizes an `editor` account against a canonical `full` daemon and proves shell/browser tools remain excluded at both reporting surfaces and at relay enforcement.
- Update MCP initialization guidance, tool descriptions, operations diagnostics, architecture, client, account, testing, and generated tool-reference documentation to use the effective-account fields when diagnosing permissions.

## 1.0.7 - 2026-07-14

### Browser-complete OAuth callback navigation

- Fix the authorization page CSP so a successful same-origin form POST may follow its `303 See Other` to the exact, already registered and validated OAuth redirect origin. The previous static `form-action 'self'` policy let the Worker issue a correct redirect but caused Chromium to block the callback navigation and leave the user on the consent page.
- Keep the policy narrow: each consent page receives only `'self'` plus that request's exact redirect origin, never a wildcard or scheme-wide allowance. Add a real headless-Chrome negative/positive regression proving the old policy blocks the callback and the new policy preserves `code` and `state`; retain Worker-level CSP, PKCE, redirect/resource, password, and token tests. Invalid credentials now preserve only the non-secret account name and display an accessible error while never reflecting the password.

## 1.0.6 - 2026-07-14

### OAuth navigation origin handling

- Stop treating the browser `Origin` header as an authentication boundary for actual Worker requests. OAuth authorization navigations and form submissions from opaque or client-specific browser containers now reach normal protocol validation instead of failing early with `origin_not_allowed`.
- Keep CORS response sharing strict: only the Worker origin, the built-in ChatGPT/Grok origins, and exact `MBM_ALLOWED_ORIGINS` additions pass preflight and receive `Access-Control-Allow-Origin`. Unrelated and `null` origins receive no CORS permission, while PKCE, exact redirect/resource binding, account authentication, bearer tokens, and admin/daemon secrets remain authoritative.

## 1.0.5 - 2026-07-14

### Built-in ChatGPT and Grok origins

- Allow the exact first-party browser origins used by ChatGPT (`https://chatgpt.com` and legacy `https://chat.openai.com`) and Grok (`https://grok.com` and `https://x.com`) directly in Worker origin validation. Users no longer need to run Wrangler or edit Cloudflare variables to complete OAuth from those clients.
- Keep `MBM_ALLOWED_ORIGINS` as an additive exact-origin extension point, preserve same-origin and no-Origin requests, reject unrelated and `null` origins, and apply one predicate to preflight and actual requests. Integration tests exercise every built-in origin alongside a configured custom origin.

## 1.0.4 - 2026-07-14

### Windows first-run workspace

- Keep the first interactive workspace question on Windows, but default it to `%USERPROFILE%\MachineBridge` instead of the Command Prompt current directory. Pressing Enter creates, canonicalizes, and remembers that folder, so users do not need `cd` or directory knowledge and an elevated prompt cannot accidentally select `C:\Windows\System32`.
- Preserve explicit `--workspace` semantics for automation, while allowing an interactively entered Windows workspace folder to be created when it does not yet exist. The installed zero-argument startup test now verifies the remembered platform default.

## 1.0.3 - 2026-07-14

### Code-scanning and supply-chain integrity

- Fix the SARIF gate so results with omitted rule metadata fail closed instead of being silently classified as non-security. Remove stale broad CodeQL exceptions, harden the generic process boundary with a fixed-option non-shell `child_process.spawn` wrapper and behavior regression, and retain only one exact, expiring false-positive record for that intentional authority boundary.
- Gate OpenSSF Scorecard SARIF before upload. Replace mutable npm bootstrap commands with an exact npm 12.0.1 tarball plus pinned SHA-512 verification, make the source wrapper use `npm ci`, and convert randomized security properties to a deterministic `fast-check` `.js` suite recognized by the pinned Scorecard scanner, and separate the signed Scorecard analysis job from the failing SARIF gate job required by the action's workflow-verification rules.
- Record only four expiring Scorecard governance/time exceptions that cannot be repaired by source code alone, reject remediable pinning/fuzzing exceptions, and require exact-commit CI, CodeQL, Governance, and Scorecard success before creating a source release.

## 1.0.2 - 2026-07-14

### Deadline and architecture integrity

- Replace wall-clock arithmetic in startup-lock waits, verified daemon takeover/stop, process-session exit waits, managed-job recovery-lock handoff, full-access diagnostics, browser waits, page actionability/stability checks, application-discovery cache freshness, and local/Worker duration metrics with monotonic elapsed time. System clock rollback can no longer extend these bounded state machines, and a forward correction cannot force premature timeout; persisted expiry and retention timestamps remain wall-clock based.
- Add deterministic clock-fault regressions at the shared deadline primitive, startup-lock production path, and browser-extension production path, and make the deadline suite a mandatory part of `npm run check`.
- Correct stale architecture claims after the state-schema-6 and named-account releases: remote tokens are bound to named account principals and roles, duplicate JSON-RPC ids are scoped to one signed MCP session, and application-level account isolation is distinguished from OS/browser tenancy. Architecture tests reject a return to the obsolete statements.

## 1.0.1 - 2026-07-14

### Startup and release-gate reliability

- Fix two production CLI references that were used without imports: `readdirSync` in the default Worker deployment fingerprint path and `inspectProcessInstance` in secret rotation. The former made a freshly installed 1.0.0 package fail immediately on zero-argument startup even though syntax, package, and cross-platform CI checks were green.
- Fix the Windows Wrangler execution boundary uncovered by the new startup probe. Runtime code no longer passes `wrangler.cmd` to `spawn(..., { shell: false })`, which fails with `EINVAL` on Node 26; it invokes the dependency's declared JavaScript entrypoint through the current Node executable on every platform. A focused regression and the installed startup probe prevent a return to shell shims.
- Add an ESLint correctness gate over Node production code, tests, scripts, and the packaged browser extension. Undefined identifiers, redeclarations, duplicate keys, unreachable statements, and non-loop constant conditions now fail `npm run check` before packaging or publication. A configuration self-test injects synthetic undefined Node/browser bindings so retaining a no-op or mis-scoped lint script cannot satisfy the gate.
- Strengthen `install:test` to install the real `npm pack` tarball into an isolated global prefix and execute the installed CLI with zero arguments from a package-free workspace and isolated state root. A cross-platform fake Wrangler shim provides a controlled external boundary; the test requires state initialization, rejects `ReferenceError`/`is not defined`, and proves that default startup reaches Worker orchestration rather than only supporting `--version`.
- Make both static lint and the installed zero-argument startup probe mandatory parts of the complete local, prepublish, Linux, macOS, and Windows release gate. Architecture checks prevent either gate from being removed silently and now enforce the existing exact-semver dependency policy instead of leaving it as documentation only.

## 1.0.0 - 2026-07-14

### Current-only protocol and runtime contract

- Declare only MCP protocol `2025-11-25` across shared metadata, stdio, the local runtime, daemon handshakes, and the Cloudflare Worker. Older protocol dates are no longer advertised as supported; clients must negotiate the current protocol before invoking tools.
- Add stateless, HMAC-bound `MCP-Session-Id` issuance. Concurrent chat windows using the same OAuth token now have independent JSON-RPC request-id and cancellation domains; sessionless independent POST requests no longer share a token-wide request-id lock.
- Make terminal relay delivery fail closed: when a completed daemon call cannot return its `tool_result`, the daemon interrupts the ambiguous socket so Worker socket cleanup releases pending calls immediately instead of retaining a phantom active call until its long timeout.
- Remove numeric-only managed-job lock interpretation and the remaining dead compatibility branches, unused imports, unreachable conditions, and stale orchestration variables. Current JSON ownership records with process start identity and random tokens are the only accepted lock contract.
- Keep the current local state schema intact so an existing 0.18.x state root upgrades in place. The source upgrade remains operationally bounded: install the new package, run one normal `machine-mcp` startup to converge Worker and daemon versions, then reload the unpacked browser extension.

### Descriptor-first file and process security

- Centralize regular-file opens behind a no-follow descriptor primitive that validates the opened object, applies permissions through the descriptor, and performs bounded reads without a separate path check. State, privacy scanning, service logs, managed-job diagnostics, and owner-only files now use this boundary.
- Inspect SSH key pairs from private, bounded snapshots copied into a private temporary directory. Fingerprinting and public/private correspondence no longer operate on mutable caller paths, and the original files are revalidated by identity and constant-time byte comparison before success is returned.
- Fix managed-job recovery handoff so the recovery runner must remove `recovery.lock` with the exact handed-off PID and ownership token. It can no longer delete a replacement claim by path alone.
- Separate the internal `runExecutable` argv boundary from explicit shell execution, bound executable/argv sizes, reject NUL bytes, and retain `shell: false` for direct execution. Worker deployment consistency now uses an HMAC fingerprint keyed by deployment secrets rather than an ordinary digest over secret values.

### Enforced security evidence

- Extend classified Windows atomic-replacement retries from 16 to 32 bounded attempts after hosted Windows runners reproduced an `EPERM` sharing window beyond the previous budget. The algorithm still uses one same-directory atomic rename, exponential backoff with jitter, and no delete-destination fallback.
- Move the repository's local GitHub control-plane prohibition into shared MCP initialization and built-in working agreements so it is visible before project-specific task execution. If local Machine Bridge `git`/`gh` access is unavailable, automation must stop rather than fall back to a hosted GitHub connector or ChatGPT plugin. Align `ENGINEERING.md` and `CONTRIBUTING.md` with the source-release ownership contract.
- Fail closed when owner-only directories are symlinks, non-directories, cannot be restricted to `0700` on POSIX, or remain group/other-accessible. Extract Worker deployment secret-file lifecycle from the CLI, bind temporary names to process-start identity, delete only positively reclaimable stale files, and surface cleanup failures instead of silently retaining management secrets.
- Apply the same private-directory boundary to browser pairing, fail managed-job launch when existing diagnostic logs cannot be safely trimmed, and roll back POSIX file/patch commits when exact mode application fails. State-root removal now blocks on unreadable, malformed, symbolic-link, oversized, or otherwise unverifiable config/profile/daemon records instead of treating them as absent.
- Remove the unused local error factory and default-role constant and make internal-only protocol, pairing, instruction, file, and OAuth helpers non-exported, reducing dead and misleading module surface.

- Add a SARIF security gate to the required CodeQL workflow. Any new security-tagged result fails the required check; intentional high-authority process boundaries require an exact rule/path exception with a substantive rationale and expiry date.
- Add deterministic property tests over hostile browser-protocol bytes, policy combinations, argv values, and shell-metacharacter arguments. Add production-path service command coverage and remove test-only filesystem check/use patterns that obscured CodeQL results.
- Preserve the complete cross-platform, Worker, stdio, browser, lifecycle, atomic-file, process-tree, package, privacy-history, dependency, and release-integrity suite as the release gate.

## 0.18.1 - 2026-07-14

### Fixed

- Wait for launchd service state to converge after a successful `bootout` before deciding that stop or restart failed. The bounded poll handles macOS's asynchronous unload window while still failing closed when the service remains active.
- Add deterministic coverage for delayed launchd inactivity and for the bounded failure path.

## 0.18.0 - 2026-07-14

### Isolated multi-account authorization

- Replace the workspace-wide shared OAuth password with named accounts and four roles: reviewer, editor, operator, and owner. OAuth codes and tokens are bound to one account id, account version, and role; account changes revoke only that account's credentials.
- Intersect each account role with the connected daemon policy when listing or invoking tools. The Worker rejects unauthorized tools before relay, and every relayed call carries immutable account authorization metadata for a second local enforcement check.
- Add owner-only account administration for listing, creating, enabling, disabling, changing roles, rotating passwords, and removing accounts. Passwords are generated 256-bit tokens stored as independent salted HMAC-SHA-256 verifiers; arbitrary human-chosen passwords are rejected, plaintext tokens are shown once, and they are not retained in local state.
- Upgrade the existing Cloudflare Worker and Durable Object in place. A one-time release operation converts the current shared credential into the initial owner account and annotates existing OAuth codes and tokens without changing their keys or the global token version, preserving the existing ChatGPT connector authorization.

### Runtime reliability and diagnostics

- Cancel all relay-owned local calls immediately when the relay disconnects. Process execution now rejects cancellation before a child emits `close`, while process ownership remains tracked until actual exit, preventing permanently active calls without losing process cleanup.
- Replace prefix-only command capture with bounded beginning-and-end retention. Long stdout and stderr report exact omitted byte counts and preserve the diagnostic tail where test and compiler failures normally appear.
- Consume rejected authenticated MCP request bodies before returning 401, preventing workerd request-stream exceptions after per-account token revocation.

### Breaking state and maintenance model

- Advance local state to schema 6, the state-root marker to schema 2, and policy to revision 5. Final runtime code accepts only the current formats; valid obsolete state is rejected instead of migrated, while syntactically corrupt JSON is isolated and rebuilt as current empty state.
- Remove shared-password CLI flags, policy migration branches, old daemon-lock interpretation, numeric managed-job PID compatibility, and old log-format archival. The one-time in-place release operation updates live state and deletes obsolete artifacts before the final runtime is installed.

## 0.17.1 - 2026-07-14

### Installation and first use

- Add an end-to-end installation and first-use guide covering transport selection, authority profiles, prerequisites, released and source installation, first remote deployment, current ChatGPT developer-mode connection, stdio configuration, existing-profile browser pairing, verification, routine operation, multi-workspace use, upgrades, layered troubleshooting, and fail-closed removal.
- Link the detailed guide from the README while retaining the compact command reference, and clarify how to distinguish package, Cloudflare, daemon, MCP-host, operating-system, and browser failures.

### Multi-client and multi-account boundary

- Document that the existing Worker supports multiple OAuth client registrations and access tokens but does not provide isolated human/service accounts: all successful authorizations use one per-workspace connection password and share the same policy and daemon authority.
- Define a principal-aware evolution path that keeps OAuth clients separate from principals, memberships, and named grants; uses capability intersection and dual Worker/local enforcement; adds targeted revocation and per-principal quotas; and retains one bridge/Durable Object per workspace or trust domain.
- Make the security and architecture contracts explicit: mutually untrusted users require separate bridge instances and preferably separate low-privilege OS, container, or VM boundaries because application-level roles cannot isolate local process, shell, browser, or credential-store authority.

## 0.17.0 - 2026-07-13

### Project governance and contribution flow

- Define a risk-based project standard covering GitHub Flow, Conventional Commits, architecture boundaries, MCP contract ownership, testing, errors, logging, supply-chain security, documentation, review, and explicit exceptions. Add pull-request and structured issue templates plus area ownership through CODEOWNERS.
- Add an executable Conventional Commit policy for pull-request and main-branch commit titles. Keep the repository on squash-based GitHub Flow rather than introducing permanent develop/release branches that do not match its single-maintainer, continuously released operating model.
- Require all repository-host operations to use local `git`, `gh`, and `gh api` through Machine Bridge. Explicitly prohibit hosted GitHub connectors or ChatGPT GitHub plugins so remote mutations, credentials, refs, checks, and recovery remain observable from one local control plane.
- Make repository automation responsible for closing the source-change lifecycle: after all required checks pass it squash-merges the pull request, verifies `main`, creates and pushes the annotated version tag, and creates or updates the matching GitHub Release. npm publication, Worker deployment, credentials, global installation, and daemon/service replacement remain separately authorized live operations.

### Generated contracts and security automation

- Generate a complete MCP tool reference from the shared tool catalog and reject stale output in the required suite. The tool catalog remains the single source for names, availability, annotations, and JSON input schemas; REST-specific Swagger documentation is not duplicated for the MCP surface.
- Add pinned, least-privilege GitHub workflows for CodeQL analysis, pull-request dependency review, OpenSSF Scorecard publication, and governance checks. Preserve exact dependency versions, registry signature/attestation verification, SBOM generation, history privacy scanning, and cross-platform package tests.

### Cohesion, reuse, and runtime reliability

- Extract optional project-metadata reads, strict integer normalization, plain-record validation, and uninstall/service state inventory into focused shared modules. Remove duplicate numeric clamping, record classification, and no-follow UTF-8 metadata readers while preserving the distinct strict validation semantics used by browser/application commands and Agent Context instruction files. Plain-record validation now rejects class instances instead of treating every non-array object as protocol/configuration data.
- Reduce the CLI entrypoint from 1,169 to 1,063 lines by moving profile, Worker, active-job, and process-lock inventory behind a dedicated boundary. Add direct failure-path tests and enforce 91% function/73% branch coverage for the new inventory module; raise the CLI branch floor from 5% to 10%.
- Canonicalize existing state roots before profile enumeration, fixing macOS `/var` versus `/private/var` alias mismatches that could make service removal or lock inspection report inconsistent profile paths. Retry only the final daemon-lock handoff after a verified service stop, and keep daemon fixture subprocesses out of V8 coverage so process teardown does not create platform-timing failures.
- Generate Wrangler environment declarations through a cross-platform script that creates ignored `.wrangler/` state before invoking Wrangler, instead of writing under `src/worker`; packaging tests reject generated type declarations. This removes clean-runner state dependence and reduces the dry-run package from about 410 KB/1.8 MB unpacked to about 314 KB/1.22 MB while retaining every Worker runtime module.
- Replace repeated empty WebSocket send/close catches in the Worker and browser extension with small module-local best-effort helpers whose comments preserve the primary failure semantics. Architecture checks reject unexplained empty catches on those protocol boundaries.

### Tests and documentation

- Extend architecture checks to require generated tool documentation, governance scripts, security workflows, explicit workflow permissions, immutable Action references, and rejection of privileged pull-request triggers or write-all permissions.
- Document why aggregate 80% coverage is not a sufficient quality target, identify the current CLI orchestration branch-coverage weakness, and retain per-module risk thresholds plus behavior-level cross-platform, concurrency, fault-injection, and protocol tests.

## 0.16.2 - 2026-07-13

### Fixed

- Package the entire `src/worker` directory (instead of just `src/worker/index.ts`) in the published npm package so that global installations have all files required to compile/deploy the Worker.
- Add regression coverage in packaging tests to verify all worker modules are present.

## 0.16.1 - 2026-07-13

### Fixed

- Fix `machine-mcp` startup after 0.16.0 by keeping normalized policy capabilities immutable while allowing the sealed CLI-owned state record to update persistence metadata.
- Add regression coverage proving `updatedAt` remains writable without permitting capability fields or undeclared fields to be mutated.

## 0.16.0 - 2026-07-13

### Runtime boundaries and lifecycle

- Replace the monolithic local tool dispatcher with a middleware-based execution pipeline covering policy authorization, bounded call registration, cancellation/deadlines, stable error normalization, structured lifecycle events, and per-tool metrics. Add explicit runtime lifecycle states and a process tracker so stop/cancel paths release calls and child ownership deterministically.
- Extract workspace filesystem transactions, process/shell execution, Git operations, CLI option/policy parsing, local resource/browser/job administration, capability ranking, managed-job plan/resource validation, browser extension protocol handling, and browser pairing persistence into focused modules. Add executable line-count and dependency-direction limits so these responsibilities cannot silently return to `LocalRuntime`, the CLI entrypoint, or browser manager.
- Split the Worker Durable Object into HTTP/CORS boundaries, OAuth state/PKCE helpers, shared policy evaluation, structured errors, pending-call indexing, and observability. Replace the linear pending-call scan with an atomic ID/request-key registry so completed, cancelled, timed-out, send-failed, and disconnected calls clear both indexes before settling; JSON-RPC request IDs can be reused immediately after completion.

### Policy, errors, logging, and observability

- Define policy revision 4 in one shared contract consumed by the local daemon, Worker, generated documentation, tests, and architecture checks. Fix `start_job` to require both write and direct-execution capabilities, keep `cancel_job` write-gated, and expose read-only resource/job inventory to review-mode clients without granting mutation authority.
- Introduce typed `BridgeError`/Worker errors with allowlisted stable codes and retryability. Centralize legacy error classification at adapters instead of making transports and tests depend on free-form English messages. Unknown programming errors are no longer silently converted into ordinary managed-resource unavailability; a failing timeout callback still settles and clears its pending indexes.
- Add structured JSON lifecycle logging and in-memory observability for calls, durations, errors, active processes, pending request indexes, daemon candidates, socket transitions, and per-tool outcomes. Autostart services now use warning-level JSON logs by default while foreground output remains human-readable; local and Worker structured-field redaction is behavior-tested.

### Tests, documentation, and audit follow-up

- Add behavior tests for policy parity, compound ACLs, middleware order, runtime lifecycle transitions, process ownership, pending-ID reuse, socket cleanup, Worker/local error serialization, structured log privacy, bilingual capability ranking, and generated policy documentation. Replace brittle source-string and monkeypatched happy-path tests with production-path deadline, process-tree, OAuth/MCP, and resource-reload coverage.
- Add a critical-module V8 coverage gate with per-module function/branch baselines, rather than a single aggregate percentage that hides weak orchestration coverage. Generate `docs/POLICY_REFERENCE.md` from the shared policy contract and tool catalog; CI rejects stale generated documentation.
- Correct an extraction defect where a re-exported resource inspector was not locally bound and a broad catch disguised the resulting `ReferenceError` as `resource_unavailable`. File availability now degrades only for classified filesystem conditions; unexpected implementation faults remain visible.

## 0.15.0 - 2026-07-13

### Daily-profile browser verification and protocol safety

- Verify the unpacked extension in the user's ordinary Chrome profile with a localhost-only live smoke test covering the acknowledged protocol handshake, real tab lifecycle, semantic inspection, open Shadow DOM, complex form fill, fixed DevTools text/click input, waits, screenshot capture, and cleanup. `browser status` and loopback health now report extension version/protocol, that Machine Bridge did not launch the browser, and the fact that daily-vs-isolated profile identity is not machine-verifiable.
- Upgrade the extension protocol to an acknowledged `hello`/`hello_ack` state machine with exact packaged-version, protocol, and capability equality. WebSocket open is no longer treated as authenticated readiness, pairing material is persisted only after a successful capability handshake, failed candidate pairing preserves the prior configuration, pairing-page and broker ports must match, and extension WebSocket origins require a canonical 32-character Chromium extension ID.
- Prevent duplicate side effects after an ambiguous trusted-input failure. `auto` falls back to DOM only before any DevTools `Input` command starts; after dispatch begins, the operation fails with an explicit unknown-outcome instruction to inspect the page before retrying. Screenshot capture temporarily activates only the requested tab, never focuses its window, and restores the previous active tab unless the user changed it concurrently.

### Bounded page processing and extension architecture

- Apply `max_bytes` and `max_elements` as aggregate request budgets across at most 64 accessible frames. Replace full `outerHTML` construction with a bounded iterative DOM serializer, cap page scans at 100,000 nodes, bound page-controlled metadata/text, cap reusable refs at 10,000 per frame, redact URL userinfo, mark contenteditable secret controls as sensitive, and report frame/node/text/ref truncation explicitly.
- Report partial multi-field form mutation precisely when a later field or submission fails. Navigation waits now inherit the bounded request deadline rather than using a hidden fixed 30-second timer.
- Extract tab/page/wait/source/screenshot orchestration into fixed `browser-operations.js`; the Manifest V3 service worker now owns only pairing, transport, acknowledged readiness, cancellation, and response routing. Architecture tests enforce this responsibility boundary.

### Cross-platform audit and regression coverage

- Replace ad-hoc Windows Scheduled Task argument quoting with the Windows CRT-compatible backslash/quote algorithm, including drive-root and trailing-backslash paths.
- Add behavior tests for handshake readiness, provisional pairing persistence, trusted-input replay prevention, focus restoration, aggregate frame/source budgets, hostile DOM/text bounds, partial form failure, strict extension origins, and Windows command-line quoting. Synchronize architecture, security, operations, testing, audit, and tool documentation.

## 0.14.0 - 2026-07-13

### Windows installation and OAuth callback reliability

- Bootstrap installation through pinned npm 12.0.1 from an empty temporary directory before using `--allow-scripts`, declare the npm 12 requirement in package `engines`, and make `machine-mcp doctor` verify the active npm version. This removes the unsupported old-npm path shown by Windows and gives accurate diagnostics for `Unknown cli config "--allow-scripts"` and legacy `devEngines.node` errors without guessing which package supplied the invalid metadata.
- Construct OAuth callback destinations with the URL API and return `303 See Other` after consent instead of manually concatenating a `Location` string. Add an end-to-end ChatGPT callback regression with reserved state characters and exact origin/path checks.
- Extend the isolated install smoke test to require npm 12, install from an empty directory, verify the packaged npm engine requirement, and run the test on Linux, macOS, and Windows CI.

### Existing-profile browser automation

- Keep the authenticated Manifest V3 extension as the primary browser backend so automation operates the user's ordinary Chromium profile, tabs, extensions, cookies, and login state instead of launching a separate profile. Add tab creation/activation/closure and explicit combined waits for URL, document readiness, page text, and element state.
- Replace fragile inspect-then-selector flows with bounded semantic snapshots containing stable per-document/frame element references, visibility/enabled/editable state, and viewport geometry. Page actions now wait for attachment, visibility, enabled/editable state, geometric stability, and unobscured pointer hit targets; ambiguous selectors and stale references fail explicitly.
- Add double-click, hover, append-text, and scroll-into-view actions. Top-frame click, double-click, hover, key press, and text input can use fixed short-lived Chromium DevTools Input commands through explicit `auto`, `trusted`, or `dom` modes. The extension exposes no caller-selected CDP method or arbitrary JavaScript and detaches the debugger in `finally`.

### Architecture, security, tests, and documentation

- Extract browser command normalization into a focused local module and isolate trusted input in a fixed extension module. Add a versioned extension capability handshake, stale-build reload guidance, explicit keepalive handling, and replacement validation that preserves the current compatible connection until the candidate is accepted; accepted replacements reject in-flight direct and proxied requests with retry guidance instead of leaving them to time out. Preserve resource-backed secrets/files, strict action/value validation, bounded broker messages, cancellation, source limits, and the existing owner-only pairing model.
- Add behavior-level tests for command contracts, trusted-input command sequences and cleanup, semantic-ref stability, deterministic scrolling, obscured-target waiting, stale refs, broker routing, catalog parity, and architecture invariants. Update browser setup, permission, security, architecture, testing, and tool documentation.

## 0.13.0 - 2026-07-13

### Automatic capability routing and observability

- Register bounded `package.*` commands from safe root `package.json` script names, while preserving explicit manifest override/deletion and never injecting script bodies. Windows uses a fixed `cmd.exe` wrapper for package-manager shims; Unix keeps direct executable argv. Extend default skill discovery to project `.codex/skills` and unrestricted `CODEX_HOME/skills` compatibility roots.
- Match installed applications by their actual names for every canonical-full task instead of requiring generic “app/window” words, with a bounded discovery cache to avoid repeated filesystem scans.
- Normalize a bounded set of common English inflections and Chinese workflow intents before skill/command ranking, and weight capability-name matches above incidental description overlap. This fixes Chinese selection of `skill-creator`, `web-research-cli`, and `skill-installer` and prevents generic “create” wording from preferring unrelated design skills.
- Record privacy-preserving bootstrap and task-resolution telemetry in `server_info` and `project_overview`: counts, timestamps, source/load flags, selected capability metadata, and a runtime-keyed task fingerprint rather than raw task text. Suppress weak skill-overlap recommendations and clarify that the MCP host still controls whether the resolver and recommended tools are invoked.

### Process and network lifecycle

- Consolidate graceful process-tree termination plus forced escalation. Timeout, cancellation, and replacement now retain the escalation timer after the direct child exits, preventing a SIGTERM-resistant descendant with detached stdio from surviving as an orphan.
- Add relay support for standard `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` routing through a reviewed HTTP(S) proxy agent. Invalid proxy URLs or unsupported proxy protocols fail fast with corrective guidance; status exposes only direct/proxy/invalid route state and never proxy URLs or credentials.

### Architecture, tests, and documentation

- Extract package metadata/command discovery and capability observation into focused modules, add domain-to-adapter import-boundary checks, remove duplicate object fields, and centralize reused metadata parsing.
- Add behavior-level regression coverage for automatic package commands, direct `.codex/skills` compatibility, capability telemetry privacy, application-cache refresh, proxy selection/failure, and the direct-child-exits-first orphan-process boundary. Synchronize architecture, operations, logging, security, testing, and agent-context documentation.

## 0.12.2 - 2026-07-12

### Cross-platform persistence and browser reliability

- Extend transient Windows atomic replacement from eight short linear retries to sixteen bounded exponential retries with jitter. The implementation continues to use one same-directory atomic rename and never falls back to deleting the destination, while tolerating longer antivirus/indexer/reader sharing windows.
- Eliminate a broker-test race that could miss the runtime `hello` message between WebSocket `open` and listener registration. Pairing HTTP requests and WebSocket open/message/close waits are now bounded, and failed proxy candidates are terminated so a handshake cannot retain the test process indefinitely.

### CI, release, and supply-chain integrity

- Require a completed successful push-triggered GitHub Actions run for the exact `origin/main` commit before creating or verifying a version tag, GitHub Release, or release asset. A local test pass is necessary but no longer sufficient for publication.
- Pin all third-party GitHub Actions to immutable commit SHAs, retain Dependabot updates, and enforce the pinning plus the release-CI wiring through architecture and dedicated release-gate tests.
- Run a reachable-history privacy audit in the package-audit job. The scanner covers historical UTF-8 blob contents, historical paths, and commit messages without printing matched values, while narrowly ignoring the standard public Dependabot signing trailer.

### Regression coverage and audit follow-up

- Add deterministic tests for twelve consecutive transient Windows replacement failures, exponential delay selection, lost browser handshakes, bounded socket waits, portable simulated-Linux launcher paths on Windows, POSIX-versus-Windows daemon-stop semantics, deleted historical credential blobs, public automation trailers, and successful/failed/pending release CI states.
- Update the architecture, engineering, privacy, testing, release, security, and audit documentation. Record remaining immutable Git-history identity metadata separately from current-tree and active-credential findings.

## 0.12.1 - 2026-07-12

### Real local automation corrections

- Make the fixed macOS JXA helper return JSON as the top-level `osascript` result instead of using `console.log`, which real `osascript` sends to stderr. Empty helper stdout now fails explicitly rather than being interpreted as a successful empty object.
- Skip recursive macOS menu-bar/menu traversal by default so bounded inspection reaches main-window controls promptly. Add `include_menus` to inspection and actions for explicit menu automation.
- Normalize hyphens, underscores, dots, and spaces during capability ranking, and strongly boost explicitly named skills and commands. Natural-language references such as `agents progressive disclosure` now select `agents-progressive-disclosure` instead of a generic competing skill.

### Live verification and regression coverage

- Add regression coverage for missing JXA output, menu-recursion forwarding, and punctuation-normalized Skill selection. Add an opt-in real macOS Calculator smoke path and document isolated-profile MV3 browser validation.
- Validate the source runtime with a temporary real global instruction file, an existing user Skill, a registered direct-argv command, shell execution, Calculator discovery/open/activation/inspection/click, and a real unpacked browser extension controlling a local form through inspect/fill/click/source/screenshot operations. Test files, browser profiles, temporary global configuration, tabs, and application state are removed afterward.

## 0.12.0 - 2026-07-12

### Locking, persistence, and process lifecycle

- Replace partial-write-prone final-path lock creation with fully written, flushed temporary files and atomic same-directory hard-link claims. Record ownership tokens and process start times, detect PID reuse, verify file identity before stale-lock removal, preserve recent malformed locks, and add bounded startup-lock waiting.
- Add a state-root maintenance lock for full uninstall, including checks in already constructed managed-job and browser managers. State roots must be disjoint from selected workspaces, including non-existent paths beneath canonicalized platform aliases; unreadable locks/jobs and ambiguous process identities now block destructive cleanup rather than being treated as inactive.
- Consolidate owner-only state, managed-job, runner, browser-pairing, and service-definition commits on one flushed atomic replacement primitive. Only successfully read invalid JSON is backed up; permission, symbolic-link, size, invalid UTF-8, and I/O failures propagate without silently reconstructing empty state.
- Persist managed-job runner process identity, protect transition/recovery locks with token and file-snapshot checks, hand recovery ownership to the runner without an unconditional delete, and keep timeout/cancellation escalation alive until resistant descendant process trees are terminated.

### Services, uninstall, and cross-platform behavior

- Extract one fail-closed service lifecycle: stop the platform service, stop every verified workspace daemon, and remove the service definition only after all stop phases succeed. Full uninstall scans every profile and rechecks managed jobs and process locks while holding maintenance ownership.
- Normalize launchd, systemd user services, and Windows Scheduled Tasks to a common success/failure contract so non-zero Linux/Windows stop results cannot be mistaken for success. Preserve service definitions and local state whenever stop, verification, definition removal, or remote Worker discovery is incomplete.
- Make CLI helper timeouts terminate process groups/trees rather than only direct children, including forced escalation for descendants that ignore graceful termination.

### Security, privacy, and local automation

- Expand repository privacy and log redaction coverage for npm authentication, common cloud/source-control/chat/payment tokens, JWT-shaped values, embedded-credential URLs, broader private-key headers, credential-shaped filenames, and non-example identities. Scanner read/traversal failures now fail closed without echoing matched values.
- Add final-component no-follow reads in restricted filesystem paths, reject NUL application action values, and normalize browser-upload filenames and MIME types to prevent deceptive metadata or downstream form parsing ambiguity.
- Close authenticated browser broker sockets with protocol-specific WebSocket codes for oversized, invalid UTF-8/JSON, or structurally invalid messages instead of silently retaining faulty clients.

### Tests, architecture, and documentation

- Replace the hand-maintained JavaScript syntax list with recursive entrypoint discovery; remove stale imports and duplicated lifecycle logic. Add executable concurrency, atomicity, PID-reuse, service-failure, process-tree, state-corruption, unsafe-root, unreadable-job, browser-protocol, upload-metadata, and privacy regression tests.
- Add `docs/AUDIT.md` and synchronize architecture, security, operations, logging, privacy, managed-job, local-automation, testing, contribution, and release documentation with the implemented fail-closed behavior and residual OS-level limitations.

## 0.11.1 - 2026-07-12

### Reliable macOS service and orphan-daemon takeover

- Stop launchd jobs by their loaded service target first, with the plist form retained as a compatibility fallback. Treat an already-unloaded job as an idempotent success, verify the post-stop state before reporting success, and prevent `service start` or `service uninstall` from continuing when the existing job remains active.
- Detect legacy daemon locks that predate mode/version metadata by inspecting the live process command line. A process is eligible for takeover only when its PID, daemon purpose, canonical workspace, canonical state root, entrypoint, and `--daemon-only` arguments all match. Foreground or unverifiable processes are never signalled.
- Let normal foreground startup and `machine-mcp service stop` terminate a verified detached/orphan service daemon with `SIGTERM`, wait for the actual PID as well as the lock to disappear, reclaim stale locks through the normal token-aware primitive, and fail with a bounded timeout rather than escalating to a forced kill.
- Extend `machine-mcp service status` to report platform-service state and workspace-daemon state separately, including whether a live legacy process was verified as service-style. This makes a launchd-unloaded but still-running daemon visible instead of presenting a misleading inactive-only status.

### Tests and documentation

- Add real child-process regression coverage for legacy orphan takeover, canonical `/var` versus `/private/var` path aliases, foreground-process protection, non-forcing timeout behavior, launchd service-target generation, and packaged daemon-process module presence. Update upgrade and recovery guidance for the exact npm install command and split service/daemon diagnosis.

## 0.11.0 - 2026-07-12

### Zero-configuration agent working agreements

- Add a package-controlled `machine-bridge://defaults/working-agreements` instruction layer so every stdio and remote MCP session starts with conservative, auditable guidance even when the user and repository provide no `MODEL.md`, `AGENTS.md`, or manifest. The baseline covers inspect-before-editing, minimal coherent changes, preservation of unrelated work, existing-toolchain reuse, tests/documentation synchronization, honest validation reporting, secret handling, safe Git practice, and explicit authorization for publication, deployment, credential rotation, live-data mutation, system-wide installation, and destructive operations.
- Keep the baseline lower precedence than explicit user and root-to-target project instructions. Expose its source, size, hash, precedence, and optional content through `session_bootstrap`, `agent_context`, and `resolve_task_capabilities`; include its hash in live capability fingerprints. The defaults are behavioral guidance rather than a replacement for Machine Bridge policy, host approvals, operating-system permissions, hooks, sandboxes, or external isolation.

### Bounded automatic project context

- Add `machine-bridge://project-context/current`, regenerated on every relevant context scan from bounded repository metadata: target-relative path, recognized project/build entry files, JavaScript package-manager and lockfile facts, package script names, runtime constraints/version hints, common documentation files, and CI entrypoint filenames. The scanner executes nothing, writes no user or repository files, omits script bodies, dependency values, source/document contents, absolute home paths, and command output, and never claims a declared command was validated.
- Harden repository-controlled metadata with strict character/count/byte limits, no-follow regular-file reads, safe workflow-name filtering, independent 16 KiB output bounds, and conservative skipping of symbolic links, invalid UTF-8, oversized files, permission failures, and transient metadata races. Add user-global `builtin_instructions` and `automatic_project_context` boolean opt-outs; project manifests cannot disable the user's baseline controls.

### Documentation and verification

- Document the default instruction model, precedence, opt-outs, privacy data surface, security boundary, recommended `AGENTS.md` content, progressive disclosure, and official cross-agent best-practice sources. Update repository automation guidance, shared MCP tool descriptions, initialization instructions, architecture, clients, logging, privacy, security, testing, and package contents.
- Add regression coverage for no-file defaults, initialization injection over stdio, automatic project refresh/fingerprints, package-manager/lockfile/script/CI discovery, script-body non-disclosure, hostile metadata filtering, global opt-out, project opt-out rejection, precedence, and packaged-module presence.

## 0.10.1 - 2026-07-12

### Foreground startup and upgrade takeover

- Make a normal `machine-mcp` start reliably take over from an active platform autostart daemon: detect whether the service is active, request shutdown, wait up to 15 seconds for the workspace daemon lock to be released, and then continue foreground startup with the newly installed CLI. A failed bounded takeover now exits with explicit `service stop`/`service status` recovery guidance instead of silently leaving the old process in place.
- Record foreground/background mode and package version in new daemon locks. A genuine lock conflict now identifies the running mode/version when known, explains how to stop it, and no longer prints the misleading `[ok] ready` block when no restart or requested change occurred. Service-style duplicate starts remain silent idempotent successes.

### Global instructions and operator guidance

- Add copy-paste setup instructions for `~/.config/machine-bridge-mcp/agent.json` and the global `MODEL.md`, explain global-versus-project precedence, live rescanning, and when a new MCP conversation/reconnection is needed for initialization-time injection.
- Document the foreground/background distinction, safe global upgrade sequence, owner-only instruction-file permissions, background log locations, and the exact optional-dependency install command that avoids the development-only `fsevents` warning.

## 0.10.0 - 2026-07-12

### Session context and capability selection

- Add a global `model_instructions_file` in `~/.config/machine-bridge-mcp/agent.json`. Stdio and remote MCP initialization append the bounded user-designated instructions when the local runtime is reachable; `session_bootstrap` exposes the same content explicitly. Project manifests cannot override the global file.
- Add `resolve_task_capabilities`, which rescans effective instructions, filesystem skills, and registered commands for every task, returns a refresh fingerprint, ranks relevant capabilities, optionally loads the best skill, and recommends application/browser/file/Git/process tools. Newly added or edited skills are visible without daemon restart or dynamic MCP tool registration. Multilingual tokenization avoids weak single-character Chinese overlap when automatically selecting a skill.
- Preserve the host boundary: Machine Bridge automates discovery, refresh, ranking, and progressive loading, while the ChatGPT/MCP host still decides whether a tool is exposed, approved, or invoked.

### Existing-profile browser and local applications

- Add a packaged Manifest V3 Chromium extension and authenticated loopback machine broker for the user's existing browser profile, windows, tabs, cookies, extensions, and login state. Multiple workspace or stdio runtimes share one extension connection through authenticated broker clients.
- Add structured browser tools for tab listing, current DOM source, frame-aware and open-Shadow-DOM interactive-element inspection, navigation/actions, complex multi-field forms, visible screenshots, and resource-backed file inputs. Page operations run through a fixed packaged module injected into the target frame rather than caller-provided or service-worker-closure code. Registered local resources can provide sensitive field text or upload bytes without returning those values through MCP results.
- Add installed-application discovery/opening and structured macOS Accessibility inspection/actions. The implementation uses fixed JXA code and does not accept caller-supplied JavaScript, AppleScript, JXA, or browser-extension source. Application paths are normalized to process names, selector indices apply to filtered matches, Linux desktop launchers use `gio launch`, Windows discovery prioritizes Start Menu launchers, and secure Accessibility fields never return values.
- Add `machine-mcp browser status|setup|pair|path` for one-time unpacked-extension setup and diagnosis. Pairing tokens remain in owner-only state and non-cacheable loopback HTML rather than MCP output, browser URL fragments, or operational logs. Established pairing is replacement-locked and requires a browser-action click on the active local pairing page before switching broker state. The extension badge reports connection state and its action opens the saved pairing page; signed browser-store packaging is the intended mass-market distribution path.

### Architecture, security, and verification

- Split agent context, application automation, and browser broker into dedicated local domain modules while retaining one static catalog shared by Worker and stdio. Bound Worker initialization bootstrap to a short failure-tolerant daemon call.
- Add loopback Host validation, extension-origin checks, authenticated extension/runtime WebSocket subprotocols, bounded messages/concurrency/source/forms/uploads, proxy timeout/cancellation cleanup, restricted-page handling, secret/value/result non-disclosure, and full-profile gating. Treat the owner-only browser pairing file as a recognized state-root entry so safe uninstall remains available.
- Extend version synchronization to the browser-extension manifest and add broker owner/client proxy, pairing-token, resource-upload, stdio initialization, live skill refresh, and remote initialization regression coverage. Update architecture, security, operations, logging, privacy, testing, client, release, and user documentation.

## 0.9.0 - 2026-07-12

### Agent context and local workflows

- Add `agent_context`, a bounded bootstrap tool with Codex-compatible instruction precedence: unrestricted `CODEX_HOME`/`~/.codex` guidance, then project root-to-target scopes, selecting the first non-empty `AGENTS.override.md` or `AGENTS.md` candidate per directory under a default 32 KiB combined budget. Add hierarchical `.machine-bridge/agent.json` manifests plus an optional unrestricted user manifest at `~/.config/machine-bridge-mcp/agent.json` for custom candidate priority and bounds.
- Add `list_local_skills` and `load_local_skill` with Codex-style progressive disclosure. Default discovery scans target-to-root `.agents/skills`, unrestricted user/admin roots, and canonicalized symlinked skill directories; invalid metadata is skipped with bounded warnings. Skill loading returns instructions and a relative file inventory without implicitly executing scripts.
- Add `list_local_commands` and direct-argv `run_local_command`. Nearest manifests can override or remove inherited commands, caller arguments require manifest opt-in, and callers cannot increase the manifest timeout ceiling.

### Architecture, security, and tests

- Extract agent discovery into `AgentContextManager` rather than expanding transport or runtime dispatch responsibilities. Keep a static MCP catalog across Worker and stdio transports so host-side caching and filtering do not require dynamic per-skill tools.
- Reject escaping instruction/config paths, unknown manifest fields, out-of-policy skill symlink targets, symbolic-link skill entrypoints, ambiguous skill names, oversized content/argv, and execution attempts under non-execution profiles. Document that repository instructions and skills are untrusted content and that registered commands are convenience aliases, not a sandbox or approval boundary.
- Add regression coverage for global/project override selection, empty-candidate fallback, custom priority, instruction-byte ceilings, target-to-root skill discovery, symlinked skill folders, invalid metadata warnings, command override/removal, literal argument handling without shell parsing, timeout ceilings, path escape denial, and execution-profile denial. Update server instructions, architecture, security, testing, and operator documentation for the new bootstrap workflow.

## 0.8.2 - 2026-07-11

### Relay reliability and protocol correctness

- Add a deadline for WebSocket connection establishment so a transport stuck in `CONNECTING` cannot freeze automatic reconnection indefinitely. Sustained-outage reminders now run on an independent exponential-backoff timer capped at 15 minutes instead of appearing only when another reconnect event happens.
- Handle Worker `{type:"error"}` messages explicitly. A daemon hello timeout is classified as transient and retried; unknown protocol errors, duplicate hello messages, identity/version mismatch, and authentication rejection terminate with actionable guidance instead of becoming an `unknown websocket message` warning.
- Validate daemon WebSocket JSON as a non-array object before field access. Invalid JSON closes with code 1007, non-object/unknown/duplicate protocol messages close with code 1002, and active daemon replacement semantics remain unchanged.

### Logging, tests, and documentation

- Replace default outage/recovery JSON field dumps with readable duration, attempt, cause, automatic-recovery, and long-outage action text. Exact seconds, error classes, retry delays, and raw transport details remain debug-only. Advance the autostart log schema so historical 0.8.1-format lines are separated into the bounded owner-only legacy snapshot. Treat a service-style daemon-only start that finds the workspace daemon already running as a silent idempotent success, preventing repeated lock warnings and duplicate readiness output from accumulating in service logs.
- Add deterministic tests for stalled connection attempts, autonomous reminder backoff, retryable versus fatal relay error messages, close-reason classification, and runtime control-message routing. Extend live Worker integration coverage to invalid JSON, non-object messages, duplicate hello, and unknown authenticated messages. Enable TypeScript unused-local and unused-parameter checks to prevent dead Worker code from accumulating.
- Update architecture, operations, logging, testing, and README guidance to match the implemented state machine and operator-facing behavior. Add a repository automation contract separating code/test/commit/push work from npm publication, global CLI installation, Worker deployment, credential rotation, and daemon/service operations; the owner performs those live release steps explicitly. Improve release-check diagnostics so a missing local or remote version tag is reported distinctly from a tag pointing at the wrong commit, with the required `release:publish` step named directly.

## 0.8.1 - 2026-07-11

### Fixed

- Recognize and validate the Worker's pre-handshake `welcome` control message instead of reporting it as an unknown WebSocket warning. A valid welcome remains debug-only and does not imply authenticated readiness; identity or version mismatch still fails immediately.
- Add a versioned autostart-log schema migration. On the first daemon start after this logging-format change, bounded prior logs are copied to owner-only `daemon.*.legacy.log` snapshots and the active logs are cleared, preventing historical raw close-code lines from appearing to be current behavior.

### Tests and documentation

- Add relay/runtime regression coverage for valid welcome handling and welcome metadata validation, plus service tests for one-time bounded legacy-log migration and schema-marker idempotence.
- Record the protocol producer/consumer contract rule and document how current and legacy daemon logs are separated.

## 0.8.0 - 2026-07-11

### Architecture

- Rename the transport-independent tool engine from `LocalDaemon`/`daemon.mjs` to `LocalRuntime`/`runtime.mjs`, reserving daemon terminology for the background process and relay attachment.
- Extract authenticated WebSocket lifecycle into `relay-connection.mjs`, separating transport state, handshake readiness, heartbeat liveness, reconnect backoff, and outage observability from local file/Git/process execution.
- Add `docs/ENGINEERING.md` as the normative record for product invariants, architectural boundaries, logging semantics, resilience, testing, documentation, and public-versus-local project knowledge. Record the owner-required default `full` profile as an explicit invariant.

### Logging and operator experience

- Replace raw default-level relay close output such as `{"code":1006,"reason":""}` with a state-transition policy: brief self-healing interruptions are debug-only, sustained outages produce one rate-limited actionable warning, and recovery produces one duration/attempt summary.
- Keep WebSocket close codes, reason strings, retry delays, heartbeat details, and brief recoveries at debug level. Expand coarse operational error classification for network and authentication failures; treat authentication and relay identity/version mismatch as immediate actionable fatal errors rather than retryable network outages.
- Add an ignored `.project-local/` area for machine-specific maintenance notes while keeping reusable decisions in tracked documentation and credentials out of both.

### Reliability and correctness

- Treat a WebSocket `open` event only as transport availability; authenticated relay readiness now requires `hello_ack`. Remove the startup path that printed `Remote MCP bridge is ready` after a timeout even when authentication had not completed.
- Terminate and retry candidates that do not acknowledge the daemon handshake, detect silent half-open connections through inbound heartbeat timeouts, and preserve bounded exponential reconnect backoff.
- Handle Cloudflare Durable Object `webSocketError` as well as `webSocketClose`, immediately rejecting pending calls bound to the failed socket through one idempotent cleanup path.
- Consolidate managed-job transition/recovery locking into one stale-PID-aware primitive and manager/runner regular-file reads into one no-follow bounded helper, with direct regression tests.
- Replace mechanical runtime/CLI switch and conditional routing with catalog-checked handler tables and named command phases while preserving explicit patch, runner, and recovery state machines.
- Replace technical Worker health warning details at default level with a user-facing reason while retaining the raw health code at debug.

### Installation, tests, and documentation

- Use the empirically verified npm 12 global install command with `--omit=optional` and the reviewed `esbuild,workerd,sharp,fsevents` script names. Add an isolated tarball/global-install smoke test that rejects blocked-script warnings, verifies `fsevents` is absent from the installed runtime, and executes the installed CLI.
- Add deterministic relay lifecycle tests for authenticated readiness, brief-interruption suppression, persistent-outage escalation, recovery summaries, handshake/heartbeat timeout, transport construction/error paths, supersession, acknowledgement identity/version mismatch, and close-code classification. Add architecture/documentation regression checks for module cycles, obsolete naming, broken links, invisible ASCII controls, and retained engineering invariants.
- Update architecture, operations, logging, privacy, testing, contribution, README, and CLI guidance to match the implemented behavior.

## 0.7.1 - 2026-07-11

### Fixed

- Persist a sanitized absolute-only command `PATH` in launchd and systemd service definitions, always including the stable Node and CLI directories plus platform defaults. This restores Homebrew/npm/git command resolution for background canonical `full` daemons without accepting empty or relative PATH entries.
- Align `doctor` with the declared sole runtime baseline by requiring Node.js 26 instead of reporting Node.js 22-25 as supported.

### Tests and documentation

- Add service-definition regression tests for PATH preservation, duplicate removal, relative-entry rejection, and launchd/systemd emission; document why `machine-mcp service install` should be rerun after PATH layout changes.

## 0.7.0 - 2026-07-11

### Runtime and dependencies

- Raise the sole supported runtime baseline to Node.js 26 and npm 12, add exact local version files and strict engine checks, update Node type definitions to 26.1.1, and run the cross-platform CI suite on Node 26, and disable setup-node's automatic package-manager cache, and bootstrap npm 12 outside the repository before strict project engine checks apply.
- Confirm Wrangler 4.110.0, ws 8.21.0, and TypeScript 7.0.2 are current; retain exact reviewed dependency versions and zero known audit findings.
- Accept both legacy array and npm 12 keyed-object `npm pack --json` metadata, invoke the active npm CLI through Node on Windows, keep generated CI SBOM files outside the repository privacy/publication surface, and retry only classified transient GitHub network failures with Git forced to HTTP/1.1. Release creation verifies server state after an ambiguous response before proceeding.

### Security and privacy

- Replace private environment-derived aliases in public examples with synthetic identifiers and add a repository privacy gate covering tracked and unignored new files, file names, common credential forms, local home paths, SSH host identifiers, and an ignored machine-specific denylist without echoing matched values. Reject publication-surface symbolic links instead of following their targets.
- Hide local resource and generated-key paths by default; require explicit `--show-paths` or `expose_paths=true`, return only bare SSH fingerprints, and broaden operational-log redaction for paths, email addresses, token forms, key headers, and Unicode display controls.
- Separate unrestricted filesystem access from absolute-path display, dynamically redact requested external paths from tool errors, harden autostart files/logs against permissive modes and symbolic links, canonicalize OAuth redirect URIs, and remove bidirectional/zero-width controls from authorization-page display text.

### Correctness and durability

- Verify staged managed-job hashes during inspection, approval, and runner startup; serialize approve/cancel transitions and reclaim stale transition/recovery locks even after PID reuse; reject direct execution of unapproved staged plans; remove stale runner claims during recovery; and redact registered-resource source-path aliases from retained output.
- Clear delayed force-kill timers after process exit, enforce the stdio line limit during incremental reads, reject oversized local WebSocket payloads before string conversion, reject ID-less `tools/call` notifications instead of silently executing them, and accept actual collision-suffixed corrupt-config backups during guarded state removal.
- Make autostart prefer a stable PATH alias that resolves to the active Node executable instead of a versioned package-manager Cellar path, preventing minor Node upgrades from leaving launchd/systemd definitions pointing at removed binaries.
- Open and trim managed-job runner diagnostic logs through no-follow file descriptors, rejecting symbolic-link targets instead of following them.

### Release governance and diagnostics

- Add a release-impact gate requiring a newer package version and matching CHANGELOG section for every tracked or nonignored repository change after the latest version tag. Document that reviewed changes must be pushed to GitHub and followed by a matching npm release.
- Clarify in `server_info`, runtime diagnostics, and operations documentation that canonical `full` controls the local daemon and relay catalog only. A connector host can expose a smaller subset, and that host-side subset is not observable or overrideable by Machine Bridge.

### Tests and documentation

- Add regression coverage for privacy scanning of new files, clean/parseable package manifests and sensitive-artifact exclusion, default path omission and explicit disclosure, hidden unrestricted paths, plan tampering, direct staged-runner invocation, transition locks, source-path redaction, symlink log targets, corrupt-state cleanup, Unicode authorization spoofing, oversized stdio recovery, ID-less tool calls, and comment-free SSH fingerprints.
- Make release packaging resilient to lifecycle output by using silent JSON mode, and document repository privacy incident response, immutable history/package limitations, explicit path disclosure, plan integrity enforcement, same-user filesystem race residuals, and privacy checks in the release process.

## 0.6.2 - 2026-07-10

### Fixed

- Retry atomic JSON file replacement with bounded backoff for transient Windows sharing failures (`EPERM`, `EACCES`, `EBUSY`, and `ENOTEMPTY`). State, managed-job manager, and detached runner commits now use one shared implementation.
- Prevent an intermittent Windows `runner_failed` result caused by a transient status-file replacement failure after the same commit had passed the protected pull-request checks.
- Preserve immediate failure for non-transient filesystem errors and keep temporary-file cleanup behavior unchanged.
- Restore corrupt-state backup creation through the shared replacement primitive, add collision-resistant backup names, and verify that recovery preserves the original corrupt bytes.

### Tests and diagnostics

- Add deterministic injected transient/non-transient atomic replacement tests.
- Run the full real-machine sandbox three consecutive times on Windows, exercising repeated detached runner, status, result, and finally-step commits.
- Include managed-job error and cleanup classifications in `full-test` output when a lifecycle check fails.

## 0.6.1 - 2026-07-10

### Full-profile contract and operator workflows

- Make named profiles canonical capability contracts. A stored `full` label is repaired to writes, shell execution, unrestricted paths, full parent environment, absolute path output, and the complete tool catalog; deliberate individual overrides remain `custom`. Advance the policy revision to 3 and expose the contract in `server_info` and `doctor`.
- Add `machine-mcp full-test`, a real local-machine acceptance suite using disposable directories. It verifies outside-workspace I/O, direct and shell execution, parent-environment inheritance, SSH key generation, sandbox `authorized_keys`, SSH client parsing, Google OS Login command availability, a non-mutating sudo probe, and detached finally cleanup without changing cloud or remote state.
- Add `machine-mcp resource generate-ssh-key NAME [PATH]` and the canonical-full-only MCP tool `generate_ssh_key_resource`. Both generate or reuse an Ed25519 pair locally, register the private file as a resource, and return only paths, modes, key type, and public fingerprint.

### Logging

- Remove every ordinary per-tool event from default `info`/`warn` logs. Starts, successes, failures, cancellations, durations, slow calls, tool names, coarse outcome classes, and call correlation are now debug-only in both remote daemon and stdio transports.
- Keep default logs focused on deployment, connection, protocol, relay, service, and infrastructure health. Tool arguments, command text, inputs, outputs, and results remain omitted at all levels.

### Security, correctness, and portability

- Verify that an existing SSH public key matches its private key and that the private key is usable non-interactively before reuse. Reject incomplete pairs and symbolic links, enforce owner-only private modes where supported, and never return private bytes.
- Fix the previously untested RSA key-generation argument order and add real RSA coverage.
- Centralize CLI and MCP key generation/registration in one locked state transaction. Roll back a newly created pair if state persistence fails, handle canonical path aliases, and reapply permissions after cross-filesystem installation.
- Validate the resource state layout before deriving its root and restrict the MCP key generator to the complete canonical `full` profile.
- Avoid reading user SSH configuration during `full-test`, canonicalize temporary path aliases, and report sudo/cloud prerequisites separately from core Machine Bridge capability.

### Tests and documentation

- Add real Ed25519/RSA generation, reuse, mismatch, incomplete-pair, symlink, mode, private-content, CLI, stdio, Worker-policy, and real-machine full-profile regression coverage.
- Update logging, architecture, operations, client, managed-job, security, and testing documentation to match the canonical-full and debug-only per-tool event contracts.

## 0.6.0 - 2026-07-10

### Added

- Add `diagnose_runtime`, a fixed-input layered diagnostic that distinguishes requests reaching the daemon from Machine Bridge policy, local filesystem, process-spawn, shell, managed-job storage, and registered-resource failures. `machine-mcp doctor` runs the same local probes.
- Add operator-registered local file resources. Credentials and other local-only files can be referenced by alias and injected into managed steps through a private copied path, stdin, or an environment variable without sending file contents or source paths through MCP.
- Add durable managed jobs with ordered argv steps, bounded output, job-scoped temporary files, detached execution, cancellation, idempotent `finally_steps`, dead-runner detection, bounded recovery, and local CLI inspection/cancellation.
- Add two-phase handoff: `stage_job` persists a validated non-running plan for operator review, and `machine-mcp job approve JOB_ID` provides explicit local authorization when a host blocks execution-class tools.
- Add a local JSON fallback with `machine-mcp job submit plan.json` for situations where the MCP host cannot deliver an execution request.

### Security and privacy

- Keep resource values out of MCP plans and results. Referenced files are reopened, bounded, hashed at acceptance, verified before use, copied with owner-only permissions, and removed after cleanup.
- Redact exact resource paths, exact UTF-8 values, and bounded exact base64/hex forms from retained output. Add `capture_output: "discard"` for credential-consuming commands where output must not be retained.
- Delete active job plans, runner PID files, temporary helper contents, argv, stdin, environment overrides, resource source paths, and hashes after terminal commit. Retain only bounded status/redacted results for up to seven days and 50 jobs.
- Enforce canonical managed-job cwd containment in restricted profiles, bounded per-job resources/temporary files/output, no-follow plan/resource reads, owner-only job state, bounded runner diagnostics, recovery mutual exclusion, and a three-attempt automatic recovery limit.
- Refuse uninstall while detached jobs remain active. Later profile changes affect new submissions; accepted running jobs require explicit cancellation.
- Clarify that managed jobs are durability and local-authorization mechanisms, not a bypass for MCP-host, operating-system, or endpoint-security policy.

### Operations and tests

- Add local resource commands: `resource add`, `list`, `check`, and `remove`.
- Add local managed-job commands: `job submit`, `inspect`, `approve`, `list`, `read`, and `cancel`. Approval is interactive by default; `--yes` is required for non-interactive JSON approval.
- Add state schema version 5 for resource registry metadata while redacting resource source paths from normal status output.
- Add regression coverage for staging/approval/cancel-before-start, stdio disconnect survival, resource replacement races and output redaction, job-scoped helper cleanup, failure/timeout/cancellation finally paths, concurrent recovery, corrupt plans, output budgets, local CLI fallback, uninstall refusal, and cross-profile tool exposure.
- Add a dedicated managed-jobs/resource operations and threat-model guide.

## 0.5.0 - 2026-07-10

### Changed

- Replace routine per-tool success chatter with explicit log levels. Foreground mode defaults to `info`, autostart uses `warn`, fast successful calls are debug-only, and successful calls over 30 seconds remain visible as slow-call events. `--verbose` maps to `debug`; `--quiet` maps to `error`; `--log-level` accepts `error`, `warn`, `info`, or `debug`.
- Record policy origin and revision in state and daemon metadata. The exact legacy implicit-default policy shape is migrated once to the current maximum-permission `full` profile, while explicit named profiles and identified custom policies are preserved.
- Redact JSON connection credentials and standalone secret-rotation output by default. Printing the client connection password now requires the explicit reconnect flag; the daemon secret is never printed in full.
- Centralize server name, MCP protocol versions, and instructions in shared metadata consumed by both Worker and local transports.
- Reject obsolete removed-local-API flags instead of silently accepting them.

### Security and privacy

- Upgrade and pin `ws` to 8.21.0 to address current memory-disclosure and denial-of-service advisories; pin the reviewed Wrangler runtime version.
- Bind text, image, and search reads to an opened file handle, enforce limits against that handle, and avoid `stat`/read growth races.
- Bound state, configuration, marker, lock, service-command, log-message, and structured-log sizes. Reject symbolic-link state files, use no-follow reads where supported, and make service-log tail trimming UTF-8 and line safe.
- Remove stale temporary Worker secret files when their owner process is gone, not only after an age threshold.
- Document and expose that Machine Bridge has no sensitive-filename blacklist. Local `full` permits any OS-readable UTF-8 regular file, but cannot override operating-system or independent MCP-host/platform policy.

### Tests and operations

- Add regression coverage for legacy policy migration, sensitive-looking files outside the workspace, inherited full-profile environment, default daemon/stdio log suppression, log bounding, state write bounds, service warning-level configuration, and shared metadata drift.
- Audit both complete and production-only dependency graphs in GitHub Actions.
- Document npm's scoped install-script approval for Wrangler native dependencies and add a dedicated logging/observability reference.

## 0.4.2 - 2026-07-10

### Fixed

- Canonicalize the configured workspace and requested targets through the same asynchronous `realpath` path on Windows, while retaining a native synchronous initial value. This prevents Windows short-path/long-path aliases for the same temporary directory from being misclassified as a workspace escape.
- Keep workspace confinement unchanged: only the representation comparison changed, and targets outside the canonical workspace remain rejected in restricted profiles.

### Verification

- Preserve the existing cross-platform path-boundary regression, which exposed the issue on the Windows GitHub Actions runner while Linux and macOS passed.
- Make the minimal-environment shell regression use a cross-platform Node command instead of POSIX parameter-expansion syntax under PowerShell.
- Convert test entry-point file URLs with `fileURLToPath()` so Windows does not interpret `/D:/...` URL paths as `C:\D:\...` filesystem paths.
- Launch Wrangler's JavaScript entry point through the active Node executable in integration tests instead of directly spawning the Windows `.cmd` shim.

## 0.4.1 - 2026-07-10

### Changed

- Make `full` the default policy for newly selected workspaces and generated client configurations, prioritizing immediate usability. The default now enables all tools, unrestricted direct filesystem paths, absolute path output, shell execution, process sessions, and the complete parent environment; existing saved workspace policies remain unchanged.
- Reframe stdio as an optional local transport rather than a model provider or a replacement for native Claude, Cursor, Codex, or ChatGPT Desktop tooling. Expand client documentation to distinguish the MCP host/model from the Machine Bridge tool server and explain when stdio is redundant or useful.
- Activate cross-platform GitHub Actions checks on Linux, macOS, and Windows, update official actions to the current major releases, disable checkout credential persistence, and retain production dependency/package auditing.

### Tests and documentation

- Add regression coverage for the maximum-permission default and for `client-config` emitting `full` when no profile is supplied.
- Update architecture, operations, security, and client guidance for profile-dependent path display, filesystem scope, and environment inheritance.

## 0.4.0 - 2026-07-10

### Architecture and compatibility

- Refactor the project into one transport-independent local runtime shared by the existing OAuth-protected Cloudflare relay and a new local MCP stdio server.
- Update MCP negotiation to `2025-11-25` while retaining compatibility with `2025-06-18` and `2025-03-26`; validate protocol-version headers and implement cancellation in both transports.
- Add ready-to-paste stdio configuration generation for Claude Desktop, Cursor, Codex CLI, and generic MCP clients.
- Replace duplicated Worker/runtime tool declarations with one schema-and-annotation catalog, tested for drift and policy consistency.

### Security and privacy

- Make the least-privilege `review` profile the default for newly selected workspaces; preserve stored pre-0.4 permissions during upgrade.
- Add explicit `review`, `edit`, `agent`, and `full` profiles plus `off`, direct-argv, and shell execution modes.
- Return workspace-relative paths by default, redact canonical/platform-alias paths from tool errors, omit Git author email unless requested, and reduce operational failures to coarse error classes.
- Replace the previous minimal environment with isolated HOME, temp, and cache directories; retain full parent environment only through explicit opt-in.
- Reject duplicate in-flight JSON-RPC IDs, canonical patch-path collisions, stale edits, unsupported image signatures, oversized session data, and ambiguous patch context.
- Make create-only writes atomic against concurrent destination creation and strengthen multi-file patch staging, revalidation, rollback, and mutation serialization.

### Tools and runtime

- Add bounded line-range reads, native MCP raster-image results, exact text editing, and structured multi-file add/update/move/delete patches.
- Add staged diffs, structured Git log, bounded Git show, and privacy-aware author metadata.
- Add direct argv execution and bounded interactive process sessions with retained offsets, stdin, output/exit waits, cancellation, tree termination, and disconnect cleanup.
- Return structured tool content alongside text compatibility output and expose tool annotations for client planning.

### Reliability, testing, and operations

- Add live stdio integration coverage for initialization, tool discovery, structured/image content, edits, patches, direct execution, sessions, cancellation, and post-cancellation health.
- Expand Worker integration coverage for latest protocol negotiation, disconnected tool advertisement, rich content, exact daemon tool sets, and remote cancellation.
- Add catalog, policy-profile, canonical-collision, no-partial-patch, Git privacy, path-redaction, isolated-environment, and session tests.
- Add a Linux/macOS/Windows GitHub Actions template, Node 22/24 coverage, package/audit checks, and Dependabot configuration.
- Rewrite architecture, security, client, operations, and testing documentation around explicit trust boundaries and non-goals.

## 0.3.3 - 2026-07-10

### Security

- Add an exact-version npm `allowScripts` policy for the reviewed Wrangler runtime/build binaries (`esbuild@0.28.1`, `sharp@0.34.5`, and `workerd@1.20260708.1`) and explicitly deny the optional `fsevents` install script. Dependency upgrades therefore require renewed script approval.

### Changed

- Exclude the development-only Worker integration test from the published npm package while retaining it in the repository and CI.
- Add a fail-closed release command that synchronizes `main`, the version tag, the GitHub Release, and its npm tarball; block `npm publish` when those artifacts do not match.

## 0.3.2 - 2026-07-10

### Fixed

- Keep the healthy daemon active until a replacement connection completes its authenticated `hello` handshake; enforce the candidate deadline with a Durable Object alarm so it survives WebSocket hibernation, and reject stale or non-handshaking candidates without disrupting the active connection.
- Send the candidate acknowledgement before closing the previous daemon, expire failed acknowledgements, clean up duplicate authenticated sockets on subsequent handshakes, and reject pre-handshake messages without changing active tool metadata.

## 0.3.1 - 2026-07-10

### Security

- Replace reversible unsalted source-address hashes used for OAuth registration limits and password throttling with deployment-keyed HMAC identifiers; stop persisting User-Agent-derived identities, remove legacy unsalted identifiers during store migration, and fail closed if no identity key is configured.

### Fixed

- Preserve timeout escalation after the direct child exits so a process-group `SIGKILL` still removes descendants that ignore `SIGTERM`; add a regression test for the orphan-process boundary.
- Replace legacy unsalted source-identity hashes with deployment-keyed HMAC identifiers, prune legacy stored identifiers, and add integration coverage for registration quotas and login throttling.

## 0.3.0 - 2026-07-10

### Security

- Confine filesystem tools to the canonical workspace by default; add explicit `--unrestricted-paths` opt-in and symbolic-link escape protection.
- Make `write_file` bounded and atomic, reject symbolic-link/non-regular destinations, and enforce optimistic hashes consistently.
- Add recursive log-field and token redaction, control-character neutralization, owner-only service logs, and bounded log trimming.
- Harden OAuth with strict PKCE/resource/client/redirect validation, validated client disclosure on the consent page, password-failure throttling, bounded dynamic registration, per-source and per-client limits, inactive-client cleanup, strict HTTP methods/UTF-8 handling, and security response headers.
- Minimize unauthenticated and relay metadata disclosure: remove workspace name/path hash/process ID from the daemon handshake, reduce default observability sampling, and bind pending calls to their originating daemon socket.
- Bound Worker/daemon request sizes and concurrency; serialize OAuth mutations; isolate WebSocket generations; serialize per-workspace startup/deploy/rotation operations; terminate timed-out or disconnected child processes and bound Wrangler subprocesses.

### Changed

- Raise the minimum Node.js version to 22 because the current Wrangler release no longer runs on Node 20; require the installed Wrangler dependency instead of falling back to an implicit network `npx` execution.
- Remove the experimental local OpenAI-compatible `/v1` API and MCP sampling proxy.
- Detect nested Git repositories for `git_status` and `git_diff`, while disabling repository-configured external diff, text conversion, and filesystem-monitor hooks for bridge Git operations.
- Use atomic local state/config writes, bounded corrupt-state backups, strict adoption/migration of dedicated state roots, and guarded state-root deletion during uninstall, including refusal while active daemon/startup locks remain.
- Reject unknown, duplicate, malformed, and command-inapplicable CLI options; fix boolean options consuming positional workspaces.
- Verify the expected Worker version before accepting a deployment hash.
- Reduce the default Worker request-body limit to 8 MiB; bound command length, directory results, recursive traversal, and path-result payloads; provide exact-origin CORS while rejecting implicit loopback browser origins.
- Update Wrangler to 4.110.x, TypeScript to 5.9.x, and Node type definitions to the supported Node 22 API line.

### Tests and documentation

- Expand self-tests across path boundaries, symlinks, writes, UTF-8, nested Git, environment isolation, locking, CLI parsing, state recovery/removal guards, logging, service logs, and Worker hardening invariants.
- Add a live local Worker OAuth/MCP integration test, verified Node 22/24 compatibility, a Worker build dry-run, dependency audit, security policy, and architecture document.

## 0.2.5

- Previous release.
