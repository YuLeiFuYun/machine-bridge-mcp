# Security policy

## Supported versions

Security fixes are applied to the latest released version. Upgrade before reporting an issue already fixed on `main`.

## Reporting a vulnerability

Do not open a public issue for an undisclosed vulnerability. Use [GitHub private vulnerability reporting](https://github.com/YuLeiFuYun/machine-bridge-mcp/security/advisories/new) for this repository. Include:

- affected version and operating system;
- remote or stdio transport;
- selected profile and relevant flags;
- minimal reproduction;
- expected and observed impact;
- whether credentials, filesystem data, process authority, or network access were exposed.

Do not include live account passwords, account-administration secrets, daemon secrets, OAuth tokens, Cloudflare credentials, private keys, or unrelated local files. Rotate credentials used in a reproduction.

## Repository and documentation privacy

Tests, examples, documentation, release notes, and package metadata are publication surfaces. Use only synthetic hostnames, resource aliases, usernames, paths, and project names. Run `npm run privacy:check` before committing, review `npm run privacy:history` before publishing, and maintain private local identifiers in the ignored `.privacy-denylist`; neither scanner mode prints matched values. See [Repository privacy hygiene](docs/PRIVACY.md).

Removing a value from the current branch does not remove it from Git history, caches, forks, or an already published npm package. Rotate any exposed credential immediately and coordinate destructive history rewriting separately when its risk is justified.

CodeQL and OpenSSF Scorecard are enforced as gates, not merely uploaded as advisory output. The shared SARIF gate rejects every security result and fails closed when a result omits the rule metadata needed to prove it non-security. Any exception requires an exact rule/path entry, a substantive rationale, and a non-expired review date; rule-wide suppression is not acceptable. CodeQL has one exact, expiring accepted result for the authorized non-shell direct-process boundary; its fixed option set and metacharacter behavior are tested. Scorecard exceptions are limited to documented governance or time-dependent conditions that repository code cannot truthfully repair, while remediable dependency-pinning and fuzzing findings remain release-blocking.

## Core trust model

Trusted components are:

1. the local OS user running the runtime;
2. the installed package/source checkout and its dependencies;
3. for remote mode, the user's Cloudflare account and deployed Worker;
4. an MCP client explicitly authorized through OAuth or launched locally through trusted stdio configuration.

An authorized client can invoke every tool exposed by the selected profile and receive its results.

The Worker is a remote authentication and relay boundary. The local runtime is the filesystem and process boundary. Stdio bypasses the Worker and relies on local process/configuration trust.

### Accounts are authorization boundaries, not OS sandboxes

Remote mode supports named accounts with independent passwords, roles, active state, versions, OAuth authorization codes, access tokens, and rotating refresh tokens. The roles `reviewer`, `editor`, `operator`, and `owner` map to the local review, edit, agent, and full policy profiles. The Worker intersects the account role with the connected daemon policy, and the local runtime validates the account role again before dispatch. Account suspension, role changes, password rotation, and removal revoke only that account.

An OAuth `client_id` still identifies client software and redirect URIs; it is not an account. One account can authorize several clients, and one client can be authorized by several accounts.

All accounts ultimately reach one daemon running as one OS user. Application roles cannot isolate direct processes, shells, browser sessions, Accessibility actions, credential stores, or network authority inherited from that user. Mutually untrusted users or hard tenant boundaries require separate bridge instances and external isolation: dedicated low-privilege OS accounts, containers, or VMs, narrow workspaces, independent state roots, and separate Workers. See [Multi-account authorization and tenancy](docs/MULTI_ACCOUNT.md).

## Profiles are capability sets, not sandboxes

The default for newly selected workspaces is `full`, which prioritizes ease of use over least privilege. Named profiles are canonical capability contracts. A stored `full` label is repaired on load to the complete maximum-permission field set and tool catalog; a deliberate per-capability override is represented as `custom`, not as a partially restricted `full`.

- `full` exposes all tools, unrestricted direct filesystem paths, absolute path output, shell execution, and the complete parent process environment.
- `agent` exposes file mutation, direct argv execution, and process sessions while keeping direct filesystem tools workspace-confined and the process environment isolated.
- `edit` exposes read and mutation tools without process execution.
- `review` exposes read-only workspace/Git/image tools.

`run_process` avoids shell parsing, which removes one injection class, but an executable such as `node`, `python`, a package manager, compiler, test runner, or repository script can execute arbitrary code. Direct mode therefore has effectively broad local-user authority once an attacker controls argv or executed code.

`exec_command` has both executable authority and shell expansion. Use `--no-exec` or `review`/`edit` when process execution is unnecessary.

For untrusted repositories or instructions, run the bridge inside a disposable VM/container or under a dedicated low-privilege OS account. On macOS and Windows, this external isolation is especially important. The project does not claim an in-process OS sandbox.

## Agent instructions, skills, and command manifests

Machine Bridge prepends a package-controlled built-in working-agreement block and an optional bounded automatic project-context block before repository/user instructions. The built-in block is guidance, not a security boundary. Automatic context reads only recognized root filenames, package-manager/lockfile facts, package script names, runtime constraints, common documentation names, and CI filenames; it does not inject script bodies, dependency values, source contents, or execute discovered commands. Symbolic-link, oversized, invalid-UTF-8, and unsupported metadata is skipped conservatively.

Repository and user instruction files remain untrusted content from the model's perspective. `agent_context` returns their text in deterministic precedence order but does not certify correctness or safety. A malicious `AGENTS.md`, custom instruction file, filename, script name, or `SKILL.md` can attempt prompt injection or recommend destructive operations. Use only trusted repositories and skill roots, keep host approvals/policy enabled, or isolate the bridge externally.

Automatic `package.*` commands expose only validated script names and fixed package-manager argv; they do not expose script bodies. Executing one still runs repository-controlled package-script code with local-user authority and is not a sandbox or trust upgrade.

Relay proxy selection honors `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY`. Only HTTP(S) proxy URLs are accepted. Autostart installation persists an allowlist of proxy and custom-CA environment values in `service-environment.json` so a background daemon can reproduce the foreground network route; a proxy URL may itself contain credentials, so this file is sensitive local state and must remain protected with the rest of the state root. Proxy endpoints, credentials, certificate paths, and authorization headers are not returned through MCP or written to operational logs; service status exposes only configured environment key names and relay status exposes only coarse route state.

Skill loading is non-executing. `load_local_skill` returns an entrypoint and bounded file inventory; scripts remain inert until a separate process or command tool is called. Symlinked skill directories are followed only after canonical path-policy validation, while symbolic-link `SKILL.md` entrypoints are rejected. Traversal, cycles, content, summaries, and inventory are bounded.

Registered commands are available only under direct-execution-capable policy. They use argv spawning rather than shell parsing, reject undeclared caller arguments, and enforce the manifest timeout as a ceiling. They are not an approval or sandbox boundary: a repository-controlled package script, interpreter, compiler, or executable can still run arbitrary code with local-user authority. Deeper manifests can override or remove inherited commands, so callers must obtain context for the actual target path rather than assuming the repository-root registry applies everywhere.

The remote MCP host remains an independent boundary. Machine Bridge can advertise these tools, append `model_instructions_file` during initialization, and recommend capabilities through `resolve_task_capabilities`, but it cannot force a host to preserve instructions, expose tools, approve calls, or invoke them.

The global `model_instructions_file` is an explicit user trust decision. It is read for every profile and sent to the authorized host during session initialization; do not place credentials, private records, or content inappropriate for every connected session in it. Project manifests cannot override this global file or the global `builtin_instructions`/`automatic_project_context` controls. Other global manifest fields that would widen local scope are ignored under workspace-confined profiles.

## Browser and application automation

Canonical `full` exposes structured browser and desktop UI authority. The browser extension operates the user's existing Chromium profile, including active login state, and has broad host access plus Chromium `debugger` permission so it can inspect arbitrary pages, fill complex forms, and issue trusted input. An authorized client may therefore read page content, click controls, submit forms, upload registered files, and cause transactions with the user's browser identity. macOS Accessibility actions similarly operate applications with the local user's UI authority.

The browser loopback broker validates loopback `Host`, requires a random owner-only bearer subprotocol, accepts extension sockets only from a canonical 32-character Chromium extension ID, requires the pairing page and WebSocket endpoint to use the same loopback port, and authenticates additional local runtimes separately. Initial extension pairing is trust-on-first-use; after pairing, a different localhost page cannot replace the stored broker unless the user clicks the extension action while the genuine pairing page is active. The pairing token is never returned by MCP or written to operational logs. These controls defend against casual cross-origin and DNS-rebinding access; they do not protect against malicious code already running as the same OS user or a compromised browser extension profile.

Caller-supplied JavaScript, AppleScript, JXA source, and arbitrary DevTools methods are deliberately unsupported. Actions use fixed implementation code and structured selectors. The debugger adapter is restricted to fixed `Input` commands, attaches only around one trusted action, and detaches in `finally`. `auto` falls back only before any Input dispatch; after dispatch begins, failure is reported as an unknown outcome and is never replayed through DOM. The broker and extension require the current protocol-3 `hello`/`hello_ack` exchange plus exact packaged-version and capability equality before either reports readiness. Pairing material is persisted only after acknowledgement, and an invalid replacement candidate cannot displace the current connection or overwrite its stored endpoint/token. This removes an avoidable arbitrary-evaluation surface but does not make DOM or Accessibility actions safe. Pages can contain prompt injection, misleading labels, hidden consequences, cross-origin frames unavailable to inspection, or state that changes between inspection and submission. High-impact account, financial, legal, medical, publishing, deletion, and purchase actions require contextual review and any host/user confirmation the client provides.

Text and file resources can be injected locally so their contents do not appear in MCP arguments or results. The destination page/application still receives the value, and remote tool metadata/results still traverse the Worker and host. Page source and screenshots can themselves contain secrets. Source/inspection budgets are aggregate across frames, page-controlled metadata is bounded, URL userinfo is removed from semantic snapshots, and contenteditable controls with secret-like identity are treated as sensitive; these limits reduce accidental exposure but do not classify every possible secret. Browser/app tool arguments, source, screenshots, field values, and results are intentionally omitted from operational logs.


## Shared authorization contract

Policy revision 5 is a single source of truth shared by the local daemon and Worker. The catalog availability class controls both advertisement and execution; manager-level checks invoke the same gate as defense in depth. Custom policies are evaluated by capabilities, so a label cannot impersonate `full`. Persistent job start requires both write and direct-execution authority; read-only job/resource inventory does not imply mutation authority.

Transport-visible failures use stable error codes and retryability. Unexpected implementation errors are not downgraded to ordinary resource state, and raw internal exceptions are not returned by the Worker. This reduces both authorization drift and accidental disclosure through error strings.

## Filesystem exposure

Direct filesystem scope is profile-dependent. The default `full` profile is unrestricted. The `agent`, `edit`, and `review` profiles confine direct filesystem tools to the canonical selected workspace, including symbolic-link resolution.

The default `full` profile returns absolute paths. Narrower profiles return workspace-relative paths to reduce username and directory-layout disclosure. Path display and access scope remain separate controls.

The server does not maintain a sensitive-filename blacklist. Under `full`, direct read tools may access any UTF-8 regular file available to the local OS user, including files outside the selected workspace and names such as `.env`, password stores, private keys, credentials, database dumps, and production configuration. Narrower profiles confine direct filesystem tools but do not classify names inside that boundary.

Maximum local policy does not bypass Unix permissions, Windows ACLs, macOS TCC/SIP, container/VM boundaries, endpoint-security controls, shell restrictions, or security decisions made by the MCP host/platform. `full` guarantees the complete local daemon and relay-advertised catalog, not the set a connector host chooses to expose to one session. The server cannot observe that host-side subset. A host-side refusal is independent of Machine Bridge and cannot be disabled by local policy configuration. `diagnose_runtime` and `machine-mcp doctor` use fixed probes to distinguish requests that reached the daemon from local filesystem/process/shell failures; they cannot inspect a call blocked before delivery.

Processes are not confined by the filesystem-tool resolver. They can access paths, networks, processes, credential stores, and devices available to the local user.

## Full-profile verification

`machine-mcp full-test` performs real local operations inside disposable temporary directories: unrestricted file access, direct and shell processes, inherited environment, SSH key generation/matching, a sandbox `authorized_keys` write, SSH client parsing, Google Cloud OS Login command discovery, a non-mutating sudo availability probe, and detached job cleanup. It makes no cloud or remote-server change and cannot prove that an MCP host will deliver a future request. The command verifies the Machine Bridge and local-machine portion of the authority chain only.

A canonical `full` profile guarantees that Machine Bridge itself will not reject a catalogued tool because of its local profile, path scope, environment mode, or shell mode. It cannot override the MCP host/connector, operating-system access controls, endpoint-security policy, remote authentication, cloud IAM, `sudo`, or service-side authorization.

## Mutation integrity

Writes are bounded, reject symbolic-link/non-regular destinations, use same-directory staging, flush staged data, and commit atomically per file. Sensitive reads and mode changes use shared descriptor-first primitives: regular files are opened with no-follow where supported, validated, bounded before allocation, and permissioned through the descriptor; POSIX owner-only directories are opened with no-follow plus directory-only flags, `fchmod`ed to `0700`, and revalidated before use. Windows retains ACL semantics without pretending POSIX modes are enforceable. Create-only and lock claims fully write a private temporary file before a same-directory hard-link claim becomes visible; a concurrent destination fails without exposing partial content. Replacement writes use `fsync` plus atomic rename/replacement. Expected hashes and exact edits reduce accidental stale overwrites. Requested file modes are applied exactly on POSIX before commit; a mode-setting failure rolls the transaction back rather than silently publishing a semantically incomplete file.

Startup, daemon, managed-job transition, recovery, and runner claims record ownership tokens and process start time. Reclamation validates process identity and a file snapshot before removal, limiting PID-reuse and stale-owner races. Recent malformed claims are not deleted immediately. Ordinary startup/state changes wait a bounded interval for a concurrent operation instead of turning a brief service-manager race into an operator error.

Patch operations prevalidate all paths/content, reject canonical collisions, recheck source hashes and destination absence, serialize bridge mutations, maintain backups, and roll back on ordinary commit errors. Existing reads and writes use canonical containment checks and final-component no-follow opens where the platform supports `O_NOFOLLOW`. On platforms without portable descriptor-relative `openat` traversal, a malicious process running as the same local account can still race a parent-directory replacement between validation and open/commit. These controls do not claim protection against a hostile same-user namespace, nor do they make a multi-directory patch power-loss atomic.

A custom state root is rejected if it overlaps the selected workspace in either direction. Recursive state removal cross-checks the marker, global selection, profile state, daemon locks, active/unreadable locks, known directory shape, package/source/workspace exclusions, service removal, and managed-job state. Any unresolved condition fails closed and retains state.

## Credential exposure

Local state contains the account-administration secret, daemon secret, and deployment-wide token version. Account passwords are generated 256-bit tokens and are not stored locally; the Worker stores only independent salted HMAC-SHA-256 verifiers. The fixed high-entropy token format is mandatory, so the verifier does not rely on a CPU-intensive human-password KDF inside the Worker request budget. State, lock, temporary secret, runtime, pairing, and service-log files use owner-only permissions where supported. Worker deployment secrets are written only to an exclusive `0600` file whose name binds PID and process-start identity; stale cleanup removes only positively reclaimable owners, verifies file identity, retains ambiguous live owners, and reports cleanup failure. State writes are flushed and atomically replaced. A read/type/permission/size/symbolic-link failure is not treated as empty or corrupt state; only successfully read invalid JSON is moved to a bounded corrupt backup. The same rule applies to recursive state-root removal: unreadable or malformed config, profile state, or daemon ownership records block deletion.

Logs recursively redact known credential fields, private-key headers, npm/GitHub/GitLab/Slack/Google/AWS/live-payment/API token forms, JWT-shaped bearer values, embedded-credential URLs, email addresses, user-home paths, and control characters. These patterns are defense in depth; unknown, transformed, split, encrypted, or application-specific secret forms can still pass through an explicitly requested tool result.

A new deployment prints the generated initial owner password once. Account creation and targeted password rotation also print the generated password once. JSON output includes a generated password only for the command that created it; status, diagnostics, and secret rotation never reveal stored secrets. The account-administration and daemon secrets are never printed. Avoid shared terminal logs, shell recordings, screenshots, CI output, or support tickets.

The default `full` profile passes the complete parent environment. Narrower profiles replace HOME, temp, and common cache paths and do not pass arbitrary parent variables. The isolated mode reduces accidental environment-secret leakage; it does not prevent code from explicitly accessing known resources.

## Local resources and managed jobs

Local resources are registered through the operator-controlled CLI or, only under canonical `full`, through `generate_ssh_key_resource`. State stores canonical paths, bounded registration-time aliases used only for redaction, and metadata—not file contents. Public status and resource results omit those aliases. The SSH generator creates or reuses an unencrypted automation key, verifies that the public and private files match, rejects symbolic links/incomplete pairs, applies `0600`/`0644` modes where supported, and returns no private bytes. Resource CLI output and `generate_ssh_key_resource` omit local paths by default; path disclosure requires `--show-paths` or `expose_paths=true`. Unix-like registration rejects group/other-readable private resource files unless explicitly overridden. Portable mode checks do not fully describe Windows ACLs or extended Unix ACLs; the operator remains responsible for platform permissions.

At job acceptance, referenced resources are bounded and hashed. The detached runner reopens and verifies each hash before copying it to a private `0600` runtime file. Resource copies are removed after the finally phase. A changed or unavailable resource fails closed.

Resource injection modes have different exposure:

- private file-path substitution is generally preferred;
- stdin avoids process arguments and environment variables;
- environment injection can be visible to same-user process inspection and inherited child processes.

Managed jobs accept arbitrary argv and therefore retain local-user authority. They are a durability mechanism, not a sandbox or an authorization bypass. A running job snapshots execution authority and environment mode at acceptance. Later profile changes affect new jobs but do not silently revoke an accepted running job; explicitly cancel active jobs when revoking authority. The initial job submission remains subject to MCP-host approval and platform safety policy; each child remains subject to local OS and endpoint-security policy.

`stage_job` is non-executing and requires write capability. Local `machine-mcp job approve` is a separate operator authorization and may launch a staged plan even when the MCP profile itself has no execution capability. Operators must review the stored plan before approval. Cancelling before approval runs neither main nor finally steps.

Active plans are owner-only and may temporarily contain argv, non-secret stdin, temporary helper content, environment overrides, and resource source paths for crash recovery. A terminal runner deletes the full plan. Status and bounded results remain for up to seven days/50 jobs. If a runner crashes before terminal commit, the plan remains until recovery or retention cleanup.

Exact canonical and registration-time resource path aliases, exact resource bytes interpreted as text, and bounded exact base64/hex forms are redacted from retained output. This cannot detect partial, transformed, encrypted, compressed, or application-specific encodings. It also cannot redact unrelated secrets inherited through the full parent environment. Use `capture_output: "discard"` whenever a process may echo credentials, and never place a secret directly in argv, ordinary env, stdin, temporary-file content, or a JSON plan.

`finally_steps` run after ordinary success, failure, timeout, and cancellation. Cancellation uses an owner-only marker rather than signaling the runner process itself, so the coordinator remains alive to execute cleanup consistently across platforms. Timeout/cancellation target the process group/tree and keep a forced-termination escalation alive even if the direct child exits before a resistant descendant. Runner identity includes process start time; recovery does not trust a reused PID. A dead runner is detected on the next daemon or local job-CLI start; stale private resource copies are removed and cleanup is retried. This is best effort. Power loss, disk failure, permanent loss of credentials/network access, SIGKILL without later recovery, or security software denying the cleanup executable can prevent cleanup. Finally steps must be idempotent and safe to repeat. Automatic recovery is capped at three attempts so persistent endpoint-security or executable-policy denial cannot create an endless launch loop. Uninstall refuses to remove local state while managed jobs are active; operators must inspect or cancel them first.

Job-scoped `temporary_files` should be used instead of loose helper scripts. They are materialized only below the private job runtime. Remote scripts should preferably be sent through a process stdin instead of written to the remote filesystem.

Runner diagnostic logs are owner-only and do not receive child stdout/stderr. Existing runner logs are tail-trimmed before launch; only an absent file is ignored, while permission, type, symbolic-link, read, truncate, or write failures block launch instead of allowing unbounded append. Step output is stored only in bounded job results according to the selected capture mode.

## OAuth and public endpoints

Remote mode uses authorization code flow with PKCE S256, exact redirect/resource/client binding, protected-resource and authorization-server discovery, bounded dynamic client registration, `offline_access`, expiring authorization codes, access tokens, and refresh tokens, hashed bearer-token storage, per-account version checks, and deployment-wide token-version revocation. Authorization codes and both token classes are bound to one client ID, account ID, account version, role, scope, and resource. Public-client refresh tokens are single-use: a successful refresh atomically stores a new access/refresh pair and removes the presented refresh token; replay and account/version invalidation return RFC 6749 `invalid_grant`. Successful consent constructs the registered callback through the URL API and returns `303 See Other`; response parameters are encoded rather than concatenated into an unchecked header string.

The authorization page displays the validated client name and redirect URI. Enter an account name and password only after initiating the connection and recognizing both values.

Password failures and pending, not-yet-authorized client registrations are limited by deployment-keyed HMAC source identity; successfully authorized DCR clients no longer consume that pending-registration quota, while the global client cap remains authoritative. Browser requests are same-origin unless an exact origin is listed in `MBM_ALLOWED_ORIGINS`; loopback OAuth redirect permission does not grant browser-origin access.

Public health and metadata do not expose live workspace or daemon status. The daemon handshake omits workspace path/name/hash and process ID.

## Relay and denial of service

Only one authenticated daemon is active. Candidates have a handshake deadline and cannot displace the current daemon before success. Authenticated sockets also carry a liveness deadline based on inbound traffic so half-open transports cannot remain the active daemon indefinitely. Pending calls are socket-bound, client-request-bound, concurrency-limited, size-limited, and timed out. Duplicate in-flight request IDs are rejected only within the same authenticated MCP session. Initialization returns a stateless HMAC-bound `MCP-Session-Id`; the signature binds the session nonce to the OAuth token identity, so one account can use multiple concurrent chat windows without sharing a cancellation or request-id namespace. Independent sessionless POST requests are not indexed by token and request id. A session id is an integrity/correlation token, not a second authorization credential.

Request bodies, WebSocket messages, tool outputs, traversals, sessions, stdin writes, OAuth records, clients, codes, access tokens, refresh tokens, and failure identities are bounded. Disconnect/replacement terminates active child process trees.

These controls reduce accidental exhaustion and simple abuse. They do not replace Cloudflare account MFA, WAF/rate limits, usage alerts, or cost controls for an internet-facing Worker.

## Process sessions

Process-session IDs are random and valid only inside one runtime. Output buffers and session counts are bounded. Sessions are killed on runtime stop or remote connection loss/replacement and expire from retained state after exit.

Sessions use pipes, not a PTY. Do not assume terminal-oriented programs will behave safely or correctly. Process output may contain secrets; it is returned to the authorized client but is not intentionally written to operational logs.

Process sessions are interactive and intentionally die with runtime disconnect/replacement. Managed jobs are separate detached processes with owner-only persistent state and best-effort finally/recovery semantics.

## Images and rich content

`view_image` accepts only signature-validated PNG, JPEG, GIF, and WebP under the size cap. SVG is intentionally excluded because it is active document content rather than a simple raster image. Image bytes pass through the Worker in remote mode and are visible to the authorized MCP client.

## Logs and privacy

Default operational logs record startup/deployment, relay, protocol, service, and infrastructure transitions. Every ordinary per-tool event—start, success, failure, cancellation, and duration—is debug-only. Tool arguments, command text, stdin, file/patch contents, and outputs are omitted. Messages and fields are bounded; unexpected daemon and Worker infrastructure exceptions are reduced to error classes. Static operator guidance uses sanitized plain output; raw plain output is reserved for explicitly requested credentials or local paths. Git author email is omitted from `git_log` unless explicitly requested.

No logging policy can prevent data from being returned to a client that explicitly invokes an enabled tool. The Worker necessarily relays remote tool arguments and results; this is not end-to-end encryption against the user's Cloudflare execution environment. Managed-job result files may contain remote command output and are owner-only local data, not operational logs.

## Hardening checklist

For sensitive review:

```sh
machine-mcp --workspace /narrow/project --profile review
```

For controlled editing without execution:

```sh
machine-mcp --workspace /narrow/project --profile edit
```

Also:

- patch the OS and use the repository-pinned Node.js 26/npm 12 baseline;
- enable MFA on Cloudflare, GitHub, and npm accounts;
- do not configure broad CORS origins;
- keep the state root completely separate from every workspace; never point `--state-dir` at a project directory or one of its ancestors;
- treat an unreadable or malformed live lock as an incident to inspect, not a file to delete blindly;
- select `agent`, `edit`, or `review` instead of the default `full` when broad authority is unnecessary;
- inspect client names and OAuth redirect URIs;
- rotate one account password after a targeted disclosure, or rotate deployment secrets after a bridge-wide incident;
- inspect `status`, `doctor`, and service status;
- register credential files as local resources instead of reading them into a model conversation;
- use `capture_output: "discard"` for credential-consuming steps and idempotent finally steps for cleanup;
- remove the Worker and state when remote access is no longer needed;
- use external OS isolation for untrusted code.

The full cross-cutting review and residual limitations are recorded in [docs/AUDIT.md](docs/AUDIT.md).

## Out of scope

The project cannot prevent an authorized client from requesting data accessible to enabled tools, make arbitrary local executables safe, identify all sensitive content, guarantee cleanup across every power/storage/security failure, override MCP-host or endpoint-security policy, or neutralize model prompt injection. Operator approval, local resource hygiene, idempotent cleanup, and narrow capability selection remain primary controls.
