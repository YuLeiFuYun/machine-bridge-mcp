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

New users should follow the end-to-end [installation and first-use guide](docs/GETTING_STARTED.md). Before sharing a deployment or connecting several accounts, read [multi-client, multi-account, and tenancy architecture](docs/MULTI_ACCOUNT.md).

## Default behavior and policy profiles

A newly selected workspace starts with the maximum-permission `full` profile for low-friction operation:

- all read, write, edit, patch, image, Git, diagnostic, direct-process, process-session, managed-job, and shell tools are available;
- direct filesystem tools may use paths outside the selected workspace;
- tool results may return absolute paths;
- child processes inherit the complete parent environment.

Policy state records whether it came from the default, an explicit named profile, or custom overrides. Named profiles are canonical contracts: a stored `full` profile always enables writes, shell execution, unrestricted paths, the full parent environment, absolute path output, and the complete tool catalog. Any explicit per-capability narrowing is stored as `custom`. Policy revision 5 is the only accepted persisted policy format and applies compound tool requirements consistently in the local daemon and Worker.

| Profile | File edits | Direct argv processes | Shell commands | Filesystem scope | Process environment |
|---|---:|---:|---:|---|---|
| `full` | Yes | Yes | Yes | Unrestricted | Full parent environment |
| `agent` | Yes | Yes | No | Selected workspace | Isolated environment |
| `edit` | Yes | No | No | Selected workspace | Isolated environment |
| `review` | No | No | No | Selected workspace | Isolated environment |

This default prioritizes usability, not least privilege. `run_process` and process sessions avoid command-shell parsing, but they are **not an operating-system sandbox**. `exec_command` additionally permits shell syntax and expansion. Use `--profile review`, `edit`, or `agent`, or use a container, VM, or dedicated low-privilege OS account when the client, repository, or instructions are not fully trusted.

## Install

For prerequisites, first remote deployment, ChatGPT connection, stdio configuration, browser pairing, upgrades, troubleshooting, and removal, follow [Installation and first use](docs/GETTING_STARTED.md). The commands below are the compact installation reference.

Version 1 supports only MCP protocol `2025-11-25`. Existing current-schema local state upgrades in place, but clients must reconnect and the unpacked browser extension must be reloaded after package upgrade.

Node.js 26 or newer and npm 12 or newer are required. The repository pins the active development versions in `.node-version`, `.nvmrc`, and `packageManager`; project installs fail on older Node runtimes.

Use a new temporary directory for the bootstrap. The existing `npm`/`npx` front-end may inspect nearby project metadata before it launches the requested npm version; starting from an empty directory prevents an unrelated outdated `devEngines` declaration from blocking the bootstrap. The actual installation is then executed by the pinned npm 12 CLI rather than whichever npm happens to be first on `PATH`.

macOS/Linux:

```sh
install_dir="$(mktemp -d)"
(
  cd "$install_dir"
  npx --yes npm@12.0.1 install --global npm@12.0.1
  npx --yes npm@12.0.1 install --global --omit=optional --allow-scripts=esbuild,workerd,sharp,fsevents machine-bridge-mcp@latest
)
rm -rf "$install_dir"
npm --version
machine-mcp doctor
```

Windows Command Prompt (`cmd.exe`):

```bat
set "MBM_INSTALL_DIR=%TEMP%\machine-bridge-mcp-install-%RANDOM%-%RANDOM%"
mkdir "%MBM_INSTALL_DIR%"
pushd "%MBM_INSTALL_DIR%"
npx --yes npm@12.0.1 install --global npm@12.0.1
npx --yes npm@12.0.1 install --global --omit=optional --allow-scripts=esbuild,workerd,sharp,fsevents machine-bridge-mcp@latest
popd
rmdir /s /q "%MBM_INSTALL_DIR%"
npm --version
machine-mcp doctor
```

`Unknown cli config "--allow-scripts"` proves the Machine Bridge install was executed by npm 11 or older rather than the required npm 12. `Invalid property "node"` or `Invalid property "devEngines.node"` means that npm parsed an outdated `devEngines` object; the npm debug log is required to identify which package supplied it. The empty-directory, pinned-npm procedure avoids relying on that old parser. If `npm --version` still reports an older version after the bootstrap, reopen the terminal and rerun `machine-mcp doctor`.

Recent npm releases may otherwise warn that Wrangler's native dependencies (`esbuild`, `workerd`, and `sharp`) have install scripts awaiting approval. The scoped command approves the reviewed native script names that npm 12 evaluates during global resolution while `--omit=optional` keeps optional `fsevents` out of the installed runtime. `fsevents` is used for development-time filesystem watching rather than Machine Bridge runtime or deployment. Omitting `--omit=optional` can therefore produce a harmless blocked-script warning for `fsevents@2.3.3`; use the documented command rather than changing global npm policy. `machine-mcp doctor` remains the authoritative runtime check.

