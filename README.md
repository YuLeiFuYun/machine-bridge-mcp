# machine-bridge-mcp

`machine-bridge-mcp` exposes a selected local workspace to Remote MCP clients through a Cloudflare Worker relay and an outbound-only local daemon.

```text
Remote MCP client -> HTTPS/OAuth -> Cloudflare Worker + Durable Object
                                      ^
                                      | outbound WebSocket
                                      |
                               local daemon -> workspace/files/shell
```

No inbound port is opened on the local machine. The Worker does not read local files or execute commands; it authenticates MCP clients and relays bounded tool calls to the daemon.

## Install and start

Recommended global installation:

```zsh
npm install -g machine-bridge-mcp@latest
machine-mcp
```

Without a global installation:

```zsh
npx machine-bridge-mcp@latest
```

From a source checkout:

```zsh
npm install
./mbm          # macOS/Linux
.\mbm.cmd      # Windows cmd
```

On first run, the CLI:

1. Selects and remembers a workspace.
2. Generates an MCP connection password, daemon secret, and OAuth token version.
3. Authenticates Wrangler if required.
4. Deploys a per-workspace Worker.
5. Installs a login autostart entry unless `--no-autostart` is used.
6. Starts the outbound local daemon.
7. Prints the Remote MCP URL and connection password.

Keep the foreground process running for the current session. The installed service handles later logins.

## Connect an MCP client

Use the values printed by `machine-mcp`:

```text
MCP Server URL: https://<worker>.<account>.workers.dev/mcp
MCP connection password: mcp_password_...
```

The password is shown on first setup, after secret rotation, when the MCP URL changes, or with `--print-mcp-credentials`. Use `--no-print-credentials` to redact it in terminal output.

The former experimental local OpenAI-compatible `/v1` API has been removed. Use the Remote MCP endpoint directly.

## Security defaults

Version 0.3.0 changes the default filesystem boundary:

- Relative paths are resolved from the selected workspace.
- Reads, writes, directory traversal, searches, and Git operations are confined to that workspace by default.
- Symbolic links cannot be used to escape the workspace boundary.
- `write_file` and `exec_command` remain enabled by default.
- Shell commands receive a minimal environment by default.
- `write_file` is limited to 5 MiB, writes atomically, and refuses to overwrite symbolic links.
- Files that look sensitive, including `.env` and key files, are readable when they are inside the selected workspace. The bridge does not infer sensitivity from filenames.

A narrower session:

```zsh
machine-mcp --no-write --no-exec
```

Explicitly permit filesystem paths outside the workspace:

```zsh
machine-mcp --unrestricted-paths
```

Pass the complete parent process environment to shell commands only when required:

```zsh
machine-mcp --full-env
```

`--unrestricted-paths` and `--full-env` materially increase the data-exposure boundary. See [SECURITY.md](SECURITY.md) before enabling them.

## Commands

```text
machine-mcp [start options]
machine-mcp workspace show
machine-mcp workspace set [PATH]
machine-mcp service status|install|start|stop|uninstall
machine-mcp status
machine-mcp doctor
machine-mcp rotate-secrets
machine-mcp uninstall [--keep-worker] [--yes]
```

Important start options:

```text
--workspace PATH
--worker-name NAME
--force-worker
--rotate-secrets
--daemon-only
--no-autostart
--no-print-credentials
--print-mcp-credentials
--no-write
--no-exec
--full-env
--unrestricted-paths
--state-dir DIR
--json
```

Unknown, duplicate, malformed, and command-inapplicable options are rejected. Boolean options do not consume a following positional workspace path; use `--option=false` when an explicit false value is needed.

## Workspace selection

```zsh
machine-mcp workspace set
machine-mcp workspace set /path/to/project
machine-mcp workspace show
machine-mcp workspace reset
```

Each canonical workspace path receives an independent profile, Worker name, secret set, and daemon lock.

## Autostart

Supported providers:

- macOS: user LaunchAgent
- Linux: `systemd --user`, with best-effort user lingering
- Windows: Scheduled Task at logon

```zsh
machine-mcp service status
machine-mcp service install
machine-mcp service start
machine-mcp service stop
machine-mcp service uninstall
```

Autostart runs `--daemon-only --no-print-credentials --quiet`. The selected write, execution, environment, and path-boundary policies are persisted in the service definition. Service log files are owner-only where supported and are trimmed at daemon startup to prevent unbounded growth.

## Secret rotation

```zsh
machine-mcp rotate-secrets
machine-mcp
```

The first command stops the installed autostart service, refuses to proceed if another foreground daemon remains active, and then rotates the MCP password, daemon secret, and OAuth token version in local state. The second redeploys the Worker; previously issued OAuth access tokens then fail validation.

