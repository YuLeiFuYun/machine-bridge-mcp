# Upgrading

This file defines the **currently supported upgrade path only**. Older version notes in the repository are historical migration records, not a declaration of the current candidate. Historical prerelease migrations and blocked-candidate details belong in [CHANGELOG.md](../CHANGELOG.md) and [AUDIT.md](AUDIT.md), not in the live upgrade contract.

## Supported upgrade contract

Machine Bridge supports direct upgrade from the immediately preceding published release. The repository may also need one bounded transition from the exact live owner-machine candidate named in the current changelog. Obsolete MCP transports, protocol sessions, replay stores, authorization workflows, and alternate runtime implementations are not retained as hidden compatibility paths.

Version 3 is a coordinated Worker, daemon, CLI, and browser-extension system. Components are expected to converge on the same exact package version before an upgrade is considered healthy. Mixed 2.x/3.x operation is unsupported. MCP `2026-07-28` remains the only native request-scoped state model; remote HTTP has one bounded, stateless initialization-compatibility surface for `2025-06-18` and `2025-11-25` hosts, and that surface must not be confused with mixed-version daemon/Worker operation or restoration of the removed session/replay model.

State migration is different from protocol compatibility. A narrowly bounded reader may still be required when valid state produced by the immediately preceding/live version must be transformed in place without deleting user credentials or creating split-brain ownership. Such migration must be one-way, fail closed on ambiguous state, and must not recreate the removed runtime behavior. beta.61's OAuth refresh persistence is one such forward migration: legacy schema-2/schema-3 main values are reconstructed in memory, consumed replay markers are moved into bounded hash shards, and the main value plus shards are committed atomically. An older runtime is not a supported reader for that migrated state; formal rollback therefore restores the complete pre-upgrade state-root backup together with the prior package, Worker, service definition, and browser extension as described below.

## Historical beta.61 migration invariant retained by current readers

This section records the origin of one persisted-state compatibility boundary; **beta.61 is not the current upgrade target**. During the beta.60 → beta.61 transition, the machine-user resource transaction lock established the wire shape that later runtimes may still need to recognize when migrating valid persisted state:

- beta.60 used `transaction.lock/` plus `owner.json` as the cross-process mutex;
- beta.61 deliberately kept that directory wire shape while beta.60 could still be live, so the final-name `mkdir` remained the cross-version atomic exclusion point;
- an incomplete directory generation was not reclaimed until the bounded orphan grace elapsed and the exact filesystem generation was revalidated;
- beta.61 also accepted the short-lived regular-file lock generation created by an earlier beta.61 implementation during that candidate cycle;
- do **not** delete, rename, or hand-edit `transaction.lock` to force progress. Let the owner-identity and stale-recovery checks converge or stop and inspect the state.

The historical channel/version snapshot that justified those migration readers belongs in the changelog and audit history, not in this live upgrade contract. Current code may retain only the bounded readers still required to consume reachable persisted state; those readers are one-way and do not make the producing runtime or protocol executable again. Do not infer support for arbitrary historical prerelease state from the presence of a migration parser, and do not treat this historical section as permission for mixed-version Worker/daemon operation.

For the beta.104 -> beta.105 transition specifically, new resource transaction claims are no longer written in that historical directory shape. beta.105 publishes `transaction.lock` as one complete-before-visible owner-state regular file, while retaining the directory reader because beta.104 is the immediately preceding runtime and a beta.104 daemon or durable runner may still hold or leave a directory claim during handoff. beta.104 already accepts the owner-state regular-file shape, so both versions still exclude one another on the same pathname. This reader is migration-only and should be removed once beta.104 no longer falls within the supported immediately-preceding/live transition; its presence does not extend general beta.60 runtime support.

Existing browser pairing and OAuth state should be left in place. Machine Bridge rotates or normalizes supported persisted state when the relevant subsystem is first used and fails closed when the stored state cannot be validated. Do not delete pairing or OAuth state merely to make an upgrade succeed; doing so can force unnecessary re-pairing or reauthorization and can hide an ownership problem that should be diagnosed.