From a source checkout, the checked-in exact-version `allowScripts` policy approves the reviewed native dependencies:

```sh
npm install
./mbm                 # macOS/Linux
.\mbm.cmd             # Windows cmd
```

## Remote MCP for ChatGPT

After a global installation, `machine-mcp` can be launched from any Command Prompt or terminal; the package installation directory is not the workspace. On the first interactive Windows start, the CLI asks:

```text
Workspace folder [C:\Users\Alice\MachineBridge] (press Enter to use the default):
```

Press Enter to create and remember `%USERPROFILE%\MachineBridge`. No `cd` command or directory selection is required. Enter another folder when desired; an interactively selected Windows folder is created if it does not yet exist. Later starts reuse the remembered workspace. Advanced users and automation may still select an existing workspace explicitly:

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
7. creates the initial `owner` account when needed and prints its password once;
8. prints the Remote MCP URL.

A normal `machine-mcp` invocation is a foreground start: it remains attached to the terminal and prints `info` logs. Startup and other state-changing operations use an owner-token/process-identity lock and wait up to 30 seconds for an ordinary concurrent startup to finish instead of failing on a brief launchd/systemd race. After a global package upgrade, the CLI unloads the platform service and also checks the workspace lock for a detached/orphan `--daemon-only` process that the service manager no longer tracks. It terminates only a process whose PID, process start time, entrypoint, canonical workspace, canonical state root, and daemon-only arguments all match, waits up to 15 seconds for the PID and lock to disappear, and then starts the installed version in the foreground. A genuine foreground or unverifiable conflict is left untouched and reported with actionable guidance. To run only in the background, use `machine-mcp service start`; inspect its owner-only logs under `~/.local/state/machine-bridge-mcp/logs/`.

Recommended upgrade sequence: repeat the package-free temporary-directory installation above, then run:

```sh
machine-mcp --verbose
```

The global install replaces files on disk but cannot hot-reload an already running Node process; the foreground command performs the bounded service and orphan-daemon takeover. Keep `--omit=optional` in the installation step to prevent the development-only optional `fsevents` package from producing a blocked-install-script warning. If takeover fails, run `machine-mcp service status` first; it reports the platform service and workspace daemon separately. Then run `machine-mcp service stop` and retry.

Use the printed URL in the MCP client:

```text
MCP Server URL: https://<worker>.<account>.workers.dev/mcp
```

During OAuth authorization, enter the name and password of a Machine Bridge account. The first start creates `owner` and prints its generated password once. Additional accounts are managed with `machine-mcp account`. The authorization flow uses PKCE S256, exact redirect/resource binding, expiring hashed access tokens, per-account version checks, and a deployment-wide token version for emergency bulk revocation.

The Worker grants browser CORS response access to the exact first-party origins used by ChatGPT (`https://chatgpt.com` and the legacy `https://chat.openai.com`) and Grok (`https://grok.com` and its X-hosted surface at `https://x.com`). Users do not need to run Wrangler or edit Cloudflare variables. `MBM_ALLOWED_ORIGINS` remains an operator-only, comma-separated extension point for other exact origins; it is additive and does not replace the built-in set. Wildcards and `null` do not receive CORS permission. Actual OAuth navigations and form submissions are not rejected solely because a browser container supplies an opaque or client-specific `Origin`; authorization still depends on exact redirect/resource binding, PKCE, account authentication, and bearer-token validation.

### Multiple clients and accounts

One Worker supports several named accounts and OAuth clients. Accounts have independent passwords, roles, active state, versions, codes, and tokens. The roles are `reviewer`, `editor`, `operator`, and `owner`; their effective authority is intersected with the connected daemon policy and enforced in both the Worker and local runtime. Role changes, suspension, password rotation, and removal revoke only the affected account.

This is application-level authorization, not kernel or browser-profile isolation. All accounts reach one daemon running as one OS user. Use separate Workers and preferably separate low-privilege OS accounts, containers, or VMs for mutually untrusted users or hard tenant isolation. See [Multi-account authorization and tenancy](docs/MULTI_ACCOUNT.md).

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

No files are created or modified by this bootstrap. Explicit user and repository instructions load later and therefore override the defaults. `session_bootstrap` supplies the chain during MCP initialization; `agent_context` exposes every source and hash; `resolve_task_capabilities` refreshes project facts, instructions, skills, commands, and installed-application matches for the current task. `server_info` and `project_overview` expose whether bootstrap and task resolution actually reached the local runtime without retaining raw task text.

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