## MCP tools

- `server_info`
- `project_overview`
- `list_roots`
- `list_dir`
- `list_files`
- `read_file`
- `write_file`
- `search_text`
- `git_status`
- `git_diff`
- `exec_command`

Tool availability reflects daemon policy after the daemon handshake. `git_status` and `git_diff` detect the repository containing the requested path, including nested repositories.

## State and logs

Default state roots:

- macOS/Linux: `~/.local/state/machine-bridge-mcp`
- Linux with `XDG_STATE_HOME`: `$XDG_STATE_HOME/machine-bridge-mcp`
- Windows: `%APPDATA%\machine-bridge-mcp`

Override the root with `--state-dir DIR`. A new custom root must be empty; a non-empty unmarked root must contain recognizable legacy Machine Bridge state before it is adopted. Legacy text markers are migrated to the current structured marker. Uninstall refuses to recursively delete filesystem roots, the home directory, the current/package directory, source trees, recorded workspaces, unrelated files, or an unrecognized state root.

State contains credentials and therefore uses owner-only permissions where supported. State/config writes use temporary files, `fsync`, and atomic rename. Corrupt state files are retained as bounded `.corrupt-*` backups rather than silently overwritten. Status and doctor output redact secrets and personal Wrangler output; structured logs fully redact credential-like fields and neutralize control characters.

Temporary Wrangler secret files are created under the owner-only profile directory and removed in a `finally` block. Stale files older than one hour are cleaned before deployment.

## Worker protections

The Worker currently enforces:

- OAuth authorization code flow with PKCE S256.
- Hashed access-token storage and token-version revocation.
- Exact resource, client, and redirect URI binding.
- Bounded registration metadata, clients, authorization codes, tokens, and failed-login records.
- Per-source dynamic-client registration limits and password-failure throttling.
- A consent page that displays the validated client and redirect URI.
- Request-body and concurrent daemon-call limits.
- Same-origin browser access by default, exact configured-origin CORS/preflight support, and rejection of unlisted cross-origin requests.
- `no-store`, content-type protection, CSP, frame denial, and referrer suppression on authorization responses.
- Minimal public health output; live daemon/workspace details require an authenticated MCP call.

Browser requests are same-origin by default. Additional browser origins can be listed exactly in `MBM_ALLOWED_ORIGINS`; the Worker then returns matching CORS preflight and response headers. Loopback OAuth redirect URIs do not implicitly authorize loopback browser origins. Do not use wildcards or `null`.

## Uninstall

Delete known Workers, autostart entries, and local state:

```zsh
machine-mcp uninstall
```

Non-interactive:

```zsh
machine-mcp uninstall --yes
```

Keep deployed Workers while removing local state and autostart:

```zsh
machine-mcp uninstall --keep-worker
```

Remove a global npm installation separately:

```zsh
npm uninstall -g machine-bridge-mcp
```

## Architecture and failure behavior

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for trust boundaries, request lifecycles, limits, reconnect behavior, and the rationale for the Worker/Durable Object/daemon split.

Operationally:

- A newer daemon connection replaces the older socket. The relay handshake does not upload the local workspace name, path hash, or process ID.
- Pending calls are bound to the socket that received them, so a stale socket cannot complete or cancel calls on the replacement connection; active child processes are terminated when that connection is lost or replaced.
- The daemon reconnects after transient Worker/network failures using bounded exponential backoff with jitter, and terminates active child processes when the active relay socket closes.
- Tool calls and Wrangler subprocesses have bounded execution time and output; timed-out commands terminate their process tree where the platform permits.
- Separate per-workspace startup and daemon locks prevent overlapping deploy/rotation operations and duplicate local daemons.
- Uninstall stops and removes autostart first, refuses to proceed while an active startup or daemon process owns a lock, and preserves local state when Worker deletion fails so the operation can be retried.
- Worker health checks verify the expected package/Worker version before a deployment hash is accepted.

## Development

```zsh
npm ci
npm run check
npm run worker:dry-run
npm audit --omit=dev --audit-level=high
```

`npm run check` generates Worker types, type-checks the Worker, checks all local JavaScript entry points, and runs regression tests for path confinement, symbolic-link escapes, atomic writes, UTF-8 handling, nested Git repositories, minimal environments, daemon locking, CLI parsing, state recovery/removal guards, log redaction, log trimming, Worker hardening guards, and a live local OAuth/MCP flow through Wrangler.

The release checks are validated on Node.js 22 and 24. Node.js 22 or newer is required by the current Wrangler toolchain. See [CHANGELOG.md](CHANGELOG.md) for release notes.
