# Upgrading

## Supported upgrade contract

Machine Bridge does not retain parallel implementations for obsolete MCP protocol dates, policy revisions, state schemas, lock formats, or browser-extension protocols. The supported path is a direct upgrade from the immediately preceding published package while its state already uses the current schema.

Version 2.0.0 is a coordinated Worker/daemon security-protocol upgrade. It replaces the long-lived daemon bearer with a P-256 device identity, replaces network account-administration bearer requests with per-request HMAC signatures, shortens OAuth access tokens, introduces refresh-token families and replay revocation, and adds local capability leases for high-impact remote effects. The Worker and daemon must converge on 2.0.0 together; the removed daemon bearer protocol is not retained as a fallback.

On the first 2.0.0 state load, a workspace without a device identity generates one locally, removes the legacy daemon secret, and rotates the deployment-wide OAuth token version. Existing pre-2.0 access and refresh credentials therefore fail closed and every client must authorize again. The device private JWK remains in owner-only local state; only the public JWK is deployed to the Worker. Subsequent ordinary starts preserve both the device identity and token version.

The canonical `full` profile is unchanged as a capability ceiling. Remote high-impact operations now require a local account/client-bound lease, while normal workspace-contained reads and edits and project inspection remain automatic. Because the packaged extension controls an existing browser profile, one `browser-session` lease covers profile reads and actions; registered-resource input or file upload uses the separate `data-export` scope. An operator may approve the requested scope or explicitly open a temporary `full` window for at most eight hours. Lease state is independent of the policy profile and does not migrate into OAuth credentials.

Version 1.2.0 could accept prototype-shaped account roles through malformed administration input. On the first 1.2.1 or later Worker access, such an account is preserved for recovery but repaired fail-closed: its role becomes `reviewer`, it is disabled, its account version advances, and its authorization codes and tokens are removed. An operator can then assign a valid role, enable the account, and rotate its password through the normal account administration flow. A local policy record with an unknown profile label is normalized to `custom` while retaining its explicit capability fields; an invalid explicit `--profile` is rejected.

A state file from an older unsupported schema is rejected rather than guessed or silently rewritten. Upgrade an old installation through the last release that understands its schema, or initialize a new workspace and re-register resources. Do not edit schema numbers by hand.

## Normal upgrade

1. Finish or cancel ordinary interactive process sessions. Accepted managed jobs may continue independently, but inspect them before replacing the daemon.
2. Install the new package with the pinned npm procedure in [Getting started](GETTING_STARTED.md).
3. Run `machine-mcp doctor`.
4. Start `machine-mcp` normally in the foreground for each workspace. Startup generates the device identity if needed, rotates the old deployment token version, deploys the matching public key and 2.0.0 Worker, verifies end-to-end readiness, and only then may replace the prior service daemon.
5. Reauthorize every remote MCP client. Pre-2.0 access and refresh tokens are intentionally invalid.
6. Reload the unpacked browser extension. Protocol and packaged-version equality are mandatory; an old extension cannot replace a working compatible connection.
7. Exercise one safe read and one high-impact operation. Approve the resulting scope or an explicit temporary `--full` window through the local CLI, then retry the operation.
8. Restore or reinstall background service operation only after the foreground path is healthy.

## Upgrade safety

Before replacing live software, copy the owner-only state directory using operating-system tools that preserve permissions. Do not publish or attach that backup: it contains credentials and private resource metadata.

Machine Bridge never treats an unreadable or foreign-schema state file as empty state. It also records a successful Worker upload before secondary health verification, so a network or proxy failure after deployment does not trigger an uncontrolled repeated write.

## Rollback

Rollback is supported only from a complete pre-upgrade backup. Version 2.0.0 changes Worker/daemon authentication, OAuth refresh state, administration authentication, and local credential material. An older package cannot use the new device protocol or refresh-family state. Rolling back package files alone therefore produces an unavailable or incorrectly authenticated mixed system. Restore the complete owner-only profile backup, prior Worker secret set/build, package version, service definition, and browser extension as one unit, or fix forward.

Never roll back by copying only selected state files or changing version fields. Restore one complete verified state backup, package version, Worker build, and browser extension as a single operational unit.
