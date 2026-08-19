# Multi-account authorization and tenancy

## What isolation means

Remote mode supports several named accounts on one workspace Worker. Each account has an independent password verifier, role, active state, version, authorization codes, access tokens, and refresh-token families.

This is application-level authorization, not operating-system multi-tenancy. All accounts ultimately reach one daemon running as one OS user. Roles do not create separate filesystems, browser profiles, process namespaces, Keychains, network identities, or kernel boundaries.

Use separate OS accounts, containers, VMs, state roots, Workers, and workspaces when users are mutually untrusted or require hard tenant isolation.

## Roles

| Role | Effective local profile | Purpose |
|---|---|---|
| `reviewer` | `review` | Read-only selected-workspace inspection |
| `editor` | `edit` | Reviewer access plus deterministic workspace file mutation |
| `operator` | `agent` | Editor access plus behaviorally sandboxed workspace-confined direct execution |
| `owner` | `full` | Complete bridge authority within the daemon capability ceiling |

Effective authority is the intersection of:

1. the daemon policy and available tools;
2. the account role;
3. the trusted OAuth client binding;
4. the current account version and refresh-token family;
5. ownership of any long-lived process, output session, or job.

There is no temporary elevation path. A `reviewer`, `editor`, or `operator` cannot acquire `owner` capability through a local lease, approval ID, token refresh, or reconnect.

The Worker filters the stable `tools/list` discovery catalog by account role. It separately rejects calls that are outside the current account role or the live end-to-end-ready daemon ceiling before relay. Every accepted call carries account ID, account version, OAuth client ID, refresh-family ID, and role. The local runtime validates those values again before dispatch.

Authenticated `server_info.authorization.effective_policy` and `effective_tools` describe the current account. `daemon.policy` describes only the local capability ceiling; a `full` daemon does not make an `editor` account full. Exact `daemon.tools` names are owner-only diagnostic inventory: non-owner responses retain the daemon tool count and an explicit hidden marker without revealing owner-only capability names. Non-owner `server_info` likewise hides cross-principal runtime/Worker activity, protected local-resource inventory, and stable device-root key identity instead of representing those unknown values as zero.

## Account lifecycle

List accounts:

```sh
machine-mcp account list
```

Create an account. The generated password is displayed once. Treat this stdout as a secret; JSON/automation output that contains the one-time password must not be copied to shared logs or support artifacts:

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

Rotate a password or remove an account:

```sh
machine-mcp account rotate-password alice
machine-mcp account remove alice --yes
```

The final active owner cannot be disabled, demoted, or removed.

Account disablement, role changes, password rotation, and removal revoke that account's credentials by changing or deleting its account version.

## Trusted OAuth clients

An OAuth `client_id` identifies client software and redirect URIs. Registration alone has no authority.

The first successful account authorization binds the client to:

- account ID;
- account version;
- role;
- authorization time.

A client cannot later authorize as a different account without first being revoked and registered again. This prevents one public client record from becoming a silent cross-account identity switch.

List clients:

```sh
machine-mcp account clients
```

Revoke one client and all of its codes, access tokens, and refresh tokens:

```sh
machine-mcp account revoke-client CLIENT_ID
machine-mcp account revoke-client CLIENT_ID --yes
```

One account may still authorize several distinct client records. Each record is independently visible and revocable.

## OAuth tokens

Authorization codes bind:

- client ID;
- account ID and account version;
- role;
- redirect URI;
- PKCE S256 challenge;
- scope and protected resource;
- expiration.

Access and refresh tokens additionally bind to the deployment token version and refresh-family ID. Token values are stored as SHA-256 lookup keys.

Access tokens last fifteen minutes. Refresh tokens rotate on every use, have a fourteen-day idle limit and thirty-day family limit, and leave bounded replay markers. To tolerate a lost response or concurrent hosted-client refresh, the same consumed token may return the same HMAC-derived replacement pair at most twice during a 30-second window. These retries do not create new credential branches or extend expiration. Further in-window attempts are rate-limited; reuse after that window revokes the complete family, including active access tokens.

A refresh request also verifies that the client remains bound to the current account version and role.

### DPoP

A capable client may bind the token family to a P-256 DPoP key. The Worker verifies the proof and requires the same key thumbprint for refresh. A copied token cannot be used without the client private key.

Bearer remains available for hosts that do not implement DPoP.

## Object ownership

Interactive processes, retained output sessions, and managed jobs bind to:

- account ID;
- account version;
- OAuth client ID;
- refresh-token family ID.

A different account, client, or token family cannot inspect, continue, send input to, cancel, or terminate the object.

This binding prevents horizontal control between two clients authorized for the same account as well as between different accounts.

## Administrative boundary

Account and client administration is not exposed as an MCP tool and does not use a long-lived administration secret.

The local CLI creates a root-certified ephemeral P-256 session. Each request signs the Worker origin, HTTP method, path, body hash, session key ID, timestamp, and nonce. The Worker verifies the root certificate, session signature, body, timestamp, and nonce replay state.

