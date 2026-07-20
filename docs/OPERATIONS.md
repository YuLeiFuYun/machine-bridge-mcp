# Operations

## Health and diagnosis

```sh
machine-mcp status
machine-mcp doctor
machine-mcp service status
```

`status` prints redacted profile state and verifies the deployed Worker version. Resource source paths remain redacted. `doctor` checks Node.js, the package-installed Wrangler binary, Cloudflare login, Worker health, and the same fixed local filesystem/process/shell/job-storage/resource probes exposed by `diagnose_runtime`. Public `/healthz` output contains only server identity and version; daemon details require an authenticated `server_info` call.

### Worker deployment and health convergence

Wrangler upload and public health verification are two separate observations. Once Wrangler reports a successful deployment and supplies the `workers.dev` URL, Machine Bridge immediately records that URL together with the exact deployment fingerprint and package version. It then verifies `/healthz` through the standard `HTTPS_PROXY`/`HTTP_PROXY` and `NO_PROXY` environment route. If that secondary probe times out or encounters a proxy, TLS, network, or temporary HTTP 5xx failure, startup stops with an actionable error, but the successful deployment evidence remains. The next ordinary start verifies the same Worker and does not repeat the upload.

Automatic redeployment is limited to bounded health evidence that the recorded endpoint is genuinely stale: a persistent package-version mismatch, an unexpected Machine Bridge identity, or a persistent `404`/`410`. Unreachability is not proof of absence. `--force-worker` remains the explicit override when an operator deliberately wants an upload despite matching state.

Each canonical workspace has one stable Worker name. A command that supplies a different `--worker-name` after initialization is rejected unless `--force-worker` is present. A name such as `mbm-example-r2` is a separate Cloudflare Worker, not a revision of `mbm-example`. A different `--workspace` is also a separate identity by design; Windows junctions and symbolic links are resolved before hashing. A transcript that runs `machine-mcp` and later runs `machine-mcp --workspace OTHER_PATH` does not by itself prove a same-workspace duplicate. Compare `machine-mcp workspace show`, `machine-mcp status`, the canonical workspace path, and the recorded Worker URL first. If an older release already created duplicates, remove only the confirmed unused Workers in the Cloudflare dashboard or with Wrangler. Source upgrades do not delete ambiguous live deployments automatically.

For a health timeout on Windows or a managed network:

```powershell
machine-mcp status
machine-mcp doctor
machine-mcp --verbose
```

Run these commands from the same environment used for startup so `HTTPS_PROXY`, `HTTP_PROXY`, and `NO_PROXY` are identical. After the foreground connection succeeds, run `machine-mcp service install` from that same PowerShell session. Installation stores only an allowlisted proxy/custom-CA environment snapshot in private local state so the logon task does not lose session-only `$env:` settings after reboot. A later start with no proxy variables does not erase the saved snapshot; set a variable explicitly to an empty value and reinstall to clear it. `machine-mcp service status` reports only the saved key names. Debug logs expose only the selected route and classified error; they never print a proxy endpoint or credentials.

### Blocking-layer decision table

| Result | Interpretation |
|---|---|
| `authorization.effective_policy.profile` is `full` and the tool is in `authorization.effective_tools`, but the current session UI exposes fewer tools | Host/connector post-relay filtering; Machine Bridge cannot enumerate or override that subset |
| `daemon.policy.profile` is `full` but `authorization.effective_policy.profile` is `review`, `edit`, or `agent` | Expected account-role narrowing; the daemon field is only a capability ceiling and must not be reported as the account permission |
| `worker.sockets_live.authenticated` is nonzero but `worker.sockets_live.ready` is zero | Transport authentication exists, but the end-to-end result probe has not completed; no daemon tools are advertised and the candidate will be closed at the readiness deadline |
| `capability_routing.bootstrap_observed` is false | The current local runtime has not received `session_bootstrap`; reconnect or inspect host initialization handling |
| `task_resolution_observed` is false after a substantive task | The host/model did not call `resolve_task_capabilities`; server-side discovery cannot force that host decision |
| Task resolution ran but all match counts are zero | The resolver ran successfully but found no sufficiently relevant local skill, command, or application |
| No structured result because the host rejects the call | Host/connector approval or safety layer, or transport before daemon delivery |
| `mcp-host-to-daemon` passes but `local-filesystem` fails | Local state/runtime permissions, disk policy, sandbox, or endpoint security |
| Filesystem passes but `local-process-spawn` fails | Local executable policy, endpoint security, OS permissions, or damaged Node runtime |
| Direct spawn passes but `local-shell` fails | Shell path/profile/policy problem |
| `managed-job-storage` fails | Owner-only profile/job directory cannot be used |
| Registered resource is unavailable | File moved, permissions changed, size exceeded, or local access denied |

