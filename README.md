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

Expected file-state failures are machine-readable. File mutations return stable codes such as `conflict`, `not_found`, `invalid_request`, and `limit_exceeded`, with bounded `details.reason` tokens where useful. Conflict responses should trigger a fresh read and reconciliation rather than a blind retry; public errors do not include file contents, compared hashes, or hidden paths.

```text
Hosted MCP client
  -> HTTPS + OAuth 2.1 / PKCE
  -> Cloudflare Worker + Durable Object
  -> root-certified ephemeral P-256 daemon channel (WebSocket primary; signed HTTPS fallback)
  -> request-level effective authority and object ownership
  -> local runtime

Local MCP client
  -> stdio
  -> local runtime
```

The complete component and trust-boundary diagram is in [docs/OVERVIEW.md](docs/OVERVIEW.md).

## MCP protocol model

Machine Bridge uses MCP `2026-07-28` as its native protocol. Stdio is current-only. Remote HTTP also accepts bounded, stateless initialization compatibility for `2025-06-18` and `2025-11-25` so older hosts can migrate without restoring the removed session model.

- **Native current requests are self-describing.** Protocol version and client capabilities travel in `_meta`; HTTP requests also mirror the version, method, and applicable name/parameter values into validated headers. Native `2026-07-28` clients use `server/discover` and do not create an MCP protocol session.
- **Remote initialization compatibility is stateless.** Compatible HTTP clients may use `initialize`, `notifications/initialized`, `ping`, `tools/list`, and `tools/call`; tool calls still execute through the current request-scoped controller. Compatibility does not create or accept `Mcp-Session-Id`, recovery GET, `Last-Event-ID`, persisted replay/delivery state, or initialization-owned authorization state.
- **HTTP streams are request-scoped and non-resumable.** Closing the response stream cancels that request. There is no recovery GET, SSE event-ID replay, or session-bound delivery store.
- **Removed session/replay semantics never execute.** Unsupported protocol dates and requests for the retired session/recovery model receive bounded rejection or upgrade guidance rather than legacy state or replay behavior.
- **Transport identity is not conversation identity.** Stdio and HTTP processes/connections may interleave unrelated requests; state that spans calls must use an explicit tool, job, process-session, or resource identifier.

The Worker validates the actual `/mcp` Origin, mirrored headers, role-filtered tool visibility, and raw arguments before routing or daemon dispatch. Tool arguments use one bounded JSON Schema 2020-12 contract in both Worker and local runtime; validation has fixed schema and runtime-work budgets and never echoes rejected values. Request-stream cancellation uses a private random capability stripped from public requests and forwards no OAuth/DPoP credential.

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

For routine remote health checks, prefer `server_info` with `detail: "summary"`; the empty/default call remains full diagnostics. For routine workspace inventory, `project_overview` also accepts `detail: "summary"`; it preserves policy/tool counts and top-level names/types without repeating exact tool arrays, account identity, routing fingerprints, or per-entry paths/sizes. Its empty/default call likewise remains full for compatibility. For remote calls, `server_info.authorization.effective_policy` and, when exact membership is needed, the full projection's `effective_tools` are authoritative. Daemon policy and tools describe only the local capability ceiling before account-role and host-side filtering.