Skill discovery follows Codex-style progressive disclosure. Default project roots include target-to-project `.agents/skills` and `.codex/skills`; unrestricted policy also enables `~/.agents/skills`, `CODEX_HOME/skills` (normally `~/.codex/skills`), and the Unix admin root. Newly added or edited skills are found on the next resolver/list call without restarting the daemon. Safe root `package.json` script names are also exposed as `package.*` command aliases with bounded deterministic English/Chinese workflow-intent terms; explicit `.machine-bridge/agent.json` commands can override or delete them. Package-script bodies are never injected, but invoking one still runs repository-controlled code with the active local policy. See [Session instructions, defaults, skills, commands, and capability discovery](docs/AGENT_CONTEXT.md).

Under canonical `full`, Machine Bridge also exposes structured local automation:

- installed application discovery/opening and macOS Accessibility inspection/actions;
- a packaged Chromium extension that controls the profile into which the user loads it, including that profile's tabs, login state, and windows; Machine Bridge does not launch a separate browser process;
- current DOM source and frame/open-Shadow-DOM inspection, stable semantic element references, actionability waits, fixed trusted mouse/keyboard input, explicit browser waits, tab management, complex multi-field forms, resource-backed secret fields, resource-backed file uploads, and screenshots.

One-time browser setup:

```sh
machine-mcp browser setup
machine-mcp browser status
```

Load the printed unpacked-extension directory in the Chromium profile you actually use; Machine Bridge does not install it into Playwright or a separate automation profile. After every Machine Bridge upgrade, reload the unpacked extension and accept any new browser permission. `machine-mcp browser status` reports both the expected packaged extension build and the authenticated connected build/protocol, and states that Machine Bridge did not launch the browser. It cannot infer whether the extension was loaded into a daily or isolated profile; that is determined by where the user installed it. Trusted input uses the Chromium `debugger` permission only for fixed, short-lived DevTools Input commands. The badge shows `ON` only after the broker acknowledges the version/capability handshake. The local pairing token remains in owner-only state and non-cacheable loopback HTML; it is not returned through MCP. For a mass-market release, distribute the same extension as a signed browser-store build rather than asking end users to enable Developer mode. See [Local application and browser automation](docs/LOCAL_AUTOMATION.md).

Machine Bridge can discover, refresh, rank, and load capabilities automatically. The ChatGPT/MCP host still owns tool selection and approval, so the server cannot force a host to expose or invoke a recommended skill, command, app, or browser operation. Check `server_info.observability.capability_routing` or `project_overview.capabilityRouting` to distinguish “the host never called the resolver” from “the resolver ran but found no relevant capability.”


## Runtime lifecycle and observability

Every tool call passes through one execution pipeline: bounded call registration and deadline/cancellation ownership, structured observability, shared policy authorization, then the typed handler. Errors use stable codes and retryability metadata instead of transport-specific message parsing. `server_info` exposes the local lifecycle state, in-flight calls, active process ownership, per-tool outcomes, durations, and error-code counts. The Worker adds pending internal/request-key indexes, daemon candidate/socket counters, and Worker-side per-tool outcomes.

Foreground logging defaults to human-readable text. Installed background services use warning-level JSON events by default. Use `--log-format json` for machine-readable foreground logs; arguments, outputs, credentials, resource contents, and local paths remain excluded or redacted.

## Policy controls

Policy revision 5 is defined once in `src/shared/policy-contract.json`. The local runtime, Worker advertisement filter, manager-level defense-in-depth checks, tests, and generated [policy reference](docs/POLICY_REFERENCE.md) consume that same contract. A custom policy is authorized by capabilities rather than its display name; compound classes such as `write+direct-exec` require every capability.

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
--log-format text|json
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
- `browser_manage_tabs` — create, activate, or close tabs
- `browser_get_source` — bounded current DOM HTML with one aggregate byte budget across up to 64 accessible frames
- `browser_inspect_page` — semantic controls, bounded LRU refs, state, geometry, and explicit frame/node/ref truncation metadata
- `browser_wait` — bounded URL/load/text/element-state waits
- `browser_action` — actionability checks plus `auto`, `trusted`, or `dom` input mode; ambiguous post-dispatch failures are never replayed through DOM
- `browser_fill_form`
- `browser_upload_files` — registered local resources to file inputs
- `browser_screenshot` — restores the prior active tab and does not focus another window


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

