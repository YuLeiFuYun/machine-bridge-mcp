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
  npx --yes npm@12.0.2 install --global npm@12.0.2
  npx --yes npm@12.0.2 install --global --omit=optional --allow-scripts=esbuild,workerd,sharp,fsevents machine-bridge-mcp@latest
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
npx --yes npm@12.0.2 install --global npm@12.0.2
npx --yes npm@12.0.2 install --global --omit=optional --allow-scripts=esbuild,workerd,sharp,fsevents machine-bridge-mcp@latest
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

When the relay must use a proxy but should not inherit an operating-system VPN/TUN path, set `MBM_RELAY_PROXY` to a dedicated HTTP(S) proxy endpoint. It takes precedence over `HTTPS_PROXY`/`HTTP_PROXY` and `NO_PROXY` for both the preferred WebSocket relay and signed HTTP fallback; a configured proxy failure never falls back to a direct relay connection. A common deployment is a loopback-only sidecar whose own upstream socket is pinned to the intended physical/network interface. Machine Bridge does not itself bind the sidecar's upstream socket, so pointing `MBM_RELAY_PROXY` at a remote proxy does not by itself bypass an operating-system tunnel. See [docs/OPERATIONS.md](docs/OPERATIONS.md).

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

For routine remote health checks, prefer `server_info` with `detail: "summary"`; the empty/default call remains full diagnostics and, for owner/full callers, includes a privacy-bounded durable continuity summary that survives Worker isolate replacement without retaining identities, call IDs, tool arguments, results, endpoints, or close reasons. For routine workspace inventory, `project_overview` also accepts `detail: "summary"`; it preserves policy/tool counts and top-level names/types without repeating exact tool arrays, account identity, routing fingerprints, or per-entry paths/sizes. Its empty/default call likewise remains full for compatibility. For remote calls, `server_info.authorization.effective_policy` and, when exact membership is needed, the full projection's `effective_tools` are authoritative. Daemon policy and tools describe only the local capability ceiling before account-role and host-side filtering.

