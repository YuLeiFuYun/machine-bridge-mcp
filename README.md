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

## Default behavior and policy profiles

A newly selected workspace starts with the maximum-permission `full` profile for low-friction operation:

- all read, write, edit, patch, image, Git, direct-process, process-session, and shell tools are available;
- direct filesystem tools may use paths outside the selected workspace;
- tool results may return absolute paths;
- child processes inherit the complete parent environment.

Policy state records whether it came from the default, an explicit named profile, or custom overrides. Version 0.5 migrates the exact pre-0.4 implicit-default shape to `full` once; explicit restrictive profiles and identified custom policies remain unchanged.

| Profile | File edits | Direct argv processes | Shell commands | Filesystem scope | Process environment |
|---|---:|---:|---:|---|---|
| `full` | Yes | Yes | Yes | Unrestricted | Full parent environment |
| `agent` | Yes | Yes | No | Selected workspace | Isolated environment |
| `edit` | Yes | No | No | Selected workspace | Isolated environment |
| `review` | No | No | No | Selected workspace | Isolated environment |

This default prioritizes usability, not least privilege. `run_process` and process sessions avoid command-shell parsing, but they are **not an operating-system sandbox**. `exec_command` additionally permits shell syntax and expansion. Use `--profile review`, `edit`, or `agent`, or use a container, VM, or dedicated low-privilege OS account when the client, repository, or instructions are not fully trusted.

## Install

Node.js 22 or newer is required.

```sh
npm install -g --allow-scripts=esbuild,workerd,sharp machine-bridge-mcp@latest
```

Recent npm releases may otherwise warn that Wrangler's native dependencies (`esbuild`, `workerd`, and `sharp`) have install scripts awaiting approval. The scoped command above approves only those packages for this installation; it does not change the user's global npm policy. A plain install can still work when compatible prebuilt artifacts are already available, but `machine-mcp doctor` is the authoritative runtime check.

From a source checkout, the checked-in exact-version `allowScripts` policy approves the reviewed native dependencies:

```sh
npm install
./mbm                 # macOS/Linux
.\mbm.cmd             # Windows cmd
```

## Remote MCP for ChatGPT

Start the bridge from the project directory or select a workspace explicitly:

```sh
machine-mcp --workspace /path/to/project
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

## Optional local stdio MCP

stdio is a local transport, not a model provider. Claude Desktop, Cursor, Codex CLI, ChatGPT Desktop, or another MCP host supplies its own model/session and launches `machine-bridge-mcp` as a subprocess. The MCP server only exposes tools and returns their results; it does not borrow the model running in ChatGPT web.

Many coding clients already have strong native filesystem and terminal tools, so configuring this stdio server is optional. It is useful when you want the same Machine Bridge tool schemas, patch behavior, process sessions, policy profiles, and logs across several clients, or when you want local access without deploying Cloudflare. If the client's built-in tools already meet your needs, there is no reason to add this server.

Generate ready-to-paste configuration:

```sh
machine-mcp client-config --client all --workspace /path/to/project
```

Or run stdio directly:

```sh
machine-mcp stdio --workspace /path/to/project
```

The stdio server writes only JSON-RPC messages to stdout and operational logs to stderr. See [docs/CLIENTS.md](docs/CLIENTS.md) for the host/model distinction and transport trade-offs.

## Policy controls

The default is `full`. Narrow or customize it with explicit flags:

```text
--profile full|agent|edit|review
--exec-mode off|direct|shell
--no-write
--no-exec
--full-env
--unrestricted-paths
--absolute-paths
--log-level error|warn|info|debug
--verbose
--quiet
```

Important distinctions:

- The default `full` profile already enables unrestricted paths, absolute path output, and the complete parent environment.
- `--unrestricted-paths=false`, `--absolute-paths=false`, and `--full-env=false` can narrow those individual settings.
- `--absolute-paths` changes returned path metadata; it does not independently grant additional access.
- In isolated-environment profiles, commands receive private HOME, temp, and cache directories plus a small set of platform variables.
- The server has no filename blacklist. Under `full`, direct read tools may read any UTF-8 regular file that the local OS user can access, including files outside the workspace and names such as `.env`, `passwords.txt`, or private-key files.
- Maximum local policy does not override operating-system permissions, macOS TCC/SIP, Windows ACLs, container boundaries, or independent safety rules imposed by the MCP host/platform. A host-generated “sensitive file” denial is outside this server's enforcement layer.

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

When workspace confinement is enabled (`agent`, `edit`, `review`, or an explicit override), existing paths are resolved with `realpath` and must remain inside the canonical workspace. New write paths validate the nearest existing ancestor, preventing missing-path writes through escaping symbolic-link directories. The default `full` profile permits direct filesystem paths outside the workspace.

Writes use same-directory temporary files and atomic commit. Create-only writes use an atomic hard-link commit so a concurrent file cannot be silently overwritten. Patch operations are prevalidated, serialized, staged, rechecked, committed with backups, and rolled back on failure.

The default `full` profile returns absolute paths. The `agent`, `edit`, and `review` profiles return workspace-relative paths to reduce unnecessary disclosure of usernames and local directory layouts.

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
machine-mcp --print-mcp-credentials
machine-mcp uninstall [--keep-worker] [--yes]
```

