# machine-bridge-mcp

`machine-bridge-mcp` exposes a selected local workspace to MCP clients through one shared, policy-controlled runtime.

It supports two transports:

```text
Remote clients such as ChatGPT
        HTTPS + OAuth 2.1 / PKCE
                  |
       Cloudflare Worker + Durable Object
                  ^
                  | outbound authenticated WebSocket
                  |
             local runtime

Local clients such as Claude Desktop, Cursor, and Codex CLI
                  |
                 stdio
                  |
             local runtime
```

The remote Worker authenticates and relays calls. It cannot directly read local files or start local processes. File, Git, image, patch, and process operations execute in the local runtime.

## Security posture first

A new workspace starts with the `review` profile:

- read-only filesystem and Git tools;
- no file mutation;
- no process execution;
- workspace-confined filesystem access;
- relative paths in tool results;
- no parent shell environment inherited by commands.

Existing pre-0.4 workspace profiles keep their saved permissions during upgrade. Select a profile explicitly to change them.

| Profile | File edits | Direct argv processes | Shell commands | Intended use |
|---|---:|---:|---:|---|
| `review` | No | No | No | Inspection and review |
| `edit` | Yes | No | No | Controlled file changes |
| `agent` | Yes | Yes | No | Coding agents and test commands |
| `full` | Yes | Yes | Yes | Deliberate full local automation |

`run_process` and process sessions avoid command-shell parsing, but they are **not an operating-system sandbox**. An allowed executable can still access anything available to the local user. `exec_command` is more exposed because it additionally permits shell syntax and expansion. Use a container, VM, or dedicated low-privilege OS account for hostile repositories or untrusted instructions.

## Install

Node.js 22 or newer is required.

```sh
npm install -g machine-bridge-mcp@latest
```

From a source checkout:

```sh
npm install
./mbm                 # macOS/Linux
.\mbm.cmd             # Windows cmd
```

## Remote MCP for ChatGPT

Start the bridge from the project directory or select a workspace explicitly:

```sh
machine-mcp --workspace /path/to/project --profile review
```

On first remote start, the CLI:

1. canonicalizes and remembers the workspace;
2. creates independent credentials and state for that workspace;
3. signs in to Cloudflare Wrangler when needed;
4. deploys a per-workspace Worker;
5. installs a platform-native login service unless `--no-autostart` is used;
6. starts an outbound-only daemon connection;
7. prints the Remote MCP URL and connection password.

Use the printed values in the MCP client:

```text
MCP Server URL: https://<worker>.<account>.workers.dev/mcp
MCP connection password: mcp_password_...
```

The remote authorization flow uses an authorization code, PKCE S256, exact redirect/resource binding, expiring access tokens stored as hashes, and a token-version value for bulk revocation.

## Local stdio MCP for Claude, Cursor, Codex, and compatible clients

Generate ready-to-paste configuration:

```sh
machine-mcp client-config --client all --workspace /path/to/project --profile agent
```

Or run stdio directly:

```sh
machine-mcp stdio --workspace /path/to/project --profile agent
```

The stdio server writes only JSON-RPC messages to stdout. Operational logs go to stderr. It supports MCP initialization/version negotiation, tool discovery, calls, cancellation, structured tool output, native image content, and process sessions.

See [docs/CLIENTS.md](docs/CLIENTS.md) for client-specific configuration and remote/local trade-offs.

## Policy controls

Profiles can be narrowed with explicit flags:

```text
--profile review|edit|agent|full
--exec-mode off|direct|shell
--no-write
--no-exec
--full-env
--unrestricted-paths
--absolute-paths
```

Important distinctions:

- `--unrestricted-paths` expands direct filesystem tools beyond the selected workspace.
- `--absolute-paths` changes returned path metadata; it does not grant additional access.
- `--full-env` passes the complete parent environment to processes. Without it, commands receive an isolated HOME, temp directory, and cache directories plus a small set of platform variables.
- Files with sensitive-looking names are not automatically blocked inside the workspace. A workspace `.env` remains readable when read tools are enabled.

## Tools

The exact `tools/list` response reflects the active local policy. Definitions come from one shared catalog used by both Worker and stdio transports.

### Workspace and content

- `server_info`
- `project_overview`
- `list_roots`
- `list_dir`
- `list_files`
- `read_file` — whole UTF-8 files or bounded line ranges
- `view_image` — bounded PNG, JPEG, GIF, or WebP as native MCP image content
- `search_text`

