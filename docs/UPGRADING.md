# Upgrading

## 3.0.0-beta.37 relay recovery

Beta.37 supersedes the locally prepared but never activated beta.36 candidate. Do not activate the beta.36 tarball: its promotion digest is stale after the second-order relay fixes. Beta.37 is a coordinated Worker and daemon update. Older components ignore or omit the optional relay diagnostic field, but exact convergence is required for idempotent cleanup, socket-generation-bound authentication, close-category precedence, and post-detach alarm recomputation.

After owner-authorized candidate activation, verify matching package/Worker/service versions, one verified login daemon, readiness recovery across a forced brief socket interruption, zero stale pending calls, and a bounded `server_info.daemon.relay_transport` summary whose `outage_active` field is false on the ready socket. `machine-mcp doctor` must explicitly report that it did not inspect the running service relay. Do not infer that a VPN/TUN product caused a disconnect solely from the coarse `system-network-stack` route class.

## Supported upgrade contract

Machine Bridge supports direct upgrade from the immediately preceding published release. Obsolete transport, state, lock, browser-extension, and authorization implementations are not retained as hidden compatibility paths.

Version 3.0.0 is a coordinated Worker, daemon, CLI, and browser-extension security upgrade. Mixed 2.x and 3.x components are intentionally unavailable.

The major changes are:

- account roles become non-escalatable hard ceilings;
- terminal approval IDs and runtime capability leases are removed from authorization;
- OAuth clients become persistently bound to one account and role version;
- process sessions, retained output, and managed jobs bind to account, client, and refresh-token family;
- account administration moves from a long-lived symmetric secret to root-certified ephemeral P-256 session signatures;
- daemon connections use a root-certified 24-hour in-memory session key;
- macOS can use a non-exportable Secure Enclave root only through an explicitly configured, provisioning-profile-validated broker; otherwise it retains the portable owner-only root;
- supported OAuth clients may use DPoP-bound access and refresh tokens;
- generic path-based remote file access to Machine Bridge control-plane state is denied even to `owner`; arbitrary owner shell execution remains local-user authority;
- delegated process execution requires a behaviorally verified OS sandbox and otherwise fails closed;
- local security events form a bounded, privacy-preserving hash chain.

## Version 2 to version 3

### Device-root migration

`3.0.0-beta.1`, `3.0.0-beta.2`, `3.0.0-beta.3`, `3.0.0-beta.4`, `3.0.0-beta.5`, and `3.0.0-beta.6` are blocked and must not be activated, accepted, published, or promoted. Beta.1 changed the canonical JWK member order used by version 2 device identifiers. Beta.2 repaired that compatibility issue but attempted to create a persistent Secure Enclave key from an ad-hoc-signed runtime helper, which macOS rejected with `errSecMissingEntitlement` (`-34018`). Beta.3 completed owner activation but exposed delegated project/Git authority defects. Beta.4 corrected those defects, yet continued owner-machine auditing found service-control self-termination, timestamp-less mixed-format logs, system-VPN relay outages amplified by a sixty-second reconnect cap, and additional state/browser/job/process boundaries. Beta.5 corrected those findings and passed live Worker/daemon/start/restart verification, but its launchd definition captured npm lifecycle PATH injection and the prior candidate runtime that activation then removed. Beta.6 removed stale candidate paths but selected only the first npm marker; nested npm activation retained an inner project-bin prefix. None of the blocked candidates intentionally rotated or invalidated the existing portable device root.

`3.0.0-beta.7` retains the portable P-256 root by default and is the next supported candidate path. It includes the beta.5 authority, relay, state, browser, managed-job, process-tree, audit-lock, hard-link, and service-lifecycle corrections, then makes the persistent service PATH independent of nested npm lifecycle injection and inactive candidate runtimes. Normal startup performs no Keychain operation and requests no user presence unless an explicitly provisioned broker is configured.

Secure Enclave enrollment is optional and explicit. Set `MBM_MACOS_TRUST_BROKER` to the absolute executable path inside an app-like broker that is signed by an Apple development or distribution identity and whose data-protection Keychain entitlements are validated by an embedded provisioning profile. Machine Bridge then verifies that the path is a non-symlink regular executable, rejects group/other-writable files, verifies the strict code signature, records the signing identifier and Team ID, and performs an end-to-end create/delete probe with a temporary Secure Enclave key. A source-built or ad-hoc-signed helper is intentionally rejected.

When a provisioned broker is configured, migration remains two-phase:

1. the broker creates the non-exportable key and Machine Bridge stores only its canonical broker binding, public JWK, key ID, and Keychain tag as `pendingDeviceIdentity`;
2. the Worker is deployed with that pending public key;
3. Worker health and exact-version convergence are verified;
4. only then is the pending root promoted to active state.

