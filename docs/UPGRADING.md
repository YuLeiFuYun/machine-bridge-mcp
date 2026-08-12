# Upgrading

This file defines the **currently supported upgrade path only**. Older version notes in the repository are historical migration records, not a declaration of the current candidate. Historical prerelease migrations and blocked-candidate details belong in [CHANGELOG.md](../CHANGELOG.md) and [AUDIT.md](AUDIT.md), not in the live upgrade contract.

## Supported upgrade contract

Machine Bridge supports direct upgrade from the immediately preceding published release. The repository may also need one bounded transition from the exact live owner-machine candidate named in the current changelog. Obsolete MCP transports, protocol sessions, replay stores, authorization workflows, and alternate runtime implementations are not retained as hidden compatibility paths.

Version 3 is a coordinated Worker, daemon, CLI, and browser-extension system. Components are expected to converge on the same exact package version before an upgrade is considered healthy. Mixed 2.x/3.x operation is unsupported. MCP `2026-07-28` remains the only native request-scoped state model; remote HTTP has one bounded, stateless initialization-compatibility surface for `2025-06-18` and `2025-11-25` hosts, and that surface must not be confused with mixed-version daemon/Worker operation or restoration of the removed session/replay model.

State migration is different from protocol compatibility. A narrowly bounded reader may still be required when valid state produced by the immediately preceding/live version must be transformed in place without deleting user credentials or creating split-brain ownership. Such migration must be one-way, fail closed on ambiguous state, and must not recreate the removed runtime behavior. beta.61's OAuth refresh persistence is one such forward migration: legacy schema-2/schema-3 main values are reconstructed in memory, consumed replay markers are moved into bounded hash shards, and the main value plus shards are committed atomically. An older runtime is not a supported reader for that migrated state; formal rollback therefore restores the complete pre-upgrade state-root backup together with the prior package, Worker, service definition, and browser extension as described below.

## Current beta.61 transition

`3.0.0-beta.61` supersedes the live beta.60 owner-machine baseline described in the changelog. The important transition boundary is the machine-user resource transaction lock:

- beta.60 uses `transaction.lock/` plus `owner.json` as the cross-process mutex;
- beta.61 deliberately keeps that directory wire shape while beta.60 may still be live, so the final-name `mkdir` remains the cross-version atomic exclusion point;
- an incomplete directory generation is not reclaimed until the bounded orphan grace has elapsed and the exact filesystem generation is revalidated;
- beta.61 can also wait for or reclaim the short-lived regular-file lock generation created by an earlier beta.61 implementation during this same candidate cycle;
- do **not** delete, rename, or hand-edit `transaction.lock` to force progress. Let the owner-identity and stale-recovery checks converge or stop and inspect the state.

This transition is intentionally narrow. It does not restore an older MCP implementation or make mixed Worker/daemon versions a supported steady state.

At the beta.61 source cutoff, the public npm channels are `latest=2.0.0` and `beta=3.0.0-beta.38`; the owner machine also has the explicitly recorded live beta.60 candidate. Migration-only readers are therefore retained only where persisted state from those real upgrade sources can reach beta.61. They are one-way readers: successful migration writes only the current schema and does not make the producing runtime/protocol executable again. Do not infer support for arbitrary historical prerelease state from the presence of a bounded migration parser.

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
6. Reconnect hosted MCP clients. Remote HTTP clients still using one of the two declared stateless initialization compatibility dates may continue through that bounded adapter, but clients requiring session/replay semantics must upgrade. Complete OAuth authorization again only when the current authorization state requires it.
7. Reload the packaged browser extension so its protocol/version handshake matches the daemon. If pairing migration reports that an older broker still owns the migrated port, restart the prior Machine Bridge runtime rather than starting a second broker on another port.
8. Verify a safe workspace read, one ordinary edit, one representative current MCP tool call, and one owner-only action appropriate for the deployment.
9. Restore persistent/background service operation only after the foreground path is healthy.

When `MBM_MACOS_TRUST_BROKER` is intentionally configured, verify that provisioned broker before activation. Do not replace failed trust material with an ad-hoc helper or hand-edit the device-root state.

## Verification

After upgrade, `server_info` should show or allow you to establish:

- exact Worker and daemon version convergence;
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
