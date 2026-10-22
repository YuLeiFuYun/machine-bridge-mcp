# Process model and output buffering

Detail behind [Architecture](../ARCHITECTURE.md#process-model). The invariants the rest of
that document depends on are the ownership chain and the resource-admission gate; the
scheduling, PTY, and output-buffer mechanics live here.

## Process model

Resource command classification distinguishes local resource cost from semantic sensitivity.
Arbitrary shell execution has no blanket zero-resource class: even a read-only-looking payload remains adaptive or is promoted by the normal shell/build classifiers, so PATH resolution, startup profiles, substitutions, wrappers, and later shell segments never need to be proven harmless merely to obtain an admission bypass.
Generic zero-resource process exceptions are identity-based in `resource-light-command.mjs` and require a small set of standard absolute executables; PATH-resolved lookalikes do not qualify.
The heavy script/package-manager family has one separate control-plane exception because the live OAuth canary must remain runnable while unrelated builds hold machine reservations.
That exception bypasses both npm lifecycle execution and mutable checkout code: only exact direct Node argv `node <activated-runtime-package>/scripts/release-oauth-canary.mjs --allow-live-oauth-canary` can become `release-control`.
The script operand must be absolute and `resource-release-control-workspace.mjs` canonicalizes it to the running package's own `scripts/release-oauth-canary.mjs`; a workspace-relative or copied canary therefore cannot qualify even when its bytes match.
`npm run release:oauth-canary` and `node scripts/release-oauth-canary.mjs ...` remain source/developer entrypoints with ordinary accounting, but prerelease canary provenance rejects them as release evidence because the executing package root must canonicalize to the package root containing activation `runtime_entry`.
The lexical Node shape alone is also insufficient.
`resource-release-control-executable.mjs` resolves the executable that the child PATH would actually invoke, canonicalizes it, and requires equality with the daemon's own `process.execPath`; a shadowing first Node match therefore fails instead of being skipped.
It refuses the light profile when Node/native debugging, profiling, TLS, loader, or resource-startup overrides such as `NODE_OPTIONS`, `NODE_DEBUG`, `NODE_TLS_REJECT_UNAUTHORIZED`, `SSLKEYLOGFILE`, `UV_THREADPOOL_SIZE`, `LD_PRELOAD`, or DYLD injection paths are present, and the canary runner enforces the same environment policy before any live OAuth mutation.
The command cwd remains bound to the running package name/version and exact canary source bytes.
The packaged canary derives its imports from the activated runtime package but deliberately uses `process.cwd()` as the candidate/evidence data root, so mutable checkout modules are never evaluated under the release-control exemption.
The canary itself requires exactly the single live-canary flag, requires empty `process.execArgv`, and rejects alternate state/workspace argv before state access because those identities and Node startup flags are not represented in acceptance evidence.
It also calls the existing service-daemon identity verifier and requires a current startup-ready service daemon whose version equals the candidate, whose canonical `entryScript` equals the executing canary package's `bin/machine-mcp.mjs`, and whose canonical Node executable equals the canary's `process.execPath`, and whose private daemon-lock Node runtime version equals `process.versions.node`.
That daemon proof applies to stable as well as prerelease candidates; the prerelease activation record remains an additional package-root/hash binding rather than the only code-origin proof.
It resolves the npm CLI needed by its explicit `--ignore-scripts` pack dry-run without trusting lifecycle `npm_execpath`; `npm-cli.mjs` uses the running Node installation layout, including the package-manager prefix associated with Homebrew Cellar Node paths, before any general fallback is considered.
Shell wrappers, npm/alternate package managers, workspace-owned canary paths, lookalikes, missing/extra argv, and candidate preparation retain ordinary accounting.
Thus the exception requires direct-argv identity, activated-runtime code identity, runtime Node identity, startup-environment identity, and runtime-bound workspace identity together.
It remains a cooperative accounting invariant, not hostile same-user code authentication, and changes neither release authorization nor OAuth mutation policy.

`run_process` and process sessions use argv arrays and do not invoke a shell.
`exec_command` invokes the platform shell and is available only in `shell` mode.
Both inherit local-user OS authority.
Process ownership is released only by real close/exit settlement, not by a standalone ChildProcess `error` event: one-shot execution, internal fixed executables, and detached managed-job steps latch asynchronous child errors until settlement before untracking or releasing resource leases.
A process-session start that fails after spawn likewise retains an internal session/tracker/lease until the child actually closes; its public error is non-retryable and reports whether termination was requested or settlement remains unknown.
Forced `kill_process` still returns the bounded request outcome described by its tool contract, but account/family authority revocation is stricter: it does not delete the retained process-session handle or acknowledge the durable revocation until the targeted session has actually closed within the monotonic settlement deadline.
Runtime shutdown first puts the call registry into terminal drain mode: new tool calls are rejected, existing calls are cancelled but remain registered until their handler lifecycle `finally` actually finishes, and a stuck handler leaves the runtime in retryable teardown failure instead of being erased from accounting.
Only after every handler has settled does the runtime drain tracked one-shot children and then process sessions.
This ordering closes the late-spawn window in which a cancelled handler could otherwise register another child after an apparently empty process drain.
Any child registered while process drain is active is terminated immediately.
An incomplete call/process/session drain moves the lifecycle to non-operational `stop_failed`, which rejects restart but permits another cleanup attempt, so daemon lock release/process exit cannot advertise ownership release while execution settlement is still unknown.

Fixed implementation-owned Git operations are not routed through that arbitrary-process capability.
`GitService` owns the filesystem-first repository discovery used by the structured Git tools and `project_overview`: metadata pointers, object stores, alternates, and reference metadata are checked against request-effective path visibility before a Git subprocess starts, and restricted principals additionally reject symbolic-link or special-file descendants in the metadata trees.
Structured Git uses code-constructed argv, literal pathspecs, no shell, a minimal isolated environment, bounded output/deadlines, and the same cancellation/process-tree accounting.
Repository configuration that redirects local files, executes conversion helpers, or enables lazy object fetching fails closed rather than expanding the structured surface.
`git_commit` also refuses merge, rebase, cherry-pick, revert, bisect, and sequencer state before staged-tree plumbing begins, so the narrow single-parent commit path cannot flatten an in-progress history operation; its fixed Git process environment comes from the same exact-value contract that validates internal overrides.
The caller cannot choose the executable or inject a command string.
Role filtering still applies to returned data and mutation availability; hostile same-UID replacement after inspection remains outside the filesystem-authority guarantee.

The default `full` profile passes the complete parent environment.
Isolated environment mode, used by the narrower named profiles unless overridden by the effective policy/accepted execution plan, creates private runtime HOME, temporary, and cache directories and passes only a small set of path/locale/platform variables.
No ambient process variable may promote isolated mode to full parent-environment inheritance.
It reduces accidental credential inheritance but cannot prevent explicit access to known filesystem paths, credential stores, network services, or other user resources.

`execution-limits.mjs` is the shared source for local tool-call concurrency, one-shot process timeout/stdin/output limits, and process-session count/stdin/output/retention limits.
Remote-owner `diagnose_runtime.runtime.execution_guardrails` reports those enforced limits, while local stdio `server_info.runtime.execution_guardrails` exposes the same contract together with explicit `not-enforced` values for CPU quota, memory quota, and network isolation.
Public one-shot commands inline at most 32 KiB per stream.
When either stream exceeds that preview, the runtime keeps up to 1 MiB per stream in a closed in-memory process session for thirty minutes and returns an `output_session_id`; `read_process` then reads monotonic byte-offset pages.
Relay-origin process reads use paced same-response follow-up.
`process-session-read.mjs` owns read/wait/output orchestration while `process-session-remote-poll.mjs` owns only hosted projection/cooldown policy, leaving `process-sessions.mjs` focused on session lifecycle and ownership.
The async read helper returns its internal plan/output snapshot before hosted projection is finalized; after the await the manager re-checks cancellation, then completes projection synchronously, so cancellation at the Promise boundary is not lost and a child exit there cannot produce `running=false` with stale cooldown metadata.
The Worker and daemon cap the actual output/exit blocking wait at one second; a live session that has just consumed a remote blocking read enters a fifteen-second would-block cooldown.
A repeated would-block request inside that cooldown is paced inside the same MCP call until output/exit or the cooldown boundary instead of returning an immediate running checkpoint, and the Worker execution budget covers that server-side delay.
When `wait_for_exit=true`, ordinary output notifications remain readable but do not release the cooldown stage; only process exit or the monotonic cooldown deadline advances the call to its bounded one-second exit-wait stage.
Every live relay-origin read identifies `status_polling_mode=paced_followup` and keeps `host_turn_handoff_recommended=false`; terminal reads identify `status_polling_mode=terminal`.
The cooldown fields are explicitly blocking-only (`blocking_poll_throttled`, `next_blocking_poll_after_ms`) so a zero-wait status read is not misrepresented as globally rate-limited.
Same-response follow-up is allowed when the task needs additional output or terminal state, but callers must not busy-loop and should respect the reported cooldown.
Elapsed wall-clock time is not a host-deadline signal: callers continue bounded follow-up while calls are accepted and hand progress back only after an actual host/tool boundary is observed, external input/authorization is required, or the user explicitly requested a checkpoint.
This state is per in-memory process session, does not alter local stdio/CLI wait behavior, and is intentionally a hosted pacing bound rather than durable scheduling.
The oldest exited session is evicted before an active session is refused, so continuation retention is explicitly best effort rather than durable.
The continuation stores command basename and cwd metadata but not argv or shell text. It is memory-only and disappears on runtime stop or daemon replacement.

Resource admission is a separate cooperative boundary, not an OS quota.
`resource-foreground-wait.mjs` owns the ordinary process-start wait budget: a one-shot foreground call defaults to 20% of its execution timeout with a two-second floor, ten-second ceiling, and never more than the complete execution timeout.
Owner-local process-session startup defaults to a ten-second cooperative wait, while relay-origin `start_process` performs one admission attempt without queueing by default so known host pressure is returned before the request-owned response budget is consumed.
An explicit configured override remains authoritative for controlled diagnostics/tests.
`LocalRuntime` leaves this default unconfigured in production so the services actually apply it, while explicit overrides are validated and capped at thirty minutes.
These admission waits occur before process spawn and do not enlarge an outer relay deadline; cancellation propagates through the same coordinator wait.
Detached managed-job steps use the shared durable-delivery admission ceiling instead: the runner may wait up to thirty minutes before spawn, child execution timeout starts only after admission succeeds, and persisted job status reports `current_phase=resource_admission` during that pre-spawn interval.
Hosted managed-job continuation has two paths, and the MCP Apps path follows an explicit data-tool/render-tool split.
When a request advertises the standard MCP Apps `text/html;profile=mcp-app` capability, an active `start_job` remains data-only and reports `ui_monitor_candidate=true`, `ui_monitor_claim_required=true`, `ui_monitor_render_tool=render_job_monitor`, and a fresh 128-bit `ui_monitor_id`; model-side `follow_up_read_required` remains true.
Issuance is latest-wins for the same job/principal: a new monitor record retires older issued/active/claimed records for that authority, so a stale View cannot keep opening new automatic status reads after a later render instance takes over.
The bounded issued/active/claimed registry is transactionally stored in the BridgeRoom Durable Object rather than isolate-local memory.
Its schema contains only job/principal/monitor/state/expiry/ordering metadata, never a `recovery_key` or job result; therefore a Worker isolate replacement between `render_job_monitor` and the View's claim can reconstruct the exact activated record without weakening authorization.
The monitor is optional because job polling ownership is not task ownership.
If the current assistant still has task-local work that depends on this job's terminal result, it does not render the monitor merely to shorten the response; it preserves `job_id` + `recovery_key` and continues bounded server-paced `read_job` calls.
Only when the current task can deliberately transfer this job's status polling without needing its terminal result for remaining same-response work does the model preserve the new ID and call `render_job_monitor(job_id,recovery_key,ui_monitor_id)` once.
That Worker-only read-authority check is the sole tool carrying the Job Monitor resource metadata and activates only the exact pre-issued monitor record; it does not generate a replacement ID, and the model does not depend on either structured or text output from the render tool.
The sandboxed View receives `job_id`, `recovery_key`, and `ui_monitor_id` from the render tool input, bounds `ui/initialize` to a 30-second response watchdog, requires `hostCapabilities.serverTools`, and calls the app-only `claim_job_monitor(job_id,recovery_key,ui_monitor_id)`.
The claim validates the existing principal-bound read capability and requires an activated monitor record before storing short-lived claimed polling evidence; the recovery capability and result are not stored, and the claim never reaches the daemon.
The model's next `read_job` passes the same `ui_monitor_id` already obtained from `start_job`, which the Worker strips before daemon dispatch.
Only a claim whose five-minute freshness window is still current projects `ui_monitor_claimed=true`, `status_polling_mode=ui_monitor`, and model-side `follow_up_read_required=false`.
For an ordinary job it keeps `host_turn_handoff_recommended=false` and suppresses duplicate model-side polling for this job only.
For an explicitly persisted `continuation_mode=task_supervisor` whose reviewed durable plan already encapsulates every remaining noninteractive task action, the same active claimed projection may set `host_turn_handoff_recommended=true`; Machine Bridge can validate that finite declaration, its persisted active state, and the current claim but cannot infer conversation-level completeness, which remains an owner/caller semantic assertion; execution ownership remains in the durable supervisor job, not the View, and no new capability authority is created; the View uses app-only `read_job_monitor`, which verifies the same principal-bound recovery capability and also requires that monitor ID to remain the latest claimed View before reducing the request to a fixed 40-second daemon `read_job` with no recovery/correlation values crossing that boundary.
Each accepted app read refreshes the five-minute handoff-freshness window.
If the host suspends the View or the machine sleeps past that interval, the expired freshness no longer proves model-side handoff, but the still-latest claimed record remains bounded in durable Worker state and the same View may resume app polling with its recovery capability; a newer issuance deletes the old record and therefore blocks resumed polling from the replaced View.
The `recovery_key` remains the data-read authority; `ui_monitor_id` is only continuation-instance gating.
A replacement can race with one old read already dispatched to the daemon, but no subsequent read from that old View is admitted.
Each app-origin status call has a 60-second client response watchdog.
A missing/transport-failed or explicitly retryable app-read response is retried in the View for at most six attempts with bounded 1/2/4/8/15/30-second backoff; exhausting those attempts or receiving a non-retryable error pauses instead of looping, and no retry path resubmits the managed job.
Claimed records remain bounded by the existing 128-record durable monitor registry, latest-wins replacement, oldest-record eviction, and authority revocation.
The View still has no direct network domains or weaker job lookup.
Unsupported hosts, and UI hosts without proven `serverTools`, retain bounded autonomous model follow-up: `managed-job-hosted-status.mjs` owns the relay-only projection, so relay-origin `read_job` reports `status_polling_mode=bounded_followup` plus `host_turn_handoff_recommended=false` for active jobs while terminal reads report `status_polling_mode=terminal`; local job reads retain their prior shape.
Worker tool guidance allows a known active job to be followed again in the same assistant response when terminal state is required, while prohibiting busy loops, repeated `list_jobs` substitution, and speculative handoff based only on elapsed wall-clock time.
`managed-job-read-wait.mjs` keeps that autonomy out of the host spin loop: the runtime `read_job` handler performs a relay-only 40-second default long-poll with five-second lightweight status-only probes, monotonic deadline accounting, and cancellation checks.
Terminal settlement returns on the next bounded probe.
Nonterminal status/phase/dependency progress is coalesced until at least the 30-second hosted progress floor (or the caller's explicitly shorter wait), and `current_step` alone is excluded from the hosted wake signature; local explicit waits retain step-progress wake behavior.
The public hosted maximum is 60 seconds; the 40-second default remains intentionally separate so ordinary continuation leaves additional host/Worker settlement headroom, while longer jobs continue through another server-paced read of the same capability-bound job rather than one overlong host request.
Full runner/recovery reconciliation is bounded to thirty-second intervals inside the advertised wait rather than executing on every lightweight probe.
The monotonic wait deadline starts before the initial full read, so initial reconciliation consumes the same per-call budget, and an unchanged timeout returns the latest secure persisted progress state without adding a second heavyweight reconcile after the deadline.
Coherent non-interactive command sequences should use a repository umbrella command or a multi-step managed job so local command fan-out does not become host-visible tool-event fan-out; this density control does not shorten the managed task or its six-hour step ceiling.
Hosted reads first verify a healthy runner with async process-start identity sampling; `managed-job-hosted-reconcile.mjs` owns that relay-only liveness/recovery decision, and only a non-current/ambiguous runner enters the existing recovery reconciliation path, so a normal long-running job no longer launches synchronous `ps` from the relay event loop every reconcile interval.
`ManagedJobManager.read()` remains the local synchronous persistence/ownership projection while relay reads use `readHosted()`; `readProgress()` deliberately omits runner reconciliation and terminal-result projection during unchanged waits.
Relay-origin `list_jobs` remains an `inventory` surface and does not recommend handoff, but its hosted projection is aggregate-only: it omits job IDs, names, and `recent_process_recovery` handles.
Hosted acceptance returns deterministic HMAC-derived `recovery_key` and `control_key` capabilities bound to account version, OAuth client, refresh family, role, job ID, and capability purpose.
The Worker validates these credentials before daemon dispatch, strips them before constructing the daemon request, requires `recovery_key` for `read_job` and every `depends_on` reference, and requires `control_key` for `cancel_job`.
The capabilities are derived from the existing Worker OAuth identity key and are never persisted with local job state; rotating that identity key invalidates outstanding hosted capabilities.
Local CLI/stdio administration intentionally retains global owner visibility.
This boundary prevents Machine Bridge's own hosted global inventory from causing cross-conversation job discovery, but it cannot distinguish two host conversations if the host itself incorrectly supplies the other conversation's still-valid capability.
Ordinary managed-job result/status projection remains separate from this hosted pacing policy.
Owner diagnostics separately expose the Boolean `waiters.drain_active`, computed by the same fairness selection state machine, so Green host/resource pressure is not confused with an aged protected waiter intentionally reserving a drain window.
A fixed CPU request that exceeds the machine's best-case priority-specific launch window is structurally incapable of becoming admissible while the configured CPU headroom remains in force; it therefore returns non-retryable `cpu_request_exceeds_launch_window` before entering the retry sleep loop instead of masquerading as transient `cpu_pressure_window`.
Explicit worker counts/argv are never rewritten and the headroom is not relaxed; elastic/unbounded requests retain their pressure-aware fitting behavior.
`resource-command-profile.mjs` classifies known light operations, bounded adaptive unknowns, and known CPU/I/O/mixed build families.
`resource-script-classification.mjs` classifies only an actually executed shell/Node/Python script operand or package-manager script name, and `resource-shell-analysis.mjs` owns conservative shell token/segment parsing.
This lets direct orchestration roots reserve startup capacity before descendant fan-out without letting an unrelated argument such as a test filename or release note impersonate a heavy script.
The arbitrary-process zero-resource allowlist is intentionally identity-bound: `resource-light-command.mjs` accepts only a small set of standard absolute executables for constant/output, process-table, uptime, and sleep probes.
Bare PATH-resolved names and every arbitrary shell invocation remain adaptive even when their apparent command is cheap, because executable resolution, startup configuration, repository configuration, path behavior, options, helpers, or input size can change the actual work.
Caller-controlled Git, filesystem metadata/query commands, lookup helpers, recursive/search/file-stream processors, `find`, application launchers, and script interpreters therefore never receive zero-resource admission from basename alone.
Implementation-owned Git/diagnostic probes use their separate fixed-argv/internal boundary and do not depend on this allowlist.
`resource-admission.mjs` persists per-user owner-only leases and waiters outside workspace state; ownership is bound to PID plus process-start identity and, where supported, the isolated process group.
Releasing the caller-side lease does not delete a bound POSIX reservation while that isolated process group still exists: the persisted lease remains until ordinary pruning observes the group gone, so a detached descendant cannot become unaccounted merely because its direct caller returned.
Independent nested process roots retain their own full durable leases for crash recovery, but live accounting does not blindly add an orchestration envelope and every child reservation.
`resource-process-ancestry.mjs` samples the live parent graph through `resource-process-ancestry-cache.mjs`; the async cache coalesces concurrent requests and retains a completed snapshot for one second so admission retries do not repeatedly enumerate the complete process table.
If ancestry cannot be sampled, accounting falls back to conservative full summation.
`resource-lease-accounting.mjs` forms an ephemeral lease forest whose effective vector is the component-wise maximum of a node's own envelope and the sum of its direct lease children.
A pending nested request is charged only for the additional vector it contributes to that forest.
Same-key contention is exempted only for the request's actual ancestor lease chain; siblings and unrelated roots still serialize.

The monitor continuation path has an explicit data-minimization boundary after daemon dispatch.
The daemon still executes the ordinary capability-checked `read_job`, but the Worker immediately converts that result into a fixed lifecycle-status allowlist before returning from app-only `read_job_monitor`; stdout/stderr, argv/command text, paths, nested step/result objects, capabilities, and unknown fields do not enter the View.
The View's initial render input is the sole source of `job_id`, `ui_monitor_id`, and `recovery_key`; later ambient tool-result notifications cannot retarget it, and teardown erases that in-memory authority plus outstanding response timers.
Monitor Durable Object storage is continuation metadata rather than business-result authority: an issuance or claim-probe storage failure after a durable result exists falls back to non-UI/model continuation, while monitor cleanup failure during authority revocation is logged by bounded operation/error class and does not block the revocation itself.
The persisted registry additionally validates unique monitor IDs, unique ordering sequences, and claim sequences no newer than the registry generation.

Live host-pressure observation is deliberately asynchronous-only.
`resource-probe-command.mjs` owns bounded `execFile` child-probe transport and intentionally exposes no synchronous `spawnSync` path; `resource-host-darwin.mjs` runs Darwin memory, VM, disk, and thermal probes concurrently, `resource-process-ancestry.mjs` samples the parent graph asynchronously, and `resource-host-snapshot.mjs` composes those results without blocking the daemon event loop on `ps`, `memory_pressure`, `vm_stat`, `iostat`, or `pmset`.
The previous sync host/Darwin/process-parent samplers and sync ancestry cache are removed rather than retained as test-only APIs that a future runtime path could accidentally call.
Process-start identity used when binding a spawned lease is also sampled asynchronously before the coordinator file lock is taken.
Lease/waiter pruning uses a separate one-second cached async process-start snapshot collected outside the transaction lock; while holding the lock it performs only PID liveness plus in-memory generation comparison.
The currently executing coordinator is authoritative for its own generation and uses `currentProcessStartTimeMs()` when a persisted waiter/lease owner or atomic staging publisher PID equals `process.pid`; the external all-process snapshot remains generation authority only for foreign owners.
Missing foreign snapshot evidence fails closed for a live PID, while a proven foreign generation mismatch remains reclaimable before isolated process-group liveness can preserve the lease.
This prevents a still-running coordinator from self-pruning its own waiter or provisional lease, or deleting its own in-flight waiter/lease staging file, because of an external process-table generation discrepancy.
Staging from an older same-PID generation remains reclaimable because its file timestamp predates the current process-start identity.
The expired beta.104 transaction-owner directory migration path is no longer executable; unsupported legacy transaction-lock directories are retained unchanged and fail closed so stale migration code cannot become a destructive recovery surface.
`resource-host-cache.mjs` treats a same-project general host snapshot as fresh for 500 milliseconds while retaining successful I/O evidence for at most five seconds; a stale general sample can therefore refresh cheap CPU/memory/load data without waiting for another one-second `iostat` interval, but an older throughput peak is not copied into a current quick sample.
Timestamps represent sample completion rather than sample start.
`resource-admission-policy.mjs` evaluates effective CPU, memory, I/O, disk-reserve, startup-window, and host-pressure values without imposing global serialism. macOS `iostat -Id` exposes transfer and throughput activity, not device utilization/saturation; fresh high IOPS/MB-per-second evidence therefore tightens I/O capacity as Yellow pressure but cannot by itself mark the host Red.
Red remains reserved for direct critical evidence such as thermal/memory/disk-headroom failure or a severe load backlog corroborated by current CPU/I/O evidence.
Linux additionally uses `MemAvailable` and optional PSI avg10 observations through `resource-host-linux.mjs`; sustained `psi_io_full_avg10 >= 60` is direct critical I/O-stall evidence and therefore Red, while lower I/O PSI remains a Yellow capacity-throttling signal.
The soft free-disk floor is `min(80 GiB, max(8 GiB, 15% of volume))`; the post-reservation hard floor is `min(50 GiB, max(5 GiB, 10% of volume))`.
Disk-only hard-red pressure has one narrow self-recovery exception: only an internally classified direct standard absolute deletion executable with the exact small `disk-reclaim` envelope may enter using Yellow capacity limits, and only when `disk_free_headroom_critical` is the sole critical reason.
PATH-resolved or shell-composed deletion cannot claim that class, and thermal, memory, PSI, CPU/load, or other Red evidence still blocks it.
Diagnostics expose observed busy CPU next to reserved CPU and their ratio as a mismatch signal, not as process attribution.
`resource-admission-diagnostics.mjs` owns the privacy-safe snapshot/check projection, while `resource-admission-diagnostic-error.mjs` separately classifies bounded transaction/staging-lock contention as retryable coordinator-busy snapshot unavailability instead of inflating the diagnostics module or mislabeling contention as process execution failure.
`resource-waiters.mjs` normally skips an older request that does not fit, but a sufficiently aged rank-zero waiter blocked by coordinator-owned project/CPU/I/O/memory capacity can enter a protected drain phase if it is structurally feasible after current leases disappear.
Fixed implementation-owned probes bypass this coordinator so diagnostics/recovery remain usable during resource pressure.

The same protocol is intentionally language-neutral: compatible workflow controllers may use the same per-user coordinator root, schema, lease ownership, contention keys, and waiter ordering.
This permits Machine Bridge and workflow-bundle to coordinate independent process trees without a new daemon.
`resource-project-key.mjs` canonicalizes the existing filesystem path before deriving the v1 project-contention hash, so path aliases such as macOS `/var` versus `/private/var` and symlinked workspace roots cannot create different mutex identities across implementations; Windows additionally normalizes separator form, path case, and extended-path prefixes before hashing.
Lease/waiter records contain resource families, numeric reservations, hashes, timestamps, and process ownership but never argv, shell text, or raw project paths.
The anonymous `project_hash` is derived from the same canonical project identity as contention and is diagnostic correlation only; it is not authorization or admission authority.
The coordinator is fail-closed on malformed persistent authority.

`resource-transaction-lock.mjs` publishes current `transaction.lock` ownership as one complete-before-visible owner-state regular file using the same exclusive-file primitive as other owner-state locks.
The record carries a fixed `resource-coordinator` purpose, random ownership token, PID, and process-start identity; release and stale-file reclamation remove only a record whose token/purpose and secure-file identity still match.
The beta.104 directory reader, owner-publication staging recovery, quarantine/restore path, and their migration-only process-identity branches have been removed because beta.104 is no longer inside the supported immediately-preceding/live transition.
Encountering the obsolete `transaction.lock/owner.json` directory shape now fails closed without modifying it and directs the operator to preserve the state and use a supported upgrade transition or rollback snapshot.
Current regular-file claims still wait for a live owner, reclaim only a proven stale matching owner, reject persistent multiple hard links, and keep transaction waiting operation-bounded: admission uses only the remaining caller admission budget, capped at 30 seconds, while spawned-process lease bind/release ownership settlement may wait up to 30 seconds and managed-job background admission retains its longer outer wait.

`resource-staging-recovery.mjs` is the narrow exception to the lease/wait directories' final-name-only rule: it understands only the exact temporary naming emitted by the coordinator's current lease/wait atomic-file helpers.
Lease/waiter recovery handles a committed two-hard-link alias or a dead-publisher single-link uncommitted replacement after identity/link-count rechecks.
A staging inode owned by a still-current publisher is classified as `MBM_RESOURCE_STAGING_BUSY`: `ResourceCoordinator.withLock()` releases the transaction generation and performs at most four five-millisecond retries so an ordinary concurrent complete-before-visible publication can settle, while a staging owner that remains live after that fixed budget still fails closed.
Process admission maps the exhausted busy classification to the same retryable resource-unavailable surface as transaction-lock contention instead of exposing an internal error.
Retired Workflow Bundle staging names are no longer an accepted migration grammar; they remain untouched as unexpected entries so current recovery never interprets obsolete publisher metadata or destructively guesses at old state.
No transaction-owner staging grammar remains after the beta.104 transition reader expired.

`resource-build-root.mjs` assigns stable per-project build caches only for toolchains with documented controls.
Cargo receives `CARGO_TARGET_DIR`; direct SwiftPM receives `--scratch-path`; direct Xcode receives `-derivedDataPath`.
The build-cache partition uses the same canonical anonymous project hash as coordinator diagnostics, so symlink and platform path aliases cannot create duplicate cache identities.
Compiler job limits are injected only when the caller did not already choose one; they are fan-out hints and startup reservations, not an OS-enforced ceiling on descendants.
Shell text is not rewritten to smuggle path flags: a conservative literal `cd` chain may refine the resource project root even when the later executable is generic, so sibling repositories do not inherit a false common-parent contention key.
Dynamic, quoted, or otherwise ambiguous directory changes are left unguessed and fall back to the last provable base.
`resource-process-priority.mjs` additionally wraps POSIX background heavy roots in `nice +5`; this is work-conserving scheduling preference rather than a quota, so background work may still use idle CPU while yielding more readily to interactive and control-plane work.
Ordinary and interactive roots are not reniced.

`resource-wait.mjs` owns coordinator retry timing.
An admission or transaction-lock wait is active process work, so its timer remains referenced until completion; cancellation removes the timer and listener, and ordinary timeout completion removes the abort listener.
This prevents the event loop from exiting while a caller is still awaiting capacity and bounds listener lifetime during long waits.

The coordinator intentionally does not claim learned per-command resource costs.
Current reservations are engineered profiles plus live pressure.
Trustworthy historical calibration requires settlement-time process-tree usage (CPU, peak RSS, I/O, descendant scope) rather than duration-only inference; the current Node process boundary does not provide an exact cross-platform equivalent of POSIX `wait4`/`rusage`.

Large object results use `structuredContent` as the authoritative representation.
The human text mirror is complete only below the shared 16 KiB projection threshold; above it, both local stdio and the Worker return the same compact byte-count/field summary instead of serializing the object a second time.
`process-result-projection.mjs`, `process-output-stream.mjs`, and the shared result projector keep lifecycle, byte retention, and MCP presentation as separate boundaries.

Startup-lock waits, daemon takeover, process-session reads, managed-job recovery handoff, browser/page waits, application-cache freshness, and in-memory duration metrics use monotonic elapsed time, so wall-clock correction cannot extend or prematurely terminate their configured duration.
Persisted timestamps and retention/credential expiry continue to use wall time.
Process sessions retain bounded byte buffers with monotonic offsets, accept bounded stdin, support short output/exit waits, and are capped per runtime.
Valid UTF-8 is returned as text; byte slices that are not valid UTF-8 also include lossless base64 data.
Head/tail previews trim incomplete UTF-8 boundary code points instead of introducing replacement characters.
Session IDs are random.
Running sessions are killed on runtime stop or non-recoverable daemon replacement; a transient same-process relay disconnect enters bounded recovery instead of being treated as cancellation.

Child processes run in a separate process group where supported.
Timeout, explicit cancellation, reconnect-grace expiry, runtime shutdown, and non-recoverable replacement send termination to process trees, with a referenced forced-escalation timer that remains alive even when the direct child exits before a resistant descendant.
The exported defaults are a two-second graceful interval and a three-second monotonic ownership-verification budget; lifecycle tests derive their observation deadline from those constants rather than duplicating an exact wall-clock boundary.
Runtime teardown does not replace a pending ownership-checked escalation with a direct group `SIGKILL`: a child that still needs forced drain enters the same supervisor with zero additional grace, and teardown waits for both direct-child settlement and every retained escalation timer before declaring process ownership drained.
POSIX ownership is captured before `SIGTERM`, refreshed immediately afterward to include descendants created near the timeout boundary, and revalidated before `SIGKILL` by PID, process start time, and process-group ID.
If a full process-table snapshot is unavailable, each captured PID is queried directly; the complete full-table plus targeted fallback decision shares that one three-second monotonic budget, so descendant count cannot multiply its requested worst-case latency.
Every synchronous `ps` deadline uses `SIGKILL`, because the Node default `SIGTERM` timeout can remain blocked when the helper does not terminate.
An empty ownership snapshot, ambiguous identity, changed start timestamp, or PID reuse fails closed before forced escalation.
One-shot execution, process sessions, and managed-job steps all attach the same `child-process-settlement.mjs` policy: ordinary `close` is preferred so stdout and stderr drain completely; after an observed `exit`, a one-second fallback destroys only residual stdio handles and settles exactly once if libuv never emits `close`.
Tracker/session/resource ownership is released only from that settlement boundary.
Windows uses tree-aware task termination.

Managed jobs use the same argv/environment primitives but a different lifecycle.
Each job is capped at 16 main and 16 finally steps, the store at 512 retained states with a 50-record list response window, 64 registered resources, 8 MiB of referenced resource bytes, 512 KiB of temporary-file content, and bounded per-step output.
They are non-interactive.
Resource paths/stdin/environment are injected only inside the runner.
The detached runner starts before its pid can be published, so `runner.pid` uses an explicit two-phase ownership claim: the parent writes a launch-token-bound `committed:false` record, applies owner-only hardening, and only then atomically replaces it with `committed:true`; the child never executes from an uncommitted claim.
Recovery never replays forward business steps: it reconstructs bounded resource/temporary state and runs recovery/finally work only.
A reconstruction or cancellation-state failure remains the main recovery error even when every independent finally step succeeds, so the terminal state is `recovery_failed`, never contradictory `recovered` plus `error_class`.
Terminal result persistence is result-first and plan/runner artifacts are scrubbed only through the terminal persistence boundary; synchronization lock files remain owned by their lock primitives.
Exact resource output redaction is defense in depth; discard capture is the strong option when a command may echo credentials.

## Output-buffer allocation

Process continuation and head/tail diagnostic buffers crop incoming bytes before copying.
Retained views must not hold an oversized producer allocation, and later producer mutation cannot change recorded output.
Output offsets and omitted-byte counts retain their existing contracts.
The allocation/aliasing and randomized partition regressions are in tests/output-buffer-test.mjs; existing runtime and continuation tests cover UTF-8 and transport integration.