A successful diagnostic result applies only to that probe. An MCP host can still deny a later call based on its own request context. This is expected layering, not a defect in the `full` profile: `full` removes Machine Bridge's own denials, while host delivery remains independent.

### Concurrent chat windows and pending calls

Machine Bridge supports concurrent calls: the Worker admits up to 32 pending daemon calls and the local runtime admits up to 16 active tool calls. These are capacity limits, not a single global execution queue. Each successful MCP initialization receives a signed `MCP-Session-Id`; JSON-RPC ids and cancellation are scoped to that session, so separate chat windows may reuse the same numeric ids safely even when they share one OAuth account and token.

`server_info.worker.pending_calls` reports `active`, `detached`, `request_keys`, `maximum`, `oldest_ms`, and `by_tool`. `worker.sockets_live` separately reports `authenticated`, `probing`, `ready`, and `candidates`; only `ready` sockets contribute to `daemon.connected` and tool advertisement. A nonzero `active` count means work is in flight, not that the bridge is locked. `detached > 0` means a daemon socket was lost and those requests are inside the bounded thirty-second same-instance reconnect window. Calls for simple reads and probes should continue while another independent process call runs. Explicit MCP cancellation, an incoming HTTP client disconnect, and timeout remove the pending record and its session request key. A daemon-socket closure detaches only calls assigned to that socket; the same daemon process can reclaim them after completing readiness, while another process cannot. Grace expiry rejects the request and cancels the local ordinary operation. Refreshing a chat page is not the recovery mechanism and should not be required.

`server_info.worker.observability.calls.unmatched_results` counts results that reached the Worker after their pending record was already removed. A small increase can accompany cancellation or timeout races, especially during mixed-version upgrade convergence; sustained growth together with old pending calls indicates incompatible components or a lifecycle defect. The counter contains no tool arguments or result data.

### Relay interruption messages

A brief relay interruption is retried automatically and is visible only with `--verbose`. Default logs do not print raw WebSocket values such as `code=1006` with an empty reason. If a transient outage persists for 10 seconds, the daemon emits a readable duration/cause/reconnect summary; later reminders use autonomous exponential backoff capped at 15 minutes, and recovery produces one readable summary. Each transport connection attempt also has a deadline, so a socket stuck in `CONNECTING` cannot freeze retries. Identity/version mismatch, authentication rejection, and unexpected protocol messages are not retried as ordinary network faults: the daemon emits an immediate actionable error and exits, requiring upgrade/redeployment or credential repair. Worker-side hello and end-to-end readiness timeouts remain retryable. Authentication is not reported as usable service readiness until a session-bound probe result returns.

Use `--verbose` only when close codes, close reasons, heartbeat timeouts, and retry delays are needed for diagnosis. A close code of 1006 means the transport ended without a normal close handshake; it does not by itself identify the cause.

The daemon honors `HTTPS_PROXY`/`HTTP_PROXY` and `NO_PROXY` through standard environment-proxy resolution for remote Worker health and relay traffic. `wss:` targets use HTTPS proxy selection and `ws:` targets use HTTP proxy selection. Only HTTP and HTTPS proxy URLs are accepted. Invalid URLs or unsupported protocols fail startup with corrective guidance instead of entering the reconnect loop. `server_info.runtime.relay.network_route` reports only `direct`, `proxy`, or `invalid-proxy-configuration`; proxy endpoints and credentials are never returned or logged. The browser-broker CLI health probe is a separate loopback-only path: it accepts only canonical `127.0.0.1`, uses direct Node HTTP with no proxy agent, and does not depend on `NO_PROXY`.

## Browser extension setup and diagnosis

The full-profile daemon starts the loopback browser broker automatically. Install/pair the packaged extension once:

```sh
machine-mcp browser setup
machine-mcp browser status
```

