# machine-bridge-mcp

`machine-bridge-mcp` exposes one local workspace to MCP clients through a shared, policy-controlled runtime. Hosted clients connect through an OAuth-protected Cloudflare Worker relay; local clients may launch the same runtime over stdio.

> [!WARNING]
> The default `full` profile retains every local-user capability: unrestricted files, shell commands, the parent environment, browser automation, applications, resources, and jobs. It is **not** an operating-system sandbox. An authenticated owner may use that ceiling without per-operation prompts. Delegated accounts are permanently constrained by their role; no approval, token, or reconnect can elevate them. Use a narrower profile or an isolated OS account, VM, or container for mutually untrusted workloads.

## Choose a path

| Goal | Start here |
|---|---|
| Install and connect a hosted client | [Getting started](docs/GETTING_STARTED.md) |
| Add a local stdio client | [Client integration](docs/CLIENTS.md) |
| Understand components and authority | [System overview](docs/OVERVIEW.md) |
| Review security assumptions | [Threat model](docs/THREAT_MODEL.md) and [security policy](SECURITY.md) |
| Operate or troubleshoot a deployment | [Operations](docs/OPERATIONS.md) |
| Contribute code | [Contributing](CONTRIBUTING.md) |

Support boundaries are defined in [SUPPORT.md](SUPPORT.md). Repository participation follows [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## What it provides

- one transport-independent local runtime for remote OAuth and local stdio clients;
- policy profiles with shared local/Worker enforcement contracts;
- bounded file, patch, Git, process, diagnostic, application, browser, and managed-job tools;
- account roles whose authority is intersected with the connected daemon policy;
- root-certified ephemeral daemon sessions, trusted OAuth client binding, refresh-family ownership, and non-escalatable account roles;
- structured, privacy-conscious lifecycle events, a worker-thread-isolated tamper-evident audit chain, and stable error codes;
- control-plane resilience through end-to-end reserved diagnostic capacity, event-loop-aware relay liveness, and explicit draining-process accounting;
- fail-closed state, lock, release, package, and supply-chain checks.

The remote Worker authenticates and relays requests. It cannot directly read local files or start local processes. Local-user authority remains in the daemon process.

```text
Hosted MCP client
  -> HTTPS + OAuth 2.1 / PKCE
  -> Cloudflare Worker + Durable Object
  -> root-certified ephemeral P-256 WebSocket session
  -> request-level effective authority and object ownership
  -> local runtime

Local MCP client
  -> stdio
  -> local runtime
```

The complete component and trust-boundary diagram is in [docs/OVERVIEW.md](docs/OVERVIEW.md).

## MCP protocol model

Machine Bridge is a dual-era server with a modern core:

- **MCP `2026-07-28` is primary.** Every request carries protocol version and client capabilities in `_meta`; HTTP requests also mirror the version, method, and applicable name/parameter values into validated headers. Clients use `server/discover`; no `initialize` handshake or MCP session is created.
- **MCP `2025-11-25` is a compatibility adapter.** Legacy clients still use `initialize`, a signed `Mcp-Session-Id`, and the older resumable Streamable HTTP behavior.
- **Modern HTTP streams are request-scoped and not resumable.** Closing the response stream cancels that request. `Last-Event-ID`, recovery GETs, and session-bound replay exist only in the legacy adapter.
- **Transport identity is not conversation identity.** Modern stdio and HTTP processes/connections may interleave unrelated requests; state that spans calls must use an explicit tool, job, process-session, or resource identifier.

The Worker validates the actual `/mcp` Origin, mirrored headers, role-filtered tool visibility, and raw arguments before routing, durable stream allocation, or daemon dispatch. Tool arguments use one bounded JSON Schema 2020-12 contract in both Worker and local runtime; validation has fixed schema and runtime-work budgets and never echoes rejected values. Modern stream cancellation uses a private random capability stripped from public requests and forwards no OAuth/DPoP credential.

`resolve_task_capabilities` provides bounded, set-level route advice across registered commands, direct Bash/argv, process sessions, managed jobs, files/Git, browser, applications, resources, and diagnostics. It does not hide or disable tools: Bash through `exec_command` remains the first-class general escape hatch under a shell-capable effective policy. The versioned result is filtered by the authenticated account's effective authority, reports routing ambiguity and fallbacks, and accepts the previous `refresh.fingerprint` to omit unchanged static instructions while still recomputing task-specific matches. Route scores are deterministic relative ranks within one response, not probabilities or cross-version metrics.

## Requirements

- Node.js 26 or newer
- npm 12 or newer

The project intentionally follows one current runtime baseline rather than carrying compatibility branches for older Node/npm behavior. Node 26 provides the tested process, module, permission, and platform semantics used by the release gates; npm 12 provides the installation-script controls used by the documented global install. `.node-version`, `.nvmrc`, `packageManager`, strict engines, local checks, and CI keep that baseline consistent.

## Install

Use an empty temporary directory so an unrelated nearby project cannot affect npm bootstrap parsing.

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

Windows Command Prompt:

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

`Unknown cli config "--allow-scripts"` means the package installation ran under npm 11 or older. `Invalid property "node"` or `Invalid property "devEngines.node"` means an older npm parser inspected incompatible nearby project metadata. Repeat the empty-directory procedure and reopen the terminal if `npm --version` still resolves to an older executable.

For a source checkout:

```sh
npm ci
./mbm                 # macOS/Linux
.\mbm.cmd             # Windows cmd
```

## Remote MCP quick start

Run the CLI in the workspace to expose:

```sh
machine-mcp --workspace /path/to/project
```

On first remote start, Machine Bridge creates workspace-scoped state, signs in to Wrangler when needed, deploys one stable Worker, creates the initial `owner` account, installs user-level autostart unless disabled, starts the outbound daemon connection, and prints the MCP URL and one-time owner password.

Use the printed endpoint in the hosted client:

```text
https://<worker>.<account>.workers.dev/mcp
```

Remote readiness is end-to-end. A daemon becomes available only after a Worker probe traverses the same authenticated local dispatch and result-delivery path used by real tool calls. A replacement daemon is verified before it displaces a healthy incumbent.

For account roles, OAuth lifecycle, supported callback behavior, and tenancy limits, read [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md) and [docs/MULTI_ACCOUNT.md](docs/MULTI_ACCOUNT.md).

## Local stdio quick start

Generate client configuration:

```sh
machine-mcp client-config --client all --workspace /path/to/project
```

Or launch stdio directly:

```sh
machine-mcp stdio --workspace /path/to/project
```

stdio is only a transport. The MCP host supplies the model and session; Machine Bridge supplies tools and executes them locally. See [docs/CLIENTS.md](docs/CLIENTS.md).

## Policy profiles

| Profile | File edits | Direct argv | Shell | Filesystem | Environment |
|---|---:|---:|---:|---|---|
| `full` | Yes | Yes | Yes | local-user accessible | parent environment |
| `agent` | Yes | Yes | No | selected workspace | isolated |
| `edit` | Yes | No | No | selected workspace | isolated |
| `review` | No | No | No | selected workspace | isolated |

The default is intentionally `full` for owner-operated local automation. This is a usability choice, not a least-privilege claim. Narrow it explicitly:

```text
--profile full|agent|edit|review
--exec-mode off|direct|shell
--no-write
--no-exec
--full-env
--unrestricted-paths
--absolute-paths
```

The shared source of truth is `src/shared/policy-contract.json`. The generated matrix is in [docs/POLICY_REFERENCE.md](docs/POLICY_REFERENCE.md).

For remote calls, `server_info.authorization.effective_policy` and `effective_tools` are authoritative. Daemon policy and tools describe only the local capability ceiling before account-role and host-side filtering.

`tools/list` is a stable discovery catalog for the authenticated account role. A brief relay interruption does not withdraw tool definitions or require a tools-list-changed notification. Discovery is not authority: every `tools/call` is still intersected with the current end-to-end-ready daemon policy and tool ceiling, and fails retryably with `unavailable` when no daemon is ready. `server_info.tool_delivery` distinguishes the stable advertised catalog from the currently effective daemon/account intersection. The remote catalog also narrows configurable foreground timeouts to 85 seconds while preserving each tool’s 30- or 60-second default; larger requests fail before daemon dispatch instead of being silently truncated after side effects may have begun.

`full` is the daemon capability ceiling. An authenticated owner may exercise it without per-operation approval IDs. Delegated reviewer, editor, and operator accounts remain inside immutable role ceilings; out-of-role operations are denied rather than converted into a temporary elevation workflow. Process sessions, retained output, and managed jobs are additionally bound to account, client, and refresh-token family. See [local authorization](docs/LOCAL_AUTHORIZATION.md).

## Browser and application automation

Under canonical `full`, Machine Bridge can discover and operate supported local applications and can control the Chromium profile into which the packaged extension is loaded.

```sh
machine-mcp browser setup
machine-mcp browser status
```

Load the printed unpacked-extension directory into the intended Chromium profile. Reload the extension after every Machine Bridge upgrade. The broker validates a versioned capability handshake, keeps pairing state local and owner-only, and does not return the pairing token through MCP.

Machine Bridge does not launch or identify a separate browser profile. It controls whichever profile contains the extension, including that profile's tabs and login state. Read [docs/LOCAL_AUTOMATION.md](docs/LOCAL_AUTOMATION.md) before enabling it.

## Durable work and local resources

Remote foreground process, shell, browser, and application calls are bounded to 85 seconds. Keep mutations and validation in independently terminal calls. A timeout is a protocol result, not proof that descendant cleanup has already completed; inspect `diagnose_runtime.runtime.processes` remotely (or `server_info.runtime.processes` over local stdio) when a heavy filesystem or process operation is still draining. Long, cleanup-sensitive, or remotely initiated workflows should use process sessions or managed jobs; managed jobs persist ordered argv steps and `finally_steps` under owner-only local state and continue across an MCP disconnect.

Credentials and files can be registered by alias without returning their contents through MCP:

```sh
machine-mcp resource add maintenance-key ~/.ssh/example_maintenance_ed25519
machine-mcp resource list
machine-mcp job submit plan.json
```

See [docs/MANAGED_JOBS.md](docs/MANAGED_JOBS.md) for integrity checks, recovery, redaction, cleanup, and residual risks.

## Operations

Common commands:

```text
machine-mcp
machine-mcp status
machine-mcp doctor
machine-mcp workspace show|set|reset
machine-mcp service status|install|start|stop|uninstall
machine-mcp account list|clients|revoke-client|add|role|enable|disable|rotate-password|remove
machine-mcp approval list|revoke|clear
machine-mcp browser status|setup|pair|path
machine-mcp resource add|list|check|remove
machine-mcp job submit|inspect|list|read|cancel
machine-mcp rotate-secrets
machine-mcp uninstall [--keep-worker] [--yes]
```

Autostart uses a macOS LaunchAgent, Linux `systemd --user`, or a least-privilege Windows logon task. State and logs are owner-only where the platform supports it. Structured events exclude arguments, results, credential values, and raw local paths by default. Read [docs/OPERATIONS.md](docs/OPERATIONS.md) and [docs/LOGGING.md](docs/LOGGING.md).

## Tool reference

The exact tool set depends on the effective policy and account role. Both transports consume the same catalog in `src/shared/tool-catalog.json`; the generated reference is [docs/TOOL_REFERENCE.md](docs/TOOL_REFERENCE.md).

Major groups include:

- workspace reads, writes, exact edits, and transactional patches;
- Git status, diff, log, and show with helper suppression and privacy bounds;
- direct argv execution, shell execution, and interactive process sessions;
- runtime diagnostics and structured project/capability discovery;
- managed jobs and registered local resources;
- supported application and browser operations.

## Development and verification

```sh
npm ci
npm run check:fast       # quiet-success local feedback; set MBM_CHECK_VERBOSE=1 only for live child logs
npm run check            # complete suite, equivalent to check:full
npm run worker:dry-run
npm audit --audit-level=high
npm audit --omit=dev --audit-level=high
npm pack --dry-run
```

The check plan is explicit in `scripts/check-plan.mjs`. macOS and Windows CI run the platform plan plus the installed-package smoke test. Linux CI runs the complete plan, including coverage, browser broker, package/install, stdio, Worker/OAuth, and real-browser navigation tests. Package audit, CodeQL, dependency review, governance, and OpenSSF Scorecard remain separate fail-closed jobs.

Testing details and design rules are in [docs/TESTING.md](docs/TESTING.md). Engineering invariants are in [docs/ENGINEERING.md](docs/ENGINEERING.md).

## Release boundary

Version 3 and later use a mandatory prerelease and soak path. Package work starts as `dev`, `beta`, or `rc`; it does not claim the stable version while candidate testing is still underway.

```sh
npm run release:candidate
# The owner runs the exact persistent activation command printed above:
npm run release:candidate:activate -- --allow-worker-deploy
# Activation requires device-authenticated relay readiness. One explicit authentication rejection may
# redeploy the same Worker once with the unchanged selected identity; it never rotates credentials.
# The login service is accepted only after a committed machine owner and the matching daemon
# publish the post-authentication, post-relay-probe readiness checkpoint.
# After the coding agent verifies the live Worker/daemon and records acceptance,
# the owner runs this from a real interactive terminal:
npm run prerelease:release -- --owner-terminal-confirm
# Explicit owner registry and live-install steps:
npm run prerelease:publish
npm run prerelease:install -- --allow-worker-deploy
```

Formal soak begins only after the exact published prerelease is installed and activated. Minimum soak is seven days for a major release, three days for a minor release, and one day for a patch. Every blocking fix creates a new prerelease and restarts the clock.

Stable promotion must retain the soaked package's functional digest. After the owner reports successful soak, the agent records the soak result and prepares and verifies the stable candidate. The owner then creates the final GitHub tag and Release from a real interactive terminal with `npm run release -- --owner-terminal-confirm`; npm stable publication is the separate explicit `npm run stable:publish` operation.

See [docs/RELEASING.md](docs/RELEASING.md).

## Documentation

- [System overview](docs/OVERVIEW.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Security policy](SECURITY.md)
- [Getting started](docs/GETTING_STARTED.md)
- [Operations](docs/OPERATIONS.md)
- [Testing](docs/TESTING.md)
- [Engineering](docs/ENGINEERING.md)
- [Project standards](docs/PROJECT_STANDARDS.md)
- [Audit record](docs/AUDIT.md)
- [Privacy hygiene](docs/PRIVACY.md)

## Uninstall

```sh
machine-mcp uninstall
npm uninstall -g machine-bridge-mcp
```

Use `--keep-worker` to retain deployed Workers while removing local state. Removal is fail-closed when service, daemon, job, lock, or state ownership cannot be verified safely.

## License

MIT