The default root is portable owner-only P-256 material, including on macOS, so independent account commands do not normally prompt. When a separately provisioned broker has explicitly enrolled a Secure Enclave root, an independent account command may request user presence once. During normal first-run daemon startup, the same in-memory session is reused for initial owner creation and relay authentication. Candidate/prerelease activation requires an existing deployment and deliberately skips initial-owner provisioning; account administration is not used as a precondition for candidate relay readiness.

The first start of a new deployment creates an owner account automatically and prints its generated password once. Subsequent starts do not display passwords.

## Delegated execution

`operator` direct execution requires a behaviorally verified OS sandbox. The sandbox must expose the selected workspace while denying the real user home, Machine Bridge state, Keychain, and desktop automation.

When the platform cannot prove that boundary, operator process execution is unavailable. The runtime does not fall back to a path blacklist that only appears isolated.

Installed-application inventory is the deliberate read-only exception: reviewer/editor/operator accounts may use `list_local_applications`, with external paths projected rather than exposed absolutely. Browser/application content inspection or control, local data export, credential operations, persistent job creation, machine-wide runtime diagnostics, protected local-resource inventory, sensitive targets, and unrestricted paths remain owner-only. In the public remote catalog this additionally means `diagnose_runtime`, `list_local_resources`, `stage_job`, and `start_job` are not discoverable or callable by reviewer/editor/operator accounts even where the underlying local daemon profile would otherwise admit them.

## Concurrency and revocation

Each MCP request has its own request-ID/cancellation boundary. Native `2026-07-28` HTTP streams are request-scoped rather than session-scoped, and the bounded initialization-era compatibility path does not create an MCP session either. Pending calls are bound to the authenticated account/client/family authority that was validated for that request.

A brief relay interruption preserves an ordinary call only within the same-daemon reconnect grace period. Reconciliation or expiry cancels calls without a receiver and terminates their child process trees. A replacement daemon process cannot claim a detached call.

Revoking an account, client, or refresh family blocks new requests immediately through the persisted OAuth/account-version state. The same mutation transaction durably queues the matching local-authority revocation before it commits. A daemon acknowledges that record only after revocation has been applied completely to pending calls, process sessions, and every inspectable matching managed job. The daemon attempts all three local execution categories before reporting an incomplete revocation, so a failed process-session termination does not postpone cancellation of an independently revocable managed job. A process-session whose direct forced tree-termination request cannot be delivered remains retained and makes the revocation retryable rather than being deleted from local control state. This internal safety cancellation is not gated by the public `cancel_job` tool's current policy availability: a job accepted under an earlier wider daemon policy must still be revocable after the policy narrows. If any matching local execution state cannot be inspected or cancelled safely—for example because a process-session termination request fails, a job transition is temporarily owned, or durable job state is unreadable—the daemon does not acknowledge the record and deliberately interrupts that relay generation so the still-persisted Worker queue is replayed on the next verified connection. That intentional reconnect is diagnosed as `local_authority_revocation_retry`, not as a generic network interruption, so operators are directed toward local retained state rather than transport troubleshooting. The queue is therefore not discarded merely because a local cancellation attempt failed. A transient Worker/relay delivery failure is likewise retried by the runtime alarm or the next verified daemon connection. Already-relayed work also remains subject to ordinary cancellation, timeout, daemon lifecycle, and process-tree cleanup.

## Audit and privacy

Operational logs and the local security audit do not contain account passwords, tokens, command text, file content, form values, or results.

Before audit events leave the daemon thread, account/client/family identifiers are HMAC-pseudonymized with a fresh per-daemon runtime key; persistent audit state then applies its existing per-file salt before storing the references. Repeated activity can therefore be correlated within one daemon runtime without storing raw identifiers or leaving a reference that can be recomputed from the public salt alone. Cross-restart principal correlation is intentionally not an audit identity guarantee. `server_info` may still return the current authenticated account ID, role, and version to that same account as part of its own authorization context.

Do not use secrets, email addresses, customer identifiers, or unnecessary personal data in account names and display names.

## Deployment topology

One workspace normally maps to one Worker, one Durable Object instance, one local profile, and one active daemon. Accounts share that topology and OS trust boundary.

Use a separate deployment when any of these differ:

- OS user or machine owner;
- workspace trust domain;
- browser/profile trust;
- network or credential-store authority;
- billing or incident-response boundary;
- requirement for hard tenant isolation.

Do not place unrelated machines or mutually untrusted teams behind one broad owner deployment merely to reduce administration.

## Security limits

A reviewer is restricted by Machine Bridge, but a bug or compromised dependency remains possible. An operator can execute interpreters and repository code inside the verified sandbox and can still damage the selected workspace. An owner has effectively the authority of the local OS user and granted browser or Accessibility permissions.

Roles, client binding, DPoP, object ownership, and targeted revocation are defense in depth. They do not replace least-privilege OS design, endpoint security, Cloudflare account protection, and careful review of untrusted repositories and instructions.