A failed probe, upload, interrupted process, or failed health check leaves the old active root intact. `--daemon-only` refuses to activate an undeployed pending root. Every later public-key check and signature revalidates the canonical broker path, code-signing identifier, and Team ID.

Other platforms, and macOS installations without a provisioned broker, use the portable P-256 provider. Its private JWK remains owner-only local state and is explicitly reported as exportable.

### OAuth clients and tokens

Existing clients may need to authorize again so the Worker can record the new trusted account binding. A refresh token whose client record is not bound to the current account version and role fails closed.

Access tokens remain short-lived. Refresh tokens remain one-time rotating and family-bound. Reuse of an already-rotated refresh token revokes the complete family, including active access tokens.

DPoP is optional. A client that supports DPoP may bind its token family to a P-256 key; clients without DPoP continue with Bearer tokens under the same account, client, role, and family checks.

### Removed authorization workflows

Version 3 does not create or consume pending approval IDs. The following workflows are obsolete:

```text
machine-mcp approval approve ...
machine-mcp approval grant ...
machine-mcp job approve ...
```

Legacy version 2 lease state may be listed, revoked, or cleared for cleanup, but it has no effect on runtime authority.

`stage_job` is a non-executing draft and cannot be promoted by a terminal approval command. A trusted owner uses `start_job`; a local machine operator may submit a reviewed plan with `machine-mcp job submit PLAN.json`.

### Removed administration secret

`ACCOUNT_ADMIN_SECRET` is deleted from local state and is no longer deployed to the Worker. Account and OAuth-client administration uses the same root-certified ephemeral session established for daemon startup or an independently authorized local administration command.

## Version 3.0.0-beta.25 MCP 2026-07-28 transition

Beta.25 makes MCP `2026-07-28` primary while retaining MCP `2025-11-25` as a compatibility adapter.

Modern clients must:

- send `io.modelcontextprotocol/protocolVersion` and `io.modelcontextprotocol/clientCapabilities` in every request `_meta`;
- include both `application/json` and `text/event-stream` in HTTP `Accept` and the required `MCP-Protocol-Version`, `Mcp-Method`, and applicable `Mcp-Name`/`Mcp-Param-*` headers;
- use `server/discover` instead of `initialize`;
- treat each HTTP response stream as request-scoped and cancelled when closed;
- not use `Mcp-Session-Id`, recovery GET, SSE event IDs, or `Last-Event-ID`.

Legacy MCP `2025-11-25` clients may continue to initialize and use the signed-session resumable path. Reconnect modern clients by rediscovering and issuing fresh requests; reconnect legacy clients by reinitializing. Existing OAuth accounts, daemon identity, service state, managed jobs, resources, and browser pairing do not require migration solely because of the protocol change.

The tool catalog is now enforced as bounded JSON Schema 2020-12 at both Worker and local runtime boundaries. Clients that previously sent unknown fields, wrong scalar types, fractional integer values, or out-of-range values will receive `-32602` before side effects rather than handler-specific fallback behavior. Fix the request; do not retry unchanged.

## Version 3.0.0-beta.31 foreground-delivery margin

Beta.31 narrows every remote configurable synchronous foreground tool to 1–60 seconds while retaining its 30- or 60-second default. The daemon execution deadline is distinct from the Worker settlement deadline: the daemon receives at most 60 seconds, while the Worker records a settlement deadline five seconds later. Admission and transport latency may consume part of that interval; it is not an external host guarantee. Owner-local registered commands retain their explicit local manifest budget. Work that may exceed 60 seconds must use `start_process`/`read_process`, managed jobs, or independently terminal mutation and verification calls.

The authenticated Worker observability snapshot replaces ambiguous terminal push/recipient counters with `legacy_internal_terminal_publications`, `legacy_internal_live_subscriber_sends`, `legacy_internal_publications_without_live_subscriber`, `legacy_internal_storage_responses`, `legacy_internal_storage_race_sends`, and `legacy_internal_storage_race_send_failures`. These fields describe legacy resumable Worker-internal storage and subscription transport only. They cannot prove that a public SSE frame was consumed or that the MCP host accepted the terminal result; `tool_delivery.host_terminal_receipt_observable` is therefore false. Tool arguments and results are not recorded. After coordinated Worker and daemon activation, reconnect or rediscover from MCP hosts that still display the older 85- or 600-second schema, because Machine Bridge cannot invalidate a host-owned discovery cache.

Unactivated legacy prepare records now expire after at most 185 seconds rather than the former 730 seconds. Active calls and terminal replay still follow their explicit operation, reconnect, and two-minute replay deadlines; no completed result retention is shortened below the documented recovery window.

## Version 3.0.0-beta.30 interruption-recovery change

