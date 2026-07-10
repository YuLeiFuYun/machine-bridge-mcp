# machine-bridge-mcp

`machine-bridge-mcp` turns your machine into a Remote MCP server through a small hosted relay and a local outbound daemon.

The recommended deployment command is short and stable for autostart:

```zsh
npm install -g machine-bridge-mcp@latest && machine-mcp
```

No-global-install alternative:

```zsh
npx machine-bridge-mcp@latest
```

Source checkout:

```zsh
./mbm          # macOS/Linux
.\mbm.cmd      # Windows cmd
```

## What it does on first run

1. Asks for a workspace path. Press Enter to use the current directory.
2. Remembers that workspace for later runs.
3. Generates a stable MCP connection password and daemon secret.
4. Checks `wrangler whoami`; if needed, opens `wrangler login`.
5. Deploys the hosted Worker relay with `wrangler deploy --secrets-file`.
6. Installs login autostart for the local daemon and default local API.
7. Starts the local daemon and local OpenAI-compatible API.
8. Prints MCP connection details on first run, plus local API settings:

```text
MCP Server URL: https://<worker>.<account>.workers.dev/mcp
MCP connection password: mcp_password_...
API Base URL: http://127.0.0.1:8765/v1
API key: local_api_key_...
```

Keep the foreground process running for the current session. The installed autostart entry keeps the daemon and local API available after future logins.

The command is safe to run repeatedly:

```zsh
npm install -g machine-bridge-mcp@latest && machine-mcp
```

On repeat runs, the CLI reuses existing state and secrets unless you request rotation, skips Worker redeploys when the deployed Worker is healthy and Worker source/config/secrets are unchanged, refreshes the autostart entry, stops any currently loaded autostart daemon before starting the foreground daemon, and refuses to start a second daemon for the same workspace if another foreground instance is already running. Local-only package, CLI, logging, and local API changes do not by themselves force a Worker redeploy.

MCP connection details are printed on first run, after secret rotation, when the MCP URL changes, or when you explicitly pass `--print-mcp-credentials`. Routine runs print that MCP details are unchanged.

## Local OpenAI-compatible API

The project exposes two connected integration surfaces:

- **ChatGPT web / ChatGPT apps:** use the Remote MCP Server URL and MCP connection password printed by `machine-mcp`. In this mode, ChatGPT calls tools on your machine through the Worker + local daemon bridge.
- **Desktop clients such as Cherry Studio, Chatbox, or Continue:** use the optional local OpenAI-compatible `/v1` API. `POST /v1/chat/completions` is backed by MCP sampling: the local API asks the hosted Worker to send `sampling/createMessage` to the already-connected ChatGPT MCP client, then wraps the MCP sampling result as an OpenAI-compatible chat completion response.

No separate model API setup is required or used in this path; the local API never asks for a model base URL or model API key. Generation depends on the ChatGPT-side MCP client actually being connected and able to receive server-to-client sampling requests. If ChatGPT is not connected, has no open MCP stream for server-to-client messages, or did not advertise the MCP `sampling` capability, generation returns an explicit OpenAI-shaped error saying that the missing piece is the MCP client stream or sampling capability.

Start the normal daemon and local API:

```zsh
machine-mcp
```

Start only the local API from remembered state:

```zsh
machine-mcp api
```

Disable the default local API for a daemon run:

```zsh
machine-mcp --no-api
```

When the API is running, the CLI prints client settings like:

```text
API Base URL: http://127.0.0.1:8765/v1
API key: local_api_key_...
Client type: OpenAI-compatible
Model: chatgpt-mcp
Backend: ChatGPT MCP sampling via the connected ChatGPT app
```

Use the API Base URL, API key, and model in your desktop client. Separately, connect ChatGPT to the printed MCP Server URL/password so the Worker has an MCP client stream that can receive `sampling/createMessage`.

If port `8765` conflicts with another local app, choose a different port explicitly:

```zsh
machine-mcp --api-port 8766
machine-mcp api --api-port 8766
```

`--port` is also accepted on the `api` command:

```zsh
machine-mcp api --port 8766
```

By default, the local API binds to `127.0.0.1`, starts with `machine-mcp`, and stores a per-workspace local API key in the same owner-only state profile used by the MCP credentials. Explicit `--api-host`, `--api-port`, and `--api-model` values are persisted for the workspace so autostart uses the same API settings. `--api-model` only controls the local model id advertised by `GET /v1/models`; the actual model is chosen by the connected MCP client, and any different `model` value in a chat-completions request is passed as an MCP model preference hint.

Rotate the local desktop-client API key with:

```zsh
machine-mcp api --rotate-api-key
```

Environment variables supported for the current process: `MBM_API_HOST`, `MBM_API_PORT`, `MBM_API_KEY`, and `MBM_API_MODEL`. Environment overrides are not persisted to state; use `--api-host`, `--api-port`, `--api-key`, or `--api-model` when you want a setting saved for future runs and autostart.

Supported local API routes:

- `GET /health` without authentication
- `GET /v1/models` with `Authorization: Bearer <local_api_key>` or `x-api-key`
- `POST /v1/chat/completions`

