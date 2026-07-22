# Local authorization model

Machine Bridge treats **capability**, **identity**, and **object ownership** as separate controls. A tool is executable only when every control permits it.

For a remote request, effective authority is:

```text
daemon capability ceiling
∩ authenticated account role
∩ trusted OAuth client binding
∩ current account version and refresh-token family
∩ per-object ownership checks
```

No approval record, token refresh, client reconnect, or local command can expand the account role. A narrower layer always wins.

Local stdio does not use remote OAuth accounts. It runs as the local owner under the selected local policy and remains subject to the MCP host and operating-system controls.

## Account roles

| Role | Effective purpose | Important limits |
|---|---|---|
| `reviewer` | Read-only inspection of the selected workspace | No mutation or process execution |
| `editor` | Workspace reads and deterministic file mutation | No process execution |
| `operator` | Workspace-confined editing and direct process execution | No unrestricted paths, credentials, browser/desktop control, or persistent job creation |
| `owner` | Complete bridge authority within the daemon policy ceiling | Generic path-based tools cannot target Machine Bridge control-plane state; owner shell remains OS-user authority |

The daemon may advertise the complete catalog as its capability ceiling. The Worker filters `tools/list` by account role, and the local runtime independently recomputes and validates the same role boundary before dispatch.

## Trusted OAuth clients

Dynamic OAuth registration creates an untrusted client record. The first successful account authorization binds that client to:

- one account ID;
- the account version at authorization time;
- the account role;
- the OAuth client ID.

A client cannot silently switch to another account. Account disablement, role changes, password rotation, client revocation, token-version rotation, and refresh-token replay invalidate the relevant credentials.

Inspect trusted clients locally:

```sh
machine-mcp account clients --workspace /path/to/project
```

Revoke one client and all of its authorization codes, access tokens, and refresh tokens:

```sh
machine-mcp account revoke-client CLIENT_ID --workspace /path/to/project
```

Account-management requests are signed by a root-certified ephemeral device session. Machine Bridge does not deploy or retain a long-lived account-administration bearer or HMAC secret.

## Automatic execution

There is no per-operation approval prompt in the current runtime.

Within the effective role and daemon ceiling, calls execute automatically. Outside that intersection, calls fail immediately with `authorization_denied`; the response does not contain an approval ID or a command to retry.

Examples:

- a reviewer may inspect files inside the selected workspace;
- an editor may update ordinary workspace files;
- an operator may run a workspace-confined process only when the delegated process sandbox is behaviorally verified;
- an owner may use shell, unrestricted paths, browser/application automation, resources, and managed jobs when enabled by the daemon policy.

Risk classification still runs for every consequential request. It supplies structured audit metadata and enforces hard boundaries; it is not a mechanism for temporary privilege escalation.

## Hard boundaries

### Machine Bridge control plane

Generic path-based file, image, search, and patch tools cannot target Machine Bridge state, device-root metadata, account-management state, audit-chain state, service metadata, or other protected roots. This applies to `owner` as well as delegated accounts.

This is an application-level path boundary, not an arbitrary-code sandbox. An authorized `owner` shell or interpreter has the daemon OS user's ambient filesystem authority. Control-plane administration uses local CLI interfaces; mutually untrusted owner execution requires external OS isolation.

### Sensitive and persistent targets

Non-owner accounts cannot access credential- or persistence-sensitive targets, including live environment files, private keys, token stores, shell startup files, Git hooks, privilege configuration, LaunchAgents, LaunchDaemons, and equivalent persistence locations.

Final symbolic-link overwrites are rejected. Existing ancestors and patch move destinations are canonicalized before classification so a workspace alias cannot conceal an external or sensitive destination.

### Browser, desktop, and data export

Only `owner` may control the existing browser profile or desktop applications, upload local files, or inject registered resources into an interactive session. Browser and application actions operate on the user's logged-in session and therefore are not delegated to lower roles.