Beta.30 changes the advertised foreground timeout schema, relay execution defaults, legacy stream-delivery behavior, pending-call record shape, and Worker rate-limit bindings. Upgrade Worker and daemon/CLI metadata together through the exact candidate activation flow. Configurable synchronous tools now advertise 1–85 seconds on every MCP surface, and relay execution uses the same 30- or 60-second default and 85-second ceiling even when a registered-command manifest is longer. Owner-local registered commands retain their explicit manifest budget; remote work that can exceed the interactive boundary must use `start_process`/`read_process` or managed jobs.

The Worker adds `STATEFUL_GLOBAL_RATE_LIMITER` at 1,200 requests per 60 seconds while retaining `STATEFUL_RATE_LIMITER` at 120 requests per 60 seconds for per-subject isolation. Existing persisted legacy pending calls without a request fingerprint remain readable and may be resumed by matching tool name during the bounded upgrade window. New calls persist the fingerprint. Multiple recovery subscribers no longer replace each other; up to four may coexist and receive the terminal event.

## Version 3.0.0-beta.24 candidate-activation convergence

Beta.23 is blocked and must not be accepted, published, or promoted. Owner-machine activation proved that a Worker could report the expected version and pass health verification while rejecting the candidate daemon before WebSocket admission because the active device-authentication material had not converged. The failed transaction then restarted an older service definition that could not authenticate to the already advanced Worker.

Beta.24 treats candidate device authentication and end-to-end readiness as required deployment evidence. One explicit authentication rejection triggers exactly one same-name redeployment with the unchanged selected identity; it does not rotate the device root, OAuth token version, account credentials, or Worker name. Candidate startup is bounded to three attempts. If remote preparation has occurred and activation still fails, local recovery installs and starts the compatible candidate service instead of restoring an incompatible old daemon. Before remote preparation, an older service is restored only when the same version and entrypoint reappear as a verified service daemon. Provider stop and start results must include verified inactive/active state; ambiguous systemd states and non-persistent Windows task completion fail closed. The original failure remains visible for diagnosis.

Beta.24 also introduces an owner-only machine-service ledger and an explicit readiness checkpoint. Service installation binds the canonical workspace, state root, exact runtime entrypoint, and version in a pending-to-committed transaction. Start/restart refuse missing, corrupt, pending, or mismatched ownership and do not accept a provider PID as proof of readiness; the exact service daemon must complete authentication, relay probing, and `ready_ack`. All machine-global service writers use one fixed per-user lock before any workspace startup lock, eliminating cross-workspace definition races and lock-order cycles. Existing beta.23 service definitions do not have this ledger; exact candidate activation installs and commits the beta.24 owner before the final handoff. Do not manually fabricate or copy `service-owner.json`.

No state-schema, OAuth-store, browser-pairing, resource, or managed-job migration is introduced. Upgrade through the exact candidate workflow. Do not delete state or rotate secrets in response to an isolated activation rejection.

## Version 3.0.0-beta.23 foreground-contract change

Beta.23 requires coordinated Worker and daemon/CLI metadata convergence. The Worker-specific `tools/list` schema narrows configurable foreground timeouts to 85 seconds while preserving each tool’s 30- or 60-second default and rejects larger values before daemon dispatch. Beta.30 later supersedes the local/remote schema split and makes all advertised synchronous foreground surfaces use the 85-second ceiling. Work that can exceed the remote foreground boundary must use process sessions, managed jobs, or independently terminal mutation/validation calls.

`machine-mcp doctor` and `diagnose_runtime` also gain a macOS-only coarse default-route check. A `tunnel-or-vpn` result is evidence that an operating-system packet tunnel carries the route; it does not identify a failing node and is not authority to modify third-party VPN settings. Upgrade through the normal exact-version candidate flow and reload the packaged extension because its `version_name` is synchronized with the package.

## Version 3 beta.21 relay-continuity change

Beta.21 changes the Worker-side stream-call record and MCP discovery contract. `tools/list` is stable for an authenticated account role; `server_info.authorization.effective_tools` remains the live execution authority. Streamed calls persist their daemon instance, WebSocket generation, request correlation, and deadlines so Durable Object hibernation or restart does not itself orphan an active call. JSON-only requests retain the prior bounded in-event path.

Treat beta.21 as a coordinated Worker and daemon candidate. A beta.20 Worker or daemon does not implement the same generation and persistence contract, so exact-version convergence is required before continuity claims are accepted. The change preserves calls only across a relay interruption while the same local daemon process and machine remain alive. A daemon-process restart, machine shutdown, or lost local execution state is still not durable execution; use managed jobs for that requirement.

## Normal upgrade