## MCP client transition

Machine Bridge uses MCP `2026-07-28` as its native protocol. Remote HTTP additionally accepts stateless initialization-era compatibility for `2025-06-18` and `2025-11-25` so hosted clients can negotiate without reviving the removed session/replay architecture. stdio remains current-only.

Current/native clients must:

- send `io.modelcontextprotocol/protocolVersion: "2026-07-28"` and `io.modelcontextprotocol/clientCapabilities` in every request `_meta`;
- use `server/discover` instead of `initialize`;
- include both `application/json` and `text/event-stream` in HTTP `Accept`;
- send the required `MCP-Protocol-Version`, `Mcp-Method`, and applicable `Mcp-Name` / `Mcp-Param-*` headers on HTTP requests;
- treat each HTTP response stream as request-scoped and cancelled when the public stream is closed;
- use explicit `session_bootstrap` / `resolve_task_capabilities` calls when refreshed project or routing context is needed;
- treat `server/discover` instructions and `tools/list` as non-reusable across semantic upgrades: both current responses advertise `ttlMs=0`, every tool description carries `Tool schema generation N`, and the live generation/version plus `discovery_ttl_ms=0` / `tool_list_ttl_ms=0` can be compared with `server_info.tool_delivery`; `host_turn_deadline_observable=false` means Machine Bridge cannot predict an external assistant-turn cutoff, while `managed_jobs_detached_from_mcp_response=true` means that cutoff does not own an accepted durable job; a new daemon/Worker version does not prove that an external host discarded a stale instruction/tool snapshot;
- not use `Mcp-Session-Id`, recovery `GET /mcp`, SSE event IDs, `Last-Event-ID`, or protocol-session replay.

For remote HTTP only, a `2025-06-18` or `2025-11-25` `initialize` may receive a bounded stateless compatibility response. After that response, the compatibility surface accepts only `notifications/initialized`, `ping`, `tools/list`, and `tools/call`; tool methods execute through the current controller and no initialization-owned session is retained. `Mcp-Session-Id`, recovery `GET /mcp`, SSE event IDs, `Last-Event-ID`, and protocol-session replay remain rejected. An initialize request outside the two declared compatibility dates, a removed session marker, or any other removed method receives bounded rejection/upgrade guidance and cannot reconstruct old state.

Unknown/future protocol versions are also rejected. Machine Bridge does not guess that a newer client is wire-compatible with the current server.

The tool catalog is enforced with bounded schema validation at the Worker and local runtime boundaries. Requests with unknown fields, wrong scalar types, fractional integer values, out-of-range values, malformed metadata, or mismatched mirrored headers fail before tool side effects. Fix the request rather than retrying it unchanged.

## Normal upgrade