`browser setup` prints the unpacked-extension path and opens the local pairing page. Load that directory into the Chromium profile you actually use; it is not installed into Playwright or a separate automation profile. `browser status` prints the authenticated extension build/protocol and the existing-profile backend. The pairing page contains the token only in non-cacheable loopback HTML; the CLI and MCP result do not print it. A first pairing is automatic. When local pairing state was reset or moved, click the extension icon on the active pairing page to authorize replacing the extension's previous broker configuration.

Diagnosis:

| Result | Interpretation |
|---|---|
| broker not reachable | no full-profile runtime owns the machine broker, state is stale, or a local security product blocked loopback listening |
| broker running, extension disconnected | extension not loaded/enabled in the intended Chromium profile, pairing not completed, browser profile not running, or MV3 worker reconnect failed |
| extension reload required | unpacked files, permissions, protocol, or capability set differ from the running extension; reload it from the extensions page and revisit the pairing page |
| tab list works but page action fails | restricted browser-internal page, inaccessible frame, stale selector, page navigation, enterprise policy, or page script interference |
| `frame_id` action fails | frame was replaced or is not accessible; inspect frames again |
| resource-backed upload fails | resource unavailable/too large, input is not `type=file`, page replaced the input, or the site rejects the file |

The machine-level broker permits multiple workspace daemons/stdio clients to share one extension. A second runtime becomes an authenticated broker client rather than selecting a new port or replacing the extension. Its owner-only `browser-bridge.json` pairing record is a recognized state-root entry, so validated uninstall can remove the complete Machine Bridge state root without treating the pairing record as unrelated data. Restarting every runtime is not normally required after adding a skill or changing a form page; capability and DOM discovery are live.

## macOS application automation

Application UI inspection/actions require Accessibility permission for the Node/Machine Bridge process. Grant it in macOS Privacy & Security, then retry `inspect_local_application`. Opening applications does not require the same Accessibility authority. If an app changes UI hierarchy or localizes labels, inspect again and use role/identifier/index selectors instead of assuming a stale title.

## Foreground startup, background service, and upgrades

`machine-mcp` is a foreground command. It remains attached to the terminal, defaults to `info` logging, and stops on `Ctrl+C`. `machine-mcp service start` launches the installed platform service in the background and returns to the shell; that service uses `warn` logging.

A global npm install changes the CLI files on disk but does not replace an already running Node process. Startup and other state-changing CLI operations use a token/process-identity lock and wait up to 30 seconds for a normal concurrent startup to finish; duration limits use monotonic elapsed time, so NTP or manual wall-clock correction does not lengthen or shorten the wait; a short launchd/systemd overlap is therefore serialized rather than reported immediately as an error. On a normal foreground start, Machine Bridge unloads the platform service and then independently examines the workspace daemon lock. This second path handles a detached/orphan `--daemon-only` process that launchd, systemd, or Task Scheduler no longer tracks. Only current lock records containing service mode, version, PID, process start time, entrypoint, workspace, and state root are eligible for takeover. Before sending `SIGTERM`, Machine Bridge verifies PID and process start time plus the live command line, entrypoint, and daemon-only flag. Explicit `--workspace` and `--state-dir` must both match the active state when present; a recovery daemon started with only `--daemon-only` is accepted when the lock owner already records that workspace and state root. Partial path identity (only one of the two flags) is rejected. If the verified daemon ignores graceful termination, Machine Bridge waits for the grace period, then repeats process-instance and full daemon-identity verification before sending `SIGKILL`. PID reuse, identity drift, foreground mode, or any ambiguity blocks escalation. The total stop remains bounded at 15 seconds and stale lock reclamation still uses token-aware ownership. A foreground or unverifiable process is left untouched; stop a foreground instance with `Ctrl+C`.

`machine-mcp service status [WORKSPACE]` reports two independent layers: the platform service (`active`) and `workspace_daemon`, plus `effective_active` and `orphaned_workspace_daemon` summary flags. On macOS it is possible for launchd to report inactive while a prior Node process remains alive with parent PID 1; that is an orphan-daemon condition, not proof that the daemon stopped. `service stop` unloads the provider when present and then terminates only a verified service-style workspace daemon. `service uninstall` and full uninstall are ordered fail-closed operations: provider stop → verified daemon stop(s) → definition removal. A failed or ambiguous stop leaves definitions and state intact. If takeover reaches its deadline, run:

```sh
machine-mcp service stop
machine-mcp service status
machine-mcp --verbose
```