`tools/list` is a stable discovery catalog for the authenticated account role. A brief relay interruption does not withdraw tool definitions or require a tools-list-changed notification. Discovery is not authority: every `tools/call` is still intersected with the current end-to-end-ready daemon policy and tool ceiling, and fails retryably with `unavailable` when no daemon is ready. `server_info.tool_delivery` distinguishes the stable advertised catalog from the currently effective daemon/account intersection. WebSocket is the preferred daemon transport: it requests a protocol-level Ping after five seconds, gives an actually dispatched Ping its full ten-second Pong deadline, then uses one independent fifteen-second application-confirmation window before a ready WSS may be terminated as a transport black hole. A protocol Pong or explicit application `pong` during that second stage preserves WSS; ordinary tool/control inbound remains receive-side evidence and cannot clear transport suspicion, while local event-loop stalls cancel remote suspicion and use the separate recovery-grace path. The periodic application heartbeat remains twenty-five/seventy-five seconds after end-to-end readiness, and the Worker keeps a wider ninety-second fallback. WSS connect attempts have a thirty-second outer budget. Signed HTTPS is independent of that budget: on first-stage WSS suspicion the same root-certified ephemeral device identity prewarms HTTPS in standby, and a real WSS loss promotes that path to exact-generation takeover while aborting any obsolete standby request. Fallback requests bind the fixed route/origin/server/version, a short-lived nonce, timestamp, and exact body hash; they use a seven-second request deadline, twelve-second liveness window, one-second ordinary poll cadence, and a 750 ms minimum request-start interval. The first authenticated exchange enters probing immediately, so verified readiness requires at most two bounded exchanges rather than a separate challenge round trip. Candidate → probing → verified-ready handover prevents the Worker from dispatching until the daemon has processed `ready_ack` and returned sequenced `https_ready`; a same-instance takeover may retire a Worker-side zombie WSS only after the signed candidate preconditions pass. Both directions use bounded contiguous transport sequences, so a lost HTTP response retransmits the same transport envelope and duplicates are discarded before business handling; this does not restore MCP sessions, recovery GET, `Last-Event-ID`, or public result persistence. Same-instance `resume_calls` / `resume_calls_ack` remains authoritative for in-flight ownership. The daemon sends `resume_calls_ack.missing_ids` only after replacement readiness and only for IDs absent from both its active-call set and unacknowledged-result ledger. Those proven-undelivered calls may be retransmitted with the same call ID, arguments, authority, and a reduced timeout inside the original deadline; a call that may have executed is never automatically replayed. A new call may wait up to fifteen seconds for a verified daemon channel, but measured recovery time is deducted from that call's original execution budget instead of extending the hosted foreground envelope. Hosted synchronous calls otherwise retain their ordinary 20-second execution plus separate five-second Worker settlement margin; configurable browser/application tools retain 20-second ordinary defaults, compound `computer_observe` / `computer_act` retain 30-second defaults, and the explicit remote maximum remains 45 seconds. Remote `exec_command`, `run_process`, and `run_local_command` require a caller-held `idempotency_key`, commit a principal-bound one-step managed job, and remain recoverable with a `read_job` status checkpoint; an active checkpoint yields the hosted turn instead of being polled to terminal state. `start_process` remains daemon-lifetime interactive state, while hosted `read_process` is a single live-session status checkpoint per assistant response: a blocking wait lasts at most one second, repeated would-block waits are throttled by the fifteen-second cooldown, and any result with `running=true` hands the turn back even when new output was returned. The durable process façade preserves account/tool authority and delegated workspace sandbox rather than expanding privileges.

`full` is the daemon capability ceiling. An authenticated owner may exercise it without per-operation approval IDs. Delegated reviewer, editor, and operator accounts remain inside immutable role ceilings; out-of-role operations are denied rather than converted into a temporary elevation workflow. Process sessions, retained output, and managed jobs are additionally bound to account, client, and refresh-token family. See [local authorization](docs/LOCAL_AUTHORIZATION.md).

## Browser and application automation

Under canonical `full`, Machine Bridge can discover and operate supported local applications and can control the Chromium profile into which the packaged extension is loaded.

```sh
machine-mcp browser setup
machine-mcp browser status
```

Load the printed unpacked-extension directory into the intended Chromium profile. Reload the extension after every Machine Bridge upgrade. The broker validates a versioned capability handshake, keeps pairing state local and owner-only, and does not return the pairing token through MCP.

Machine Bridge does not launch or identify a separate browser profile. It controls whichever profile contains the extension, including that profile's tabs and login state. Read [docs/LOCAL_AUTOMATION.md](docs/LOCAL_AUTOMATION.md) before enabling it.

For stateful GUI trajectories, owner/full callers can use the higher-level `computer_observe` / `computer_act` pair. `computer_observe` creates one bounded browser or application snapshot with semantic evidence and native MCP image content when available; `computer_act` consumes the exact snapshot as one-shot mutation authority, dispatches at most once, observes post-state, and reports dispatch/effect settlement separately so ambiguous mutations are not automatically replayed. Their `timeout_seconds` value is one end-to-end budget for the compound operation rather than a fresh timeout for each internal screenshot, Accessibility/DOM preflight, dispatch, verification, or post-observation stage. See [docs/COMPUTER_USE.md](docs/COMPUTER_USE.md).

## Durable work and local resources