1. Inspect interactive process sessions and managed jobs. Cancel work that should not survive daemon replacement; durable managed jobs that are intentionally left running keep their own persisted lifecycle.
2. Back up the owner-only Machine Bridge state with an operating-system tool that preserves permissions. Do not upload or publish that backup.
3. Install the new package through the supported package/release channel.
4. Run `machine-mcp doctor` and resolve state, toolchain, service-owner, or network errors before forcing any mutation.
5. Start the target workspace in the foreground so the package can verify/deploy the matching Worker and complete end-to-end daemon readiness.
6. If the release changes tool schemas, descriptions, or hosted orchestration semantics, compare `server_info.tool_delivery.tool_schema_generation` and `tool_schema_server_version` with the candidate; also require both discovery/tool-list TTLs to be zero and confirm the host-turn/durable-job boundary fields. Current 2026-07-28 discovery must advertise `tools.listChanged=true`, and a `subscriptions/listen` request for `toolsListChanged` must receive the supported-subset acknowledgement plus `notifications/tools/list_changed`; initialization-era 2025 compatibility remains `listChanged=false`. Treat `server_info.tool_delivery.tools_list_change_subscription_opened_for_account=true` only as server-side evidence that an open live subscription response was constructed; `tools_list_change_subscription_client_receipt_observable=false` means it cannot prove client receipt or catalog refresh and is not a universal freshness requirement. `tools_list_change_subscription_lease_ms` is the bounded fail-safe for a public HTTP disconnect that Workers may not propagate into the Durable Object stream lifecycle; after aborting a test client, active subscription capacity must return to zero no later than that lease while the opened flag remains diagnostic history. ChatGPT workspace apps can keep a frozen approved tool/input snapshot. When that governance layer is relevant, automation may inspect Workspace Settings -> Apps -> the app -> Action control and require the expected action count plus current generation/semantics after the supported refresh/review path without a separate conversational approval. Opaque ChatGPT-internal cache inspection is not part of upgrade acceptance and must not be introduced as an alternate freshness gate or remediation trigger. Product-level recreation/republication is a last resort only when the governed Workspace approved snapshot itself cannot be updated in place or remains stale/partial/mixed after the supported refresh path, or when separate workspace governance explicitly requires republication. For managed-job continuation changes, verify an active `read_job` with omitted `wait_ms` actually uses the advertised 40-second host-safe server-side long-poll (or returns early on real progress), while `wait_ms=0` remains an immediate checkpoint. Treat the five-minute value as an explicit maximum, not a universal hosted default: only use it on a client whose request lifetime has been independently demonstrated. Per-call wait survival and aggregate host-response lifetime are independent, but a fixed >100-minute soak is not a release-acceptance prerequisite. When aggregate recovery is affected, exercise the relevant host/tool or daemon/relay boundary with a bounded live probe, retain the same `job_id`, and prove recovery after ordinary helper-command churn. A typed `not_found` means the retained record is unavailable, not that the underlying operation never ran, and is not permission to replay a side effect. `host_visible_schema_known_to_server=false` means backend version convergence alone is insufficient; use the governed Workspace snapshot where applicable plus actual invocation behavior. Also verify the host invocation validator and the daemon validation path, not only displayed descriptions: for beta.112 and later generation-5 candidates, a terminal `read_job` with `wait_ms=40001` must reach Machine Bridge and return immediately rather than fail under either a stale host-side 40,000 ms maximum or the beta.111 daemon-local static 40,000 ms schema, and a non-executing `stage_job` with `timeout_seconds=3601` must cross the former one-hour boundary before being cancelled/cleaned. Generation-6 retention semantics additionally require a syntactically valid but unretained `job_id` to return typed non-retryable `not_found`, proving the changed behavior reached the current runtime without interpreting that absence as non-execution proof.
7. Reconnect hosted MCP clients. Remote HTTP clients still using one of the two declared stateless initialization compatibility dates may continue through that bounded adapter, but clients requiring session/replay semantics must upgrade. Complete OAuth authorization again only when the current authorization state requires it.
8. Reload the packaged browser extension from the same path reported by `browser status` so its protocol/version handshake matches the daemon. Local release candidates publish into a stable owner-only release-channel directory before old candidate runtimes are pruned. If the extension was originally loaded from a beta.72-or-earlier versioned candidate-runtime directory, perform one **Load unpacked** migration to the current `extension_path`, then use Reload for later upgrades. If pairing migration reports that an older broker still owns the migrated port, restart the prior Machine Bridge runtime rather than starting a second broker on another port.
9. Verify a safe workspace read, one ordinary edit, one representative current MCP tool call, and one owner-only action appropriate for the deployment.
10. Restore persistent/background service operation only after the foreground path is healthy.

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

`server/discover` should advertise only `2026-07-28`. A full daemon policy is not proof that a delegated account has full authority; use `authorization.effective_policy` and `authorization.effective_tools` for the current request.

For a source-release candidate, follow [RELEASING.md](RELEASING.md). Candidate generation, owner activation, soak acceptance, npm publication, and stable promotion have separate evidence gates; a later healthy service does not retroactively turn a failed activation command into valid release evidence.

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