For installation or upgrade, launch a pinned npm 12 CLI from an empty temporary directory. This avoids depending on the old npm version currently on `PATH` and prevents its `npx` bootstrap from validating unrelated nearby project metadata first. On Windows Command Prompt:

```bat
set "MBM_INSTALL_DIR=%TEMP%\machine-bridge-mcp-install-%RANDOM%-%RANDOM%"
mkdir "%MBM_INSTALL_DIR%"
pushd "%MBM_INSTALL_DIR%"
npx --yes npm@12.0.1 install --global npm@12.0.1
npx --yes npm@12.0.1 install --global --omit=optional --allow-scripts=esbuild,workerd,sharp,fsevents machine-bridge-mcp@latest
popd
rmdir /s /q "%MBM_INSTALL_DIR%"
npm --version
machine-mcp --verbose
```

`Unknown cli config "--allow-scripts"` proves the package installation ran under npm 11 or older. `Invalid property "node"` or `Invalid property "devEngines.node"` means npm parsed an outdated `devEngines` object; inspect the npm debug log to identify its source rather than assuming it belongs to Machine Bridge. The published package declares both Node.js 26 and npm 12 in `engines`, and `machine-mcp doctor` checks both active versions. Keep `--omit=optional` in the install command. Without it npm may resolve optional `fsevents` and warn that its install script was not included in `allowScripts`; Machine Bridge does not require that development-time watcher at runtime.

After global installation, Windows users may open any `cmd.exe` window and run `machine-mcp`; they do not need to navigate to a project or package directory. On the first interactive start, the CLI asks for a workspace folder and displays `%USERPROFILE%\MachineBridge` as the default. Pressing Enter creates and remembers that folder. This avoids inheriting an arbitrary Command Prompt current directory such as `C:\Windows\System32`. Typing another folder in the prompt creates that folder when necessary. Explicit `--workspace PATH` remains a strict automation interface and requires an existing path.

## Version 1 upgrade convergence

Version 1 advertises only MCP protocol `2025-11-25`. Upgrade the MCP client/host if it cannot negotiate that version; Machine Bridge does not retain an obsolete protocol dispatcher. The current local state schema is unchanged from the final 0.18.x release, so do not delete the state root merely to upgrade.

Use this sequence:

1. Install the released version with the documented pinned npm 12 command.
2. Run `machine-mcp --verbose` once. Startup verifies package/Worker versions, performs the ordinary authenticated Worker convergence when needed, stops only a verified service-style old daemon, waits for its lock, and starts the installed version.
3. Run `machine-mcp status` and `machine-mcp doctor`.
4. Reload the unpacked browser extension and revisit the pairing page. Exact package version and capability equality are required before browser readiness is reported.
5. Reconnect MCP clients so they initialize with the current protocol and tool metadata.

A failed state read, unverifiable process owner, active managed job, Worker authentication failure, or extension version mismatch remains fail closed. Preserve the state root and logs for diagnosis rather than deleting them to force apparent success.

## State-root safety and removal

The state root must be a dedicated directory and must not equal, contain, or be contained by the selected workspace. Do not point `--state-dir` at a project directory. On POSIX, every state, profile, job, service-log, browser-pairing, and temporary-secret directory is descriptor-opened without following the final symlink, restricted to `0700`, and revalidated; failure stops the operation. State/config and lock files are owner-only, bounded, and committed through flushed atomic primitives. A permission, type, symbolic-link, size, encoding, or I/O failure is reported; only successfully read invalid JSON is moved to a bounded `.corrupt-*` backup. Removal applies the same fail-closed rule to global config, every profile state, and daemon ownership records.

Uninstall acquires a state-root `maintenance.lock` that blocks new profile/state operations and state-backed operations from already constructed managed-job/browser managers, then scans all known profiles, active managed jobs, daemon/startup locks, global workspace selection, profile state, daemon lock workspace metadata, the state marker, and directory shape. It rechecks jobs and locks after stopping services/daemons. An unreadable lock is treated as a blocker, not as inactivity. Do not manually delete a lock merely because it looks old; inspect the recorded PID and command first.

## Logs

### Lifecycle and pending-call diagnosis

