# Security policy

## Supported versions

Security fixes are applied to the latest released version. Upgrade before reporting an issue already fixed on `main`.

## Reporting a vulnerability

Do not open a public issue for an undisclosed vulnerability. Use GitHub private vulnerability reporting for this repository. Include:

- affected version and operating system;
- remote or stdio transport;
- selected profile and relevant flags;
- minimal reproduction;
- expected and observed impact;
- whether credentials, filesystem data, process authority, or network access were exposed.

Do not include live MCP passwords, daemon secrets, OAuth tokens, Cloudflare credentials, private keys, or unrelated local files. Rotate credentials used in a reproduction.

## Repository and documentation privacy

Tests, examples, documentation, release notes, and package metadata are publication surfaces. Use only synthetic hostnames, resource aliases, usernames, paths, and project names. Run `npm run privacy:check` before committing or publishing, and maintain private local identifiers in the ignored `.privacy-denylist`; the scanner never prints matched values. See [Repository privacy hygiene](docs/PRIVACY.md).

Removing a value from the current branch does not remove it from Git history, caches, forks, or an already published npm package. Rotate any exposed credential immediately and coordinate destructive history rewriting separately when its risk is justified.

## Core trust model

Trusted components are:

1. the local OS user running the runtime;
2. the installed package/source checkout and its dependencies;
3. for remote mode, the user's Cloudflare account and deployed Worker;
4. an MCP client explicitly authorized through OAuth or launched locally through trusted stdio configuration.

An authorized client can invoke every tool exposed by the selected profile and receive its results.

The Worker is a remote authentication and relay boundary. The local runtime is the filesystem and process boundary. Stdio bypasses the Worker and relies on local process/configuration trust.

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

Repository and user instruction files are untrusted content from the model's perspective. `agent_context` returns their text in deterministic precedence order but does not certify correctness or safety. A malicious `AGENTS.md`, custom instruction file, or `SKILL.md` can attempt prompt injection or recommend destructive operations. Use only trusted repositories and skill roots, or isolate the bridge externally.

Skill loading is non-executing. `load_local_skill` returns an entrypoint and bounded file inventory; scripts remain inert until a separate process or command tool is called. Symlinked skill directories are followed only after canonical path-policy validation, while symbolic-link `SKILL.md` entrypoints are rejected. Traversal, cycles, content, summaries, and inventory are bounded.

Registered commands are available only under direct-execution-capable policy. They use argv spawning rather than shell parsing, reject undeclared caller arguments, and enforce the manifest timeout as a ceiling. They are not an approval or sandbox boundary: a repository-controlled package script, interpreter, compiler, or executable can still run arbitrary code with local-user authority. Deeper manifests can override or remove inherited commands, so callers must obtain context for the actual target path rather than assuming the repository-root registry applies everywhere.

The remote MCP host remains an independent boundary. Machine Bridge can advertise these tools and instruct the model to bootstrap with `agent_context`, but it cannot force a host to expose or invoke them, and it cannot bypass host confirmation or refusal.

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

Writes are bounded, reject symbolic-link/non-regular destinations, use same-directory staging, and commit atomically per file. Create-only commit fails if a concurrent destination appears. Expected hashes and exact edits reduce accidental stale overwrites.

Patch operations prevalidate all paths/content, reject canonical collisions, recheck source hashes and destination absence, serialize bridge mutations, maintain backups, and roll back on ordinary commit errors. On platforms without descriptor-relative path traversal, a malicious process running as the same local account can still race filesystem or parent-directory replacement between validation and commit. These controls do not claim protection against a hostile same-user namespace, nor do they make a multi-directory patch power-loss atomic.

## Credential exposure

Local state contains the MCP connection password and daemon secret. State, lock, temporary secret, runtime, and service-log files use owner-only permissions where supported. State writes are atomic. Logs recursively redact known credential fields and token formats and neutralize control characters.

First-run or explicit reconnect output can intentionally display the MCP connection password. JSON output and standalone secret rotation redact credentials by default; printing requires the explicit reconnect flag. The daemon secret is never printed in full. Avoid shared terminal logs, shell recordings, screenshots, CI output, or support tickets.

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

`finally_steps` run after ordinary success, failure, timeout, and cancellation. Cancellation uses an owner-only marker rather than signaling the runner process itself, so the coordinator remains alive to execute cleanup consistently across platforms. A dead runner is detected on the next daemon or local job-CLI start; stale private resource copies are removed and cleanup is retried. This is best effort. Power loss, disk failure, permanent loss of credentials/network access, SIGKILL without later recovery, or security software denying the cleanup executable can prevent cleanup. Finally steps must be idempotent and safe to repeat. Automatic recovery is capped at three attempts so persistent endpoint-security or executable-policy denial cannot create an endless launch loop. Uninstall refuses to remove local state while managed jobs are active; operators must inspect or cancel them first.