1. Inspect or cancel interactive processes and managed jobs that should not survive daemon replacement.
2. Back up the owner-only state directory with an operating-system tool that preserves permissions. Do not upload or publish the backup.
3. Install the version 3 package.
4. Run `machine-mcp doctor`.
5. Start each workspace normally in the foreground. Without a provisioned broker, macOS reuses the portable root and does not prompt.
6. When `MBM_MACOS_TRUST_BROKER` is intentionally configured, verify the broker deployment first and complete the single user-presence request used to sign the daemon session certificate. Do not start with `--daemon-only` during this optional root migration.
7. Allow Machine Bridge to deploy and verify the matching version 3 Worker. A pending root is promoted only after health convergence.
8. Reconnect each hosted MCP client and complete OAuth authorization when requested.
9. Inspect trusted clients with `machine-mcp account clients` and revoke stale or duplicate records.
10. Reload the version 3 browser extension.
11. Verify one safe workspace read, one ordinary edit, and one owner-only action appropriate for the deployment.
12. Restore background service operation only after the foreground path is healthy.

## Verification

After upgrade, `server_info` should report:

- matching Worker and daemon version;
- end-to-end relay readiness;
- the authenticated account role and effective policy;
- a current OAuth client and refresh family;
- device-root provider and exportability;
- ephemeral session use for reconnect signing;
- delegated sandbox status;
- security-audit chain health.

A full daemon policy is not proof that a delegated account has full authority. Use `authorization.effective_policy` and `authorization.effective_tools` for the current request.

## Upgrade safety

Machine Bridge rejects unreadable, malformed, foreign-schema, or ambiguous state rather than silently initializing replacement state.

Worker deployment records upload success separately from health convergence. Post-deployment verification allows a longer bounded edge-propagation window. Once the current package fingerprint and version are recorded, ordinary retries verify that deployment without uploading again; only explicit `--force-worker` authorizes a duplicate deployment after diagnosis. A failed activation that stopped an active service restores the provider after releasing candidate and workflow locks, and a pending root is not promoted merely because Wrangler returned success.

The packaged Swift broker source is a development and protocol-conformance fixture only. The local build is ad-hoc signed and is deliberately rejected by the production validator because it cannot obtain a provisioning-profile-validated data-protection Keychain access group. A production Secure Enclave broker must be shipped as an app-like, correctly signed and provisioned component outside the npm runtime build.

## Rollback

Rollback is supported only as a complete unit from a verified pre-upgrade backup.

Version 3 changes daemon authentication, account administration, OAuth client trust, object ownership, local authorization, and device-root storage. Copying an older package over version 3 state produces a mixed system that should fail closed.

A rollback must restore together:

- the complete prior owner-only state root;
- the prior package;
- the prior Worker build and secrets;
- the prior service definition;
- the prior browser extension.

Do not roll back by editing version or schema fields, copying selected credential files, or restoring only the Worker. Prefer fixing forward when a complete backup is unavailable.
## Version 3.0.0-beta.18

Beta.18 replaces beta.17 for hosted clients that experienced intermittent account connection loss during refresh rotation. Upgrade Worker, daemon/CLI, and browser-extension metadata together. Existing refresh state migrates from schema 2 to schema 3 without credential deletion.

Activate the candidate through the standard owner command:

```sh
npm run release:candidate:activate -- --allow-worker-deploy
```

The existing same-name `workers.dev` endpoint remains the public MCP URL, so users do not need to own a domain or update the hosted client endpoint solely for this upgrade.

## Version 3.0.0-beta.15

Beta.15 replaces blocked beta.14. Upgrade Worker, daemon/CLI, and browser-extension metadata together through the normal candidate activation flow. Streamed daemon calls now use event-driven settlement: the initiating Durable Object request returns after registration and send, while later WebSocket, cancellation, timeout, send-failure, or reconnect-expiry events persist the terminal result. Clients that support standard resumption should reconnect and reinitialize so they send `MCP-Session-Id` and use `GET /mcp` with `Last-Event-ID`; older JSON-only clients retain single-response behavior but cannot recover a disposed response stream.

## Blocked version 3.0.0-beta.14

Do not activate, accept, publish, or promote beta.14. It moved public SSE to the outer Worker but retained an unresolved terminal Promise in the initiating Durable Object event. Exact owner-machine verification showed that concurrent status and cancellation requests still did not enter while SSE remained open. Beta.15 removes that Promise and requires a new activation and acceptance cycle.

## Blocked version 3.0.0-beta.13

Do not activate, accept, publish, or promote beta.13. Exact owner-machine verification found that recovery worked after disconnect, but an SSE response directly owned by the production Durable Object prevented concurrent control requests—including explicit MCP cancellation—from entering until the stream ended. Beta.14 moves the public stream outside the Durable Object and requires a new activation and acceptance cycle.