`server_info.runtime.lifecycle` reports `ready`, `starting`, `running`, `failed`, `stopping`, or `stopped`. `server_info.observability.in_flight_calls` and `server_info.runtime.processes` distinguish a blocked call from a surviving process. `server_info.runtime.execution_guardrails` reports the enforced local concurrency/timeout/stdin/output/session limits and explicitly states that CPU quota, memory quota, and network isolation are not enforced in process. Worker `server_info.worker.pending_calls` reports the internal-call index, client request-key index, and detached-call count. All three must return to zero after a terminal result, explicit cancellation, client disconnect, timeout, or reconnect-grace expiry. During a brief daemon interruption, `active` and `request_keys` may remain nonzero while `detached` identifies the recoverable subset; after same-instance readiness, `detached` returns to zero without losing those requests. Nonzero request-key counts after active calls reach zero indicate a lifecycle defect rather than normal load. `worker.observability.calls.unmatched_results` is the bounded counter for late results that no longer have a receiver.

Stable errors include `policy_denied`, `invalid_request`, `timeout`, `cancelled`, `network_error`, `unavailable`, `limit_exceeded`, and `integrity_error`, with retryability metadata. Diagnose by code first; free-form messages are guidance, not an API contract.


Windows Task Scheduler limits the `/TR` action text, so the platform adapter writes a short private `service-launcher.cmd` under the state root rather than embedding the full Node, package, workspace, state, and logging argv in the task action. The launcher uses CRT-compatible argument quoting, sends stdout/stderr to the normal service logs, exits on a successful daemon exit, and restarts a nonzero exit after five seconds. Task creation is accepted only after a separate state query observes the task. Start, stop, and removal likewise query the Task Scheduler state through fixed PowerShell object properties instead of parsing localized `schtasks` messages; an installed `Ready` task is not mislabeled as currently running.

The Windows trigger is current-user `ONLOGON` with `LIMITED` run level. After a reboot, signing in to that user is sufficient; no terminal command is required. Pre-login operation is intentionally not provided by the default design because it would require a different service-account/credential boundary. Remote autostart definitions prefer a stable PATH alias that resolves to the currently running Node executable and persist a sanitized absolute-only service `PATH` containing the Node/CLI directories, the installer's absolute PATH entries, and platform defaults. A private allowlisted `service-environment.json` preserves `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, matching lowercase forms, optional `ALL_PROXY`, Node proxy selection, and custom-CA path variables. Existing saved values survive an environment-free reinstall, while explicitly supplied values replace case-insensitive prior variants. Values may include proxy credentials, so the file stays in owner-only state and is never returned or logged; status exposes key names only. Re-run `machine-mcp service install` after changing Node installation families, PATH layout, proxy, or CA configuration. Custom Windows state paths used for autostart must also remain within the Task Scheduler path limit and must not contain a literal `%`.

A service-style `--daemon-only` start that finds the same workspace daemon already running is an idempotent no-op: it exits successfully without repeating warnings or readiness output; explicit policy/secret/change requests still report that changes were not applied. Autostart logs are stored under the state root in `logs/daemon.out.log` and `logs/daemon.err.log`. Installed services pass `--log-level warn --log-format json`, so each active line is a bounded JSON event suitable for ingestion. Files are owner-only where supported and tail-trimmed before daemon startup. If the log schema marker does not match the current format, the active files are cleared before startup and the current marker is written. Runtime code reads and maintains only the active filenames.

Logging is level-based:

```text
error  unrecoverable local/transport/service failures
warn   persistent retryable relay degradation, supersession, and service problems
info   startup/deploy/connect transitions
debug  all per-tool starts/successes/failures/cancellations/timing, late-result disposal, correlation and reconnect details
```

Foreground mode defaults to `info`; autostart uses `warn`. Use `--verbose` or `--log-level debug` only for diagnosis. `--quiet` is an alias for `--log-level error`.

Normal logs intentionally omit tool arguments, file/patch/image content, command text and argv, stdin/stdout/stderr, OAuth request bodies, connection credentials, authorization codes, and tokens. Unexpected daemon and Worker failures use coarse error classes rather than raw exception messages. Messages and structured fields are bounded and redact private-key headers, common access-token/API-key/JWT forms, embedded-credential URLs, email addresses, and user-home paths. Raw plain terminal output is reserved for explicitly requested credentials or local paths; operational guidance uses sanitized plain output.

See [LOGGING.md](LOGGING.md) for the event contract and MCP-host boundary. Cloudflare observability is sampled and is not a complete audit log.

## Full capability acceptance

Run:

