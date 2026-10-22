# Runtime and verification boundaries

These invariants are linked from release evidence but describe runtime, delivery, and
verification boundaries rather than artifact publication. Artifact identity and publication
remain owned by [Release integrity](release-integrity.md).

### Recovery and delivery boundaries

The relay connection owns transport lifecycle, while liveness policy is decomposed instead of accumulating in that class: `relay-liveness.mjs` composes transport and application monitors; `relay-liveness-actions.mjs` owns suspect/recovered/hard-failure effects; `relay-heartbeat.mjs` owns timer and event-loop-stall scheduling; `relay-heartbeat-transport-state.mjs` advances transport probe/confirmation phases; `relay-heartbeat-options.mjs` normalizes bounded timing; `relay-probe-dispatch.mjs` owns sender-dispatch identity/race state and `relay-probe-dispatch-metrics.mjs` its bounded diagnostics; `relay-probe-deadline.mjs` owns the post-dispatch Pong deadline; `relay-transport-confirmation.mjs` owns the second-stage application-confirmation state; `relay-transport-probe.mjs` owns socket-generation fencing plus bounded sender backlog while `relay-transport-probe-send.mjs` owns low-level Ping/fallback dispatch.
`relay-transport-error-state.mjs`, `relay-heartbeat-stall.mjs`, `relay-connect-timing.mjs`, `relay-connection-classification.mjs`, and `relay-diagnostics.mjs` retain their error, stall, connect-timing, classification, and public-projection responsibilities.
Application proxy selection is intentionally separated from the operating-system network path.
Reconnect backoff is bounded at fifteen seconds, but each WebSocket connect attempt now has a thirty-second per-attempt connect budget because live successful upgrades were observed within roughly fourteen seconds of the former fifteen-second cutoff.
Transport liveness requests a protocol probe after five seconds.
`ws.ping()` queueing is not treated as dispatch: the local sender has a separate thirty-second no-progress bound, and only its write callback starts the full ten-second Pong response deadline.
If fresh inbound traffic arrives while that callback is delayed, the logical dispatch retires at its deadline rather than letting a stale callback arm a future timeout.
If a dispatched Ping reaches its ten-second deadline, a ready connection receives a separate fifteen-second application confirmation before `relay_transport_timeout` is allowed to terminate it; HTTPS is prewarmed during that suspect interval and becomes exact-generation takeover only after actual WSS loss.
The twenty-five-second periodic application heartbeat / seventy-five-second application watchdog and ninety-second Worker daemon-liveness fallback remain separate checks with separate purposes.
Worker-issued `connection_id` is part of the same-version welcome contract and binds an HTTPS fallback takeover to the exact disconnected WebSocket generation, so a delayed takeover request cannot retire a newer same-instance WebSocket that has already recovered.
The root-signed daemon session remains intentionally bounded to 24 hours; expiry is a terminal runtime condition rather than a transport retry.
Runtime cleanup precedes nonzero exit, after which installed service supervision obtains a new session on daemon restart instead of extending the certificate lifetime or looping forever with expired WSS/HTTPS credentials.

Exclusive lock publication is itself a two-name hard-link commit: after the complete staging inode is linked at the final lock path and before the private staging alias is removed, `nlink` is transiently two.
Process/startup locks, owner-state locks, managed-job transition/recovery locks, browser pairing creation, and managed-job runner claims are the only current consumers allowed to bridge that internal window with the shared fixed multiple-link retry.
If that window survives a publisher crash, `exclusive-publication-recovery.mjs` does not delete the alias: it opens the canonical target first, opens only candidates in the reserved internal staging grammar, requires exactly one same-generation/same-inode two-link alias, rechecks the held target descriptor, and returns the exact filesystem identity as a bounded read token.
Default readers still reject multiple links.
A stale owner may remove only the canonical target after the usual owner/token/generation proof, potentially leaving the owner-only internal alias until the containing state/job generation is retired.
Runner claims use the same no-follow path-identity boundary and never gain general hard-link acceptance.

