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
| Contribute code | Use the contribution guide in the source repository |

Support boundaries are defined in [SUPPORT.md](SUPPORT.md). Contribution, conduct, governance, architecture, and test-design material is maintained in the source repository and is intentionally not part of the consumer package.

## What it provides

- one transport-independent local runtime for remote OAuth and local stdio clients;
- policy profiles with shared local/Worker enforcement contracts;
- bounded file, patch, Git, process, diagnostic, application, browser, and managed-job tools;
- account roles whose authority is intersected with the connected daemon policy;
- root-certified ephemeral daemon sessions, trusted OAuth client binding, refresh-family ownership, and non-escalatable account roles;
- structured, privacy-conscious lifecycle events, a worker-thread-isolated self-verifying audit hash chain with documented same-user rewrite limits, and stable error codes;
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

Machine Bridge uses MCP `2026-07-28` for both stdio and remote HTTP. There is no successful initialization-era adapter: every supported request is current and request-scoped.

- **Native current requests are self-describing.** Protocol version and client capabilities travel in `_meta`; HTTP requests also mirror the version, method, and applicable name/parameter values into validated headers. Current `2026-07-28` clients use `server/discover` and do not create an MCP protocol session.
- **Removed protocol requests fail closed.** `initialize`, `Mcp-Session-Id`, `Last-Event-ID`, and other explicit removed session/replay markers do not dispatch tool work and receive bounded upgrade guidance. Remote `/mcp` is POST-only; GET remains a 405 method rejection. Obsolete clients must reconnect with MCP `2026-07-28`.
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

On first remote start, Machine Bridge creates workspace-scoped state, signs in with `cf auth login --scopes account-settings.read user-details.read workers-scripts.read workers-scripts.write workers-scripts.bind workers-routes.read workers-routes.write workers-observability.read workers-observability.write offline` when needed, builds and deploys one stable Worker through `cf`, creates the initial `owner` account, installs user-level autostart unless disabled, starts the outbound daemon connection, and prints the MCP URL and one-time owner password.

Machine Bridge, including Worker deployment, requires Node.js 26 or later. `cf` has its own login, separate from Wrangler. Before unattended activation, complete `cf auth login` in an ordinary owner terminal; for multiple Cloudflare accounts, set `CLOUDFLARE_ACCOUNT_ID` to the existing Worker's account. The pinned deployment tools stay in Machine Bridge's private toolchain, outside the consumer runtime dependencies. Native `cloudflare.config.ts` controls deployment; the retained `wrangler.jsonc` is used for deterministic runtime type generation and legacy maintenance commands.

Use the printed endpoint in the hosted client:

```text
https://<worker>.<account>.workers.dev/mcp
```

Remote readiness is end-to-end. A daemon becomes available only after a Worker probe traverses the same authenticated local dispatch and result-delivery path used by real tool calls. A replacement daemon is verified before it displaces a healthy incumbent.

When the relay must use a proxy but should not inherit an operating-system VPN/TUN path, set `MBM_RELAY_PROXY` to a dedicated HTTP(S) proxy endpoint. By default it takes precedence over `HTTPS_PROXY`/`HTTP_PROXY` and `NO_PROXY` for both the preferred WebSocket relay and signed HTTP fallback; a configured proxy failure never silently retries the same transport directly. Deployments that need the HTTPS fallback in a different application-layer fault domain may also set `MBM_RELAY_FALLBACK_PROXY`: a non-empty value selects an explicit fallback-only HTTP(S) proxy, while an explicitly empty value restores standard `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` resolution for the fallback without changing the WebSocket route. A common primary deployment is a loopback-only sidecar whose own upstream socket is pinned to the intended physical/network interface. Machine Bridge does not itself bind either route below the application layer, so a `system-network-stack` fallback may still be intercepted by an operating-system VPN/TUN. See [docs/OPERATIONS.md](docs/OPERATIONS.md).

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

`tools/list` is the authenticated account's discovery catalog. Both `server/discover` and `tools/list` advertise `ttlMs=0`, and every host-visible tool description carries `Tool schema generation N`. Remote discovery supports `tools.listChanged=true`: `subscriptions/listen` acknowledges `toolsListChanged`, emits a level-trigger `notifications/tools/list_changed`, and stays open until cancellation or its bounded lease expires. Clients re-fetch the catalog; the server cannot prove which generation a host cached. Discovery does not grant authority: calls still require the current account/ready-daemon intersection.