### Persistent jobs

Only `owner` may create persistent execution plans with `start_job` or non-executing drafts with `stage_job`.

`stage_job` does not execute and is not an approval workflow. The removed `machine-mcp job approve` path cannot turn a draft into a running job. Execution requires a trusted owner request through `start_job`, or an explicit local `job submit` operation performed by the machine operator.

## Delegated process isolation

An `operator` process is not accepted merely because its current directory and environment are restricted. Machine Bridge requires a behaviorally verified OS sandbox that:

- exposes the selected workspace and an isolated runtime directory;
- blocks the real user home and Machine Bridge state;
- blocks Keychain and desktop automation access;
- preserves the minimum system runtime needed by ordinary tools.

The probe is fail-closed. The presence of a sandbox executable is not sufficient.

On platforms where the negative security boundary cannot be verified, delegated process execution is unavailable. Owner execution remains governed by the selected daemon policy. For mutually untrusted workloads, use a separate OS account, container, or VM.

Implementation-owned metadata probes are a separate boundary from delegated arbitrary execution. `project_overview` and the read-only Git tools use fixed argv selected by Machine Bridge, never a caller-provided executable or shell string. Those probes run with a minimal isolated environment, bounded output and deadlines, cancellation/process-tree tracking, and the request’s path-visibility rules. They do not grant `run_process`, registered-command, or shell authority to reviewer/editor accounts.

## Object ownership

Long-lived runtime objects bind to the principal that created them:

- account ID;
- account version;
- OAuth client ID;
- refresh-token family ID.

The binding applies to interactive processes, retained command-output sessions, and managed jobs. Another account, client, or refresh family cannot read, continue, send input to, cancel, or terminate those objects.

## Device-root authorization

The default root on every platform is a portable owner-only P-256 key. It signs the 24-hour ephemeral session certificate without Keychain access or a user-presence prompt. On macOS, `MBM_MACOS_TRUST_BROKER` may explicitly select a separately provisioned app-like broker; only after its code signature, Team ID, canonical non-symlink path with no group/other write access, and real Secure Enclave key probe validate does a non-exportable root replace the portable provider. That provider requests user presence once when signing the daemon session certificate. The private session key remains in memory and handles WebSocket preflight, challenge authentication, reconnects, and local account administration for that daemon lifetime.

Expected interaction frequency:

- ordinary tool calls: no local prompt;
- portable-root daemon startup: no prompt;
- provisioned Secure Enclave daemon startup: one user-presence prompt;
- network reconnect: no prompt;
- an independent account-management command: no prompt with a portable root, or one prompt with a provisioned Secure Enclave root;
- root rotation: one explicit operation, with user presence only when the provisioned broker requires it.

Every platform uses the portable P-256 provider unless an explicitly configured non-exportable platform provider has been installed and validated. `server_info.security.device_root` reports the active provider and whether the root key is exportable.

## DPoP

OAuth clients that support DPoP may bind access and refresh tokens to their own P-256 key. The Worker validates the proof method, URL, timestamp, nonce identifier, access-token hash, and key thumbprint. A copied token is insufficient without the client private key.

Bearer remains available for MCP hosts that do not implement DPoP. Client trust, account versioning, refresh-family rotation, and role ceilings still apply.

## Audit and incident response

The local security audit is a bounded SHA-256 hash chain. It records operation class, outcome, duration, byte counts, target digest, and salted principal references. It does not record command text, file paths, file contents, form values, or tool output.

For incident response:

1. stop the daemon;
2. revoke the affected OAuth client or disable the account;
3. rotate the account password or global token version when appropriate;
4. rotate the device root when device identity may be compromised;
5. inspect the audit-chain health and local endpoint logs;
6. restart and reconnect only trusted clients.

Legacy capability-lease files from version 2 may still be listed, revoked, or cleared by the local CLI for migration cleanup. The version 3 runtime never consumes them and never creates pending approval IDs.
