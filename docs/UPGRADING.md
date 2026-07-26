# Upgrading

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

Worker deployment records upload success separately from health convergence. A post-upload network failure does not trigger an uncontrolled repeated write, and a pending root is not promoted merely because Wrangler returned success.

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