`tools/list` is the authenticated account's current discovery catalog. Discovery instructions and tool descriptions carry execution/orchestration semantics, so both `server/discover` and `tools/list` advertise `ttlMs=0`. Current MCP 2026-07-28 remote discovery also advertises `tools.listChanged=true`: a client that opts into `toolsListChanged` through `subscriptions/listen` receives a correlated acknowledgement and level-trigger `notifications/tools/list_changed` event, then re-fetches `tools/list`. The request-scoped subscription remains open until explicit cancellation or the advertised bounded server lease expires; the lease is a fail-safe for HTTP disconnects that the Worker runtime cannot reliably observe and does not replace the initial level-trigger/refetch contract. Initialization-era 2025 compatibility retains `listChanged=false` because that protocol family uses different notification semantics. Every host-visible tool description carries `Tool schema generation N`; `server_info.tool_delivery` exposes the current `tool_schema_generation`, `tool_schema_server_version`, and `tool_list_ttl_ms`, while explicitly reporting that Machine Bridge cannot observe which schema generation an external host has actually cached. A generation change therefore requires the subscription/refetch path or another host-side schema refresh plus post-activation verification. Discovery is not authority: every `tools/call` is still intersected with the current end-to-end-ready daemon policy and tool ceiling, and fails retryably with `unavailable` when no daemon is ready. `server_info.tool_delivery` also distinguishes the advertised catalog from the currently effective daemon/account intersection. WebSocket is the preferred daemon transport: verified ready traffic resumes immediately, but reconnect attempt history resets only after five seconds of generation-stable ready uptime so a shorter ready/close flap keeps its prior exponential backoff position. It requests a protocol-level Ping after five seconds and gives an actually dispatched Ping its full ten-second Pong deadline, then uses one independent fifteen-second application-confirmation window before a ready WSS may be terminated as a transport black hole. A protocol Pong or explicit application `pong` during that second stage preserves WSS; ordinary tool/control inbound remains receive-side evidence and cannot clear transport suspicion, while local event-loop stalls cancel remote suspicion and use the separate recovery-grace path. The periodic application heartbeat remains twenty-five/seventy-five seconds after end-to-end readiness, and the Worker keeps a wider ninety-second fallback. WSS connect attempts have a thirty-second outer budget. Signed HTTPS is independent of that budget: on first-stage WSS suspicion the same root-certified ephemeral device identity prewarms HTTPS in standby, and a real WSS loss promotes that path to exact-generation takeover while aborting any obsolete standby request. Fallback requests bind the fixed route/origin/server/version, a short-lived nonce, timestamp, and exact body hash; they use a seven-second request deadline, twelve-second liveness window, one-second ordinary poll cadence, and a 750 ms minimum request-start interval. The first authenticated exchange enters probing immediately, so verified readiness requires at most two bounded exchanges rather than a separate challenge round trip. Candidate → probing → verified-ready handover prevents the Worker from dispatching until the daemon has processed `ready_ack` and returned sequenced `https_ready`; a same-instance takeover may retire a Worker-side zombie WSS only after the signed candidate preconditions pass. Both directions use bounded contiguous transport sequences, so a lost HTTP response retransmits the same transport envelope and duplicates are discarded before business handling; this does not restore MCP sessions, recovery GET, `Last-Event-ID`, or public result persistence. Same-instance `resume_calls` / `resume_calls_ack` remains authoritative for in-flight ownership. A planned daemon shutdown is a different boundary: before a ready runtime closes its relay it sends `daemon_draining`; the Worker settles calls still owned by that daemon with structured `daemon_planned_drain` recovery and acknowledges the drain. In-flight `read_job` is explicitly read-only recoverable with `recovery.mode=read_same_job` plus the original `job_id`; resume by reading that same job after reconnect. This does not transfer an executing call to a new daemon process, whose random instance identity remains intentionally distinct, and it cannot revive an external assistant turn that has already ended. The daemon sends `resume_calls_ack.missing_ids` only after replacement readiness, only for IDs absent from both its active-call set and unacknowledged-result ledger, and only while it still has fail-closed proof that missing ownership means the call did not execute locally. If a completed-but-unacknowledged result expires, `diagnose_runtime.runtime.relay_result_recovery.automatic_redelivery_safe` becomes false and missing-ID automatic redelivery is disabled rather than risking duplicate side effects. A safe proven-undelivered call may be retransmitted with the same call ID, arguments, authority, and a reduced timeout inside the original deadline; a call that may have executed is never automatically replayed. A new call may wait up to fifteen seconds for a verified daemon channel, but measured recovery time is deducted from that call's original execution budget instead of extending the hosted foreground envelope. Hosted synchronous calls otherwise retain their ordinary 20-second execution plus separate five-second Worker settlement margin; configurable browser/application tools retain 20-second ordinary defaults, compound `computer_observe` / `computer_act` retain 30-second defaults, and the explicit remote maximum remains 45 seconds. Remote `exec_command`, `run_process`, and `run_local_command` require a caller-held `idempotency_key`, commit a principal-bound one-step managed job, and remain recoverable through bounded same-response `read_job` follow-up when the current task needs terminal state. Hosted active `read_job` uses a server-side 40-second long-poll by default and returns earlier on meaningful job progress or terminal state; `wait_ms=0` requests an immediate checkpoint, while every public hosted call is capped at 60 seconds. The default remains 40 seconds: live hosted evidence carried both the default and an explicit 60-second read, while beta.151 later reproduced `mcp_network_error` on a second explicit 180-second read even though the Worker-to-daemon WebSocket remained continuously ready. Longer tasks therefore keep the same `job_id` and use another server-paced read rather than one overlong host request. This keeps long-task waiting inside Machine Bridge within the demonstrated per-call host lifetime; the 40-second interval also bounds interaction density to at most 150 reads for a synthetic unchanged 100-minute job, but that arithmetic does not prove that one assistant response can survive the aggregate duration or call count. If a real host/tool boundary ends a response, preserve the durable identifier and resume the same operation later rather than resubmitting its side effect. `start_process` remains daemon-lifetime interactive state; hosted `read_process` permits paced same-response follow-up, defaults an omitted relay `wait_ms` to the one-second blocking cap, and paces another would-block read inside the fifteen-second cooldown within that same MCP call until output/exit or the cooldown boundary. Active job/process reads do not force a user-turn handoff. Callers must not infer or preempt a host/tool deadline from elapsed wall-clock time: while calls continue to be accepted and the task still needs the result, bounded same-response follow-up may continue. Handoff is reserved for an actual observed host/tool boundary, required external input or authorization, or an explicit user checkpoint, while busy loops and status-surface substitution remain prohibited. The durable process façade preserves account/tool authority and delegated workspace sandbox rather than expanding privileges.

`full` is the daemon capability ceiling. An authenticated owner may exercise it without per-operation approval IDs. Delegated reviewer, editor, and operator accounts remain inside immutable role ceilings; out-of-role operations are denied rather than converted into a temporary elevation workflow. Process sessions, retained output, and managed jobs are additionally bound to account, client, and refresh-token family. See [local authorization](docs/LOCAL_AUTHORIZATION.md).

## Browser and application automation

