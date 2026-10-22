# Component reference

Detail behind [Architecture](../ARCHITECTURE.md#components). Every module named here is an
architecture-boundary module: its responsibility, the state it may hold, and the boundary it
may not cross are all enforced by `tests/architecture/module-boundaries.mjs`.


## Shared protocol metadata and tool catalog

`src/shared/server-metadata.json` is the single source of truth for server identity, the sole current MCP protocol version, and host instructions.
`src/shared/tool-catalog.json` is the single source of truth for tool names, descriptions, input schemas, annotations, and policy availability.
The Worker and local runtime import both directly.
Catalog tests reject metadata drift, duplicate names, unknown availability classes, open schemas, missing annotations, profile drift, and second hand-maintained Worker definitions.

## CLI and state layer

The CLI canonicalizes workspaces, resolves policy profiles, maintains per-workspace state and credentials, serializes startup/deploy/rotation with process-identity locks, deploys the Worker, installs optional platform-native autostart, and starts either remote daemon or stdio mode.
On a first interactive Windows start, workspace selection remains explicit but offers `%USERPROFILE%\MachineBridge` as a dedicated default; accepting it creates and remembers the folder instead of inheriting the shell current directory.
Non-Windows interactive starts retain the current-directory default, and explicit `--workspace` paths remain strict existing-path inputs.

A canonical workspace receives an independent profile, Worker name, secret set, resource registry, managed-job directory, daemon/startup locks, and state file.
State schema version 6 records named accounts, policy origin/revision, and local resource metadata in addition to the capability fields.
`exclusive-file.mjs` owns complete-before-visible exclusive claims and flushed atomic replacement; pre-commit cleanup faults retain the primary cause, while a cleanup fault after an exclusive target is already committed is surfaced as fixed non-serialized cleanup evidence rather than converting the committed write into a false failure.
`filesystem-identity.mjs` is the shared exact filesystem-generation boundary: default security-sensitive observations use BigInt device/inode/change-time stats, same-inode reuse with a changed generation is rejected, and unsafe Number identities fail closed.
`process-identity.mjs` owns PID liveness, process start-time comparison, bounded command-line inspection, and PID-reuse classification.
`service-lifecycle.mjs` owns the fail-closed stop-daemons-before-remove state machine shared by service removal and full uninstall.

## Local runtime

`LocalRuntime` is the transport-independent local tool orchestrator.
It owns the shared authorization/execution pipeline, manager construction, cancellation, and the narrow delegation surface used by stdio and relay transports.
Domain behavior remains in focused services:

- `workspace-file-service.mjs` and `git-service.mjs` own canonical filesystem/Git operations; `file-mutation-coordinator.mjs` supplies the shared resolved-path conflict identity and serializes only conflicting paths, registers every path in a multi-file transaction before waiting, and holds those reservations until the filesystem callback settles. `workspace-file-transaction.mjs` owns flushed staging, no-overwrite target publication, whole-file compare-and-swap, patch rollback, and cleanup causality. A late patch target becomes `conflict/target_appeared`; a rollback failure after any user-file commit is a public non-retryable `patch_recovery_incomplete` settlement directing the caller to inspect affected paths, while staging-only cleanup failure remains an internal cleanup error and post-commit artifact cleanup remains a warning rather than a false rollback claim;
- `process-contract.mjs` owns argv shape/size validation; `process-tree-signal.mjs`, `process-tree-supervisor.mjs`, `process-tree-snapshot.mjs`, and `process-tree-ownership.mjs` separate cross-platform signaling, asynchronous escalation, bounded process-group observation, and PID/start-time ownership; `process-execution.mjs` and `process-sessions.mjs` own one-shot and interactive execution; `process-nonreplayable-settlement.mjs` maps fixed internal UI-launch/native-input helpers from definite pre-spawn failure to non-retryable unknown settlement after process start; and `process-tracker.mjs` retains active and draining process ownership until close;
- `shared/tool-call-capacity.mjs` defines the control-tool set and generic admission algebra; local `call-capacity.mjs` and Worker `pending-call-capacity.ts` apply it independently, while `runtime-reporting.mjs` builds privacy-aware runtime and project snapshots;
- `runtime-diagnostics.mjs` owns fixed local probes and their stable interpretation, while `runtime-diagnostic-state.mjs` projects privacy-safe control-plane state for remote diagnosis. On macOS, `system-sleep-diagnostics.mjs` is the only power-history parser used by that surface: it runs a fixed bounded `pmset` pipeline, returns only recent sleep interval timestamps/durations/coarse reasons, correlates an event-loop stall only when both its resume time and duration match an operating-system sleep interval within the fixed tolerance, and independently intersects the most recently completed relay disconnect interval with those same sleep intervals. A majority-sleep relay overlap means host suspension dominated the observed outage and a retained socket reset is aftermath evidence rather than proof of a separate network root cause; an unmatched pause or awake relay reset remains unassigned instead of being guessed into another cause;
- `runtime-capabilities.mjs` composes agent, application, browser, and effective-policy-filtered routing results, while `execution-routing.mjs` owns bounded set-level route scoring, ambiguity, fallbacks, and advisory tool projection;
- `runtime-tool-handlers.mjs` owns catalog-to-handler registration;
- `runtime-relay.mjs` owns relay construction and inbound envelope normalization; `runtime-device-session.mjs` owns bounded portable-root daemon-session rollover state, retry timing, and coarse renewal diagnostics while leaving non-renewable roots on the existing fail-closed expiry path; `relay-call-recovery.mjs` owns bounded disconnect grace, authoritative resumed-call reconciliation, and same-daemon redelivery orchestration; `relay-result-retention.mjs` owns the bounded completed-but-unacknowledged result ledger plus the fail-closed automatic-redelivery proof; and `relay-recovery-admission.mjs` owns recovery-capacity accounting and its privacy-safe diagnostic projection;
- `macos-idle-sleep-assertion.mjs` is the single adapter boundary for the fixed macOS `/usr/bin/caffeinate` primitive: flags are selected only from the closed `-i`/`-s` set, ownership is bound with `-w <owner-pid>`, process creation uses `shell: false` and ignored stdio, and failures expose only a coarse error class. `macos-idle-sleep-recovery.mjs` owns desired-state recovery with fixed 1/5/30-second backoff, generation/restart accounting, and bounded unprotected-duration telemetry; explicit release disables desired state before terminating the child. `remote-idle-sleep-assertions.mjs` composes the closed `activity`, `ac-continuous`, and `continuous` policies without changing the default. `activity` retains the existing shared `-i -s` assertion plus thirty-minute inactivity grace; `ac-continuous` adds a daemon-lifetime `-s` assertion while leaving battery Idle Sleep prevention activity-scoped; in both activity-bearing modes the fixed thirty-minute inactivity grace begins only after the last handler/process-session activity settles. `continuous` holds `-i -s` for the daemon lifetime and suppresses activity grace. `remote-activity-idle-sleep-guard.mjs` owns authorized relay activity/timeline semantics, while `process-session-remote-activity.mjs` extends activity ownership beyond `start_process` only after resource admission and through child settlement. Remote account managed-job runners remain independently bound to the runner PID and inherit the same assertion self-healing after claim/ownership validation. Runtime shutdown terminates process sessions before releasing daemon assertions. Persisted mode comes from owner-only global state rather than shell-only environment inheritance, and relay heartbeats do not count as user activity. These guards do not claim to defeat explicit sleep, lid-close sleep, power loss, or operating-system behavior outside `caffeinate` contracts;
- `runtime-paths.mjs` owns runtime-directory creation, containment checks, and error-path redaction;
- `runtime-resource-service.mjs` owns registered-resource lookup, bounded binary/UTF-8 reads for browser/application injection, and SSH-resource registration/result projection;
- `security-audit-log.mjs` owns only the bounded main-thread queue and cached initializing/health projection; `security-audit-worker.mjs`, `security-audit-storage.mjs`, `security-audit-dispatch.mjs`, and `security-audit-warning.mjs` isolate startup verification, all disk/hash work, batch persistence, privacy projection, and warning suppression from result delivery;
- `managed-job-lock.mjs`, `managed-job-runner.mjs`, `managed-job-storage.mjs`, and `managed-job-projection.mjs` separate transition ownership, detached runner identity, private persistence/diagnostics, and public result shaping from the managed-job lifecycle;
- `mcp-response-proxy.ts` owns public request-scoped SSE lifecycle/pumping, while `mcp-response-cancel.ts` owns the bounded private Durable Object cancellation-control settlement so one stalled control fetch cannot retain a public response indefinitely;
- `browser-request-registry.mjs`, `browser-broker-routes.mjs`, `browser-broker-server.mjs`, and `browser-bridge-http.mjs` separate direct request ownership, runtime-client proxy routing, authenticated loopback WebSocket upgrades/listening, and loopback HTTP handling from broker startup and extension handover;
- managed jobs, local resources, application automation, browser automation, and snapshot-bound Computer Use remain separate managers.

Architecture tests cap the orchestration module and each extracted service independently and reject a return of low-level process, patch, diagnostic, capability-scoring, heartbeat-policy, or audit-storage logic to `LocalRuntime`.
`RelayConnection` owns remote WebSocket transport, `hello_ack` authentication, end-to-end `relay_probe`/`ready_ack` readiness, reconnect backoff, outage logging, and a monotonically increasing in-memory transport generation.
Verified readiness restores business traffic immediately, but reconnect failure history is cleared only after five seconds of generation-stable ready uptime; a shorter ready/close flap keeps its prior exponential backoff position instead of returning to the shortest delay.
`RelayLiveness` owns the two-layer connection liveness policy: protocol Ping remains the first-stage half-open detector, but one missed dispatched Pong on a ready socket enters a bounded application-confirmation state rather than immediately terminating WSS; the independent periodic application heartbeat still refreshes Worker daemon activity and runs only after verified readiness.
`RelayHeartbeatMonitor` remains the shared timer/recovery loop beneath that policy; `RelayHeartbeatStall` owns expected-versus-actual timer-lag diagnostics and wall-clock stall timestamps, `RelayProbeDeadline` owns the transport probe's dispatch-relative response deadline, and `RelayTransportConfirmation` owns the second-stage confirmation window so delayed local scheduling, sender backpressure, one transient persistent-flow stall, and a confirmed two-stage black hole remain distinguishable.
The generation still protects the pre-ready probe and prevents arbitrary use of a stale socket.
An explicit stop while the first connection is still waiting for readiness settles that pending start as cancelled/no-readiness rather than leaving its Promise unresolved; `LocalRuntime` also refuses to overwrite a concurrent `stopping`/`stopped` lifecycle with a late relay success or failure.
Ordinary tool calls additionally bind to an ephemeral identifier generated once per local daemon process.
If a ready socket drops, the Worker detaches its pending calls for at most the shared two-minute reconnect grace; only a replacement socket that presents the same daemon-process identifier and completes the full readiness probe can reclaim them.
The local runtime keeps those calls alive and retains completed results while ownership evidence remains valid.
A resumed call ID is reported as daemon-proven missing only while `RelayResultRetention` can still prove that absence means the call did not execute locally.
If acknowledgement retention expires, emergency retention is consumed, or reconnect-grace cleanup discards a completed result, that proof becomes permanently false for the current recovery owner; subsequent reconciliation suppresses transparent missing-ID replay rather than risk duplicate side effects.
`diagnose_runtime` exposes only aggregate recovery counts and this Boolean safety state.
A different process instance, an explicit cancellation, or grace expiry cannot receive queued results.
Stdio mode invokes `LocalRuntime` directly without that adapter.

The control plane has explicit availability budgets at both admission layers.
The Worker admits thirty ordinary pending daemon calls and reserves two additional slots for `diagnose_runtime`/`list_roots`; one serialized admission gate and the transient pending-call registry enforce that per-tool capacity.
There is no second durable MCP call pool to merge into the accounting.
Pending operation/reconnect delays are positive finite safe integers bounded by the shared relay contract before any timer or Durable Object alarm deadline is armed; malformed internal timing cannot become an infinite timer.
The local relay independently rejects malformed call IDs, tool-name shapes, authorization field types, and timeout values before dispatch instead of coercing them into a usable envelope.
The local runtime independently admits fourteen ordinary tools and reserves two control slots; the total ceilings remain thirty-two and sixteen.
A timed-out or cancelled process call settles at the protocol boundary before operating-system cleanup necessarily completes, so `process-tracker.mjs` keeps that process under a draining call until `close` and reports pending escalation supervision.
Neither process ownership inspection nor security-audit persistence performs synchronous process creation or disk `fsync` on the daemon event loop.

`daemon-process.mjs` owns workspace-daemon inspection and takeover.
It distinguishes platform service state from the lock-owning Node process, validates PID and process-start identity, canonicalizes workspace/state paths before comparison, parses bounded process command lines without executing them, and accepts lock-backed `--daemon-only` recovery processes that omit repeated path flags.
Stop/takeover sends `SIGTERM` only to a verified same-workspace service daemon.
If it remains alive after the grace period, the code revalidates PID, process-start identity, command line, entrypoint, daemon mode, workspace, and state root before sending `SIGKILL`; a foreground, replaced-PID, or otherwise unverifiable process remains untouched.
CLI orchestration never treats a missing launchd/systemd job as proof that the process exited.

`service-owner.mjs` is the machine-global identity ledger for the one launchd/systemd/Task Scheduler definition.
Its owner-only record binds the canonical workspace, state root, exact runtime entrypoint, and package version.
Installation is a pending-to-committed transaction: once provider mutation begins, failure remains pending because the code cannot prove that the external service manager made no partial change.
`service-runtime.mjs` loads only a committed owner, verifies provider state, starts or restarts the provider, and waits for the matching daemon lock to publish its token-protected startup-readiness checkpoint.
That checkpoint is written once, after device authentication, relay probing, and `ready_ack`; PID stability or a provider `active` flag is not equivalent evidence.
Missing, corrupt, pending, mismatched, or unready ownership fails closed.

All machine-global service writers share a fixed per-user machine-service lock independent of workspace and custom state roots.
The lock and service-owner ledger live in a dedicated control root (`machine-bridge-mcp-control`), while ordinary workspace/profile state uses `machine-bridge-mcp`; XDG and Windows APPDATA preserve the same sibling separation.
The control root is never a default state root or candidate-runtime root.
Paths that also need a workspace startup lock acquire machine-service first and startup second.
Foreground startup releases the machine lock after provider takeover and daemon ownership are established, before entering the long-lived runtime; activation retains it through candidate verification, definition commit, service launch, and background readiness.
Service-spawned `--daemon-only` children do not reacquire the parent transaction lock.
This ordering prevents cross-workspace service-definition races, state/control namespace collision, and machine/startup lock cycles.

## Agent context and capability resolver

`AgentContextManager` discovers the nearest Git/workspace scope, applies authority-permitted user configuration plus hierarchical `.machine-bridge/agent.json` files, selects built-in/user/root-to-target instructions, discovers bounded filesystem skills, and resolves registered commands.
Remote non-owner accounts confined to the workspace do not read the machine owner's user-global agent config or `model_instructions_file`; local machine-user calls retain those global preferences, and broader remote authority may use them only when the effective path policy permits that scope.
`agent-context-projection.mjs` owns capability fingerprints, privacy-aware public projections, bounded skill summaries, command rendering, and effective-instruction rendering.
`agent-skill-discovery.mjs` owns bounded skill-root traversal, symlink containment, metadata parsing, warnings, and file inventory; `agent-text-file.mjs` owns no-follow bounded UTF-8 reads.
Filesystem/config discovery no longer maintains those output and skill-scanning mechanics inline.
`agent-contract.mjs` is the strict checked-JavaScript boundary for configuration shape, registered-command normalization, encoded-size limits, and configured-path containment; the manager does not maintain a second parser.
`project-package.mjs` owns no-follow package metadata parsing, package-manager selection (including fail-closed conflicting-lockfile handling), script-name normalization, bounded workflow-intent aliases, and automatic `package.*` command construction so instruction rendering and command execution do not duplicate package parsing.
Its optional project-metadata reader opens first with no-follow semantics and then compares path and descriptor identity through the shared lossless BigInt filesystem-identity boundary before consuming bytes; unsupported or unavailable optional metadata may be omitted conservatively because discovery does not authorize or mutate state.
`default-instructions.mjs` supplies a versioned in-package working-agreement block and derives a small virtual project-context block from root filenames and bounded metadata.
It reads package script names but not bodies, does not inspect dependency values or source contents, executes nothing, and writes no user/repository files.
A global `model_instructions_file` is a separate user-designated local/authorized session source and cannot be overridden by a project.

MCP `2026-07-28` `server/discover` returns static bounded guidance and leaves `session_bootstrap` as an explicit refresh tool; there is no initialization-time daemon bootstrap path.
`resolve_task_capabilities` performs a fresh deterministic scan, rebuilds automatic project facts, ranks skills, commands, and policy-visible tools, then scores compatible execution surfaces as sets rather than independent names.
Registered commands, Bash/direct argv, process sessions, managed jobs, files/Git, browser, applications, protected resources, and diagnostics remain distinct routes with explicit fallbacks.
The routing envelope is schema-versioned; scores are deterministic relative ranks within one response, not probabilities or stable cross-version values.
Routing is advisory and never narrows the effective policy; `exec_command` remains available as the general shell escape hatch.

Application and browser discovery uses the request's effective account/daemon policy intersection, not the daemon ceiling.
Read-only accounts exposing `list_local_applications` may receive application inventory; discovery does not grant launch, Accessibility, or desktop-control authority.
Recommendations include only tools available to the request.
Installed application inventory uses a short bounded cache.
`CapabilityObserver` records only counts, timestamps, source flags, match counts, recommended tool names, primary route, ambiguity class, score gap, and a runtime-keyed task fingerprint; it stores no task text.

The MCP catalog remains static: local skills and commands do not become dynamically named tools.
This avoids stale host catalog caches and keeps Worker/stdio schema parity.
Progressive disclosure separates discovery, instruction loading, routing advice, and execution authority.
The refresh fingerprint binds the target/scope, configuration paths, instruction source/precedence/content identity, skill source identity, and complete registered-command definition.
Returning it as `known_refresh_fingerprint` permits the server to omit unchanged static context while still rescanning and recomputing task-specific matches.
It is not authorization, a conversation identifier, or permission to reuse stale tool results.

See [Session instructions, skills, commands, and capability discovery](../AGENT_CONTEXT.md).

## Application automation manager

`AppAutomationManager` owns installed-application discovery, OS launching, structured Accessibility automation, bounded window screenshot capture, exact private value readback for verification, and the fixed macOS native-input adapter.
The Node orchestration boundary remains in `app-automation.mjs`, while the fixed macOS Accessibility program lives in `app-automation-macos-jxa.mjs`; macOS inspection/actions execute that package-owned JXA through `osascript` and expose only typed selectors/actions.
Snapshot-bound application authority pairs the PID with the public libproc process-birth generation and, when visual/window evidence exists, the exact observed owner-window binding.
Exact resource-backed values retained for post-write verification use the manager monotonic clock rather than wall time and are removed on one-shot consumption, explicit cleanup, capacity eviction, or the 60-second fallback TTL.
Unknown post-spawn application mutations preserve structured `side_effects_started`, `termination_requested`, and `effect_settlement` metadata when the fixed process boundary supplied it.
The caller cannot provide script source.
OS Accessibility, Automation, and Screen Recording/TCC remain independent boundaries.
The experimental background visual backend is opt-in and is not loaded merely because application automation is available.

## Snapshot-bound Computer Use

`ComputerUseManager` composes the existing browser and application managers rather than replacing them.
`computer-use-arguments.mjs` owns request normalization and cross-field validation, while `computer-use-observation-contract.mjs` validates captured browser/application authority evidence and normalizes browser observation calls before a snapshot can become actionable; this leaves `computer-use.mjs` focused on snapshot authority, preflight, dispatch, and effect settlement.
Both `computer_observe` and `computer_act` treat `timeout_seconds` as one monotonic end-to-end deadline for the compound operation: application observation shares one budget across screenshot, Accessibility inspection, and window revalidation, while action shares one budget across preflight, one dispatch attempt, verification, and post-observation.
Deadline exhaustion before mutation remains a definite no-side-effect timeout; after mutation handoff, settlement stays conservative rather than replayable.
`computer-use-snapshot-store.mjs` owns the bounded 64-entry one-shot/LRU authority state separately from the orchestration kernel; snapshot TTL and application verification duration both use monotonic time, so wall-clock correction cannot create or destroy mutation authority.
`computer_observe` publishes a process-local, ten-minute snapshot containing public semantic evidence plus private target bindings; `computer_act` requires that exact snapshot, performs read-only preflight, atomically consumes its mutation authority before backend handoff, dispatches at most once, then captures post-state and reports `dispatch_status` separately from `effect_status`.
Browser refs are document/frame scoped and can use high-confidence private backend-node bindings; application refs are snapshot scoped and re-resolve against process-generation and owner-window evidence.
Unknown mutation outcomes are never same-action retry authority; callers continue from the returned post snapshot or observe again.
Computer Use core/observation/recovery/snapshot modules and their browser/native adapters are explicit architecture-boundary modules with line budgets rather than an exception to the dependency-direction rules.

Native MCP image content and structured state share the ordinary 7 MiB tool-result boundary.
`computer-use-result-budget.mjs` performs the budget check before an observation snapshot ID is published.
If a screenshot alone would exceed the result budget, the image and pixel-action authority are omitted while the still-valid semantic snapshot and private identity evidence are retained.
Post-action results apply the same rule after mutation: screenshot content is dropped first and settlement/diff/continuation are recomputed; if the remaining full post projection is still too large, a compact non-retryable settlement retains dispatch/effect status, `post_snapshot_id`, continuation/retry guidance, and bounded errors rather than replacing an already-issued mutation with a generic size failure.

## Browser extension and machine broker

`BrowserBridgeManager` owns only connection orchestration for the loopback HTTP/WebSocket broker, owner/client failover, routed requests, cancellation, extension replacement, and start/stop generation control.
Every asynchronous startup boundary rechecks the generation so a listener or upstream socket cannot appear after `stop()` has invalidated that start.
`browser-operation-service.mjs` owns MCP-facing browser argument normalization, resource-backed values/uploads, form semantics, screenshot conversion, and status presentation.
Extension version/capability parsing lives in the strict checked `browser-extension-protocol.mjs`; pairing files and local HTML/Host/Origin helpers live in `browser-pairing-store.mjs`.
The first runtime for the machine-level state root becomes broker owner; additional workspaces and stdio runtimes authenticate to `/runtime` and proxy through the same extension socket.
This preserves one extension pairing while allowing multiple local MCP runtimes.

The packaged Manifest V3 extension runs in the user's existing Chromium profile.
Because that profile and its active-tab focus are shared machine state rather than hosted conversation identity, the Worker-hosted schema requires an explicit `tab_id` for browser source/inspection/wait/action/form/screenshot/upload calls and for `computer_observe(surface="browser")`; only local surfaces retain any active-tab convenience default.
Later `computer_act` remains snapshot-bound to the explicitly observed target, so another hosted conversation changing browser focus cannot silently retarget an already-scoped operation.
Its service worker is limited to pairing, transport, acknowledged protocol readiness, cancellation, bounded request lifecycle, and response routing.
It independently caps active operations at 32 even though the local broker enforces the same ceiling.
Fixed `browser-error-boundary.js` maps only an allowlist of actionable messages to the remote protocol; unclassified Chrome, DevTools, page, selector, URL, path, and account-shaped exception text becomes the fixed `browser operation failed` result.
Fixed `browser-operations.js` owns tab lifecycle, aggregate frame/source budgets, waits, screenshots, Computer Use observation dispatch, and input-backend selection; `devtools-session.js` serializes same-tab debugger ownership and independently bounds debugger attach, each CDP command, and detach cleanup so one non-settling Chrome promise cannot retain the tab queue past its settlement budget.
`devtools-observation.js` captures bounded Accessibility/DOMSnapshot/layout/screenshot evidence and treats a session timeout as a failed CDP capture that can fall back to semantic observation; `devtools-input.js` exposes only fixed trusted mouse, drag, wheel, keyboard, and text sequences, and a command timeout after Input dispatch remains non-fallback-safe/unknown.
Callers cannot select CDP methods.
Fixed `page-automation.js` is injected into selected frames for snapshot-version-3 semantics, per-document epochs, stable refs, bounded DOM/text traversal, actionability checks, open-Shadow-DOM traversal, structured DOM operations, multi-field forms, and resource-backed file inputs.
Browser mutation classification has one source in `browser-extension-protocol.mjs`; once a mutating request has been handed to the extension transport, `browser-request-settlement.mjs` maps timeout, disconnect, malformed response, send uncertainty, or a completed mutation whose oversized/unserializable result cannot be delivered to fixed non-retryable unknown settlement while preserving structured side-effect/cancellation evidence.
The local MCP and extension response paths are both pinned to the same 7 MiB result ceiling by an architecture guard, so cross-runtime size drift cannot silently change that settlement boundary.
Pre-send failures and read-only failures retain their ordinary definite/retryable semantics.
Protocol 3 requires bidirectional `hello`/`hello_ack` plus exact packaged-version and capability equality; pairing state and replacement are committed only after validation, so an invalid candidate cannot displace or overwrite the working configuration.
The broker validates loopback hostnames, canonical extension IDs, matching pairing/broker ports, one-time role-bound HMAC WebSocket proofs, message sizes, concurrency, and deadlines.
Long-lived extension/runtime tokens remain owner-only HMAC keys and are never placed in WebSocket subprotocols.
Clients first fetch a five-second challenge through an internal-header loopback endpoint, authenticate the broker's server proof, then present a one-time client proof; the broker consumes it once.
Public pairing status and the long-lived broker `/pair` document are permanently token-free.
An explicit pair action first binds an OS-assigned one-shot loopback listener owned by the current Machine Bridge process, then opens that temporary page with a 30-second bootstrap only in the URL fragment.
The temporary listener serves exactly one pairing page and then closes (or expires after 30 seconds), so a process occupying the long-lived broker port cannot redirect the bootstrap.
The `document_start` content script removes the fragment before page scripts run and keeps it only in the extension isolated world.
The fragment secret is never sent in the HTTP request; instead it authenticates a bounded `/pair-auth` exchange.
The broker derives the same secret from the owner-only extension token, proves possession first, consumes the matching client proof once, and only then releases the long-lived extension token to the extension.
Manual repair reuses the isolated-world bootstrap through extension messaging rather than reading credentials from page DOM.
Pairing material is omitted from MCP/log output.

See [Local application and browser automation](../LOCAL_AUTOMATION.md).

## Managed job runner

`ManagedJobManager` persists bounded per-workspace job envelopes below the owner-only profile directory.
Managed-job active and terminal lifecycle classifications have one shared source in `managed-job-terminal.mjs`; manager reconciliation, retention, detached-runner fatal settlement, and production full-access diagnostics consume that source instead of maintaining parallel status lists.
`start_job` validates the complete plan, snapshots referenced resource metadata/hashes, writes an owner-only plan/status, and launches `job-runner.mjs` as a detached process with runner-level logs redirected to owner-only files.
`stage_job` performs the same acceptance validation but writes a non-running, review-only `staged` envelope; staged records have no promotion/approval execution path, so execution requires a separate trusted `start_job` request or an explicit local `job submit` plan.
`managed-job-dependency-admission.mjs` binds optional `depends_on` references to same-authority durable job identities and rejects staged or already-failed dependencies before acceptance.
`managed-job-dependencies.mjs` then keeps a dependent runner in pre-execution `queued/dependency_wait` state until all upstream jobs succeed, or settles it with `dependency_failed` when one later fails; no dependent main child or process resource lease exists during that wait.
Because Windows atomic replacement/runner-exit recovery can make an otherwise valid status file transiently unreadable, dependency polling gives only `permission_denied`, `identity_changed`, and generic `resource_unavailable` reads a fixed 45-second monotonic recovery grace.
One successful secure read clears that grace; persistent unavailability still fails closed as `dependency_unavailable`, while missing, corrupt, witness-mismatched, staged, or otherwise invalid evidence is never converted into a retry.
`managed-job-relaunch.mjs` preserves the pre-execution distinction across a dead dependency-wait runner by restarting the original `dependency_wait` job rather than converting it to cleanup-only recovery.
`managed-job-retention.mjs` owns staged expiry timing and seven-day terminal retention; `managed-job-capacity.mjs` bounds durable retained state at 512 while the public `list_jobs.jobs` primary response window remains capped at 50 records.
Completed one-step process carriers are marked internally as `transient_process`, and a separate private `transient_recovery_pending` bit records whether the initiating hosted response actually told the caller that `read_job` follow-up is required.
If such a helper later becomes terminal while its hosted response still requires follow-up, retention makes it non-evictable under capacity pruning for a fixed 24-hour undelivered-result grace.
`managed-job-transient-recovery-capacity.mjs` adds the complementary admission-side fairness boundary for relay non-owner carriers: while the existing root `capacity.lock` serializes the create transaction, the helper derives at most 16 unresolved pending promises for one account ID plus account version directly from retained status, aggregating all OAuth clients and refresh families and adding no second quota ledger.
Active pending states count regardless of age; terminal pending states count only through the same 24-hour hard grace.
Owner/local work bypasses this account quota and still uses the global 512-state capacity contract.
A securely readable valid persisted status for the same deterministic idempotent job may be replayed at quota because it adds no reservation.
A deterministic directory with no `status.json` is recognized as incomplete publication rather than replay or an account reservation, so its retry re-enters quota admission; present-but-unreadable, malformed, wrong-identity, or terminal-evidence-invalid status fails closed.
When any hosted read path produces the terminal result—during the initial two-second settlement or a later `read_job`—`managed-job-transient-recovery.mjs` clears that private bit under the job transition lock and the result drops to the shorter thirty-minute bounded newest-16 transient delivery reserve.
The downgrade is best effort: failure to clear only keeps stronger recovery protection and cannot weaken continuity.
`recent_process_recovery` remains a separate capped-at-16 authority-visible projection without step output or internal retention metadata; it prioritizes retained follow-up-required helpers before ordinary recent transient history when the durable-first primary window omits them.
This recovery-discovery projection does not create MCP replay/session state or change request ownership.
The two-tier policy does not enlarge the 512-state cap: pending undelivered transient terminals inside 24 hours are excluded from the removable set, so ordinary removable terminal history may be reclaimed first; if all 512 retained states are active, staged, unreadable, dependency-pinned, retired blockers, or hard-protected undelivered terminals, the existing typed retryable `limit_exceeded` capacity path rejects another job instead of deleting recovery evidence.
Terminal delivery clears the pending marker and returns that helper to the newest-16/thirty-minute delivered reserve, while a pending terminal older than 24 hours becomes ordinary removable history.
`managed-job-dependency-retention.mjs` pins terminal records referenced by active/staged dependency plans and fails closed if that protection cannot be read safely.
`managed-job-directory.mjs` maps a syntactically valid but no-longer-retained job ID to fixed non-retryable `not_found`; that absence is recovery-evidence loss rather than proof that the underlying operation never executed.
`managed-job-terminal-maintenance.mjs` owns post-settlement evidence validation and artifact scrubbing; `managed-job-directory-generation.mjs` binds whole-directory retirement to the exact filesystem generation that retention inspected.
Retirement first revalidates the full observed generation, atomically renames that directory to an internal `retired_job_*` name carrying its device/inode identity, revalidates the moved object, and only then recursively deletes it.
The retirement namespace deliberately does not match the public `MANAGED_JOB_ID` grammar, so list/read/lock scans cannot reinterpret internal cleanup state as an ordinary job.
A crash after rename therefore leaves recognizable state rather than an anonymous orphan: a later maintenance pass reclaims it only when the encoded generation still matches, while a type mismatch, generation mismatch, or unreadable retired entry is projected into active-state inventory as a privacy-bounded `retired_managed_job`/`unreadable` blocker without exposing the internal filename or filesystem identity.
Before destructive terminal cleanup, status/result must describe the same directory job ID, terminal state, and `finished_at` generation; the degraded `result_persisted=false` form must carry an explicit terminal-record error class.
Corrupt terminal evidence is therefore retained as unreadable state and also blocks state removal instead of authorizing plan/runtime scrubbing or capacity eviction.
Expiry is a real per-job state transition: it acquires `transition.lock`, re-reads the staged state, and commits through the same result-first terminal persistence path as cancellation/runner settlement.
Seven-day retention is measured from terminal `finished_at`, not an older directory mtime.
Admission may evict only safely removable terminal records and never active, staged, unreadable, generation-replaced, or unreclaimed retired state merely to make room; every recognized retired entry still counts toward the same hard retained-state capacity until safely removed.
Cross-process create transactions serialize through an owner-identity-checked root `capacity.lock` across prune/recheck and status publication, and state inventory treats a live capacity lock as an uninstall blocker.

The runner:

- materializes registered resources as private `0600` copies after hash verification;
- materializes bounded job-scoped temporary files;
- substitutes resource/temp/runtime/workspace placeholders;
- executes ordered argv steps with bounded output and timeout/process-tree termination;
- polls an owner-only cancellation marker, terminates the current child tree, and keeps the runner alive for finally steps;
- attempts ordered finally steps after success, failure, timeout, or cancellation;
- removes private runtime copies;
- writes bounded redacted results and terminal status;
- deletes the full execution plan and runner PID file after terminal commit.

Running managed jobs do not belong to an MCP socket or daemon call ID and snapshot the accepted environment mode/resources.
Later profile changes govern new direct submissions; accepted running jobs require explicit cancellation.
Staged plans launch no process and have no terminal promotion path.
Daemon disconnect/replacement does not terminate them.
Dead runner PIDs are detected on the next daemon or local job-CLI start; stale private runtime data is removed and the finally phase is retried in recovery mode.
Recovery deliberately reruns all finally steps, so cleanup must be idempotent.

Local resource registrations remain in owner-only state and are reloaded for every new job.
MCP-visible resource inventory includes aliases and validation status but never source paths, hashes, or contents.

## Canonical policy contracts

Policy revision 5 is loaded from one shared JSON contract by both local and Worker policy evaluators.
Tool advertisement and execution authorization use catalog availability classes; managers receive the same authorizer instead of reimplementing profile conditionals.
Read-only job/resource inspection is `always`, job cancellation is write-gated, and starting a persistent job requires `write+direct-exec`.

Named profiles are normalized to their complete capability sets.
In particular, `full` always means write enabled, shell execution, unrestricted paths, complete parent environment, absolute-path display, and every catalog tool.
CLI flags that alter an individual capability deliberately change the profile identity to `custom`.
Policy revision 5 defines the only accepted persisted policy shape; data from another revision is rejected rather than interpreted.
Compound availability requirements come from the shared contract.

Remote authority has a separate final layer.
After the Worker intersects account role with daemon policy, the local runtime independently rebuilds authority from account ID, account version, OAuth client ID, refresh-family ID, and role.
`OperationAuthorizer` classifies normalized effects and enforces hard invariants: generic path-based tools cannot target control-plane roots; sensitive and persistence targets, browser and application control, data export, credential operations, and persistent-plan creation are owner-only; arbitrary remote process execution and process-session controls are owner-only, while external paths remain inside the effective policy.
Classification produces audit metadata, not an approval or privilege-escalation workflow.
Before a classified operation can be rejected by a role ceiling or protected-root check, the request context receives only the coarse risk category, normalized scopes, and runtime-keyed HMAC target fingerprint with `allowed: false`; the outer audit middleware can therefore preserve deny-path evidence without persisting the path, argv, resource name, or raw target hash.
Successful authorization replaces that attempted projection with `allowed: true`.
Every patch destination is canonicalized through the execution resolver before classification.
Long-lived processes, output sessions, and jobs retain the creating principal binding.
Version 3 has no capability-lease authorization or cleanup surface.
See [LOCAL_AUTHORIZATION.md](../LOCAL_AUTHORIZATION.md).

The full-only `generate_ssh_key_resource` operation is implemented locally.
The Worker only filters and relays its shared catalog definition.
Local generation uses `ssh-keygen`, verifies public/private correspondence, registers the private file through the same owner-only state transaction as the CLI, and rolls back a newly created pair if state persistence fails.

`full-test` constructs a local runtime with canonical full policy and executes real operations in disposable directories.
It is an acceptance test for the local implementation, not a probe that changes remote systems or bypasses host policy.

## Stdio MCP server

The stdio server implements newline-delimited JSON-RPC over stdin/stdout.
Each executable request must satisfy the single supported MCP `2026-07-28` metadata contract; there is no protocol session.
There is no stdio compatibility mode. `initialize` receives the same bounded removed-protocol rejection as other legacy handshake markers; `notifications/initialized` has no handshake effect. The CLI rejects `--compat`, and `MBM_MCP_COMPAT` cannot enable metadata normalization. Every request must supply the current protocol version and client capabilities in `_meta`.
It advertises policy-filtered tools through current discovery/list results, returns text plus structured content, supports native image content, maps current stdio cancellation notifications to runtime call IDs, and sends process diagnostics only to stderr.

## Cloudflare Worker and Durable Object

Public `/healthz`, `/`, discovery metadata, CORS preflight, and unknown-path 404s are answered by the outer Worker without Durable Object requests.
Only an exact stateful route allowlist passes a burst guard and reaches one named Durable Object.
It owns:

- OAuth clients, authorization codes, hashed access-token records, an independently versioned hashed refresh-token store, and throttling metadata;
- one preferred end-to-end-verified daemon WebSocket plus at most one schedulable signed HTTPS fallback channel, with bounded candidate/probing state for each transport;
- policy/tool metadata attached to the active daemon channel;
- a bounded in-memory map for daemon calls whose initiating request or response stream still owns settlement;
- one bounded pre-dispatch daemon-ready waiter set that uses the same 30 ordinary + 2 reserved-control capacity algebra as pending calls and folds current pending usage into that shared ceiling before accepting another disconnected new call. There is no separate pending-registration queue: on an already-ready daemon, capacity check, pending registration, and first send remain synchronous in one Durable Object JavaScript turn.

`BridgeRoom` owns stateful routing, MCP authorization/dispatch, daemon-channel lifecycle, cancellation, and composition of the extracted state machines.
`daemon-registry.ts` presents one transport-neutral ready-daemon view while `daemon-sockets.ts` retains WebSocket candidate/probe/hibernation ownership and the HTTP registry owns only the fallback channel.
`worker-entry.ts` owns outer-Worker static routing, stateful admission, current request-scoped SSE proxying, and privacy-safe gateway failures; `worker-static-routes.ts` and `worker-metadata.ts` own stateless public responses; `worker-edge-guard.ts` owns the burst guard and quota classification.
The outer Worker applies a two-level stateful burst guard before Durable Object routing: a high-capacity route/Worker bucket preserves aggregate abuse resistance, while a lower route/subject bucket isolates authenticated credentials or anonymous network identities through internal truncated SHA-256 keys.
Raw credentials and addresses are never stored in application logs or returned by diagnostics; the hash is an opaque bucketing key, not a claim of cryptographic anonymity for low-entropy network addresses.
Limiter failure is fail-open and never logs key material.
Both outer and Durable Object `/mcp` boundaries validate the actual Origin.

`mcp-http-contract.ts` owns MCP `2026-07-28` request metadata, strict media-type/`Accept` validation, and mirrored-header validation, including `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`, and schema-declared `Mcp-Param-*`.
`mcp-tool-call-input.ts` is the shared role-visible name/raw-argument/schema gate before side effects.
`mcp-controller.ts` owns request dispatch.
Discovery instructions and tool descriptions are host-cached execution contracts as well as documentation: `server/discover` and `tools/list` deliberately advertise `ttlMs=0`, every remote tool description carries the current `Tool schema generation N`, and `server_info.tool_delivery` exposes that generation, live server version, both zero TTLs, `host_visible_schema_known_to_server=false`, and `host_turn_deadline_observable=false`.
The server therefore distinguishes what it controls—request/tool deadlines and durable ownership—from an external assistant-turn deadline it cannot predict or extend; `managed_jobs_detached_from_mcp_response=true` records that accepted managed work is not owned by that response lifetime.
A package/Worker upgrade that changes tool semantics is incomplete until host-visible schema is independently verified after activation.
Current MCP `2026-07-28` remote discovery advertises `tools.listChanged=true`.
`subscriptions/listen` validates and bounds the requested filter; when `toolsListChanged` is requested it acknowledges that supported subset, emits a correlated level-trigger `notifications/tools/list_changed`, and keeps the request-scoped SSE stream open until explicit cancellation or the bounded server lease expires so the client can re-fetch `tools/list`.
`mcp-subscription-contract.ts` sets that lease to two public heartbeat intervals (10 seconds).
This is deliberately not an attempt to infer client receipt: Wrangler/Workers integration proved that a disconnected public HTTP client can close locally without producing a reliable request-abort, response-cancel, or heartbeat-write failure in the Worker/DO path for more than one heartbeat.
Tool definitions are immutable within one deployed Worker generation, so the immediate level-trigger is the only freshness edge available in that deployment; a client that needs another edge opens a new subscription.
Default full stdio keeps `listChanged=false` and completes validated subscriptions immediately; opt-in progressive stdio retains bounded tools-list subscriptions until cancellation or EOF.
No persisted subscription registry or replay log is introduced: deployment/connection loss terminates the request-scoped stream and a new subscription receives a fresh level-trigger edge.
Because rate limiting bounds subscription creation rate but not the number of already-open streams, the controller uses a separate subscription-capacity component: one Durable Object permits at most 32 active subscriptions and one authenticated account at most 8, preventing a lower-privilege account from monopolizing the freshness channel.
Capacity is reserved before stream creation and returned exactly once on abort/cancel/lease expiry, while over-capacity requests fail before allocating another stream.
`server_info.tool_delivery` projects only the current authenticated account's active subscription count plus whether the server successfully opened a freshness stream for that account during the current Durable Object instance; that opened-stream history is bounded to the most recent 64 accounts and never exposes account identifiers or another account's activity.
`tools_list_change_subscription_client_receipt_observable=false` makes the evidence boundary explicit: Machine Bridge can report server-side stream construction and current liveness, but it cannot prove that an external host read the acknowledgement or list-change notification, nor that the host refreshed its catalog.
`mcp-subscription-stream.ts` owns subscription SSE lifecycle and cleanup callbacks, while `mcp-response-stream.ts` remains responsible for direct tool-response SSE framing without event IDs or replay.
`mcp-response-proxy.ts` forwards exactly one Durable Object response, emits bounded keepalive comments, releases the internal reader on every terminal path, and maps public response-stream closure to a credential-free stream-scoped private cancel control.
`mcp-stream-proxy-contract.ts` contains only the private `direct`/`cancel` control shape and strips caller-supplied internal headers at the public boundary.
There is no long-lived subscription registry, prepare/subscribe delivery phase, result registry, protocol session, recovery GET, `Last-Event-ID`, cross-event terminal Promise, or persisted MCP replay result.

MCP `2026-07-28` requests are independent.
The Worker validates Origin, authenticates the request, checks body metadata and mirrored HTTP headers, intersects the tool with the account-visible catalog, and validates raw arguments before dispatch.
OAuth token plus JSON-RPC request ID is deliberately not a global request key: two requests sharing one token may reuse the same ID concurrently.
A streamed call remains owned by its initiating response stream and the ordinary bounded pending-call index.
Public abort, response-body cancellation, or failed keepalive delivery sends one random internal stream capability that removes the matching pending call and requests daemon cancellation.
Public requests cannot supply that capability because internal headers are stripped, and the control request forwards neither Authorization nor DPoP.

Daemon reconnect continuity remains separate from MCP delivery semantics.
WebSocket is preferred, but a daemon that loses verified WSS readiness may establish the signed HTTPS fallback with the same ephemeral root-certified P-256 identity and daemon instance.
Planned process shutdown is explicitly separated from that accidental transport-loss path: a ready local runtime sends one bounded `daemon_draining` control message before closing the relay, the Worker settles pending calls still owned by that daemon using recovery metadata already attached to each call, and `daemon_draining_ack` lets shutdown proceed without waiting for a socket failure to classify the event.
`read_job` carries a read-only same-`job_id` recovery descriptor, while mutations remain fail-closed if their execution settlement is ambiguous.
The handshake does not reuse daemon process identity and therefore cannot duplicate execution across old/new daemons.
Each fallback POST signs the fixed route/origin/server/version, a 30-second replay nonce/timestamp, and the exact body hash.
Both directions carry bounded contiguous transport sequences; an unacknowledged envelope retains its sequence across a response loss, duplicates are discarded before business handling, and sequence gaps fail closed.
HTTPS handover is candidate → probing → verified-ready.
An explicit same-instance takeover is allowed to retire a Worker-side zombie WSS only after the signed new-session request passes candidate preconditions; a malformed/stale request cannot knock down a healthy incumbent.
The daemon reconciles `resume_calls`, processes `ready_ack`, commits local readiness, emits sequenced `https_ready`, and only then emits `resume_calls_ack`; the Worker does not expose the fallback to ordinary dispatch before `https_ready`.
This order makes a non-empty `resume_calls_ack.missing_ids` a proof both that the same daemon never owned those call IDs and that the replacement channel is locally ready.
While the initiating MCP response still owns settlement and at least one second of the original execution budget remains, the Worker may transparently retransmit exactly that proven-undelivered call with the same call ID, arguments, authority, and a reduced timeout bounded by the original execution deadline.
If redelivery cannot be accepted or too little execution budget remains, the old safe retryable `unavailable` settlement is retained.
Calls present in the active-call or unacknowledged-result ledger, calls from a different daemon instance, and any mutation with ambiguous/post-dispatch settlement are never automatically replayed.
Result delivery has a distinct same-daemon boundary: after a transport interruption, the pending registry may extend only the original in-memory settlement owner to one fixed fifteen-second deadline beyond its original settlement deadline, including when the original settlement deadline was already at the ordinary per-tool ceiling.
The extension is absolute rather than cumulative across detach/rebind cycles, preserves cancellation, and cannot be consulted as execution/redelivery authority; its sole purpose is to accept an already-executed terminal result from the verified same daemon.
This transport continuity never creates MCP session/replay state.
A new call arriving with no verified daemon channel has a separate pre-dispatch recovery path: `daemon-ready-waiters.ts` waits at most fifteen seconds and never longer than that call's own execution budget; measured recovery time is deducted by `daemon-recovery-budget.ts` before dispatch while preserving the separate five-second Worker settlement margin.
Waiter authority and shared-capacity reservation remain live until the handover reaches its final no-`await` release point: WebSocket readiness first completes old-channel cleanup and runtime-alarm settlement, HTTPS readiness first completes its final alarm settlement, and only then does `notifyReadyDaemon` release the batch.
A socket that is already marked ready while waiters still exist is treated as handover-in-progress, so fresh calls join the same waiter set instead of leapfrogging its reserved capacity; waiter timeout returns retryable `unavailable` rather than bypassing a missing final handover notification.
Once released, the already-ready path performs capacity check → pending registration → first daemon send synchronously with no intervening `await`.
Ordinary standby/ready signed-HTTP exchanges retain the seven-second request deadline, while an exact-generation takeover uses a three-second request deadline until verified readiness.
One fully timed-out stale takeover request, the first one-second failure backoff, and two further fully bounded takeover exchanges therefore fit inside the existing fifteen-second new-call recovery window without enlarging the hosted foreground envelope.
Owner diagnostics report WebSocket and HTTPS fallback readiness separately.
ResilientRelayConnection owns fallback-to-outage attribution: a verified HTTPS takeover is keyed to the current stable WebSocket outage number, and the bounded reconnect history carries per-outage `https_fallback_taken_over` and `https_fallback_takeover_ms` evidence.
A bounded top-level last-takeover outage number exists only so Worker synthesized recovery can bind a pre-ready diagnostic snapshot to that exact episode; downstream daemon/Worker/runtime projections sanitize and copy the attribution rather than re-inferring it from timing.
Late results after request cancellation/timeout are acknowledged only so local recovery storage can release them; results from a superseded owner are rejected.
`relay-call-recovery.mjs` retains completed results in memory until acknowledgement, but that ownership is not allowed to grow outside the call-capacity model: `relay-recovery-admission.mjs` combines active relay tools with unacknowledged result count under the same 16-total / 14-ordinary / 2-reserved-control algebra.
Retained results count conservatively as ordinary ownership, so another ordinary call is rejected before execution once ordinary recovery ownership is full while `diagnose_runtime`/`list_roots` retain reserved capacity.
The retained-result store is encapsulated behind `RelayResultRetention`: normal ownership has a separate 16-entry hard ceiling, plus exactly one non-admission emergency slot reserved for an already-executed result that reaches retention only after that invariant has unexpectedly been violated.
The emergency slot preserves acknowledgement/reconnect ownership instead of sending an executed result untracked; it does not enlarge admission capacity, and a second overflow is not sent.
`relay-result-retention.mjs` also records a monotonic first-retained timestamp and prunes any result still unacknowledged after the 315-second maximum Worker settlement lifetime on the next live relay pulse; reconnect failure keeps its separately shorter grace cleanup.
Diagnostics project only aggregate counts.
A hibernated WebSocket attachment missing current liveness fields fails closed rather than being interpreted through an old schema.

`runtime-alarm.ts` and `runtime-alarm-storage.ts` own transient request deadlines plus both daemon transports' readiness/liveness alarm projection.
`daemon-sockets.ts` owns WebSocket role transitions, `daemon-http-channel.ts` owns fallback transport sequencing/readiness, and `daemon-socket-attachment.ts` remains the bounded policy/tool/instance metadata shape shared by transport projections.
`daemon-last-observation.ts` owns one in-memory, privacy-bounded last-verified-channel observation and `daemon-registry.ts` wires it across both transports so `server_info.daemon.previous_connection` remains useful while both are offline; that observation contains only transport/timestamps/sanitized relay diagnostics and is never authority, routing, or dispatch state.
`runtime-relay-shutdown-drain.mjs` owns the local bounded pre-close drain/ack exchange; `daemon-planned-drain.ts` owns Worker-side planned-drain settlement, while `daemon-ready-messages.ts` remains the common ready-channel dispatcher for terminal result, resume acknowledgement, authority-revocation acknowledgement, and planned-drain dispatch.
`mcp-jsonrpc.ts` owns JSON-RPC shape validation and current result/error/tool-result projection.
`websocket-protocol.ts` remains WebSocket-specific send/close/rejection plumbing.
`OAuthController` owns OAuth-store pruning, registration throttling, authorization submission, account-admin routing, token exchange, access-token verification, and the serialization queue for OAuth mutations.
Worker-internal TypeScript imports use explicit `.ts` specifiers and JSON import attributes, so the same modules are directly executable under the pinned Node runtime and bundled by the pinned Wrangler builder through native cf configuration.

The shared tool catalog is executable protocol data rather than documentation only.
`tool-argument-validation.mjs` compiles the supported JSON Schema 2020-12 subset at process/module initialization, rejects unsupported dialects or keywords instead of silently weakening them, refuses automatic network `$ref` dereference, and bounds schema depth, node count, pattern length, issue count, and total runtime validation steps.
Array elements and each own object property consume work; object traversal does not allocate an unbounded key array before checking the budget.
The open JSON portions of request metadata, capabilities/extensions, and subscription filters use a separate 4,096-node/32-level/bounded-key structural walk, and resource subscription lists are count/length bounded.
Worker validation prevents invalid remote calls from reaching the daemon; local validation remains a second boundary for stdio, relay, and direct runtime entrypoints.
Validation diagnostics contain only JSON Pointer instance path, keyword, and constraint text—never the rejected value or an unbounded caller-supplied identifier.


## Daemon device authentication

The local daemon uses a long-term P-256 device root to certify a 24-hour ephemeral session key.
Worker deployment receives only the root public JWK.
The default provider on every platform is an owner-only portable private JWK. macOS can instead use non-exportable Secure Enclave material only when `MBM_MACOS_TRUST_BROKER` identifies an app-like broker whose Apple signature, Team ID, canonical non-symlink executable path with no group/other write access, provisioning-backed Keychain capability, and actual create/delete key probe all validate.
The source-build development broker cache is separate from that production trust decision: a versioned marker binds both source and compiled-binary SHA-256, and cache reuse additionally requires a regular single-link owner-only executable before signature verification.
The enrolled state binds that broker identity, Keychain tag, and public key.
One root signature at daemon startup certifies the in-memory session key.
Every WebSocket attempt then carries a short-lived preflight signed by the session key and bound to Worker origin, package version, nonce, timestamp, and the root certificate.
The nonce is consumed once through bounded Durable Object state.
After upgrade, the Worker issues a fresh challenge and accepts tools only after a second session signature binds the challenge, origin, package version, daemon instance ID, and timestamp.
Reconnects reuse the in-memory key without touching the root.
End-to-end readiness still requires an ordinary relay probe before a verified candidate replaces the incumbent.

The primary OAuth store separates trusted client registrations and named accounts from authorization codes and access-token records.
A separate versioned Durable Object key owns refresh-token families, consumed-token markers, and family revocation.
A `client_id` identifies an MCP application and redirect URIs; account records identify the authorized human or service identity.
Codes and tokens bind client ID, account ID, account version, role, scope, resource, deployment token version, family identity, and expiration where applicable.
Only hashes of bearer tokens are persisted.
Access tokens last fifteen minutes; refresh tokens rotate and expire after fourteen idle days or thirty absolute family days.
An identity-equivalent retry may reproduce the same deployment-keyed HMAC replacement pair at most twice inside a 30-second concurrency window without extending its expiration; retry-budget exhaustion is throttled, while reuse after that window revokes the complete family, including active access tokens.
The Worker carries account, client, and refresh-family identity with every relayed call so long-lived runtime objects cannot cross principals.
Authority mutations durably queue matching local revocations in the same Worker transaction.
The daemon acknowledges a queued revocation only after local pending calls, process sessions, and inspectable managed jobs have all applied it.
Every local execution category is attempted even when an earlier category fails, so a failed process-session termination does not postpone cancellation of an independently revocable managed job; any failure still withholds acknowledgement and interrupts that relay generation for prompt replay on reconnect.
This internal cancellation bypasses public tool availability only—it still enforces object ownership, state-maintenance, transition-lock, process-termination delivery, and persistence invariants—so later policy narrowing cannot make an older durable job non-revocable.
One bridge-specific Durable Object and one local runtime remain the normal topology for a workspace/trust domain; see [MULTI_ACCOUNT.md](../MULTI_ACCOUNT.md).

The daemon attachment deliberately omits workspace path/name/hash and process ID.
Explicit authenticated tools may return workspace metadata according to local path-display policy.

## Autostart layer

The service layer emits launchd, systemd-user, or Windows Scheduled Task definitions.
Worker/account credentials are not embedded in service definitions; the daemon loads owner-only state.
The exact policy is stored in owner-only state.
An allowlisted `service-environment.json` separately persists only network-proxy and custom-CA variables needed by a background daemon, because shell-session environment is not inherited reliably by login managers; values are loaded only for `--daemon-only`, never logged, and status exposes key names only. launchd/systemd definitions contain the workspace/state-root selectors, `warn` plus JSON log settings, and a sanitized absolute-only PATH captured at installation so background `full` mode can resolve the same developer tools without accepting relative PATH entries.
The current Node and package bin are explicit; all nested npm run-script prefixes and inactive candidate-runtime entries are removed so the service definition does not depend on whether installation was invoked from an npm lifecycle or a prior candidate daemon.

The Windows adapter owns a short private restart launcher because Task Scheduler's `/TR` action is substantially smaller than the Windows process command-line limit and the full installed Node/CLI/workspace argv can exceed it.
The scheduled action therefore contains only the launcher path.
The launcher performs the full quoted invocation, redirects to service logs, and restarts only nonzero exits.
A fixed PowerShell object query supplies language-independent `Ready`/`Running` state; provider installation is not equated with process activity.
The trigger is least-privilege current-user logon, not boot-time `SYSTEM` execution.

The platform adapters normalize launchd, systemd, and Windows Scheduled Task operations to one `{ok, provider}` result contract.
Provider activity is tri-state: only verified active/inactive evidence yields a boolean; unavailable, ambiguous, or transitioning provider state yields `active: null`, and service-runtime mutation refuses it. launchd status is fail closed: `launchctl print` exit 0 is loaded evidence, exit 113 is the explicit missing-service result, and every other nonzero exit is `status_unavailable` rather than inferred absence.
A launchd stop/removal is verified only after the service is both inactive and unloaded from the launchd domain; observing a process exit while the service remains registered is not sufficient deletion evidence. systemd treats only recognized `is-active` states as status evidence: `active`, `inactive`, `failed`, and confirmed missing state are actionable, while transition states and installed-but-unknown state remain non-boolean.
`service-runtime.mjs` owns committed-owner/provider orchestration, while `service-runtime-convergence.mjs` owns daemon readiness and replacement evidence.
Start may return idempotently for an already-ready owner; restart may not, and an active restart requires provider evidence plus a different ready daemon PID.
Removal is not a provider-specific sequence: `service-lifecycle.mjs` first stops the provider, then every verified workspace daemon in scope, and only then removes the definition.
A failed stop or unverifiable process prevents definition/state deletion.

The autostart provider name is machine-global, but daemon locks are state/workspace-scoped.
Foreground startup therefore does not stop the provider merely because a Machine Bridge service exists.
It first verifies that the current state's daemon lock identifies a live `service` process whose command line matches the same canonical workspace and state root.
Only that proven owner may trigger provider stop; isolated installs, another workspace, another state root, and foreground locks leave the existing service untouched.

Local release-candidate browser integration has one additional release-owned state surface: `release-channels/browser-extension`.
Versioned candidate package roots resolve browser setup/status to this stable physical directory rather than their disposable `runtimes/v<version>-<sha>-<nonce>/.../browser-extension` path.
Activation publishes exact installed candidate files there only after Worker/background-daemon convergence, replaces ordinary files atomically, commits `manifest.json` last as the extension-version marker, then prunes inactive candidate runtimes and writes activation evidence.
Ordinary checkout and global-package runtimes remain package-local, so development code is not silently redirected through release state.
This stable directory exists because Chromium persists the source path selected by **Load unpacked**; candidate runtime pruning must never invalidate that source path again.
