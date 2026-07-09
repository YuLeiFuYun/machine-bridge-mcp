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
6. Installs login autostart for the local daemon and default local API proxy.
7. Starts the local daemon and local OpenAI-compatible API provider.
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

On repeat runs, the CLI reuses existing state and secrets unless you request rotation, skips Worker redeploys when the deployed Worker is healthy and Worker source/config/secrets are unchanged, refreshes the autostart entry, stops any currently loaded autostart daemon before starting the foreground daemon, and refuses to start a second daemon for the same workspace if another foreground instance is already running. Local-only package, CLI, logging, and API-provider changes do not by themselves force a Worker redeploy.

MCP connection details are printed on first run, after secret rotation, when the MCP URL changes, or when you explicitly pass `--print-mcp-credentials`. Routine runs print that MCP details are unchanged.

## Local OpenAI-compatible API proxy

The project has two separate integration surfaces:

- **ChatGPT web / ChatGPT apps:** use the Remote MCP Server URL and MCP connection password printed by `machine-mcp`. In this mode, ChatGPT calls tools on your machine through the Worker + local daemon bridge.
- **Desktop clients such as Cherry Studio, Chatbox, or Continue:** may use the optional local OpenAI-compatible `/v1` proxy. This proxy is not backed by your ChatGPT web session, ChatGPT Plus, or ChatGPT Pro. It can only generate text after you configure a separate OpenAI-compatible model API provider.

Start the normal daemon and local API proxy:

```zsh
machine-mcp
```

Start only the local API proxy, without the Remote MCP daemon:

```zsh
machine-mcp api
```

Disable the default local API proxy for a daemon run:

```zsh
machine-mcp --no-api
```

When the proxy is running, the CLI prints client settings like:

```text
API Base URL: http://127.0.0.1:8765/v1
API key: local_api_key_...
Client type: OpenAI-compatible
ChatGPT web backing: no
```

Use these values in the desktop client only if you also configure an external model provider. For ChatGPT web, ignore the local API fields and use the MCP connection details instead.

Configure an external OpenAI-compatible model API provider once:

```zsh
machine-mcp api configure
```

Non-interactive setup is also supported:

```zsh
machine-mcp api configure \
  --api-upstream-url https://api.openai.com/v1 \
  --api-upstream-key "$OPENAI_API_KEY" \
  --api-upstream-model gpt-4.1-mini
```

The external provider key is saved in the owner-only workspace state and redacted in status/doctor output. Existing `machine-mcp` API processes from v0.2.3+ reload this saved provider configuration on each request, so a newly configured provider is picked up without changing Cherry Studio's Base URL or local API key. After configuration, select the model shown by `GET /v1/models` in the desktop client.

If no external provider is configured, `GET /v1/models` returns an empty list and generation endpoints return `503 upstream_not_configured` with an explanation. This is intentional: ChatGPT web does not expose an OpenAI-compatible local API through this project.

If port `8765` conflicts with another local app, choose a different port explicitly:

```zsh
machine-mcp --api-port 8766
machine-mcp api --api-port 8766
```

`--port` is also accepted on the `api` command:

```zsh
machine-mcp api --port 8766
```

By default, the local API binds to `127.0.0.1`, starts with `machine-mcp`, and stores a per-workspace local API key in the same owner-only state profile used by the MCP credentials. Explicit `--api-host`, `--api-port`, `--api-upstream-url`, and `--api-upstream-model` values are persisted for the workspace so autostart uses the same API settings. `--api-model` is accepted as a compatibility alias for `--api-upstream-model`; local `/v1/models` still displays the external provider model directly. External provider keys are saved only when you explicitly run `machine-mcp api configure` or pass `--api-upstream-key`; they are stored in owner-only state and redacted in diagnostics.

Rotate the local desktop-client API key with:

```zsh
machine-mcp api --rotate-api-key
```

Update the external OpenAI-compatible provider later:

```zsh
machine-mcp api configure \
  --api-upstream-url https://api.openai.com/v1 \
  --api-upstream-key "$OPENAI_API_KEY" \
  --api-upstream-model gpt-4.1-mini
```

Requests are forwarded with the model selected by the desktop client; if a request omits `model`, the proxy fills in the configured external provider model.

Environment variables are also supported for the current process: `MBM_API_HOST`, `MBM_API_PORT`, `MBM_API_KEY`, `MBM_API_UPSTREAM_URL`, `MBM_API_UPSTREAM_KEY`, `MBM_API_UPSTREAM_MODEL`, `MBM_API_MODEL`, plus common OpenAI names such as `OPENAI_API_KEY`, `OPENAI_BASE_URL`, and `OPENAI_MODEL`. For login autostart, prefer `machine-mcp api configure` so the external provider is available without relying on shell environment inheritance.

Supported local API routes:

- `GET /health` without authentication
- `GET /v1/models` with `Authorization: Bearer <local_api_key>` or `x-api-key`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/embeddings`
- `POST /v1/completions`

Model-producing routes proxy to the configured external provider. Logs record route, status, latency, and safe configuration metadata; request and response bodies and API keys are not logged.

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

State contains the MCP password, daemon secret, local API key, and any explicitly configured upstream provider key. Status/doctor output redacts secrets. The normal foreground `start` command prints the MCP password only when a ChatGPT app is likely to need reconnection: first run, secret rotation, MCP URL changes, or `--print-mcp-credentials`. The local API base URL and API key print on normal foreground starts because desktop AI clients need them. Use `--no-print-credentials` to redact console credentials. State files, temporary Worker secret files, lock files, and log directories are created under the user state root with owner-only permissions where the platform supports POSIX modes.

The Worker rejects browser requests with an `Origin` header unless the origin is the Worker itself or a loopback HTTP origin. To allow additional browser-based MCP clients, set `MBM_ALLOWED_ORIGINS` to a comma-separated list of exact origins in `wrangler.jsonc` or Cloudflare Worker settings.

Override state root:

```zsh
machine-mcp --state-dir /path/to/state
```

## Architecture

```mermaid
flowchart LR
  C["Remote MCP client"] -- "HTTPS /mcp + OAuth" --> W["Hosted Worker relay"]
  W --> DO["Durable Object broker"]
  D["Local daemon"] -- "outbound WebSocket" --> W
  D --> M["Local filesystem and shell"]
  API["Default local /v1 API"] -- "OpenAI-compatible HTTP" --> U["Configured upstream provider"]
  CLI["machine-mcp CLI"] --> API
  CLI["machine-mcp CLI"] --> W
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
