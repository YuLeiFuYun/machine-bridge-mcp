# Upgrading

This file defines the **currently supported upgrade path only**. Older version notes are historical migration records, not a declaration of the current candidate. The current [CHANGELOG.md](../CHANGELOG.md) and [AUDIT.md](AUDIT.md) contain only active release/audit information; older migration and blocked-candidate details remain available from tagged repository history.

## Supported upgrade contract

Machine Bridge supports direct upgrade from the immediately preceding published release. The repository may also need one bounded transition from the exact live owner-machine candidate named in the current changelog. Obsolete MCP transports, protocol sessions, replay stores, authorization workflows, and alternate runtime implementations are not retained as hidden compatibility paths.

Version 3 is a coordinated Worker, daemon, CLI, and browser-extension system. Components are expected to converge on the same exact package version before an upgrade is considered healthy. Mixed 2.x/3.x operation is unsupported. MCP `2026-07-28` is the only supported request-scoped protocol for both stdio and remote HTTP. Obsolete initialize/session/replay requests fail closed with bounded upgrade guidance and cannot be confused with mixed-version daemon/Worker operation or restoration of removed state.

State migration is different from protocol compatibility. A bounded one-way reader may transform only the explicitly supported immediately preceding/live state for a subsystem without deleting credentials or creating split-brain ownership; ambiguous state fails closed and removed runtime behavior is not restored. Browser pairing uses schema 3, with one narrow beta.198-to-beta.199 transition: only the exact stable beta.198 schema-2 envelope with `pairingAuthVersion: 2` and `migrationPending: false` is accepted, and its two existing credentials plus port are preserved while the obsolete marker is removed. A beta.198 envelope with `migrationPending: true` remains blocked until beta.198 completes that earlier migration; older, extra-field, malformed, or coercible shapes remain unsupported. Security-audit persistence uses schema 3, with one deliberately narrow beta.198-to-beta.199 transition: the reader accepts only the exact beta.198 schema-1 envelope, validates its exact keys and native field types, verifies the existing hash chain, and preserves every prior event object and hash unchanged as an explicit legacy prefix before current events are appended. Schema 2 and unrelated older audit shapes remain unsupported. OAuth refresh persistence remains schema 3 with bounded consumed-token shards. Beta.198 already writes that current sharded OAuth shape; beta.199 no longer carries the older schema-1/schema-2 refresh upgrader or the pre-shard consumed-marker merger. An older runtime cannot safely read current state. Rollback must restore the complete pre-upgrade state root together with the prior package, Worker, service definition, and browser extension.

## Historical resource transaction-lock formats

Older prereleases used a `transaction.lock/owner.json` directory mutex before the current complete-before-visible owner-state regular file was established. That transition is historical only; no current reader consumes or migrates the directory format. If the obsolete directory shape is encountered, current code fails closed and leaves it unchanged. Do **not** delete, rename, or hand-edit the lock to force progress. Preserve the state for diagnosis and either traverse a supported immediately-preceding release path or restore the complete pre-upgrade rollback snapshot. Detailed historical migration mechanics remain in the corresponding tagged source snapshots, not in the live upgrade contract.

Existing browser pairing and OAuth state should be left in place. Beta.199 upgrades the exact stable beta.198 browser-pairing writer image in place without rotating its credentials or changing its port; a pending beta.198 pairing migration is deliberately not collapsed into the new schema. Machine Bridge otherwise fails closed when stored state cannot be validated. Do not delete pairing or OAuth state merely to make an upgrade succeed; doing so can force unnecessary re-pairing or reauthorization and can hide an ownership problem that should be diagnosed. If beta.198 reports a pending browser migration or older OAuth refresh shape, complete that release's supported normalization before upgrading rather than asking beta.199 to reinterpret retired authority formats.

## MCP client transition

Machine Bridge uses MCP `2026-07-28` for both remote HTTP and stdio. Successful initialization-era protocol compatibility is not retained.

Current/native clients must:

- send `io.modelcontextprotocol/protocolVersion: "2026-07-28"` and `io.modelcontextprotocol/clientCapabilities` in every request `_meta`;
- use `server/discover` instead of `initialize`;
- include both `application/json` and `text/event-stream` in HTTP `Accept`;
- send the required `MCP-Protocol-Version`, `Mcp-Method`, and applicable `Mcp-Name` / `Mcp-Param-*` headers on HTTP requests;
- treat each HTTP response stream as request-scoped and cancelled when the public stream is closed;
- use explicit `session_bootstrap` / `resolve_task_capabilities` calls when refreshed project or routing context is needed;
- treat `server/discover` instructions and `tools/list` as non-reusable across semantic upgrades: both current responses advertise `ttlMs=0`, every tool description carries `Tool schema generation N`, and the live generation/version plus `discovery_ttl_ms=0` / `tool_list_ttl_ms=0` can be compared with `server_info.tool_delivery`; `host_turn_deadline_observable=false` means Machine Bridge cannot predict an external assistant-turn cutoff, while `managed_jobs_detached_from_mcp_response=true` means that cutoff does not own an accepted durable job; a new daemon/Worker version does not prove that an external host discarded a stale instruction/tool snapshot;
- not use `Mcp-Session-Id`, recovery `GET /mcp`, SSE event IDs, `Last-Event-ID`, or protocol-session replay.