Each canonical workspace has an independent profile, Worker name, credential set, state file, startup lock, and daemon lock.

## Autostart

Remote mode supports:

- macOS user LaunchAgent;
- Linux `systemd --user`, with best-effort lingering;
- Windows Scheduled Task at logon.

The service definition contains neither credentials nor a duplicate policy. It loads the selected policy from owner-only local state and uses the documented `full` default if policy state is absent. Background services run at log level `warn`: failures and connection problems are retained, while routine successful tool calls are omitted. Logs are owner-only where supported and bounded by tail trimming.

## Secret rotation

```sh
machine-mcp rotate-secrets
machine-mcp --print-mcp-credentials
```

Rotation stops the installed service, refuses to proceed while another foreground daemon owns the workspace lock, rotates the MCP password, daemon secret, and OAuth token version, and requires redeployment. Rotated values are redacted by default; only the client connection password can be printed through the explicit reconnect flag. Previously issued access tokens then fail validation.

## State and observability

Default state roots:

- macOS/Linux: `~/.local/state/machine-bridge-mcp`
- Linux with `XDG_STATE_HOME`: `$XDG_STATE_HOME/machine-bridge-mcp`
- Windows: `%APPDATA%\machine-bridge-mcp`

State/config writes use owner-only temporary files, flushes, and atomic rename. Malformed state is retained as a bounded corrupt backup before reconstruction. Uninstall validates markers, canonical paths, active locks, workspace/source exclusions, and known contents before recursive deletion.

Default foreground logs show startup/deployment transitions, relay connectivity, warnings/errors, and successful calls that exceed 30 seconds. Routine successful tool calls and correlation IDs appear only at `--log-level debug` or `--verbose`. Background services use `warn`. Log messages and structured fields are bounded, secret-like keys and known token formats are redacted, and tool arguments/results are not written. See [docs/LOGGING.md](docs/LOGGING.md) and [docs/OPERATIONS.md](docs/OPERATIONS.md).

## Development and verification

```sh
npm ci
npm run check
npm run worker:dry-run
npm audit --audit-level=high
npm audit --omit=dev --audit-level=high
npm pack --dry-run
```

`npm run check` covers generated Worker types, TypeScript, JavaScript syntax, the shared tool catalog, local path/write/process/state/log/service invariants, a live stdio MCP flow, and a live local OAuth/Worker/WebSocket/MCP flow. GitHub Actions runs the suite on Linux, macOS, and Windows with supported Node versions.

See [docs/TESTING.md](docs/TESTING.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), and [SECURITY.md](SECURITY.md).

## Uninstall

```sh
machine-mcp uninstall
npm uninstall -g machine-bridge-mcp
```

Use `--keep-worker` to retain deployed Workers while removing local state and autostart.

## License

MIT
