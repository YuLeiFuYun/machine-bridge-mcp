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

The remote Worker authenticates and relays calls. It cannot directly read local files or start local processes. File, Git, image, patch, process, diagnostic, and managed-job operations execute in the local runtime.

## Default behavior and policy profiles

A newly selected workspace starts with the maximum-permission `full` profile for low-friction operation:

- all read, write, edit, patch, image, Git, diagnostic, direct-process, process-session, managed-job, and shell tools are available;
- direct filesystem tools may use paths outside the selected workspace;
- tool results may return absolute paths;
- child processes inherit the complete parent environment.

Policy state records whether it came from the default, an explicit named profile, or custom overrides. Named profiles are canonical contracts: a stored `full` profile is repaired on load to enable writes, shell execution, unrestricted paths, full parent environment, absolute path output, and the complete tool catalog. Any explicit per-capability narrowing is stored as `custom`. Policy revision 3 refreshes default/migrated state and preserves explicit restrictive/custom profiles.

| Profile | File edits | Direct argv processes | Shell commands | Filesystem scope | Process environment |
|---|---:|---:|---:|---|---|
| `full` | Yes | Yes | Yes | Unrestricted | Full parent environment |
| `agent` | Yes | Yes | No | Selected workspace | Isolated environment |
| `edit` | Yes | No | No | Selected workspace | Isolated environment |
| `review` | No | No | No | Selected workspace | Isolated environment |

This default prioritizes usability, not least privilege. `run_process` and process sessions avoid command-shell parsing, but they are **not an operating-system sandbox**. `exec_command` additionally permits shell syntax and expansion. Use `--profile review`, `edit`, or `agent`, or use a container, VM, or dedicated low-privilege OS account when the client, repository, or instructions are not fully trusted.

## Install

Node.js 26 or newer and npm 12 or newer are required. The repository pins the active development versions in `.node-version`, `.nvmrc`, and `packageManager`; project installs fail on older Node runtimes.

```sh
npm install -g --omit=optional --allow-scripts=esbuild,workerd,sharp,fsevents machine-bridge-mcp@latest
```

Recent npm releases may otherwise warn that Wrangler's native dependencies (`esbuild`, `workerd`, and `sharp`) have install scripts awaiting approval. The scoped command approves the reviewed native script names that npm 12 evaluates during global resolution while `--omit=optional` keeps optional `fsevents` out of the installed runtime. `fsevents` is used for development-time filesystem watching rather than Machine Bridge runtime or deployment. Omitting `--omit=optional` can therefore produce a harmless blocked-script warning for `fsevents@2.3.3`; use the documented command rather than changing global npm policy. `machine-mcp doctor` remains the authoritative runtime check.

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

A normal `machine-mcp` invocation is a foreground start: it remains attached to the terminal and prints `info` logs. If an older autostart daemon is active after a global package upgrade, the CLI stops that service, waits up to 15 seconds for its workspace lock, and then starts the newly installed version in the foreground. A genuine foreground conflict is left untouched and reported with actionable guidance. To run only in the background, use `machine-mcp service start`; inspect its owner-only logs under `~/.local/state/machine-bridge-mcp/logs/`.

Recommended upgrade sequence:

```sh
npm install -g --omit=optional --allow-scripts=esbuild,workerd,sharp,fsevents machine-bridge-mcp@latest
machine-mcp --verbose
```

The global install replaces files on disk but cannot hot-reload an already running Node process; the second command performs the bounded service takeover. If takeover fails, run `machine-mcp service stop`, confirm with `machine-mcp service status`, and retry.

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

## Session instructions, local skills, commands, apps, and browser

Machine Bridge now starts with useful agent guidance even when the user has not created `MODEL.md`, `AGENTS.md`, or `.machine-bridge/agent.json`.

Two lower-precedence virtual sources are generated in memory:

- `machine-bridge://defaults/working-agreements` supplies conservative cross-project rules for inspection, scoped changes, preservation of unrelated work, validation, security, Git discipline, and explicit authorization for deployment/publication/destructive operations.
- `machine-bridge://project-context/current` derives bounded facts from the active repository: target path, common project/build files, package-manager declarations and lockfiles, package script names, runtime constraints, documentation files, and CI entrypoints. It never injects package-script bodies or source contents and does not claim commands were validated.