Any `initialize` request, removed session marker, replay marker, or other explicit retired protocol-session marker receives bounded rejection/upgrade guidance and cannot reconstruct or dispatch old behavior. Remote `GET /mcp` is unsupported and returns 405; it is not a recovery channel.

Unknown/future protocol versions are also rejected. Machine Bridge does not guess that a newer client is wire-compatible with the current server.

The tool catalog is enforced with bounded schema validation at the Worker and local runtime boundaries. Requests with unknown fields, wrong scalar types, fractional integer values, out-of-range values, malformed metadata, or mismatched mirrored headers fail before tool side effects. Fix the request rather than retrying it unchanged.

## Normal upgrade

1. Inspect interactive process sessions and managed jobs. Cancel work that should not survive daemon replacement; durable managed jobs that are intentionally left running keep their own persisted lifecycle.
2. Back up the owner-only Machine Bridge state with an operating-system tool that preserves permissions. Do not upload or publish that backup.
3. Install the new package through the supported package/release channel.
4. Run `machine-mcp doctor` and resolve state, toolchain, service-owner, or network errors before forcing any mutation.
5. Start the target workspace in the foreground so the package can verify/deploy the matching Worker and complete end-to-end daemon readiness.
6. If tool schemas, descriptions, or hosted orchestration changed, complete the applicable catalog and continuation checks below. Backend version convergence alone does not prove that a host refreshed its approved tool snapshot.
7. Reconnect hosted MCP clients. All hosted MCP clients must reconnect using `2026-07-28`; obsolete initialize/session/replay clients must upgrade before reconnecting. Complete OAuth authorization again only when the current authorization state requires it.
8. Reload the packaged browser extension from the `extension_path` reported by `browser status`, then verify its protocol/version handshake. Local release candidates use a stable owner-only release-channel directory. If the browser has not loaded that current directory, use **Load unpacked** once; later upgrades use Reload. If pairing reports that another broker owns the port, stop/restart the prior Machine Bridge runtime rather than creating a second broker on another port.
9. Verify a safe workspace read, one ordinary edit, one representative current MCP tool call, and one owner-only action appropriate for the deployment.
10. Restore persistent/background service operation only after the foreground path is healthy.

Persistent activation has an additional fail-closed transaction boundary: before it stops the existing provider or takes over the daemon lock, the candidate performs a read-only restartability preflight against its exact package entry/version, the persisted service-network environment, and the platform service definition it would install. An unsupported persisted service-environment key or invalid candidate package identity fails the command before production service mutation. Preserve the existing service and state for diagnosis; do not hand-edit `service-environment.json`, delete service ownership state, or force activation past this check.

ChatGPT host-control-plane UI is not a separate conversational authorization boundary. Existing MCP discovery and harmless invocation-validator probes remain the preferred first-line evidence, but automation may inspect and operate the supported Apps/Plugins/admin refresh/review flow when a governed Action control snapshot is genuinely needed for upgrade diagnosis or publication verification. Prefer in-place refresh/review before recreation or republication, verify settlement after every mutation, and never replay an unknown-outcome UI mutation blindly. Host-internal cache inspection is outside the upgrade workflow.

When `MBM_MACOS_TRUST_BROKER` is intentionally configured, verify that provisioned broker before activation. Do not replace failed trust material with an ad-hoc helper or hand-edit the device-root state.

## Verification

After upgrade, `server_info` should show or allow you to establish:

- exact Worker and daemon version convergence;
- `server_info.tool_delivery.tool_schema_generation` plus `tool_schema_server_version` match the activated runtime, `discovery_ttl_ms=0`, `tool_list_ttl_ms=0`, `host_turn_deadline_observable=false`, and `managed_jobs_detached_from_mcp_response=true`; when ChatGPT workspace governance freezes actions, the Workspace Action control snapshot shows the expected action count and current generation/semantics after automation performs the supported refresh/review path;
- end-to-end relay readiness with one verified ready daemon for the workspace;
- the authenticated account role and effective policy/tool intersection;
- healthy pending-call and relay capacity without detached work left beyond its bounded reconnect window;
- current device-authentication and OAuth state;
- healthy local security-audit and managed-job state where those subsystems are enabled.