```sh
machine-mcp full-test --workspace /path/to/project
```

The command uses disposable local directories and performs actual read/write, process, shell, environment, SSH-key, sandbox authorized-key, SSH-client, managed-job and finally-cleanup operations. It also checks whether the Google Cloud OS Login command exists and whether `sudo -n true` is currently permitted, without changing either system. `ok` covers core Machine Bridge functionality; `operator_workflow_ready` additionally reports the local SSH/Google CLI prerequisites. No external cloud, account, or server change is made.

Generate and register an operator key locally:

```sh
machine-mcp resource generate-ssh-key NAME [PRIVATE_KEY_PATH]
```

An authorized canonical-full MCP client can use `generate_ssh_key_resource`. Both paths validate the key pair and return only metadata and the bare public fingerprint. Local paths are omitted unless `--show-paths` or `expose_paths=true` is explicitly requested; public-key comments are not included in the returned fingerprint. They do not install the public key in Google, modify `authorized_keys`, or grant remote `sudo`; those remain explicit managed-job/local-operator operations.

## Managed jobs and local recovery

Register local-only resources from the terminal:

```sh
machine-mcp resource add NAME FILE_PATH
machine-mcp resource list                 # paths omitted by default
machine-mcp resource list --show-paths    # explicit local-only disclosure
machine-mcp resource check NAME
machine-mcp resource remove NAME
```

Inspect detached jobs even when the MCP host no longer permits execution tools:

```sh
machine-mcp job list
machine-mcp job inspect JOB_ID
machine-mcp job approve JOB_ID [--yes]
machine-mcp job cancel JOB_ID
machine-mcp job submit plan.json
```

Registry changes apply to newly submitted jobs without restarting the daemon. Active jobs use the resource snapshot accepted with their plan.

Policy changes affect new direct submissions. Cancel accepted running jobs explicitly when revoking execution authority. A staged plan launches only after local `job approve`, which is an independent operator authorization. A managed job transitions through `queued`, `running`, `cleaning`, and a terminal status such as `succeeded`, `failed`, or `cancelled`. Cleanup-specific terminal variants report a failed finally phase. If a runner PID dies, the next daemon/job-CLI start marks the job interrupted, removes stale private runtime copies, and runs the finally phase in recovery mode. Automatic recovery is capped at three attempts; persistent failure becomes `recovery_exhausted`.

Use job-scoped `temporary_files` for local helpers. For remote maintenance, prefer `ssh ... sh -s` with the remote script in step `stdin`; this avoids remote temporary scripts. Explicit remote cleanup belongs in idempotent `finally_steps`.

Uninstall refuses to remove local state while any managed job remains active. Active plans are needed for recovery and are owner-only. Terminal jobs delete their full plans. Bounded redacted results and runner-level diagnostics remain for up to seven days/50 jobs. Step output is never copied to ordinary daemon logs.

See [MANAGED_JOBS.md](MANAGED_JOBS.md).

## Hosted OAuth reconnection

Hosted clients may refresh access without asking the user to authorize again. Machine Bridge returns a replacement refresh token on every successful public-client refresh and invalidates the presented token. `invalid_grant` therefore means the token was already rotated, expired, or revoked by an account change or deployment-wide token-version rotation. Remove and reconnect the hosted connector; repeatedly retrying the stale token cannot recover it.

Claude and Copilot Studio call the public Worker from their cloud connectivity layers. Do not add broad Anthropic or Microsoft domains to `MBM_ALLOWED_ORIGINS` as a connectivity workaround; that variable controls browser response sharing, not server-to-server reachability, tenant policy, WAF rules, or Power Platform data policy.

## Reconnect and replacement

The daemon sends heartbeats and reconnects with bounded exponential backoff and jitter. A new socket progresses through candidate, authenticated/probing, and ready states. After `hello_ack`, the Worker sends a random probe that must return through the exact local dispatcher and relay-session result path used by real calls. Only the matching result produces `ready_ack`, `daemon.connected=true`, and tool advertisement. A healthy incumbent remains active until that proof succeeds, so a bad replacement cannot create an avoidable outage.