Owner-state mutations use shared complete-before-visible lock primitives with separate lock files per concern.
Process/startup, owner-state, managed-job transition/recovery, and shared owned-JSON removal derive ownership bytes and lossless filesystem generation identity from the same opened descriptor; ownership files reject multiple hard links before stale/release decisions except for the exact descriptor-verified internal residue token above, and known change-time generation must still match at canonical-target removal.
The internal staging alias itself is never destructively removed by the recovery reader.
Security-audit writes, obsolete authorization-state migration cleanup, daemon/startup ownership, and managed-job transition/recovery are visible to state inventory so uninstall cannot race an active mutation.
Workspace trust-state recovery requires a complete canonical envelope before its recovery marker is removed.

Static package identity is separate from persistence ownership.
`package-identity.mjs` is the single local source for package root/name/version and shared application name; CLI, stdio, Worker-deployment helpers, browser identity, shell integration, and trust checks do not reparse the root package manifest independently.
State-root/profile/workspace path and hash semantics remain deliberately in `state.mjs`, where platform/environment injection, canonical workspace identity, case-folding, schemas, locks, recovery, and removal share one contract.
The unused divergent `state-locations.mjs` experiment was removed; a future extraction is valid only when real consumers migrate and parity tests prove identical path semantics.

State-root retirement is a generation-bound quarantine transaction, not an unguarded pathname recursive deletion.
POSIX removal validates the complete observed generation, opens the exact root with `O_NOFOLLOW|O_DIRECTORY`, keeps that descriptor alive across the rename, and requires the retired pathname to match the pinned descriptor both before and after the full moved-root safety traversal.
Holding the original inode reference closes immediate inode-reuse ABA without requiring change time to remain stable across rename, and a replacement installed during verification is retained as non-reclaimable quarantine evidence.
Windows uses the platform's held-directory replacement semantics and the same pre/post generation contract without the POSIX descriptor primitive.
Portable Node.js still lacks an `unlinkat/openat` directory-capability primitive for recursive deletion, so a determined same-user process can race the final identity check and pathname `rm`; that hostile-account residual is governed by the broader same-user threat-model boundary rather than claimed as eliminated here.

SSH-key registration follows the same evidence-before-mutation rule as state/lock cleanup.
Existing pairs are cryptographically inspected before permissions are normalized; chmod and rollback are bound to the inspected/generated filesystem generation rather than a pathname.
Generated-key publication keeps the staging descriptor open across the hard-link commit, re-observes its generation after the legitimate link-count/ctime change, and removes the source or rolls back the target only while each pathname still resolves to that pinned object.
A startup-lock wait may use the pre-lock state only to locate the lock; the registry is reloaded under the lock before any resource entry is changed.
Machine-global service writes are serialized at the mutation itself: ordinary foreground startup releases its takeover lock before remote network work, then reacquires a short machine-service lock around the eventual best-effort autostart install.
Launchd/systemd definition deletion similarly snapshots the installed definition before provider shutdown and removes only that same single-link generation after stop/disable succeeds.
Windows task removal applies the same rule to the state-root launcher file after Task Scheduler confirms the task is absent; a changed/new launcher is retained rather than treated as owned cleanup.

Managed-job file semantics distinguish Machine Bridge-owned control state from user-supplied files.
Runner and manager processes legitimately publish/read `status.json` concurrently via atomic replacement, so managed-job JSON reads alone may retry the stable `MBM_IDENTITY_CHANGED` condition up to four times; the final snapshot still requires no-follow path identity and single-link evidence, and exhausted churn remains an error rather than absence.
Internal plan/status JSON and transition/recovery locks are no-follow identity-verified reads and reject multiple hard links; explicit external plan/resource inputs remain ordinary bounded no-follow files so legitimate user hard links are not rejected merely because internal ownership state is stricter.
Browser resource injection uses the exact bytes returned by the validating resource snapshot; it never validates one open and injects a second open.
Browser pairing schema/token validation lives only in `browser-pairing-store.mjs`; CLI status/pairing commands consume a port-only projection and do not parse or return pairing credentials.


Managed-job terminal persistence is an ordered recoverable protocol, not a collection of ignored cleanup calls.
Browser broker storage, HTTP/Origin validation, route state, and extension identity are separate modules.
Broker internals are not exposed as mutable public aliases; only bounded counts are projected.
Browser ownership is elected by the loopback listener plus the persisted runtime credential: a second runtime with the same state root must proxy the existing broker.
A contender first authenticates the occupied port by verifying the broker's HMAC server proof without disclosing the runtime token; once that proof succeeds, failure to complete the subsequent one-time-proof WebSocket/hello is treated as an authenticated-but-unready owner and the contender fails/retries rather than advancing to another port and creating a second owner.
Different state roots have different credentials and may use adjacent ports without sharing authority.

