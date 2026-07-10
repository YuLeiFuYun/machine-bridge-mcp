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

## Core trust model

Trusted components are:

1. the local OS user running the runtime;
2. the installed package/source checkout and its dependencies;
3. for remote mode, the user's Cloudflare account and deployed Worker;
4. an MCP client explicitly authorized through OAuth or launched locally through trusted stdio configuration.

An authorized client can invoke every tool exposed by the selected profile and receive its results.

The Worker is a remote authentication and relay boundary. The local runtime is the filesystem and process boundary. Stdio bypasses the Worker and relies on local process/configuration trust.

## Profiles are capability sets, not sandboxes

The default for newly selected workspaces is `full`, which prioritizes ease of use over least privilege.

- `full` exposes all tools, unrestricted direct filesystem paths, absolute path output, and the complete parent process environment.
- `agent` exposes file mutation, direct argv execution, and process sessions while keeping direct filesystem tools workspace-confined and the process environment isolated.
- `edit` exposes read and mutation tools without process execution.
- `review` exposes read-only workspace/Git/image tools.

`run_process` avoids shell parsing, which removes one injection class, but an executable such as `node`, `python`, a package manager, compiler, test runner, or repository script can execute arbitrary code. Direct mode therefore has effectively broad local-user authority once an attacker controls argv or executed code.

`exec_command` has both executable authority and shell expansion. Use `--no-exec` or `review`/`edit` when process execution is unnecessary.

For untrusted repositories or instructions, run the bridge inside a disposable VM/container or under a dedicated low-privilege OS account. On macOS and Windows, this external isolation is especially important. The project does not claim an in-process OS sandbox.

## Filesystem exposure

Direct filesystem scope is profile-dependent. The default `full` profile is unrestricted. The `agent`, `edit`, and `review` profiles confine direct filesystem tools to the canonical selected workspace, including symbolic-link resolution.

The default `full` profile returns absolute paths. Narrower profiles return workspace-relative paths to reduce username and directory-layout disclosure. Path display and access scope remain separate controls.

Sensitive-looking names are not blocked inside the workspace. Files such as `.env`, private keys, credentials, database dumps, and production configuration remain readable when they are in the selected workspace. Choose the narrowest practical workspace.

Processes are not confined by the filesystem-tool resolver. They can access paths, networks, processes, credential stores, and devices available to the local user.

## Mutation integrity

Writes are bounded, reject symbolic-link/non-regular destinations, use same-directory staging, and commit atomically per file. Create-only commit fails if a concurrent destination appears. Expected hashes and exact edits reduce accidental stale overwrites.

Patch operations prevalidate all paths/content, reject canonical collisions, recheck source hashes and destination absence, serialize bridge mutations, maintain backups, and roll back on ordinary commit errors.

These controls do not defend against a malicious process running under the same user racing filesystem metadata, nor do they make a multi-directory patch power-loss atomic.

## Credential exposure

Local state contains the MCP connection password and daemon secret. State, lock, temporary secret, runtime, and service-log files use owner-only permissions where supported. State writes are atomic. Logs recursively redact known credential fields and token formats and neutralize control characters.

First-run or explicit credential output can intentionally display the MCP password. Avoid shared terminal logs, shell recordings, screenshots, CI output, or support tickets. Use `--no-print-credentials` for recorded sessions.

The default `full` profile passes the complete parent environment. Narrower profiles replace HOME, temp, and common cache paths and do not pass arbitrary parent variables. The isolated mode reduces accidental environment-secret leakage; it does not prevent code from explicitly accessing known resources.

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

## Images and rich content

`view_image` accepts only signature-validated PNG, JPEG, GIF, and WebP under the size cap. SVG is intentionally excluded because it is active document content rather than a simple raster image. Image bytes pass through the Worker in remote mode and are visible to the authorized MCP client.

## Logs and privacy

Operational logs record coarse metadata and error classes, not tool arguments, command text, stdin, file/patch contents, or outputs. Unexpected Worker exceptions are reduced to error classes. Git author email is omitted from `git_log` unless explicitly requested.

No logging policy can prevent data from being returned to a client that explicitly invokes an enabled tool. The Worker necessarily relays remote tool arguments and results; this is not end-to-end encryption against the user's Cloudflare execution environment.

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

- patch the OS and use supported Node.js releases;
- enable MFA on Cloudflare, GitHub, and npm accounts;
- do not configure broad CORS origins;
- avoid `--full-env`, `--unrestricted-paths`, and `--absolute-paths` unless required;
- inspect client names and OAuth redirect URIs;
- rotate secrets after suspected disclosure;
- inspect `status`, `doctor`, and service status;
- remove the Worker and state when remote access is no longer needed;
- use external OS isolation for untrusted code.

## Out of scope

The project cannot prevent an authorized client from requesting data accessible to enabled tools, make arbitrary local executables safe, identify all sensitive content, or neutralize model prompt injection. Operator approval and narrow capability selection remain primary controls.