Current security-audit writes use schema 3. An exact beta.198 schema-1 audit is admitted only through the one-way verified transition above; its legacy event bytes/hashes remain unchanged and newly appended events use the current schema-3 fields. Schema 2, malformed beta.198 state, and unrelated older audit files are retained as evidence and rejected. When audit verification is unhealthy, read-only local/remote diagnosis remains available but new remote non-read-only dispatch stays fail closed. Preserve the state root and use a supported upgrade or rollback path; do not delete or hand-edit the audit file merely to restore availability.

### Catalog and continuation checks

Apply the checks affected by the upgrade; use harmless invocations and retain their actual results.

| Boundary | Required evidence |
|---|---|
| Catalog freshness | Compare the current generation/version and both zero TTLs with `server_info.tool_delivery`. `host_visible_schema_known_to_server=false` means the server cannot attest to the host's approved snapshot. When workspace governance retains a frozen approved tool/input snapshot, inspect **Action control** after the supported refresh/review flow and verify the expected action count and current semantics. Backend convergence alone is insufficient. |
| Tool-list subscription | Discovery advertises `tools.listChanged=true`; `subscriptions/listen` for `toolsListChanged` receives the subset acknowledgement and `notifications/tools/list_changed`. A server-opened subscription cannot prove client receipt or catalog refresh and is not a universal freshness requirement. After client abort, active capacity must clear by `tools_list_change_subscription_lease_ms`; the opened flag remains history. |
| Active job waiting | With `wait_ms` omitted, an active `read_job` uses the advertised 40-second server-paced long-poll or settles early on real progress; `wait_ms=0` is immediate. Public hosted `wait_ms` is capped at 60 seconds. Longer jobs continue through another paced read of the same capability-bound job, not an overlong tool invocation. Per-call survival and aggregate host-response lifetime need separate evidence. |
| Invocation validation | A terminal `read_job` with `wait_ms=40001` reaches the current runtime and returns immediately. A non-executing `stage_job` with `timeout_seconds=3601` crosses the former one-hour boundary; cancel/clean the draft afterward. These harmless probes check host and daemon validation, not just displayed descriptions. |
| Recovery across interruption | When aggregate recovery changes, use a bounded live probe through the affected host/tool or daemon/relay boundary, retain the same `job_id` plus principal-bound `recovery_key`, and recover after ordinary helper churn. A fixed >100-minute soak is not a release-acceptance prerequisite. A syntactically valid unretained job returns typed non-retryable `not_found`; absence is not proof of non-execution or permission to replay. |

Opaque ChatGPT-internal cache inspection is excluded from upgrade acceptance. Use the supported governed refresh/review flow first; recreation or republication is warranted only when the approved snapshot cannot be updated or remains stale, partial, or mixed, or separate governance requires it. Observe each UI mutation's settlement and never replay an unknown outcome blindly.

`server/discover` should advertise only `2026-07-28`. A full daemon policy is not proof that a delegated account has full authority; use `authorization.effective_policy` and `authorization.effective_tools` for the current request.

Source-release candidate generation, owner activation, soak acceptance, npm publication, and stable promotion remain separate evidence gates. Their detailed maintainer procedure is source-repository release-governance material rather than part of the consumer package; a later healthy service still does not retroactively turn a failed activation command into valid release evidence.

## Upgrade safety

Machine Bridge rejects unreadable, malformed, foreign-schema, symbolic-link, hard-link, ownership-ambiguous, or generation-ambiguous control state rather than silently creating replacement authority.

Do not solve an upgrade failure by deleting state, rotating credentials, copying selected state files between workspaces, editing schema/version fields, or running an older daemon against a newer Worker. Preserve the evidence and diagnose the failing boundary.

Worker deployment records upload success separately from health convergence. A successful upload is not enough: the matching daemon must authenticate and reach end-to-end readiness. Likewise, service-manager PID/activity is not a substitute for verified Machine Bridge readiness.

Execution continuity and client delivery continuity are separate. A brief relay interruption may rebind an already-dispatched call to the same daemon instance and may retain an unacknowledged completed result in daemon memory for the bounded reconnect window. This is not an MCP replay promise. Work that must survive daemon/process/machine replacement belongs in the managed-job subsystem.

## Rollback

Rollback is supported only as a complete unit from a verified pre-upgrade backup.

A rollback must restore together:

- the complete prior owner-only state root;
- the prior package;
- the prior Worker build and secrets;
- the prior service definition;
- the prior browser extension.

Do not roll back by editing version/schema fields, copying selected credential files, or restoring only the Worker. If a complete consistent backup is unavailable, prefer diagnosing and fixing forward rather than manufacturing a mixed-version system.