Under canonical `full`, Machine Bridge can discover and operate supported local applications and can control the Chromium profile into which the packaged extension is loaded.

```sh
machine-mcp browser setup
machine-mcp browser status
```

Load the printed unpacked-extension directory into the intended Chromium profile. Reload the extension after every Machine Bridge upgrade. The broker validates a versioned capability handshake, keeps pairing state local and owner-only, and does not return the pairing token through MCP.

Machine Bridge does not launch or identify a separate browser profile. It controls whichever profile contains the extension, including that profile's tabs and login state. Because browser focus is shared machine state rather than hosted conversation identity, hosted browser content/action tools require an explicit `tab_id` from `browser_list_tabs`, and hosted browser `computer_observe` requires the same explicit target before snapshot creation. Read [docs/LOCAL_AUTOMATION.md](docs/LOCAL_AUTOMATION.md) before enabling it.

For stateful GUI trajectories, owner/full callers can use the higher-level `computer_observe` / `computer_act` pair. `computer_observe` creates one bounded browser or application snapshot with semantic evidence and native MCP image content when available; `computer_act` consumes the exact snapshot as one-shot mutation authority, dispatches at most once, observes post-state, and reports dispatch/effect settlement separately so ambiguous mutations are not automatically replayed. Their `timeout_seconds` value is one end-to-end budget for the compound operation rather than a fresh timeout for each internal screenshot, Accessibility/DOM preflight, dispatch, verification, or post-observation stage. See [docs/COMPUTER_USE.md](docs/COMPUTER_USE.md).

## Durable work and local resources