No files are created or modified by this bootstrap. Explicit user and repository instructions load later and therefore override the defaults. `session_bootstrap` supplies the chain during MCP initialization; `agent_context` exposes every source and hash; `resolve_task_capabilities` refreshes project facts, instructions, skills, and commands for the current task.

Optional user-global preferences still live in `~/.config/machine-bridge-mcp/agent.json`:

```json
{
  "version": 1,
  "model_instructions_file": "~/.config/machine-bridge-mcp/MODEL.md"
}
```

Use `MODEL.md` for preferences not covered by the baseline, such as default language or organization-specific review rules. Repository-specific rules belong in `AGENTS.md`/`AGENTS.override.md`; deeper files take precedence. Keep secrets out of every instruction file.

To disable either automatic layer globally:

```json
{
  "version": 1,
  "builtin_instructions": false,
  "automatic_project_context": false
}
```

Repositories cannot disable these user-level controls. Editing instruction files or project metadata does not require a daemon restart; start a new MCP conversation or reconnect when initialization-time injection must be guaranteed from the beginning.

Skill discovery follows Codex-style progressive disclosure. Default roots are target-to-project `.agents/skills`; unrestricted policy also enables user/admin roots. Newly added or edited skills are found on the next resolver/list call without restarting the daemon. A project can customize instruction candidates, skill roots, and direct-argv registered commands with `.machine-bridge/agent.json`. See [Session instructions, defaults, skills, commands, and capability discovery](docs/AGENT_CONTEXT.md).

Under canonical `full`, Machine Bridge also exposes structured local automation:

- installed application discovery/opening and macOS Accessibility inspection/actions;
- a packaged Chromium extension that controls the user's existing daily browser profile, active tabs, login state, and windows;
- current DOM source and frame/open-Shadow-DOM inspection, structured page actions, complex multi-field forms, resource-backed secret fields, resource-backed file uploads, and screenshots.

One-time browser setup:

```sh
machine-mcp browser setup
machine-mcp browser status
```

Load the printed unpacked-extension directory once in Chrome, Edge, Brave, Vivaldi, or another compatible Chromium browser. The extension badge reports connection state, and clicking it opens the saved local pairing page. The local pairing token remains in owner-only state and the loopback pairing page; it is not returned through MCP. For a mass-market release, distribute the same extension as a signed browser-store build rather than asking end users to enable Developer mode. See [Local application and browser automation](docs/LOCAL_AUTOMATION.md).

Machine Bridge can discover, refresh, rank, and load capabilities automatically. The ChatGPT/MCP host still owns tool selection and approval, so the server cannot force a host to expose or invoke a recommended skill, command, app, or browser operation.

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
- Maximum local policy does not override operating-system permissions, macOS TCC/SIP, Windows ACLs, container boundaries, or independent safety rules imposed by the MCP host/platform. `full` means the local daemon and relay advertise the complete catalog; a connector may still expose only a subset to a particular session. Machine Bridge cannot observe or override that host-side subset. A host-generated “sensitive file” denial is outside this server's enforcement layer.

## Diagnose host, bridge, and local execution failures

A displayed `full` policy proves only that Machine Bridge has enabled its own capabilities. Execution can still be denied by the MCP host/connector, macOS TCC/SIP, Unix permissions, Windows ACLs, shell policy, or endpoint-security software.

Use:

```text
diagnose_runtime
```

or locally:

```sh
machine-mcp doctor
```

A successful `diagnose_runtime` response proves that request reached the local daemon. It then reports fixed probes for Machine Bridge policy, private filesystem access, direct process spawning, shell execution, managed-job storage, and registered resources. If the host blocks the tool call before any structured response, the server cannot diagnose that request because it never received it.

Run a real local acceptance test for the canonical `full` contract:

```sh
machine-mcp full-test --workspace /path/to/project
```

The test uses a temporary sandbox to perform an outside-workspace read/write, direct process, shell command, parent-environment inheritance, Ed25519 generation, temporary `authorized_keys` write, SSH client check, Google Cloud OS Login command availability check, non-mutating `sudo -n true` probe, and detached managed-job/finally lifecycle. It does not add a cloud key, contact a remote maintenance host, modify a user account, or retain the generated key.

## Managed jobs and local resources

Long, remote, multi-step, or cleanup-sensitive work should not depend on a sequence of later MCP calls remaining available. `start_job` durably accepts ordered argv steps plus `finally_steps`, then launches an independent local runner. It continues after MCP disconnects or later host-side tool refusals.

