# Multi-account authorization and tenancy

## What isolation means

Machine Bridge remote mode supports several named accounts on one workspace Worker. Each account has an independent password, role, active state, version, OAuth authorization codes, access tokens, and refresh tokens. Account changes revoke only that account's outstanding credentials.

This is application-level authorization, not operating-system isolation. All accounts ultimately reach one local daemon running as one OS user. Roles limit which Machine Bridge tools can be listed and invoked; they do not create separate filesystems, browser profiles, process namespaces, keychains, network identities, or kernel security boundaries.

Use separate OS accounts, containers, VMs, state roots, Workers, and workspaces when users are mutually untrusted or require hard isolation.

## Roles

| Role | Effective local profile | Typical use |
|---|---|---|
| `reviewer` | `review` | Read-only workspace, Git, image, resource, and job inspection |
| `editor` | `edit` | Reviewer access plus deterministic file mutation |
| `operator` | `agent` | Editor access plus workspace-confined direct process execution and sessions |
| `owner` | `full` | Complete bridge authority, including shell, unrestricted paths, browser, applications, resources, jobs, and account administration |

The effective tool set is the intersection of:

1. the account role;
2. the policy advertised by the connected local daemon;
3. the tools actually available from that daemon.

The Worker filters `tools/list` and rejects unauthorized calls before relay. Every accepted relay call also carries `account_id`, `account_version`, and `role`; the local runtime validates the role again before dispatch. The shared policy contract remains the single source of capability semantics.

Authenticated `server_info` deliberately reports both layers. `authorization.effective_policy` and `authorization.effective_tools` are authoritative for the current account. The nested `daemon.policy` and `daemon.tools` fields are only the local capability ceiling before account-role filtering; a `full` daemon does not make an `editor` account full. Remote `project_overview` uses the effective values at top-level `policy` and `tools` and preserves the daemon values as `daemonPolicy` and `daemonTools`.

## Account lifecycle

List accounts:

```sh
machine-mcp account list
```

Create an account. The generated password is displayed once and is not stored locally:

```sh
machine-mcp account add alice reviewer
machine-mcp account add build-bot operator
```

Change role or active state:

```sh
machine-mcp account role alice editor
machine-mcp account disable build-bot
machine-mcp account enable build-bot
```

Rotate one account's password:

```sh
machine-mcp account rotate-password alice
```

Remove an account:

```sh
machine-mcp account remove alice
machine-mcp account remove alice --yes
```

The final active owner cannot be disabled, demoted, or removed. This prevents an accidental administrative lockout.

## OAuth model

An OAuth `client_id` identifies client software and its registered redirect URIs. It is not an account. One OAuth client may be authorized by several Machine Bridge accounts, and one account may authorize several OAuth clients.

An authorization code records:

- OAuth client ID;
- account ID and account version;
- role;
- redirect URI;
- PKCE S256 challenge;
- scope and protected resource;
- expiration.

An access-token record contains the same account binding plus the deployment-wide token version. Token values are stored only as SHA-256 lookup keys. Account passwords are CLI-generated 256-bit tokens. The Worker stores independent salted HMAC-SHA-256 verifiers and rejects arbitrary human-chosen passwords; the token entropy, rather than a CPU-intensive dictionary-hardening loop, provides offline-guessing resistance within the Worker CPU budget.

At each authenticated request, the Worker verifies that the account still exists, is active, and has the same version and role recorded in the token. A password rotation, role change, suspension, or removal increments or removes that account state and invalidates only its codes and tokens.

`machine-mcp rotate-secrets` is intentionally broader. It rotates the account-administration secret, daemon secret, and deployment-wide token version, invalidating every account token and requiring all clients to authorize again.

## Administrative boundary

Account administration is not exposed as an MCP tool. It uses an owner-only local secret to call private Worker administration endpoints from the CLI. The administration secret is stored only in owner-protected local state and Cloudflare Worker secrets; it is never printed by `status`, sent through MCP, or used as an account password.

The first start of a new deployment creates an `owner` account automatically and prints its generated password once. Subsequent starts do not display account passwords.

## Concurrency and revocation

Pending calls remain bound to the OAuth access token and JSON-RPC request ID. Duplicate in-flight IDs under one token are rejected. Account revocation blocks new requests immediately; calls already relayed remain subject to ordinary cancellation, deadlines, local role validation, and the bounded same-daemon reconnect state machine. A replacement process cannot inherit a detached call.

A relay interruption keeps ordinary relay-owned calls alive only inside the bounded same-daemon reconnect window. Reconciliation or grace expiry cancels calls that no longer have a remote receiver and terminates their child process trees. Process promises settle on cancellation even when a child does not emit `close`; process ownership remains tracked until actual exit.

## Audit and privacy

Operational metrics identify tools and stable error classes, not account passwords, bearer tokens, arguments, command text, file content, or results. `server_info` may return the authenticated account ID, role, and version to that account so the client can verify its authorization context.

Account names and display names are operator-selected metadata. Do not use secrets, email addresses, customer identifiers, or other unnecessary personal data in account names.

## Deployment topology

One workspace normally maps to one Worker name, one Durable Object instance, one local state profile, and one active daemon. Multiple accounts share this topology and its OS trust boundary.

Use a separate deployment when any of these differ:

- OS user or machine owner;
- workspace trust domain;
- browser/profile trust;
- network or credential-store authority;
- billing or incident-response boundary;
- requirement for hard tenant isolation.

Do not place several unrelated machines or mutually untrusted teams behind one broad owner deployment merely to reduce administration.

## Security limits

A `reviewer` cannot invoke mutation or process tools through Machine Bridge, but data readable by the local OS user may still be exposed by a bug, compromised dependency, or incorrectly broad workspace. An `operator` can run interpreters, package managers, compilers, and repository scripts; direct argv execution therefore remains powerful even without a shell. An `owner` has effectively the authority of the local OS user and any browser or Accessibility permissions granted to the runtime.

Roles are useful defense in depth and targeted revocation. They are not substitutes for least-privilege OS design, sandboxing, endpoint security, Cloudflare account protection, or careful review of untrusted repositories and instructions.
