# Security policy

## Supported versions

Security fixes are applied to the latest released version. Upgrade before reporting an issue that is already fixed on `main`.

## Reporting a vulnerability

Do not open a public issue for an undisclosed vulnerability. Use GitHub's private vulnerability reporting feature for this repository. Include:

- affected version and operating system;
- deployment mode and relevant policy flags;
- a minimal reproduction;
- expected and observed impact;
- whether credentials, filesystem data, or command execution were exposed.

Do not include live MCP passwords, daemon secrets, OAuth tokens, Cloudflare credentials, private keys, or unrelated local files. Rotate any credential used in a reproduction.

## Trust model

The following components are trusted:

1. The local user account running the daemon.
2. The installed package/source checkout.
3. The user's Cloudflare account and deployed Worker.
4. An MCP client that has completed OAuth authorization with the connection password.

The Worker is a relay and authorization boundary. The local daemon is the filesystem and command-execution boundary. A successfully authorized MCP client can invoke every tool enabled by the daemon policy and can receive the resulting file contents and command output.

This project does not provide a sandbox for shell commands. `exec_command` has the operating-system permissions of the local user. Workspace path confinement limits filesystem tools, but it cannot constrain commands executed by the shell. Use `--no-exec` when shell access is unnecessary.

## Primary risks and controls

### Credential disclosure

Local state contains the MCP password and daemon secret. State, lock, temporary secret, and service-log files use owner-only permissions where the platform supports them. State writes are atomic. Logs recursively and fully redact common credential fields and known token formats.

Terminal output can intentionally display the MCP password. Avoid recording first-run output in shared shell history, CI logs, screen recordings, or support tickets. Use `--no-print-credentials` for recorded sessions.

### Filesystem exposure

Filesystem tools are confined to the canonical selected workspace by default, including symbolic-link resolution. `--unrestricted-paths` exposes absolute and parent paths and should be used only for a deliberate, short-lived session.

Sensitive filenames are not automatically blocked inside the workspace. Select the narrowest practical workspace and use `--no-write` for review-only sessions.

### Command execution

`exec_command` is enabled by default but can be disabled with `--no-exec`. Commands run with a minimal environment unless `--full-env` is supplied. Minimal environment handling reduces accidental environment-secret disclosure; it does not sandbox filesystem, network, process, or credential-store access available to the user account.

### OAuth and public endpoints

OAuth uses authorization codes, PKCE S256, exact redirect/resource binding, hashed access-token storage, expiring codes/tokens, and a version value that revokes existing tokens after rotation. Client registration, codes, tokens, pending calls, body sizes, and failed password attempts are bounded.

The authorization page displays the validated client name and redirect URI. Do not enter the connection password unless you initiated the connection and recognize both values. Browser-originated requests are same-origin by default; exact additional origins require `MBM_ALLOWED_ORIGINS` and receive explicit CORS headers. Loopback redirect URIs do not grant browser-origin access.

Public health and metadata endpoints do not expose live daemon policy or connection status. The daemon handshake does not upload the local workspace name, path hash, or process ID. Authenticated `server_info` exposes only bounded operational metadata needed to diagnose the relay.

### Relay and denial of service

Only one daemon socket is active. New connections replace old ones. Pending calls are socket-bound and concurrency-limited. Request and output sizes are bounded. Dynamic registration is limited globally and per keyed-HMAC source identity; the source IP is not stored directly and inactive clients expire.

These controls reduce accidental exhaustion and simple abuse. The CLI uses the package-installed Wrangler binary and does not fall back to downloading an unpinned command through `npx`. They do not replace Cloudflare account protections, rate-limiting/WAF rules, or cost alerts for an internet-facing deployment.

## Hardening checklist

For a high-sensitivity workspace:

```zsh
machine-mcp --workspace /narrow/project --no-write --no-exec --no-print-credentials
```

Also:

- keep the local OS and Node.js supported and patched;
- enable MFA on the Cloudflare and GitHub accounts;
- do not set `MBM_ALLOWED_ORIGINS` broadly;
- avoid `--full-env` and `--unrestricted-paths`;
- rotate secrets after suspected disclosure;
- inspect `machine-mcp status` and `machine-mcp service status`;
- uninstall the Worker and local state when the bridge is no longer needed.

## Out of scope

The project cannot prevent an authorized MCP client from requesting sensitive data that the enabled tools can access. It also cannot make arbitrary shell commands safe. Model-level prompt injection and unsafe operator approval remain outside the transport's security guarantees; use narrow workspaces and restrictive policy flags as the primary controls.