WebSocket is preferred. An actually dispatched Ping has a ten-second Pong deadline, followed by one independent fifteen-second application-confirmation window. A protocol Pong or explicit application `pong` during that second stage preserves WSS. Local event-loop stalls use a separate recovery path. WSS connect attempts have a thirty-second outer budget. Healthy WSS keeps signed HTTPS fallback stopped; suspicion permits standby prewarming, and actual loss permits takeover of that exact generation. The daemon sends `resume_calls_ack.missing_ids` only after replacement readiness and only with fail-closed proof that absent ownership means non-execution. A possibly executed call is never automatically replayed. See [architecture](https://github.com/YuLeiFuYun/machine-bridge-mcp/blob/main/docs/ARCHITECTURE.md#daemon-reconnect-and-replacement) for transport sequencing, deadlines, and diagnostics.

Planned shutdown sends `daemon_draining` before relay close. An interrupted `read_job` returns `recovery.mode=read_same_job`; preserve its `job_id` and `recovery_key` and read that same job after reconnect. Replacement does not transfer ordinary executing calls to a new daemon.

Hosted synchronous calls otherwise retain their ordinary 20-second execution plus separate five-second Worker settlement margin. Configurable browser/application tools use 20-second defaults; compound `computer_observe` / `computer_act` retain 30-second defaults, with a 45-second explicit maximum. Durable process acceptance and continuation have separate budgets below. These limits do not establish external host receipt or a whole-assistant-turn deadline.

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

Remote `exec_command`, `run_process`, and `run_local_command` require a caller-held `idempotency_key` and become principal-bound one-step jobs before execution. Their acceptance envelope is ten seconds; child execution is independently bounded to 1–600 seconds after resource admission. Use `start_job` for a continuous command needing more time: main/finally steps default to 600 seconds and may request up to 21,600 seconds (six hours). Batch coherent non-interactive work into one plan or repository umbrella command. Process sessions serve interactive stdin/incremental output and retain daemon-lifetime ownership; hosted `read_process` reports `status_polling_mode=paced_followup`, with a one-second actual blocking cap and a fifteen-second would-block cooldown.

Preserve `job_id`, `recovery_key`, and `control_key` from acceptance. Reads/dependencies require the recovery capability; cancellation requires the control capability. A bare ID is not hosted authority. When terminal state is needed, continue bounded same-response `read_job` follow-up: active reads report `status_polling_mode=bounded_followup` and `host_turn_handoff_recommended=false`. The default long-poll is 40 seconds, terminal checks are bounded to five-second intervals, and nonterminal progress is coalesced for at least 30 seconds; step-name changes alone do not wake a hosted read. Explicit `wait_ms=0` requests a checkpoint and the public maximum is 60 seconds. Do not busy-loop or substitute diagnostic calls for known-job reads. Elapsed minutes do not justify handoff; after an actual host/tool boundary, recover the same job instead of repeating its side effect.

An active `start_job` may offer a Job Monitor on an MCP Apps-capable host. Polling ownership is separate from task ownership: if remaining work needs the result, keep following `read_job`. Otherwise render once with the accepted `job_id`, `recovery_key`, and `ui_monitor_id`, then read with those same values to verify the View claim. A claimed ordinary job reports `status_polling_mode=ui_monitor`, `follow_up_read_required=false`, and `host_turn_handoff_recommended=false`. Only an explicit `continuation_mode=task_supervisor` plan that already owns all remaining noninteractive work may recommend handoff; completeness remains an owner/caller semantic assertion. Monitor failures never resubmit execution.

The retained-state cap is 512. A hosted helper awaiting its promised terminal response is non-evictable during the fixed 24-hour undelivered-result grace; a store with no removable slot rejects new work with retryable `limit_exceeded`. After terminal delivery, helpers have a bounded newest-16/thirty-minute reserve and lower eviction priority than explicit durable history. Delegated one-step pending recovery is capped at 16 records per account ID plus account version across all OAuth clients and refresh families, checked before new state or process launch; a valid same-key replay adds no slot, while a statusless directory must pass admission again. Local CLI/stdio retains detailed inventory; hosted `list_jobs` exposes aggregates, so lost capabilities require local administration. A retained-record `not_found` does not prove non-execution.

Jobs can declare `depends_on`: the dependent remains `queued/dependency_wait` before main execution, upstream failure yields `dependency_failed`, and active/staged dependencies protect referenced results. Register secrets as local resource aliases and put idempotent cleanup in `finally_steps`. Timeout or cancellation alone does not prove process-tree settlement. See [managed jobs](docs/MANAGED_JOBS.md) for examples, retention, recovery, and privacy boundaries.

The repository-tracked `workflow-bundle.json` is the project-native lifecycle authority for local readiness. Its `project-native:npm:check:fast` and `project-native:npm:check:full` stages must remain `sandbox: required`; a machine-local or untracked lifecycle file must not silently lower high-risk containment. Release architecture checks enforce both Git tracking and those required Seatbelt modes, so the job-local continuation contract above is validated under the same repository-owned verification authority used for the candidate.

The Job Monitor is deliberately a status surface, not a duplicate result viewer. Its app-only reads expose only bounded lifecycle state; command output, command text, paths, nested step results, and recovery/control capabilities remain on the normal managed-job result path. The `recovery_key` is present in the render input only because it is the View's read authority and is cleared from View memory on teardown. If optional monitor coordination storage is unavailable after `start_job` or `read_job` has already succeeded, Machine Bridge keeps the durable job result authoritative and falls back to normal model-side continuation rather than reporting a new job failure.

On macOS, authorized remote activity uses a bounded idle-sleep assertion so ordinary system Idle Sleep does not suspend an active remote workflow. Relay handlers share the assertion for their execution lifetime plus a fixed thirty-minute rolling inactivity grace; each new authorized remote activity cancels a pending release and restarts the full grace after the last concurrent handler settles. An admitted remote process session extends daemon-side ownership until its child settles, and an account-backed managed-job runner owns a runner-bound assertion from confirmed claim through terminal persistence. Local managed jobs do not acquire the remote-continuity assertion. These protections do not override explicit sleep or lid-close behavior.

When `run_process` or `exec_command` returns a child exit code and bounded stdout/stderr, the local process did run. For nested tools such as `ssh`, a remote forced-command usage message or command allowlist is therefore evidence from the target-side authorization layer, not evidence that Machine Bridge blocked process execution. Diagnose and change the narrowest failing layer instead of widening the `full` profile, which already removes Machine Bridge's own shell and path restrictions.

Credentials and files can be registered by alias so the injection operation does not place their contents in MCP arguments or echo them in its result:

```sh
machine-mcp resource add maintenance-key ~/.ssh/example_maintenance_ed25519
machine-mcp resource list
machine-mcp job submit plan.json
```

See [docs/MANAGED_JOBS.md](docs/MANAGED_JOBS.md) for integrity checks, recovery, redaction, cleanup, and residual risks.
For browser or application injection, the destination receives the content by design and can copy, render, or transmit it; later observations of that destination can therefore expose content it now holds.

## Operations

Common commands:

```text
machine-mcp
machine-mcp status
machine-mcp doctor
machine-mcp workspace show|set|reset
machine-mcp idle-sleep show|set MODE
machine-mcp service status|install|start|stop|uninstall
machine-mcp account list|clients|revoke-client|add|role|enable|disable|rotate-password|remove
machine-mcp browser status|setup|pair|reset|path
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

In a source checkout, the repository check plan defines the fast, full, and platform verification waves. macOS and Windows CI run the platform plan plus the installed-package smoke test. Linux CI runs the complete plan, including coverage, browser broker, package/install, stdio, Worker/OAuth, and real-browser navigation tests. Package audit, CodeQL, dependency review, governance, and OpenSSF Scorecard remain separate fail-closed jobs.

Detailed test design and engineering invariants are source-repository maintenance material; they are not installed with the consumer package.

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

Detailed release-governance instructions are source-repository maintenance material; the installed package retains only the release helpers required by the supported release and activation workflows.

## Documentation

- [System overview](docs/OVERVIEW.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Security policy](SECURITY.md)
- [Getting started](docs/GETTING_STARTED.md)
- [Client integration](docs/CLIENTS.md)
- [Operations](docs/OPERATIONS.md)
- [Upgrading](docs/UPGRADING.md)
- [Computer use](docs/COMPUTER_USE.md)
- [Managed jobs](docs/MANAGED_JOBS.md)
- [Audit status](docs/AUDIT.md)
- [Privacy hygiene](docs/PRIVACY.md)

Architecture, engineering, testing, project-standard, release-governance, contribution, conduct, and governance documents remain available in the source repository but are not part of the npm consumer payload.

## Uninstall

```sh
machine-mcp uninstall
npm uninstall -g machine-bridge-mcp
```

Use `--keep-worker` to retain deployed Workers while removing local state. Removal is fail-closed when service, daemon, job, lock, or state ownership cannot be verified safely.

## License

MIT