`POST /v1/responses`, `POST /v1/completions`, and `POST /v1/embeddings` return `501 unsupported_endpoint`; MCP sampling is a chat-message path and does not expose embeddings or the full Responses API. Logs record route, status, latency, and safe configuration metadata; request and response bodies and API keys are not logged.

## Re-select workspace

```zsh
machine-mcp workspace set
```

Or provide it directly:

```zsh
machine-mcp workspace set /path/to/new/default
```

Show the remembered workspace:

```zsh
machine-mcp workspace show
```

## Autostart service

Supported platforms:

- macOS: user LaunchAgent
- Linux: `systemd --user` with best-effort `loginctl enable-linger`
- Windows: Scheduled Task at logon

Commands:

```zsh
machine-mcp service status
machine-mcp service install
machine-mcp service start
machine-mcp service stop
machine-mcp service uninstall
```

`start` installs autostart by default. Skip that behavior with:

```zsh
machine-mcp --no-autostart
```

Autostart runs the daemon with `--daemon-only --no-print-credentials`, so service logs do not contain the MCP connection password. If you start with `--no-write`, `--no-exec`, or `--full-env`, those policy flags are preserved in the autostart entry. macOS/Linux service definitions restart only on process failure; a normal duplicate-instance exit is not treated as a crash loop.

## Secrets rotation

```zsh
machine-mcp rotate-secrets
machine-mcp
```

`rotate-secrets` creates a new MCP connection password, daemon secret, and OAuth token version. The next deploy rejects previously issued OAuth access tokens.

## Uninstall

Delete known deployed Worker(s), remove autostart entries, and remove local state:

```zsh
machine-mcp uninstall
```

Non-interactive:

```zsh
machine-mcp uninstall --yes
```

Keep the deployed Worker but remove local state/autostart:

```zsh
machine-mcp uninstall --keep-worker
```

If installed globally, remove the npm package afterwards:

```zsh
npm uninstall -g machine-bridge-mcp
```

## Defaults and permissions

This project optimizes for easy use with official Remote MCP clients:

- `write_file` is enabled by default.
- `exec_command` is enabled by default.
- Absolute paths are allowed.
- Parent-directory paths such as `../other-project/file.ts` are allowed.
- Sensitive-looking files such as `.env`, private keys, token files, and dot-directories are not hidden by default.
- Relative paths use the selected workspace as cwd.
- Shell commands run with a minimal environment by default; use `--full-env` to pass the parent process environment.

Narrower session:

```zsh
machine-mcp --no-write --no-exec
```

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

## State and logs

Default state roots:

- macOS/Linux: `~/.local/state/machine-bridge-mcp`
- Linux with `XDG_STATE_HOME`: `$XDG_STATE_HOME/machine-bridge-mcp`
- Windows: `%APPDATA%\machine-bridge-mcp`

State contains the MCP password, daemon secret, and local API key. Status/doctor output redacts secrets. The normal foreground `start` command prints the MCP password only when a ChatGPT app is likely to need reconnection: first run, secret rotation, MCP URL changes, or `--print-mcp-credentials`. The local API base URL and API key print on normal foreground starts because desktop AI clients need them. Use `--no-print-credentials` to redact console credentials. State files, temporary Worker secret files, lock files, and log directories are created under the user state root with owner-only permissions where the platform supports POSIX modes.

The Worker rejects browser requests with an `Origin` header unless the origin is the Worker itself or a loopback HTTP origin. To allow additional browser-based MCP clients, set `MBM_ALLOWED_ORIGINS` to a comma-separated list of exact origins in `wrangler.jsonc` or Cloudflare Worker settings.

Override state root:

```zsh
machine-mcp --state-dir /path/to/state
```

## Architecture

```mermaid
flowchart LR
  C["ChatGPT / MCP client"] -- "HTTPS /mcp + OAuth" --> W["Hosted Worker relay"]
  C -- "GET SSE stream for server-to-client MCP" --> W
  W --> DO["Durable Object broker"]
  D["Local daemon"] -- "outbound WebSocket" --> W
  D --> M["Local filesystem and shell"]
  API["Local /v1/chat/completions"] -- "POST /api/mcp/sampling" --> W
  DO -- "sampling/createMessage" --> C
  CLI["machine-mcp CLI"] --> API
  CLI --> W
  CLI --> D
  CLI --> S["Autostart service"]
```

Why this architecture:

- No inbound local port is exposed to the internet.
- No local tunnel process is required.
- The public MCP URL is stable after deployment.
- The Worker stores OAuth client/code/token metadata and relays tool calls.
- The local daemon is the only process touching files or executing commands.
- The local `/v1` API binds to loopback by default, starts automatically with the daemon, and can be disabled with `--no-api`.
- Autostart keeps the daemon and local API alive across logins without requiring MCP clients to change URLs.

## Development

```zsh
npm install
npm run check
```

`npm run check` generates Worker runtime types, type-checks the Worker, checks local JS syntax, and runs daemon self-tests.

Worker build dry-run:

```zsh
npx wrangler deploy --dry-run
```