Job-scoped `temporary_files` should be used instead of loose helper scripts. They are materialized only below the private job runtime. Remote scripts should preferably be sent through a process stdin instead of written to the remote filesystem.

Runner diagnostic logs are owner-only and do not receive child stdout/stderr. Step output is stored only in bounded job results according to the selected capture mode.

## OAuth and public endpoints

Remote mode uses authorization code flow with PKCE S256, exact redirect/resource/client binding, expiring authorization codes and access tokens, hashed token storage, token-version revocation, and bounded dynamic client registration.

The authorization page displays the validated client name and redirect URI. Enter the connection password only after initiating the connection and recognizing both values.

Password failures and registrations are limited by deployment-keyed HMAC source identity. Browser requests are same-origin unless an exact origin is listed in `MBM_ALLOWED_ORIGINS`; loopback OAuth redirect permission does not grant browser-origin access.

Public health and metadata do not expose live workspace or daemon status. The daemon handshake omits workspace path/name/hash and process ID.

## Relay and denial of service

Only one authenticated daemon is active. Candidates have a handshake deadline and cannot displace the current daemon before success. Pending calls are socket-bound, client-request-bound, concurrency-limited, size-limited, and timed out. Duplicate in-flight request IDs for one access token are rejected.

Request bodies, WebSocket messages, tool outputs, traversals, sessions, stdin writes, OAuth records, clients, codes, tokens, and failure identities are bounded. Disconnect/replacement terminates active child process trees.

These controls reduce accidental exhaustion and simple abuse. They do not replace Cloudflare account MFA, WAF/rate limits, usage alerts, or cost controls for an internet-facing Worker.

## Process sessions

Process-session IDs are random and valid only inside one runtime. Output buffers and session counts are bounded. Sessions are killed on runtime stop or remote connection loss/replacement and expire from retained state after exit.

Sessions use pipes, not a PTY. Do not assume terminal-oriented programs will behave safely or correctly. Process output may contain secrets; it is returned to the authorized client but is not intentionally written to operational logs.

Process sessions are interactive and intentionally die with runtime disconnect/replacement. Managed jobs are separate detached processes with owner-only persistent state and best-effort finally/recovery semantics.

## Images and rich content

`view_image` accepts only signature-validated PNG, JPEG, GIF, and WebP under the size cap. SVG is intentionally excluded because it is active document content rather than a simple raster image. Image bytes pass through the Worker in remote mode and are visible to the authorized MCP client.

## Logs and privacy

Default operational logs record startup/deployment, relay, protocol, service, and infrastructure transitions. Every ordinary per-tool event—start, success, failure, cancellation, and duration—is debug-only. Tool arguments, command text, stdin, file/patch contents, and outputs are omitted. Messages and fields are bounded; unexpected daemon and Worker infrastructure exceptions are reduced to error classes. Git author email is omitted from `git_log` unless explicitly requested.

No logging policy can prevent data from being returned to a client that explicitly invokes an enabled tool. The Worker necessarily relays remote tool arguments and results; this is not end-to-end encryption against the user's Cloudflare execution environment. Managed-job result files may contain remote command output and are owner-only local data, not operational logs.

## Hardening checklist

For sensitive review:

```sh
machine-mcp --workspace /narrow/project --profile review --no-print-credentials
```

For controlled editing without execution:

```sh
machine-mcp --workspace /narrow/project --profile edit --no-print-credentials
```

Also:

- patch the OS and use the repository-pinned Node.js 26/npm 12 baseline;
- enable MFA on Cloudflare, GitHub, and npm accounts;
- do not configure broad CORS origins;
- select `agent`, `edit`, or `review` instead of the default `full` when broad authority is unnecessary;
- inspect client names and OAuth redirect URIs;
- rotate secrets after suspected disclosure;
- inspect `status`, `doctor`, and service status;
- register credential files as local resources instead of reading them into a model conversation;
- use `capture_output: "discard"` for credential-consuming steps and idempotent finally steps for cleanup;
- remove the Worker and state when remote access is no longer needed;
- use external OS isolation for untrusted code.

## Out of scope

The project cannot prevent an authorized client from requesting data accessible to enabled tools, make arbitrary local executables safe, identify all sensitive content, guarantee cleanup across every power/storage/security failure, override MCP-host or endpoint-security policy, or neutralize model prompt injection. Operator approval, local resource hygiene, idempotent cleanup, and narrow capability selection remain primary controls.