Remote request-owned foreground work uses the hosted reply-safe budgets described above; configurable browser/application calls may explicitly request at most 45 seconds, while remote `exec_command`, `run_process`, and `run_local_command` are durable one-step jobs with a 10-second acceptance envelope and an independent 1–600-second child execution budget after admission. A continuous process that legitimately needs more than 600 seconds must use `start_job`: managed-job main/finally steps default to 600 seconds and may explicitly request up to 21,600 seconds (six hours), with resource admission occurring before that execution timer begins. The Worker retains separate settlement ownership for five additional seconds, but neither that margin nor its internal stream metrics prove that an external MCP host consumed the terminal frame. Keep unrelated mutations and validation independently terminal, but batch one coherent non-interactive command sequence into a repository umbrella command or multi-step `start_job` instead of creating one host-visible one-step job per tiny probe. A timeout is a protocol result, not proof that descendant cleanup has already completed; a remote owner can inspect `diagnose_runtime.runtime.processes`, while local stdio exposes `server_info.runtime.processes`. Non-owner accounts receive authority-scoped readiness rather than machine-wide process activity. Remote process sessions are for interactive stdin or incremental output, not a substitute for ordinary durable work: hosted `read_process` reports `status_polling_mode=paced_followup`, caps the actual output/exit blocking wait at one second, and paces a repeated would-block read inside the fifteen-second cooldown within that same MCP call until output/exit or the cooldown boundary instead of returning a rapid running checkpoint. When the current task needs more output or terminal state, the same session may be read again in the same assistant response without busy-looping. Non-interactive work should use durable `run_process`/`read_job`; multi-step, cleanup-sensitive, or daemon-restart-surviving workflows should use managed jobs, which persist ordered argv steps and `finally_steps` under owner-only local state and continue across an MCP disconnect. Hosted durable acceptance returns `job_id`, `recovery_key`, and `control_key`: preserve them together, use the read capability for `read_job` and `depends_on`, and use the control capability for `cancel_job`; a bare job ID is not remote recovery authority. On an MCP Apps-capable host, an active `start_job` may report `ui_monitor_candidate=true` plus `ui_monitor_render_tool=render_job_monitor`, but it remains a data/execution tool and carries no UI template. Call `render_job_monitor` once with the exact accepted `job_id` + `recovery_key`; the Worker verifies read authority, mounts the static Job Monitor resource, and returns a fresh random `ui_monitor_id`. Then issue `read_job` with the same `job_id`, `recovery_key`, and `ui_monitor_id`. Only that exact active read may report `ui_monitor_claimed=true`, `status_polling_mode=ui_monitor`, `host_turn_handoff_recommended=true`, and `follow_up_read_required=false`, after the mounted View has completed its MCP Apps handshake, observed `hostCapabilities.serverTools`, and claimed the same monitor instance. The monitor then continues the same capability-bound `read_job` sequence through the host bridge; an older View claim cannot transfer a newer turn because its monitor ID differs. Unsupported hosts, or hosts that can render MCP Apps but cannot proxy app-origin server tools, retain the existing contract: active relay-origin `read_job` reports `status_polling_mode=bounded_followup` and `host_turn_handoff_recommended=false`. Its hosted default is a 40-second server-side long-poll, so an unchanged long job occupies one bounded live MCP response rather than forcing rapid host-side checkpoints. Terminal settlement returns on the next bounded five-second internal poll; nonterminal status/phase/dependency progress is coalesced for at least 30 seconds by default, and `current_step`-only churn does not wake the hosted call. `wait_ms=0` is available only when an immediate checkpoint is actually wanted, and public hosted `wait_ms` is capped at 60 seconds; longer work continues through another paced read of the same `job_id` plus its preserved `recovery_key`. At the default, a synthetic 100-minute unchanged job has an anti-amplification ceiling of 150 status reads, while continuously changing nonterminal progress is separately bounded by the 30-second coalescing floor; those are density estimates rather than proof of aggregate same-response host lifetime. A known job may be followed through paced same-response `read_job` calls while those calls continue to be accepted and the task still needs the result; after an actual host/tool boundary, later recovery must continue from the same `job_id`. Completed one-step process carriers are lower-priority terminal retention than explicit managed jobs, so removable helper history is reclaimed first under the 512-state durable cap. A hosted helper whose current response still requires `read_job` continuation keeps stronger private recovery priority for the fixed thirty-minute grace because Machine Bridge explicitly told the caller to follow that durable handle. Once Machine Bridge produces a terminal hosted response for the helper—during initial settlement or a later `read_job`—the private marker drops to the bounded newest-16 transient delivery reserve because only outer response-delivery uncertainty remains. The daemon/local `list_jobs.jobs` inventory keeps a 50-record durable-first primary window and `recent_process_recovery` remains capped at 16 additional authority-visible handles for local administration. The hosted Worker projection deliberately removes those job IDs/names/handles and exposes aggregate retained/capacity/activity state only, so one hosted conversation cannot discover another workflow's durable handle through shared owner inventory. Hosted recovery therefore depends on the capability returned by the original acceptance; legacy or lost-capability jobs require local CLI/stdio administration. Owner/local `capacity` diagnostics expose only coarse `durable_terminal` and `transient_terminal` counts; this improves recovery visibility without pretending that Worker acknowledgement proves an external host rendered the final assistant message. Long cross-job workflows can declare `depends_on`: the dependent job remains pre-execution `queued/dependency_wait` without spawning its main child until all upstream jobs succeed, and an upstream failure settles `dependency_failed` instead of leaving a file-poll loop waiting for an artifact that can never appear. Active/staged dependency plans pin referenced retained results until the dependency-bearing plan is terminal. A valid `job_id` that is no longer retained returns typed `not_found`; that absence is not proof that its underlying side effect never executed. `list_jobs` remains inventory rather than a substitute polling loop, and `server_info`/`diagnose_runtime` remain diagnostic surfaces rather than alternate wait channels. Elapsed minutes are not evidence that an external host deadline is near; return the durable recovery identifier for a later turn only after an actual host/tool boundary is observed, external input or authorization is required, or the user explicitly requested a checkpoint.

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
# Repository automation then runs the exact persistent activation command without another conversational approval:
npm run release:candidate:activate -- --allow-worker-deploy
# Activation requires device-authenticated relay readiness. One explicit authentication rejection may
# redeploy the same Worker once with the unchanged selected identity; it never rotates credentials.
# The login service is accepted only after a committed machine owner and the matching daemon
# publish the post-authentication, post-relay-probe readiness checkpoint.
# After the coding agent verifies the live Worker/daemon and records acceptance,
# GitHub source publication proceeds automatically once release-integrity gates pass:
npm run prerelease:release
# npm publication is the sole explicit authorization boundary:
npm run prerelease:publish -- --owner-confirm
# Registry-verified installation/activation then proceeds automatically:
npm run prerelease:install -- --allow-worker-deploy
```

The full release gate starts with a real source-tree SBOM check. The GitHub and npm publication commands also rebuild ignored `node_modules` from the committed lockfile through the integrity-pinned hardened npm before their release verification, so publication does not rely on a stale ambient dependency tree.

Formal soak begins only after the exact published prerelease is installed and activated. Minimum soak is seven days for a major release, three days for a minor release, and one day for a patch. Every blocking fix creates a new prerelease and restarts the clock.

Stable promotion must retain the soaked package's functional digest. After the owner reports successful soak, the agent records the soak result and prepares and verifies the stable candidate. Final GitHub tag/Release publication uses `npm run release` automatically once its gates pass; npm stable publication is the sole separately authorized operation and uses `npm run stable:publish -- --owner-confirm`.

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