### Mutation

- `write_file` — atomic whole-file write with create-only and SHA-256 checks
- `edit_file` — exact text replacement with ambiguity rejection
- `apply_patch` — bounded multi-file add/update/move/delete transaction with rollback

### Git

- `git_status`
- `git_diff` — working tree or staged
- `git_log` — structured commits; author email omitted unless explicitly requested
- `git_show`

Repository-configured external diff, text conversion, and filesystem-monitor helpers are disabled for bridge Git inspection.

### Processes

- `run_process` — one-shot argv execution without a shell
- `start_process`
- `read_process`
- `write_process`
- `kill_process`
- `exec_command` — shell execution, available only in `shell` mode

Process sessions retain bounded stdout/stderr, support offsets and short waits, accept stdin, and are killed when the daemon connection is lost or replaced. They are pipe-based and do not emulate a terminal/PTY.

## Path and write behavior

By default, existing paths are resolved with `realpath` and must remain inside the canonical workspace. New write paths validate the nearest existing ancestor, preventing missing-path writes through escaping symbolic-link directories.

Writes use same-directory temporary files and atomic commit. Create-only writes use an atomic hard-link commit so a concurrent file cannot be silently overwritten. Patch operations are prevalidated, serialized, staged, rechecked, committed with backups, and rolled back on failure.

Returned paths are workspace-relative by default. This reduces unnecessary disclosure of usernames and local directory layouts. Enable `--absolute-paths` only when a client genuinely needs absolute paths.

## Commands

```text
machine-mcp [start options]
machine-mcp stdio [options]
machine-mcp client-config [all|claude|cursor|codex|generic]
machine-mcp workspace show|set|reset
machine-mcp service status|install|start|stop|uninstall
machine-mcp status
machine-mcp doctor
machine-mcp rotate-secrets
machine-mcp uninstall [--keep-worker] [--yes]
```

Each canonical workspace has an independent profile, Worker name, credential set, state file, startup lock, and daemon lock.

## Autostart

Remote mode supports:

- macOS user LaunchAgent;
- Linux `systemd --user`, with best-effort lingering;
- Windows Scheduled Task at logon.

The service definition contains neither credentials nor a duplicate policy. It loads the selected policy from owner-only local state and fails closed to the `review` profile if policy state is absent. Service logs are owner-only where supported and trimmed before daemon startup.

## Secret rotation

```sh
machine-mcp rotate-secrets --no-print-credentials
machine-mcp
```

Rotation stops the installed service, refuses to proceed while another foreground daemon owns the workspace lock, rotates the MCP password, daemon secret, and OAuth token version, and requires redeployment. Previously issued access tokens then fail validation.

## State and observability

Default state roots:

- macOS/Linux: `~/.local/state/machine-bridge-mcp`
- Linux with `XDG_STATE_HOME`: `$XDG_STATE_HOME/machine-bridge-mcp`
- Windows: `%APPDATA%\machine-bridge-mcp`

State/config writes use owner-only temporary files, flushes, and atomic rename. Malformed state is retained as a bounded corrupt backup before reconstruction. Uninstall validates markers, canonical paths, active locks, workspace/source exclusions, and known contents before recursive deletion.

Operational logs record bounded metadata such as component, tool name, shortened call ID, duration, outcome, and error class. They do not intentionally log file contents, patch bodies, command strings, stdin, OAuth passwords, access tokens, or daemon secrets. See [docs/OPERATIONS.md](docs/OPERATIONS.md).

## Development and verification

```sh
npm ci
npm run check
npm run worker:dry-run
npm audit --omit=dev --audit-level=high
npm pack --dry-run
```

`npm run check` covers generated Worker types, TypeScript, JavaScript syntax, the shared tool catalog, local path/write/process/state/log/service invariants, a live stdio MCP flow, and a live local OAuth/Worker/WebSocket/MCP flow. A ready-to-enable GitHub Actions template is included at `docs/examples/github-actions-ci.yml` for Linux, macOS, and Windows with supported Node versions. Activating it requires a GitHub credential authorized to modify workflow files.

See [docs/TESTING.md](docs/TESTING.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), and [SECURITY.md](SECURITY.md).

## Uninstall

```sh
machine-mcp uninstall
npm uninstall -g machine-bridge-mcp
```

Use `--keep-worker` to retain deployed Workers while removing local state and autostart.

## License

MIT