The Worker tracks inbound `lastSeenAt` and reclaims ready or probing sockets that go silent past their applicable liveness/readiness windows. Diagnose with `daemon.readiness_verified`, `worker.sockets_live.ready`, `worker.sockets_live.probing`, and `daemon.last_seen_at`; cumulative `worker.observability.sockets.authenticated` is an event counter, not current liveness. A state with no ready daemon is unavailable by construction rather than falsely online. Restart the daemon only after inspecting the classified timeout/protocol error; refreshing an MCP client does not repair the local transport.

Pending calls are bound to the socket that received them. Results from another socket are ignored. A lost or replaced socket rejects only its own pending calls and terminates locally tracked child process trees. Process sessions are in-memory and do not survive daemon restart or replacement.

## Limits

Defense-in-depth limits include:

- Worker MCP body: 8 MiB by default, hard cap 16 MiB;
- stdio JSON-RPC line: 8 MiB, enforced incrementally while reading;
- OAuth body: 64 KiB;
- daemon WebSocket message: 8 MiB, enforced by the local WebSocket parser before string conversion;
- text writes and patch envelopes: 5 MiB;
- images: 4 MiB before base64 encoding;
- shell/argv envelope: 64 KiB;
- captured one-shot output: 512 KiB per stream by default;
- process-session retained output: 1 MiB per stream, with lossless base64 fallback for non-UTF-8 slices;
- process sessions: 8 retained per runtime;
- process stdin write: 64 KiB per call;
- local simultaneous tool calls: 16;
- Worker pending daemon calls: 32;
- command timeout: 1–600 seconds;
- process-session read wait: at most 30 seconds, measured with monotonic elapsed time;
- direct directory result: 10,000 entries and 4 MiB of path metadata;
- recursive walk: 200,000 visited entries;
- managed jobs: 50 retained, seven-day retention;
- managed-job steps: 16 main plus 16 finally;
- managed-job timeout: 1–3,600 seconds per step;
- managed-job output: 64 KiB per stream and 256 KiB total captured across one job;
- registered resources: 64, 1 MiB each, 8 MiB referenced per job;
- browser source: 4 MiB aggregate across at most 64 accessible frames; semantic inspection: 1,000 elements aggregate, 100,000 scanned nodes, 10,000 reusable refs, and 2 MiB bounded page-text search per frame; browser WebSocket messages: 8 MiB; pending browser requests: 32 per runtime;
- browser forms: 200 fields, 128 KiB per text value, and 4 MiB aggregate text; upload: eight resources and 5 MiB total;
- application Accessibility inspection: 500 elements and depth 12; action text: 4,000 characters;
- job-scoped temporary files: 16 files, 512 KiB total content.

The list above describes bounded application resources, not OS quotas. CPU time shares, resident-memory ceilings, syscall sandboxes, and egress policy must be imposed by the account/container/VM that runs Machine Bridge. Check `server_info.runtime.execution_guardrails.operating_system_enforcement`; current in-process values are intentionally `not-enforced` rather than inferred from timeouts or output limits.

## Upgrade behavior

Policy revision 5 makes named profiles canonical and evaluates compound tool requirements from the shared contract. A state entry labelled `full` means writes, direct processes, process sessions, shell execution, unrestricted direct filesystem paths, absolute path output, the complete parent environment, and the complete tool catalog. CLI capability overrides are stored as `custom`. Persisted policies from another revision are rejected rather than interpreted.

`full` removes Machine Bridge's own profile/path/environment/shell denials and makes the complete catalog available to the relay. It does not force a connector host to expose every relayed tool, and the server cannot see the host's final subset. It also does not override operating-system access controls, endpoint security, remote authentication, cloud IAM, `sudo`, or independent MCP-host/platform policy.

Inspect effective policy with:

```sh
machine-mcp status
machine-mcp doctor
```

Select a policy explicitly with:

```sh
machine-mcp --workspace /path/to/project --profile full
machine-mcp --workspace /path/to/project --profile agent
```

A remote policy change is saved locally, propagated in the daemon handshake, and loaded by autostart from owner-only state.

## Incident response

After suspected credential or client compromise:

1. stop foreground and autostart daemons;
2. run `machine-mcp rotate-secrets`;
3. restart without broad flags and redeploy;
4. inspect Cloudflare account access, Worker configuration, local state/resource permissions, process-lock owners, managed-job results, and service logs;
5. cancel active managed jobs and remove compromised resource aliases;
6. remove the Worker and local state if continued remote access is unnecessary.

The detailed 0.12.0 audit record and residual operational limits are in [AUDIT.md](AUDIT.md).
