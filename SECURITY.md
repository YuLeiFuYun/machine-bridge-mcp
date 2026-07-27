# Security policy

## Supported versions

Security fixes are applied to the latest released version. Upgrade before reporting an issue already fixed on `main`.

## Reporting a vulnerability

Do not open a public issue for an undisclosed vulnerability. Use [GitHub private vulnerability reporting](https://github.com/YuLeiFuYun/machine-bridge-mcp/security/advisories/new). Include:

- affected version and operating system;
- remote or stdio transport;
- selected daemon policy and authenticated account role;
- minimal reproduction;
- expected and observed impact;
- whether credentials, files, process authority, browser/application state, or network access were exposed.

Do not include live account passwords, OAuth tokens, Cloudflare credentials, private keys, browser material, or unrelated local files. Rotate any credential used in a reproduction.

## Repository and documentation privacy

Tests, examples, documentation, release notes, and package metadata are publication surfaces. Use synthetic hostnames, aliases, usernames, paths, and project names.

Run:

```sh
npm run privacy:check
npm run privacy:history
```

Maintain private local identifiers in the ignored `.privacy-denylist`. Removing a value from the current branch does not remove it from Git history, caches, forks, or published packages. Rotate exposed credentials immediately.

CodeQL and OpenSSF Scorecard are release gates. Exceptions must be exact, justified, time-bounded, and independently visible; rule-wide suppression is not accepted.

## Core trust model

The detailed model is in [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

Trusted components are:

1. the local OS account running Machine Bridge;
2. the installed package or source checkout and its dependencies;
3. the user's Cloudflare account and deployed Worker in remote mode;
4. the explicitly authorized MCP client;
5. the selected browser profile and extension installation when browser automation is enabled.

The Worker authenticates and filters remote requests. The local runtime owns filesystem, process, browser, application, resource, and job authority. Stdio bypasses the Worker and relies on local process and configuration trust.

## Effective remote authority

Remote authority is an intersection:

```text
daemon capability ceiling
∩ account role
∩ trusted OAuth client binding
∩ account version and refresh-token family
∩ object ownership
```

The roles are:

- `reviewer`: read-only selected-workspace access;
- `editor`: selected-workspace reads and deterministic file mutation;
- `operator`: workspace-confined mutation and direct process execution;
- `owner`: complete bridge authority within the daemon policy ceiling.

No approval ID, refresh token, reconnect, client registration, or legacy lease can expand a role. Out-of-role operations fail with `authorization_denied`.

The Worker filters the stable discovery catalog by account role. Discovery is not authorization: each call is separately intersected with the current end-to-end-ready daemon capability ceiling, and the local runtime independently recomputes the role and policy boundary before dispatch. Account disablement, role change, password rotation, account removal, client revocation, token-version rotation, and refresh-family replay invalidate the appropriate credentials.

An OAuth client is bound to one account, account version, and role after successful authorization. It cannot silently switch accounts. Use `machine-mcp account clients` to inspect clients and `machine-mcp account revoke-client CLIENT_ID` to revoke one client and its credentials.

## Profiles are capability sets, not sandboxes

The default `full` profile prioritizes owner automation over least privilege.

- `full` exposes all tools, unrestricted paths, absolute path output, shell execution, browser/application automation, managed jobs, and the complete parent environment.
- `agent` exposes workspace-confined mutation and direct process execution with an isolated environment.
- `edit` exposes reads and file mutation without process execution.
- `review` exposes read-only workspace, Git, and image tools.

A stored `full` label is canonical. Per-capability narrowing is represented as `custom`, not as a partially restricted `full`.

`run_process` avoids shell parsing but an invoked interpreter, package manager, compiler, test runner, or repository script can execute arbitrary code. `exec_command` additionally enables shell expansion.

Owner execution is not OS-sandboxed by Machine Bridge. Use a dedicated low-privilege account, container, or VM for mutually untrusted workloads.

## Delegated process isolation

An `operator` process must pass a behaviorally verified OS-sandbox boundary. Restricting only cwd and environment is insufficient because an ordinary same-user process can otherwise read the user's home, Machine Bridge state, Keychain, and desktop session.

The sandbox probe must demonstrate that the selected workspace is usable while protected roots remain unreadable. If the platform cannot demonstrate the negative boundary, delegated process execution fails closed.

The existence of `sandbox-exec`, a container binary, or another sandbox command is not treated as proof of isolation.

## Machine Bridge control plane

Generic path-based file, image, search, and patch tools cannot target Machine Bridge control-plane roots, including device-root metadata, account-management state, audit state, service metadata, locks, native broker artifacts, resources, and profile state. This denial also applies to `owner/full` and prevents accidental export through structured file APIs.

It is not an OS sandbox. `owner/full` shell or interpreter execution runs with the daemon OS user's ambient authority and can access same-user files outside Machine Bridge's path resolver. Protect mutually untrusted owner clients with a separate low-privilege OS account, VM, or container; do not describe the path check as protection from arbitrary owner code execution.

## Device identity and user presence

Remote daemon authentication uses a long-term device root and a root-certified ephemeral session.

The default provider on every platform, including macOS, is an owner-only portable P-256 root. Its private JWK is exportable by the daemon OS user and is reported as such in `server_info`. The root signs a 24-hour ephemeral session certificate at daemon startup; the ephemeral private key remains in memory and signs WebSocket preflight, Worker challenge, reconnect, and account-administration requests. Portable startup does not access Keychain and does not request user presence.

macOS can opt into a non-exportable Secure Enclave root only through `MBM_MACOS_TRUST_BROKER`. The configured executable must be an app-like broker signed by an Apple development or distribution identity with provisioning-profile-validated data-protection Keychain entitlements. Machine Bridge validates its canonical path, file mutability, strict code signature, signing identifier, Team ID, protocol responses, and a real create/delete Secure Enclave key probe before enrollment. The broker identity remains bound to the root and is revalidated before later use.

The prompt frequency is therefore:

- ordinary tool calls: none;
- portable-root daemon startup: none;
- provisioned Secure Enclave daemon startup: one user-presence operation;
- relay reconnect: none;
- independent local account administration: none with a portable root, or one with a provisioned Secure Enclave root;
- device-root rotation: one explicit operation, plus user presence only when the provisioned broker requires it.

The packaged Swift source and ad-hoc build are development/protocol fixtures. The production validator deliberately rejects them because ad-hoc code has no provisioning-profile-validated data-protection Keychain access group.

The broker path, signing identifier, Team ID, and capability are revalidated before use, but those checks cannot distinguish a malicious replacement signed by the same trusted Apple team and identifier. Install production brokers in a root-owned or otherwise daemon-user-non-writable location and protect the signing identity and update channel.

## Account administration

Version 3 has no long-lived `ACCOUNT_ADMIN_SECRET`. Account and OAuth-client administration uses P-256 requests signed by the root-certified ephemeral session. The signature binds:

- Worker origin;
- HTTP method and path;
- request-body hash;
- ephemeral key ID;
- timestamp;
- random nonce.

The Worker verifies the root certificate, session signature, bounded timestamp, body hash, and nonce replay state. Nonce capacity fails closed instead of evicting live replay markers. The local administration client accepts at most one MiB, cancels oversized responses, and requires every successful non-empty reply to be a JSON object; malformed success cannot be mistaken for an empty valid result.

Account passwords are generated 256-bit tokens. The Worker stores independent salted verifiers, not plaintext passwords. A generated password is printed once by the command that creates or rotates it.

## OAuth and DPoP

Remote mode uses authorization code flow with PKCE S256, exact redirect and resource binding, bounded dynamic client registration, short-lived access tokens, one-time rotating refresh tokens, family lifetime limits, and replay-family revocation.

Codes and tokens bind to client ID, account ID, account version, role, scope, resource, deployment token version, and refresh family.

Supported clients may use DPoP ES256. The Worker verifies proof method, target URL, timestamp, unique identifier, public-key thumbprint, access-token hash, and supported JWS header semantics. Verification alone does not consume global replay capacity: the Worker stores the `jti` replay marker only after the access token or OAuth grant, client, account, and resource are valid. A copied DPoP-bound token is insufficient without the client private key.

Bearer remains available for MCP hosts without DPoP. Bearer possession is therefore a residual risk until token expiry or revocation.

Authorization pages display the validated client name and redirect URI. Enter an account password only after initiating the connection and recognizing both values.

Public health and discovery endpoints do not expose workspace, daemon, account, or tool state.

## Agent instructions, skills, and registered commands

Built-in working agreements and bounded project facts are guidance, not a security boundary. Repository instructions, custom instruction files, script names, and skills are untrusted content and may attempt prompt injection.

Automatic project context does not inject package-script bodies, dependency values, source contents, or execute discovered commands. Skill loading inventories bounded text; scripts remain inert until a separate execution tool is invoked.

Registered commands use fixed argv execution, reject undeclared arguments, and enforce configured timeouts. They are not a trust upgrade: a repository-controlled script or executable can still run arbitrary code within the caller's effective authority.

## Browser and application automation

Only `owner` may control the existing browser profile, desktop applications, or export local data into them.

The browser broker:

- listens only on canonical loopback;
- validates `Host` and extension origin;
- uses owner-only pairing material;
- requires protocol, package version, and capability equality;
- does not let an invalid replacement displace a healthy connection;
- restricts DevTools use to fixed input commands;
- does not accept caller-supplied JavaScript, AppleScript, JXA, or arbitrary DevTools methods.

These controls do not make web content trustworthy. Pages may contain prompt injection, deceptive labels, hidden consequences, changing UI state, inaccessible cross-origin frames, or high-value authenticated sessions. Machine Bridge cannot prove the extension is loaded in an isolated profile.

The extension independently caps active operations at 32. Its public error boundary returns only fixed or allowlisted guidance; raw Chrome, DevTools, page, URL, selector, filesystem-path, account-shaped, and credential-shaped exception text is not forwarded to a remote client. Successful trusted-input fallback likewise reports a fixed reason rather than the local debugger failure.

After trusted input dispatch begins, an ambiguous failure is reported as unknown outcome and is not automatically replayed.

Local resources may be injected without returning their bytes through MCP, but the destination page or application still receives them. Screenshots and page source can themselves contain secrets.

## Filesystem and mutation integrity

Workspace-confined profiles canonicalize existing paths and write ancestors. Final symbolic-link writes are rejected. Patch add, update, delete, and move destinations are classified before mutation.

Writes use bounded same-directory staging and atomic replacement. Expected hashes and exact edits reduce stale overwrites. Patch transactions prevalidate all operations, serialize mutation, maintain backups, and roll back ordinary commit errors.

On systems without descriptor-relative traversal, a malicious same-user process can still race parent-directory replacement between validation and open. Machine Bridge does not claim protection from a hostile process with equivalent OS-user authority.

Sensitive and persistence targets are owner-only. Generic remote file tools cannot access Machine Bridge's own control-plane state.

## Processes and sessions

Direct processes use argv without shell parsing. Shell expansion is available only through the explicit shell tool.

Process counts, stdin, output, timeouts, retained sessions, and tool-call concurrency are bounded. Timeout, explicit cancellation, reconnect-grace expiry, runtime shutdown, and non-recoverable daemon replacement use process-tree termination with bounded graceful and forced phases. A transient relay or HTTP/SSE disconnect is not cancellation. Streamed-call ownership and deadlines survive Durable Object hibernation, while a random per-WebSocket generation prevents an obsolete socket from settling or detaching a rebound call.

Interactive process sessions die when their owning runtime stops or is replaced; an ordinary same-process relay reconnect does not itself destroy them. Retained output sessions and process control are bound to account, account version, OAuth client, and refresh family.

The daemon does not enforce universal CPU, memory, disk, or network quotas. An authorized owner process can still exhaust host or external resources.

## Local resources and managed jobs

Registered resources store canonical paths and bounded metadata, not file contents. Private resource files require restrictive permissions on Unix-like systems unless explicitly overridden. Generated SSH private-key bytes are never returned through MCP. If state registration fails after a new key pair is created, both files are removed; failure to complete that rollback is surfaced as a compound error rather than silently leaving an unregistered private key.

At job acceptance, referenced resources are reopened, bounded, hashed, and copied into a private runtime area. Changed or unavailable resources fail closed. Environment injection may be visible to same-user process inspection; private file-path substitution or stdin is generally safer.

Managed jobs are durability, not sandboxing. Only `owner` may create remote persistent plans. Long-lived jobs bind to account, account version, OAuth client, and refresh family.

`stage_job` is non-executing and cannot be promoted by a terminal approval command. `machine-mcp job approve` was removed. Execution requires trusted `start_job` authority or an explicit local `machine-mcp job submit PLAN.json` action.

Job output and state are bounded. `finally_steps` are best effort and must be idempotent because recovery may repeat them. Power loss, disk failure, revoked external credentials, or endpoint-security denial can prevent cleanup.

Use `capture_output: "discard"` whenever a process may echo credentials. Never put a secret directly in argv or ordinary JSON plan fields.

## State, locks, and rotation

State roots must be separate from workspaces. State and lock files are owner-only where supported, bounded, schema-validated, and atomically replaced. Process locks bind owner tokens to PID and process start time. Ambiguous or unreadable ownership fails closed.

Device-root migration is two-phase: a pending public root is deployed and health-verified before local promotion. `--daemon-only` refuses to activate an undeployed pending root.

Destructive state removal validates marker files, selected workspace, known layout, lock ownership, service state, and managed-job activity. Unresolved conditions retain state.

## Relay and denial of service

Only one verified daemon is active. Candidates have preflight, hello, readiness, and liveness deadlines. A candidate cannot displace the current daemon before authentication and end-to-end readiness.

Pending calls are bounded, socket-generation-bound, request-bound, timed out, cancellable, and recoverable only for the same verified daemon instance during the documented reconnect grace period. Worker transport/liveness invalidation is retryable and cannot by itself stop the daemon process; unknown protocol messages, authentication rejection, and identity/version mismatch remain fatal.

Request bodies, messages, traversals, files, output, OAuth stores, nonce stores, sessions, and failure identities are bounded. These controls do not replace Cloudflare MFA, WAF/rate limits, billing alerts, or external cost controls.

## Logs, audit, and privacy

Operational logs omit tool arguments, command text, stdin, file/patch contents, form values, and outputs. Known credential forms, private-key material, embedded-credential URLs, user-home paths, email addresses, and control characters are recursively redacted as defense in depth.

The local security audit is a bounded SHA-256 hash chain. It records operation type, risk category, outcome, duration, byte counts, target digest, and salted principal references. It does not record commands, paths, contents, fields, or results.

No logging policy prevents data from being returned to an authorized client that explicitly invokes an enabled tool. Remote arguments and results necessarily traverse the user's Worker and MCP host.

## Hardening checklist

- Use `review` or `edit` when execution is unnecessary.
- Use a dedicated OS account, container, or VM for untrusted repositories, prompts, or clients.
- Enable MFA for Cloudflare, GitHub, npm, and Apple developer accounts.
- Keep the state root separate from every workspace.
- Inspect OAuth client names and redirect URIs.
- Inspect trusted clients and revoke stale records.
- Prefer DPoP-capable clients where available.
- Use the portable root unless a separately provisioned macOS trust broker has been installed and validated; never point `MBM_MACOS_TRUST_BROKER` at an ad-hoc or mutable executable.
- Register credentials as local resources instead of reading them into a model conversation.
- Use discard capture for credential-consuming jobs and idempotent finally steps.
- Inspect `status`, `doctor`, `server_info`, service state, delegated-sandbox status, and audit-chain health.
- Rotate an account password after targeted disclosure; revoke a client after client compromise; rotate the device root and global token version after bridge-wide compromise.
- Remove the Worker and local state when remote access is no longer required.

## Out of scope

Machine Bridge cannot make arbitrary local executables safe, identify all sensitive data, guarantee cleanup across every power/storage/security failure, override MCP-host or endpoint-security policy, neutralize prompt injection, protect against root or a fully compromised same-user account, or manufacture production signing and governance controls.

See [docs/AUDIT.md](docs/AUDIT.md) for historical findings and residual limitations.
## Resumable Streamable HTTP delivery

SSE event identifiers are cursors, not bearer credentials. Recovery requires a valid OAuth Bearer/DPoP request and the original signed `MCP-Session-Id`; a cursor from another token or session is reported as not found. `GET /mcp` only replays an existing stream, while POST always represents new work.

The Worker stores bounded stream and call state to bridge transport loss. Active streamed-call records contain opaque ownership/generation identifiers, request correlation, deadlines, and no tool arguments; terminal records retain at most 1.5 MiB for two minutes and include SHA-256 integrity metadata. The index is limited to 64 streams. This protects continuity and detects accidental storage corruption, not compromise of the Worker account or Durable Object. A valid persisted call remains pending after Worker restart. Only a pending stream record with no durable call owner is reported as an ambiguous execution outcome; clients must reconcile before retrying a non-idempotent tool in that case.