Remote request-owned foreground work uses the hosted reply-safe budgets described above; configurable browser/application calls may explicitly request at most 45 seconds, while remote `exec_command`, `run_process`, and `run_local_command` are durable one-step jobs with a 10-second acceptance envelope and an independent 1–600-second child execution budget after admission. The Worker retains separate settlement ownership for five additional seconds, but neither that margin nor its internal stream metrics prove that an external MCP host consumed the terminal frame. Keep mutations and validation in independently terminal calls. A timeout is a protocol result, not proof that descendant cleanup has already completed; a remote owner can inspect `diagnose_runtime.runtime.processes`, while local stdio exposes `server_info.runtime.processes`. Non-owner accounts receive authority-scoped readiness rather than machine-wide process activity. Remote process sessions are for interactive stdin or incremental output, not a substitute for waiting synchronously on ordinary long work: hosted `read_process` is a status checkpoint, its blocking wait is at most one second, repeated would-block waits on the same live session are throttled for fifteen seconds, and a hosted assistant response should call it at most once for a live session before returning any `running=true` session/progress to the user, even when that checkpoint returned new output. Non-interactive work should use durable `run_process`/`read_job`; multi-step, cleanup-sensitive, or daemon-restart-surviving workflows should use managed jobs, which persist ordered argv steps and `finally_steps` under owner-only local state and continue across an MCP disconnect. Durable acceptance is also a hosted-turn handoff: if one `read_job` checkpoint still reports an active job, return its `job_id`, status, and current phase to the user rather than polling it to terminal state in the same assistant response. `list_jobs` is an inventory checkpoint under the same rule, not a substitute polling loop for waiting on active work. More generally, hosted read-only status/diagnostic surfaces such as `server_info` or `diagnose_runtime` are evidence checkpoints rather than alternate wait loops for the same background state.

On macOS, authorized remote activity uses a bounded idle-sleep assertion so ordinary system Idle Sleep does not suspend an active remote workflow. Relay handlers share the assertion for their execution lifetime plus a fixed thirty-minute rolling inactivity grace; each new authorized remote activity cancels a pending release and restarts the full grace after the last concurrent handler settles. An admitted remote process session extends daemon-side ownership until its child settles, and an account-backed managed-job runner owns a runner-bound assertion from confirmed claim through terminal persistence. Local managed jobs do not acquire the remote-continuity assertion. These protections do not override explicit sleep or lid-close behavior.

When `run_process` or `exec_command` returns a child exit code and bounded stdout/stderr, the local process did run. For nested tools such as `ssh`, a remote forced-command usage message or command allowlist is therefore evidence from the target-side authorization layer, not evidence that Machine Bridge blocked process execution. Diagnose and change the narrowest failing layer instead of widening the `full` profile, which already removes Machine Bridge's own shell and path restrictions.

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
- Git status, diff, log, and show with helper suppression and privacy bounds, plus structured staged-only `git_commit`;
- direct argv execution, shell execution, and interactive process sessions;
- runtime diagnostics and structured project/capability discovery;
- managed jobs and registered local resources;
- supported application/browser operations and snapshot-bound Computer Use.

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
# The coding agent rechecks source/package identity and disposable installability before live activation:
node scripts/start-release-candidate.mjs --install-only
# After explicit owner authorization, the owner or authorized agent runs the exact persistent activation command:
npm run release:candidate:activate -- --allow-worker-deploy
# Activation requires device-authenticated relay readiness. One explicit authentication rejection may
# redeploy the same Worker once with the unchanged selected identity; it never rotates credentials.
# The login service is accepted only after a committed machine owner and the matching daemon
# publish the post-authentication, post-relay-probe readiness checkpoint.
# After the coding agent verifies the live Worker/daemon and records acceptance,
# source publication requires explicit owner authorization; a TTY is optional:
npm run prerelease:release -- --owner-confirm
# Registry publication and live install are separately authorized operations:
npm run prerelease:publish
npm run prerelease:install -- --allow-worker-deploy
```

Formal soak begins only after the exact published prerelease is installed and activated. Minimum soak is seven days for a major release, three days for a minor release, and one day for a patch. Every blocking fix creates a new prerelease and restarts the clock.

Stable promotion must retain the soaked package's functional digest. After the owner reports successful soak, the agent records the soak result and prepares and verifies the stable candidate. Final GitHub tag/Release publication requires explicit owner authorization and uses `npm run release -- --owner-confirm`; npm stable publication is the separate explicitly authorized `npm run stable:publish` operation.

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