When the host blocks execution-class tools but still permits state mutation, `stage_job` stores the same validated plan without starting any process. The operator can review it with `machine-mcp job inspect JOB_ID` and explicitly authorize execution with `machine-mcp job approve JOB_ID`. Cancelling a staged plan does not run main or finally steps.

Register credential/key files locally without sending their contents through MCP:

```sh
chmod 600 ~/.ssh/example_maintenance_ed25519
machine-mcp resource add maintenance-key ~/.ssh/example_maintenance_ed25519
machine-mcp resource list                 # paths omitted by default
machine-mcp resource list --show-paths    # explicit local-only path disclosure
```

Generate an Ed25519 key and register its private file in one operation:

```sh
machine-mcp resource generate-ssh-key maintenance-key ~/.ssh/machine-mcp-example-maint-ed25519
```

Under canonical `full`, an authorized MCP host can invoke `generate_ssh_key_resource` with the same semantics. The tool is idempotent, verifies that existing public/private files match, enforces local file modes where supported, and returns the public fingerprint, key type, and registration status—not private key bytes or local paths. Pass `expose_paths=true` only when the caller genuinely needs those paths.

A job refers to the alias rather than the value:

```json
{
  "name": "remote maintenance",
  "steps": [
    {
      "argv": [
        "ssh",
        "-i",
        "{{resource:maintenance-key}}",
        "admin@server.example",
        "sh",
        "-s"
      ],
      "stdin": "set -eu\n# remote repair commands\n"
    }
  ],
  "finally_steps": [
    {
      "argv": ["ssh", "-i", "{{resource:maintenance-key}}", "admin@server.example", "rm", "-f", "/tmp/helper"],
      "allow_failure": true
    }
  ]
}
```

Prefer sending a remote script through stdin so no remote helper file is created. For local helpers, use job-scoped `temporary_files` and `{{temp:name}}`; the private job runtime is removed after cleanup.

Resources can be injected by private copied path (`{{resource:name}}`), `stdin_resource`, or `env_resources`. Use `capture_output: "discard"` for commands that may echo credentials. Exact resource values and common exact encodings are redacted from retained results, but transformed or partial-secret detection is not guaranteed.

If the MCP host later blocks all execution tools, use the local fallback:

```sh
machine-mcp job list
machine-mcp job read JOB_ID
machine-mcp job cancel JOB_ID
machine-mcp job submit plan.json
```

Finally steps and restart recovery are best effort and should be idempotent. See [docs/MANAGED_JOBS.md](docs/MANAGED_JOBS.md) for lifecycle, security limits, plan format, and diagnosis guidance.

## Tools

The exact `tools/list` response reflects the active local policy. Definitions come from one shared catalog used by both Worker and stdio transports.

### Workspace and content

- `server_info`
- `project_overview`
- `session_bootstrap` — built-in defaults, automatic project facts, explicit instructions, and refresh metadata
- `agent_context` — complete default/explicit instruction precedence, skill summaries, and registered commands for a target path
- `resolve_task_capabilities` — live skill/command ranking and local automation recommendations
- `list_local_skills`
- `load_local_skill` — load instructions and file inventory without implicit execution
- `list_local_commands`
- `list_roots`
- `list_dir`
- `list_files`
- `read_file` — whole UTF-8 files or bounded line ranges
- `view_image` — bounded PNG, JPEG, GIF, or WebP as native MCP image content
- `search_text`

### Local applications and browser (`full`)

- `list_local_applications`
- `open_local_application`
- `inspect_local_application` — bounded macOS Accessibility tree
- `operate_local_application` — structured Accessibility action, no arbitrary script source
- `browser_status`
- `pair_browser_extension`
- `browser_list_tabs`
- `browser_get_source` — bounded current DOM HTML, including selected frames
- `browser_inspect_page`
- `browser_action`
- `browser_fill_form`
- `browser_upload_files` — registered local resources to file inputs
- `browser_screenshot`


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

### Diagnostics and durable work

- `diagnose_runtime` — fixed layered probes; no user-controlled command input
- `list_local_resources` — aliases and validation status without paths or values
- `generate_ssh_key_resource` — canonical-full-only Ed25519 generation and private-file registration; private bytes and local paths are omitted by default
- `stage_job` — persist a validated plan for later local approval without executing it
- `start_job` — detached ordered argv steps, private temporary files, and finally steps
- `list_jobs`
- `read_job`
- `cancel_job`