- `run_local_command` — fixed argv execution of an explicit or automatic package-script command
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
machine-mcp account list|add|role|enable|disable|rotate-password|remove
machine-mcp browser status|setup|pair|path
machine-mcp job submit|inspect|approve|list|read|cancel
machine-mcp uninstall [--keep-worker] [--yes]
```

Each canonical workspace has an independent profile, Worker name, credential set, state file, startup lock, and daemon lock.

## Autostart

Remote mode supports:

- macOS user LaunchAgent;
- Linux `systemd --user`, with best-effort lingering;
- Windows Scheduled Task at logon.

The service definition contains neither credentials nor a duplicate policy. It loads the selected policy from owner-only local state and uses the documented `full` default if policy state is absent. launchd/systemd definitions persist a sanitized absolute-only PATH captured during installation, including the stable Node/CLI directories, so background `full` mode does not lose Homebrew or other developer command locations. Background services run at log level `warn` with JSON output: relay, protocol, and service problems are retained as bounded structured events, while all per-tool success/failure/cancellation/timing events remain debug-only. Logs are owner-only where supported and bounded by tail trimming.

## Secret rotation

```sh
machine-mcp rotate-secrets
```

Rotation stops the installed service, refuses to proceed while another foreground daemon owns the workspace lock, and rotates the account-administration secret, daemon secret, and deployment-wide OAuth token version. It invalidates every account access token and requires all clients to authorize again. Use `machine-mcp account rotate-password NAME` for targeted password rotation without affecting other accounts.

## State and observability

Default state roots:

- macOS/Linux: `~/.local/state/machine-bridge-mcp`
- Linux with `XDG_STATE_HOME`: `$XDG_STATE_HOME/machine-bridge-mcp`
- Windows: `%APPDATA%\machine-bridge-mcp`

State/config writes use owner-only temporary files, `fsync`, and atomic replacement. Exclusive locks are fully written before a same-directory hard-link claim becomes visible; lock ownership includes a token and process start time so PID reuse and lock replacement cannot silently transfer ownership. Only successfully read but invalid JSON is retained as a bounded corrupt backup; permission, symbolic-link, size, encoding, and I/O failures remain explicit. A custom state root must not equal, contain, or be contained by the selected workspace. Resource source paths are redacted from `status` output. Active managed-job plans are owner-only and are deleted after a terminal result; bounded redacted results are retained temporarily. Uninstall first acquires a state-root maintenance lock that blocks new profile/state operations and state-backed operations from already constructed managed-job/browser managers, stops the platform service and all verified workspace daemons before removing definitions, rechecks jobs and locks, then validates markers, canonical paths, workspace/source exclusions, and known contents before recursive deletion.

The relay honors standard `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` environment routing. Invalid or unsupported proxy configuration fails fast; runtime status reports only `direct`, `proxy`, or `invalid-proxy-configuration`, never proxy URLs or credentials.

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

`npm run check` covers privacy and release-impact gates, architecture/link invariants, generated Worker types, TypeScript, recursively discovered JavaScript syntax, semantic undefined-identifier checks, catalog-to-runtime handler parity, deterministic relay lifecycle and secure-file tests, concurrent lock/atomic-replacement/PID-reuse fixtures, fail-closed service lifecycle tests, descendant process-tree termination, local path/write/state/log/service invariants, Ed25519/RSA generation and key-pair validation, real-machine `full` sandbox acceptance, a clean npm package-manifest/mode/sensitive-artifact check, an isolated installation of the actual packed tarball whose zero-argument CLI startup must reach a controlled Worker-deployment boundary, managed-job integrity/redaction/finally/cancellation/recovery, a live stdio MCP flow, and a live local OAuth/Worker/WebSocket/MCP flow. GitHub Actions runs the complete suite on Linux, macOS, and Windows with the pinned Node 26/npm 12 baseline.

The cross-cutting 0.12.0 review, corrected failure modes, and residual OS-level limits are recorded in [docs/AUDIT.md](docs/AUDIT.md). See also [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md), [docs/MULTI_ACCOUNT.md](docs/MULTI_ACCOUNT.md), [docs/AGENT_CONTEXT.md](docs/AGENT_CONTEXT.md), [docs/LOCAL_AUTOMATION.md](docs/LOCAL_AUTOMATION.md), [docs/MANAGED_JOBS.md](docs/MANAGED_JOBS.md), [docs/TESTING.md](docs/TESTING.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/ENGINEERING.md](docs/ENGINEERING.md), [docs/PROJECT_STANDARDS.md](docs/PROJECT_STANDARDS.md), the generated [MCP tool reference](docs/TOOL_REFERENCE.md), and [SECURITY.md](SECURITY.md).

## Uninstall

```sh
machine-mcp uninstall
npm uninstall -g machine-bridge-mcp
```

Use `--keep-worker` to retain deployed Workers while removing local state and autostart. Uninstall is fail-closed: if the platform service, a verified daemon, a managed job, an unreadable lock, or a service-definition removal cannot be resolved safely, service definitions and local state are retained for diagnosis instead of being partially deleted.

## License

MIT

See [repository privacy hygiene](docs/PRIVACY.md) and [contribution/release discipline](CONTRIBUTING.md) before committing. Every release-relevant code, test, script, configuration, or documentation change must be pushed to GitHub with a new version and followed by a matching npm release.
