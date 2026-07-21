# Local transaction authorization

Machine Bridge separates **available capability** from **current remote authority**.

The canonical `full` profile still exposes the complete tool catalog, unrestricted local-user paths, shell execution, browser and application automation, managed jobs, absolute paths, and the complete parent environment. It remains the default for a trusted owner. Version 2.0 does not redefine or narrow that profile.

An authenticated `owner` account activates the capabilities permitted by the daemon policy ceiling without a second terminal approval step. This preserves uninterrupted owner automation while retaining OAuth identity binding, account-version revocation, device authentication, and the daemon policy as hard boundaries.

For delegated `reviewer`, `editor`, and `operator` accounts, the local daemon applies a final transaction gate after the Worker and local runtime have checked the account role and daemon policy. Ordinary project work remains automatic; an operation that crosses a consequential boundary requires a short-lived local capability lease.

Local stdio calls are not affected by this remote transaction gate. They remain governed by the selected local policy and the MCP host's own approval model.

## What remains automatic

Remote calls do not require a lease for:

- project discovery, status, diagnostics, ordinary metadata, and owner-configured Machine Bridge Agent guidance intended for MCP clients;
- reads inside the selected workspace, except credential-sensitive paths;
- ordinary source and configuration writes inside the selected workspace, excluding credential- and persistence-sensitive targets;
- transactional patches whose source, destination, and move targets remain inside the selected workspace and outside sensitive targets;
- Git inspection;
- browser broker status without reading profile content;
- installed-application discovery without inspecting an application UI;
- registered-resource metadata inspection.

This is the normal delegated-account coding and review path. A trusted owner is not interrupted by local approval prompts. For non-owner browser work, one reusable profile-session lease covers the session rather than prompting per page read, field, or click.

## What requires a lease

The daemon requests local authorization for these remote effects:

| Scope | Examples |
|---|---|
| `shell` | shell commands, direct process launch, process output continuation, interactive process input or termination, registered local commands |
| `external-read` | reading, searching, imaging, or inspecting a path outside the selected workspace |
| `sensitive-read` | reading credential-sensitive locations or names such as SSH/AWS/Keychain state, `.env`, tokens, secrets, or private keys |
| `external-write` | writing, editing, patching, or moving a patch target outside the selected workspace |
| `sensitive-write` | writing credentials, live `.env` files, SSH/privilege files, shell startup files, Git hooks, LaunchAgents/LaunchDaemons, or other persistence-sensitive paths even when they are inside the selected workspace |
| `browser-session` | listing or reading tabs, source, screenshots, waits, navigation, form input, clicks, submission, tab management, or extension pairing in the existing browser profile |
| `data-export` | uploading a file, inserting a registered local resource into a browser or desktop application, or filling an explicitly sensitive browser field |
| `persistent-job` | staging, starting, listing, reading output from, or cancelling a managed job |
| `application-control` | opening, inspecting, or operating a desktop application |
| `credential-operation` | generating an SSH key resource |
| `full` | all of the above for one explicit temporary automation window |

Classification uses canonicalized paths and bounded operation metadata. A single operation may require more than one scope: for example, a browser upload requires both `browser-session` and `data-export`, and an external credential read requires both `external-read` and `sensitive-read`. Existing leases may satisfy those scopes independently. A pending approval contains only the scopes still missing, and approving it creates one compound lease for those missing scopes. Pending records contain a SHA-256 target digest, not command text, file contents, form values, or uploaded bytes.

Write targets are canonicalized through their nearest existing ancestor even under `full`. A path that enters an in-workspace symbolic-link directory is classified by the real destination, while overwriting a final symbolic link is rejected. Patch `Move to` destinations are classified alongside add/update/delete paths. This preserves unrestricted-path capability without allowing path aliases to weaken the lease boundary.

The browser boundary is intentionally session-granular. The packaged extension controls whichever Chromium profile the user loaded it into; Machine Bridge cannot prove that the profile is isolated. Requiring one `browser-session` lease protects tab metadata and authenticated page content without degrading into per-click prompts. Once granted, ordinary browser reads, navigation, filling, and clicks proceed continuously until expiry. Exporting registered local data remains separately gated.

## Optional delegated-account approval flow

Owner requests never create pending approval IDs. When a lease is missing for a non-owner account, the tool call fails with `local_approval_required` and a command containing a random pending approval ID. List pending requests and active leases locally:

```sh
machine-mcp --workspace /path/to/project approval list
```

Approve only the requested scope for one hour:

```sh
machine-mcp --workspace /path/to/project approval approve APPROVAL_ID --duration 1h
```

Then retry the original task. Further matching operations from the same account and OAuth client run without interruption until the lease expires.

For a trusted, intensive automation session, convert the same pending request into an explicit temporary `full` window:

```sh
machine-mcp --workspace /path/to/project approval approve APPROVAL_ID --full
```

`--full` defaults to eight hours and cannot exceed eight hours. It is local, account-bound, client-bound, time-bounded, and revocable. It does not change the saved policy profile or extend itself remotely.

A specific scope can also be granted in advance. Account and OAuth client IDs are available from `approval list --json` after the client has produced a pending request. Wildcards are supported only when entered explicitly:

```sh
machine-mcp --workspace /path/to/project approval grant shell \
  --account ACCOUNT_ID --client CLIENT_ID --duration 2h
```

## Revocation

Revoke one lease:

```sh
machine-mcp --workspace /path/to/project approval revoke LEASE_ID
```

Revoke every active remote capability lease for the workspace:

```sh
machine-mcp --workspace /path/to/project approval clear
```

Stopping the daemon prevents execution while it is offline, but leases remain in owner-only state until expiry or explicit revocation. Incident response should therefore stop the daemon, clear leases, revoke or rotate affected OAuth credentials, and inspect account/client state.

## Binding and storage

Every lease binds:

- account ID;
- OAuth client ID;
- one or more explicitly approved scopes, or the standalone `full` scope;
- creation and expiration times;
- an optional source pending-approval ID.

Normal scopes may last at most twelve hours. `full` may last at most eight hours. Pending requests expire after ten minutes. Lease and pending files are size-bounded, owner-only, atomically replaced, schema-validated, and validated record by record. Daemon-created pending requests and separate CLI approval/revocation processes serialize mutations through an owner-only process-identity lock, preventing lost updates during concurrent use. Malformed state or lock metadata fails closed.

This is an application-level control, not an OS sandbox. A process already running as the same OS user can interfere with local files and memory. Use a separate OS account, VM, or container when the client, repository, or instructions are mutually untrusted.
