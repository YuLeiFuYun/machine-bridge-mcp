# Upgrading

## Supported upgrade contract

Machine Bridge does not retain parallel implementations for obsolete MCP protocol dates, policy revisions, state schemas, lock formats, or browser-extension protocols. The supported path is a direct upgrade from the immediately preceding published package while its state already uses the current schema.

Version 1.2.2 keeps local state schema version 6 and policy revision 5 unchanged. Existing 1.2.1 workspaces, named accounts, resource registrations, managed-job history, Worker identity, and browser pairing state are reused without a schema conversion. The package change affects relay call/result lifetime, Worker request cancellation, logging presentation, and observability; it does not alter the stored authority model.

Version 1.2.2 requires the Worker, local daemon, and browser extension to converge on the same package version. Normal startup redeploys the versioned Worker when required. The Worker configuration now enables Cloudflare request-signal delivery and signal passthrough to the Durable Object; an old Worker therefore does not provide the new HTTP-disconnect cancellation path even when the local daemon has already been upgraded.

Version 1.2.0 could accept prototype-shaped account roles through malformed administration input. On the first 1.2.1 or later Worker access, such an account is preserved for recovery but repaired fail-closed: its role becomes `reviewer`, it is disabled, its account version advances, and its authorization codes and tokens are removed. An operator can then assign a valid role, enable the account, and rotate its password through the normal account administration flow. A local policy record with an unknown profile label is normalized to `custom` while retaining its explicit capability fields; an invalid explicit `--profile` is rejected.

A state file from an older unsupported schema is rejected rather than guessed or silently rewritten. Upgrade an old installation through the last release that understands its schema, or initialize a new workspace and re-register resources. Do not edit schema numbers by hand.

## Normal upgrade

1. Finish or cancel ordinary interactive process sessions. Accepted managed jobs may continue independently, but inspect them before replacing the daemon.
2. Install the new package with the pinned npm procedure in [Getting started](GETTING_STARTED.md).
3. Run `machine-mcp doctor`.
4. Start `machine-mcp` normally for each workspace. Startup verifies state, stops only a verified same-workspace daemon, converges the Worker deployment, and takes over using the installed version.
5. Reload the unpacked browser extension. Protocol and packaged-version equality are mandatory; an old extension cannot replace a working compatible connection.
6. Reconnect MCP clients if they retain stale tool or session metadata.

## Upgrade safety

Before replacing live software, copy the owner-only state directory using operating-system tools that preserve permissions. Do not publish or attach that backup: it contains credentials and private resource metadata.

Machine Bridge never treats an unreadable or foreign-schema state file as empty state. It also records a successful Worker upload before secondary health verification, so a network or proxy failure after deployment does not trigger an uncontrolled repeated write.

## Rollback

Rollback is supported only when the older package understands every persisted schema and protocol already written by the newer package. Version 1.2.1 does not advance local state or policy schemas, so rollback to 1.2.0 remains structurally possible. A repaired malformed account remains a valid disabled reviewer record that 1.2.0 can read. The preferred recovery is still to fix forward because the browser extension and deployed Worker must match the running package exactly, and rollback would restore the defective input validation.

Never roll back by copying only selected state files or changing version fields. Restore one complete verified state backup, package version, Worker build, and browser extension as a single operational unit.