Managed jobs are non-interactive and persist independently of the MCP connection. Process sessions remain interactive and memory-only.

### Processes

- `run_local_command` — direct argv execution of a manifest-registered command
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
machine-mcp resource add|list|check|remove
machine-mcp browser status|setup|pair|path
machine-mcp job submit|inspect|approve|list|read|cancel
machine-mcp --print-mcp-credentials
machine-mcp uninstall [--keep-worker] [--yes]
```

Each canonical workspace has an independent profile, Worker name, credential set, state file, startup lock, and daemon lock.

## Autostart

Remote mode supports:

- macOS user LaunchAgent;
- Linux `systemd --user`, with best-effort lingering;
- Windows Scheduled Task at logon.

The service definition contains neither credentials nor a duplicate policy. It loads the selected policy from owner-only local state and uses the documented `full` default if policy state is absent. launchd/systemd definitions persist a sanitized absolute-only PATH captured during installation, including the stable Node/CLI directories, so background `full` mode does not lose Homebrew or other developer command locations. Background services run at log level `warn`: relay, protocol, and service problems are retained, while all per-tool success/failure/cancellation/timing events remain debug-only. Logs are owner-only where supported and bounded by tail trimming.

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

State/config writes use owner-only temporary files, flushes, and atomic rename. Malformed state is retained as a bounded corrupt backup before reconstruction. Resource source paths are redacted from `status` output. Active managed-job plans are owner-only and are deleted after a terminal result; bounded redacted results are retained temporarily. Uninstall validates markers, canonical paths, active locks, workspace/source exclusions, and known contents before recursive deletion.

Default foreground logs report authenticated relay readiness, readable persistent-degradation summaries, and recovery rather than raw WebSocket callbacks or JSON field dumps. Brief self-healing disconnects and close codes/reasons are debug-only. Stalled connection attempts have a deadline, and sustained-outage reminders use autonomous exponential backoff. Every per-tool event—including success, failure, cancellation, and slow-call timing—also appears only at `--log-level debug` or `--verbose`. Background services use `warn`, so ordinary tool outcomes and brief network changes do not fill daemon logs. Log messages and structured fields are bounded, secret-like keys and known token formats are redacted, and tool arguments/results are not written. See [docs/LOGGING.md](docs/LOGGING.md) and [docs/OPERATIONS.md](docs/OPERATIONS.md).

## Development and verification

```sh
npm ci
npm run check
npm run worker:dry-run
npm audit --audit-level=high
npm audit --omit=dev --audit-level=high
npm pack --dry-run
```

`npm run check` covers privacy and release-impact gates, architecture/link invariants, generated Worker types, TypeScript, JavaScript syntax, catalog-to-runtime handler parity, deterministic relay lifecycle and secure-file tests, local path/write/process/state/log/service invariants, Ed25519/RSA generation and key-pair validation, real-machine `full` sandbox acceptance, a clean npm package-manifest/sensitive-artifact check, managed-job integrity/redaction/finally/cancellation/recovery, a live stdio MCP flow, and a live local OAuth/Worker/WebSocket/MCP flow. GitHub Actions runs the suite on Linux, macOS, and Windows with the pinned Node 26/npm 12 baseline; macOS and package-audit jobs also exercise the documented isolated global installation.

See [docs/AGENT_CONTEXT.md](docs/AGENT_CONTEXT.md), [docs/LOCAL_AUTOMATION.md](docs/LOCAL_AUTOMATION.md), [docs/MANAGED_JOBS.md](docs/MANAGED_JOBS.md), [docs/TESTING.md](docs/TESTING.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/ENGINEERING.md](docs/ENGINEERING.md), and [SECURITY.md](SECURITY.md).

## Uninstall

```sh
machine-mcp uninstall
npm uninstall -g machine-bridge-mcp
```

Use `--keep-worker` to retain deployed Workers while removing local state and autostart.

## License

MIT

See [repository privacy hygiene](docs/PRIVACY.md) and [contribution/release discipline](CONTRIBUTING.md) before committing. Every release-relevant code, test, script, configuration, or documentation change must be pushed to GitHub with a new version and followed by a matching npm release.