### Optional cloud scratch execution

Cloud-hosted scratch execution is not part of the owner-machine authority model.
The 2026-08-08 review of `cloudflare/computer@8758b51c8891c211dddd1903d2ee2d12a75ac7ff` found useful patterns for Durable Object row-budget benchmarking, capability-bounded Worker runtimes, disabled-by-default outbound networking, and explicit runtime disposal, but the upstream package is still preview/alpha and its container transport documents unresolved connection-authentication, frame/in-flight limits, and process-user boundaries.
Machine Bridge therefore does not depend on or delegate authority to Cloudflare Computer today.
The pinned upstream exposes a workspace/runtime/backend library rather than an MCP server/client surface, so any future integration must be a Machine Bridge-owned backend adapter, not protocol chaining.
A future integration, if adopted, must be a separately named, default-off, non-authoritative scratch workspace/runtime with its own Durable Object namespace and read/write budgets; backend selection must be host-owned, local credentials/state must not be inherited, outbound capabilities must start closed, and the container backend must not be enabled until its authentication and resource-limit contracts are explicit and tested.
It must never silently mirror or replace the real owner-machine workspace.

### Progressive tool disclosure and dynamic tool groups

Opt-in stdio `MBM_PROGRESSIVE_TOOLS=1` starts with nine listed tools, including `resolve_task_capabilities`. The resolver activates validated policy-visible groups from `src/shared/tool-groups.mjs`: browser, app, jobs, git, process, diagnostics, skills and files. Only explicitly requested groups are expanded; `recommended_tools` is added as individual tool names, and `activate_recommended_groups: true` is the explicit opt-in that expands those recommendations to their groups. The result reports `activated_tools`. The resolver is reachable without calling a hidden tool. Default full discovery remains unchanged.

Progressive stdio advertises `tools.listChanged=true` and a `ttlMs` of 120 s for `tools/list`, because this session's list mutates as groups activate: a cache entry has to exist for `notifications/tools/list_changed` to invalidate. The static full catalog keeps `ttlMs=0`, so it never advertises a reusable cross-release cache. Only an accepted `toolsListChanged` subscription receives a correlated notification, once per effective activation batch; cancellation and EOF complete its request. At most 32 subscriptions are retained. A hidden or unavailable tool is rejected before execution. Startup selects the mode; `tools/list` does not mutate it. [AGENT_CONTEXT](../AGENT_CONTEXT.md) owns the client-facing discovery and budgeting contract.

### Bounded lexical outline

The runtime has no native parser dependency. A newline-preserving lexical sanitizer extracts navigation hints; it does not establish semantic correctness. Async protected reads enforce per-file policy, cancellation, entry/depth/read-byte limits and a total output-line ceiling. Parameter values are omitted. Directory and single-file rendering share truthful truncation behavior; see [AGENT_CONTEXT](../AGENT_CONTEXT.md) for exact limits.

### Pure effect verification and domain consolidation

`computer-use.mjs` owns observation, preparation, single dispatch and post-observation orchestration. `computer-use-verification.mjs` evaluates explicit evidence without I/O, dispatch or retries; incomplete evidence remains unknown. Existing browser/application trajectory and fault-injection fixtures exercise the same coordinator before and after extraction.

Managed-job listing, activity metrics and bounded recovery priority share one listing module. Output ring-buffer helpers live with their sole buffer owner, and compact relay status lives with runtime-info projection. Canonical terminal/retention, identity, authority and settlement policy remain separate boundaries. An unused duplicate workspace-config module is removed; consumed workspace path helpers remain.

### AST-based semantic architecture verification

To prevent mechanical line-count and substring assertions from impeding domain refactoring, Machine Bridge includes a semantic architecture analyzer (`tests/architecture/semantic-analyzer.mjs`). Powered by Babel parser, it verifies actual AST import/export specifiers, call expressions (such as distinguishing forbidden wall-clock calls from benign comments), and semantic statement complexity.
