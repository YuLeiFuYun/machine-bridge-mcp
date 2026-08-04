# Operations

## Health and diagnosis

```sh
machine-mcp status
machine-mcp doctor
machine-mcp service status
```

`status` prints redacted profile state and verifies the deployed Worker version. Resource source paths remain redacted. `doctor` checks Node.js, the package-installed Wrangler binary, Cloudflare login, Worker health, the configured policy, the automatic-without-per-operation-prompts authorization model, and the same fixed local filesystem/process/shell/job-storage/resource probes exposed by `diagnose_runtime`. It constructs an isolated local runtime: `diagnosticScope.running_service_process_inspected=false` and `remote_relay_inspected=false` are deliberate, so a green doctor result is not evidence that the launchd/systemd/Scheduled Task daemon retained its Worker WebSocket. Inspect authenticated `server_info.daemon.relay_transport` for the running service relay. Authenticated `server_info.authorization.execution_model` reports the authority contract and identifies whether the account has daemon-OS-user ambient authority. Public `/healthz` output contains only server identity and version; daemon details require an authenticated `server_info` call.

### Worker deployment and health convergence

`/healthz` and `/` are answered by the outer Worker and do not consume Durable Object request volume. If MCP or daemon routes return `503 durable_object_quota_exceeded` (or Cloudflare 1101 with Durable Objects free-tier exhaustion in Worker tails), wait for the daily UTC free-tier reset or move the account off the free DO plan; do not treat that as a failed script deploy when `/healthz` still reports the expected version.

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

### Worker quota controls

The standard public endpoint remains the automatically provisioned `workers.dev` URL printed by Machine Bridge; no personal domain is required. The outer Worker serves health, discovery metadata, CORS preflight, and unknown 404s without Durable Object state. Stateful routes pass a 120-per-minute Cloudflare Rate Limiting binding before DO dispatch. This guard is per Cloudflare location and executes after the Worker starts; it protects the Durable Object from ordinary bursts but is not an exact account-wide daily Workers quota. Configure Cloudflare account usage alerts when available. A binding outage fails open so quota protection cannot become an authentication outage.

`server_info.worker.observability.oauth_refresh` distinguishes normal rotation, bounded retry issuance, exhausted retry budget, post-grace family revocation, and rejected grants. `durable_budget` reports estimated stream-row writes plus alarm sets, deletes, and no-ops. These are process-lifetime logical counters for diagnosis, not Cloudflare billing records.

### Blocking-layer decision table

| Result | Interpretation |
|---|---|
| `authorization.effective_policy.profile` is `full` and the tool is in `authorization.effective_tools`, but the current session UI exposes fewer tools | Host/connector post-relay filtering; Machine Bridge cannot enumerate or override that subset |
| `daemon.policy.profile` is `full` but `authorization.effective_policy.profile` is `review`, `edit`, or `agent` | Expected account-role narrowing; the daemon field is only a capability ceiling and must not be reported as the account permission |
| `worker.sockets_live.authenticated` is nonzero but `worker.sockets_live.ready` is zero | Transport authentication exists, but the end-to-end result probe has not completed. The stable account catalog remains discoverable, while `authorization.effective_tools` contains no executable daemon tool and calls fail retryably until readiness |
| `capability_routing.bootstrap_observed` is false | The current local runtime has not received `session_bootstrap`; reconnect or inspect host initialization handling |
| `task_resolution_observed` is false after a substantive task | The host/model did not call `resolve_task_capabilities`; server-side discovery cannot force that host decision |
| `primary_route` is unexpected or `routing_ambiguity` is high | Inspect the returned competing routes and tool-description boundaries; routing is advisory, so use any tool allowed by the effective policy. Do not treat a fallback as permission to bypass a host or policy denial. |
| Capability responses repeat large unchanged instructions | Return the previous lowercase SHA-256 `refresh.fingerprint` as `known_refresh_fingerprint`; static context is omitted only when its identity still matches, while task routing is recomputed. |
| Task resolution ran but all match counts are zero | Check `application_discovery`: `available=false` or a nonzero warning count means application inventory was partial or unavailable; otherwise the resolver ran successfully but found no sufficiently relevant local skill, command, or application |
| No structured result because the host rejects the call | Host/connector approval or safety layer, or transport before daemon delivery |
| `mcp-host-to-daemon` passes but `local-filesystem` fails | Local state/runtime permissions, disk policy, sandbox, or endpoint security |
| Filesystem passes but `local-process-spawn` fails | Local executable policy, endpoint security, OS permissions, or damaged Node runtime |
| Direct spawn passes but `local-shell` fails | Shell path/profile/policy problem |
| `managed-job-storage` fails | Owner-only profile/job directory cannot be used |
| Registered resource is unavailable | File moved, permissions changed, size exceeded, or local access denied |

A successful diagnostic result applies only to that probe. An MCP host can still deny a later call based on its own request context. This is expected layering, not a defect in the `full` profile: `full` removes Machine Bridge's own denials, while host delivery remains independent.

### Concurrent chat windows and pending calls

Machine Bridge supports concurrent calls: the Worker admits 32 pending daemon calls (30 ordinary plus two reserved control calls), and the local runtime admits 16 active tool calls (14 ordinary plus two reserved control calls). The same `diagnose_runtime`/`list_roots` control set is enforced at both layers. These are capacity limits, not a single global execution queue. Modern MCP `2026-07-28` HTTP requests are independent: JSON-RPC IDs are scoped to each request/response stream, so separate clients may reuse the same numeric ID even when they share one OAuth account and token. Legacy MCP `2025-11-25` initialization still receives a signed `Mcp-Session-Id`; idempotency, explicit cancellation, and replay for that compatibility path remain session-scoped. Within the bounded two-minute recovery window, a typed request ID denotes one operation and must not be intentionally reused for new work.

`server_info.worker.pending_calls` reports `active`, `detached`, `request_keys`, `maximum`, `oldest_ms`, `by_tool`, `transient`, and `durable_streams`. `worker.sockets_live` separately reports `authenticated`, `probing`, `ready`, and `candidates`; only `ready` sockets contribute to `daemon.connected` and `authorization.effective_tools`. `daemon.relay_transport` is the bounded, daemon-supplied summary captured during the current connection handshake: it records the immediately preceding reconnect episode without endpoints, interface names, arguments, or results. A nonzero `active` count means work is in flight, not that the bridge is globally locked. `detached > 0` means the daemon WebSocket was lost and calls are inside the bounded same-daemon reconnect interval. This relay-layer state exists below both MCP eras.

For modern MCP `2026-07-28`, the public response stream is the request owner: closing it cancels the transient pending call, and no request-key or replay record should remain. For legacy MCP `2025-11-25`, the signed session and typed JSON-RPC ID own bounded idempotency and explicit `notifications/cancelled`; closing a resumable public stream alone does not cancel the operation. Legacy terminal completion, explicit cancellation, timeout, or reconnect-grace expiry must eventually return active/detached/pending-call request-key counts to zero, while the separate stream-level replay identity may remain until the two-minute recovery record expires. A verified same-daemon replacement may reclaim detached relay calls after readiness, while a new daemon process cannot. Delayed results from the old socket are rejected. `detached > 0` materially beyond the two-minute grace, a modern transient call surviving response closure, or a legacy request-key count remaining after active calls reach zero is a lifecycle defect.

A Worker-requested `daemon_transport_error` or `daemon_liveness_timeout` is a retryable connection invalidation. The local daemon must close only the affected socket, preserve pending-call detach semantics, and reconnect; it must not enter the fatal `relay_protocol_error` path or exit for launchd to restart. The Worker uses close code 1012 for these transient cases. The daemon also recognizes the bounded close reasons `daemon pong failed`, `daemon send failed`, and `daemon liveness timeout` if the preceding error frame is not delivered. Unknown error codes, authentication rejection, and server identity/version mismatch remain permanent failures and require operator action.

For modern MCP `2026-07-28`, every POST advertises both `application/json` and `text/event-stream` with valid positive HTTP quality values, carries protocol version and capabilities in request `_meta`, and mirrors the version/method/applicable name into validated HTTP headers. The actual `/mcp` Origin must be absent, same-origin, built-in, or explicitly allowlisted; CORS preflight accepts only fixed protocol headers plus exact catalog-declared `Mcp-Param-*` names. A JSON response completes immediately; a streamed `tools/call` receives a request-scoped SSE stream without event IDs. Closing that response stream is cancellation: the outer Worker observes request abort, response-body cancellation, or failed bounded keepalive delivery and sends one random internal capability without Authorization or DPoP headers. The Durable Object consumes it before OAuth only to remove the already-active matching pending call and send `cancel_call` when work has been dispatched; caller-supplied internal headers are stripped. Modern streams are never resumed through GET or `Last-Event-ID`. Local Wrangler does not propagate a raw TCP close into the Worker cancellation callbacks reliably, so deterministic proxy tests enforce this control path and live candidate verification must exercise it on the deployed edge.

Legacy MCP `2025-11-25` retains the older delivery contract for existing hosts. Name, account-visible tool membership, and raw arguments are validated before any resumable record is allocated; malformed or role-hidden calls return `-32602` with no daemon dispatch. For a valid call, the outer Worker emits sequence-zero and sequence-one event IDs while `BridgeRoom` persists bounded session-bound stream/call ownership before daemon dispatch. A compatible legacy host should recover with authenticated `GET /mcp`, its original `Mcp-Session-Id`, and `Last-Event-ID`. If transport loss makes the original POST preparation or terminal response uncertain, an exact signed-session retry is safe throughout the stream's bounded recovery lifetime: the request identity and canonical argument fingerprint reattach it to the active or terminal stream, while changed arguments are rejected. Intentional new work must use a fresh typed request ID until that record expires or the client explicitly acknowledges sequence one, which deletes the replay record. Sessionless legacy POSTs remain independent for compatibility with clients that share one bearer token; without a signed session they do not receive POST idempotency, the outer Worker does not retry an ambiguous prepare, and the client must not blindly repeat an ambiguous side-effecting request. Legacy records are token/session-bound, retained for at most two minutes, limited to 64 streams, and persist at most 1.5 MiB of terminal JSON. Errors `-32002`, `-32003`, and `-32005` in this area are legacy recovery diagnostics, not modern protocol errors. Caller-supplied internal stream headers are removed at the public boundary in both eras.

The daemon-to-Worker terminal protocol is at-least-once until `tool_result_ack`. Queueing a WebSocket frame is not durable delivery: the runtime retains a bounded terminal envelope, replays it after same-daemon reconnect or heartbeat, and removes it only after acknowledgement or the authoritative `resume_calls` reconciliation excludes it. The modern public stream has no replay surface; the legacy terminal store is generation-checked and exactly-once from the client's recovery perspective. `server_info.worker.observability.terminal_results` separates the actual disposition of daemon result envelopes: `transient_committed` and `durable_committed` reached their owners; `owner_missing_acknowledged` arrived after the owner had already settled or been removed and was safely acknowledged to stop at-least-once replay; `stale_connection_rejected` came from a connection that no longer owned the durable call and was not acknowledged. The older `calls.unmatched_results` field remains a compatibility aggregate of the last two counters and must not be interpreted alone. Growth only in `owner_missing_acknowledged` usually indicates acknowledgement loss, cancellation, timeout, or deployment/reconnect overlap; growth in `stale_connection_rejected`, especially with old pending calls or protocol errors, indicates a connection-identity or lifecycle defect. These counters contain no arguments or result data.

### MCP host or connector internal-storage errors

An error naming an internal shard mapper, temporary keyspace, backfill store, connector database, or host-side cache is not automatically a Machine Bridge Worker or daemon error. Check whether the exact text appears in repository source, Worker events, daemon logs, or local process output, and whether Worker `requests.server_error` increased. If even `server_info` fails before reaching the Worker while local readiness remains healthy, preserve credentials and state; report the host/connector incident separately rather than rotating OAuth/device secrets or redeploying blindly.

After the host path recovers, compare authenticated `server_info`, `machine-mcp doctor`, and `machine-mcp service status`: ready socket count, pending age, daemon PID/start time, `daemon.relay_transport`, and local logs. Treat doctor as local dependency/probe evidence only; it does not inspect the running service relay. A host-storage incident and a genuine stale pending call can coexist; investigate the latter independently if it exceeds its operation or reconnect deadline.

### Relay interruption messages

A reconnect warning proves a transport interruption, not a daemon crash. Compare daemon PID and process start time with `connected_at`, `last_seen_at`, `daemon.relay_transport.last_close_category`, `last_close_code`, `outage_count`, `outage_attempts`, and the coarse network-route class. A VPN/TUN UI may remain “connected” while its upstream route is unusable. Machine Bridge reports only coarse route/proxy classes and never logs interface names, addresses, DNS answers, proxy credentials, or Worker secrets.

Brief retryable outages reconnect automatically. On a ready beta.37 socket, `server_info.daemon.relay_transport.outage_active=false`; the remaining fields describe the immediately preceding reconnect episode rather than a current outage. A persistent outage emits bounded summaries; identity/version mismatch, authentication rejection, and unexpected protocol messages remain permanent failures requiring version convergence or credential repair. Compare outage intervals with sleep/wake records and `diagnose_runtime.runtime.relay.heartbeat` before classifying them as active network faults; local stdio `server_info.runtime.relay.heartbeat` exposes the same state. A nonzero `event_loop_stall_count` with a large `max_event_loop_lag_ms` means the local daemon was not scheduled promptly; during recovery grace it sends a new heartbeat and deliberately postpones disconnect. That is distinct from a relay that remains silent after local scheduling has recovered. Use `--verbose` only when close codes, heartbeat deadlines, and retry delays are required.

A foreground MCP tool is not a durable job. Every advertised MCP surface accepts at most 60 seconds of daemon execution. The Worker records a settlement deadline five seconds later than the daemon execution duration for result acceptance, persistence, acknowledgement, and terminal settlement. Admission and transport latency may consume part of that interval, and it is not a guarantee that an external host will consume the final frame. Relay execution applies the same 30- or 60-second default when the field is omitted, and a registered-command manifest cannot extend a relay call past 60 seconds. An owner-local registered command may retain a longer explicit manifest timeout because it does not depend on a hosted response stream. Longer remote work belongs in `start_process` plus bounded `read_process`, or in a managed job. Keep mutation and verification in independently terminal calls when a host exposes only a foreground shell tool.

The daemon honors `HTTPS_PROXY`/`HTTP_PROXY` and `NO_PROXY` through standard environment-proxy resolution for remote Worker health and relay traffic. `wss:` targets use HTTPS proxy selection and `ws:` targets use HTTP proxy selection. Only HTTP and HTTPS proxy URLs are accepted. Invalid URLs or unsupported protocols fail startup with corrective guidance instead of entering the reconnect loop. `diagnose_runtime.runtime.relay.network_route` reports remotely, while local stdio `server_info.runtime.relay.network_route` reports `system-network-stack`, `application-http-proxy`, or `invalid-application-proxy-configuration`. This field describes only Machine Bridge application-level proxy selection: an operating-system VPN/TUN may still intercept `system-network-stack` traffic. `network_route_scope`, outage timestamps/durations, close category/code, transport error class, and next retry timing make that distinction explicit; proxy endpoints and credentials are never returned or logged. The browser-broker CLI health probe is a separate loopback-only path: it accepts only canonical `127.0.0.1`, uses direct Node HTTP with no proxy agent, and does not depend on `NO_PROXY`.

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

Foreground shell, process-session, and managed-job timeouts terminate the complete process group rather than only the direct child. On macOS, ownership capture and revalidation use asynchronous `ps -g <PGID>` so unrelated system-wide process-table load cannot erase all identity evidence or block the daemon event loop. The identity snapshot begins before `SIGTERM`; post-signal refresh and pre-`SIGKILL` revalidation share one three-second monotonic inspection budget and compare exact PID, start time, and PGID. Empty or ambiguous ownership still fails closed; the operation may require manual cleanup rather than risk signaling a reused process.

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

### Start, restart, and cross-workspace ownership

`service install` writes a machine-global owner record before it touches launchd, systemd, or Task Scheduler. The record is `pending` during provider mutation and becomes `committed` only after the exact canonical workspace, state root, runtime entrypoint, and package version are installed. A partial or ambiguous provider failure remains pending; `service start` and `service restart` then refuse to run until installation is repeated successfully. A missing or malformed owner is reported by `service status` as `missing` or `invalid` rather than hiding the provider diagnostics.

`service start` is an idempotent ensure-running operation, but provider state is only an intermediate observation. It loads the committed owner, verifies that no foreground, unverifiable, or orphan service daemon conflicts with it, starts the provider, and waits for the exact service-mode daemon to publish its token-protected startup-readiness checkpoint. The daemon publishes that checkpoint once, only after device authentication, relay probe, and `ready_ack`; a stable launchd PID or a Windows task that briefly reports `Running` is not sufficient. Failed readiness triggers a bounded provider stop and reports whether cleanup itself was verified. A Windows task that completes and returns to `Ready` remains `completed_without_persistence`, even when its process exit code was zero.

`service restart` uses the same owner/readiness convergence after its detached service-manager handoff, but unlike idempotent `service start` it must invoke the provider. When the service was already active, success requires both explicit provider restart evidence and a ready replacement daemon PID; the old daemon remaining ready is `daemon_replacement_not_observed`, not success. Windows restart remains fail closed from inside the running task because Task Scheduler `/End` may terminate the helper with the daemon; use an independent terminal stop/start sequence until a behaviorally verified Windows handoff exists.

A workspace/state selector does not grant authority over the machine-global service label. All service mutations share one fixed per-user machine-service lock. Operations that also need a workspace startup lock acquire machine-service first; foreground startup releases the machine lock after service takeover and daemon-lock acquisition rather than holding it for the lifetime of the foreground runtime. Stop, restart, foreground takeover, secret rotation, and uninstall still require exact live ownership evidence. Service status returns only provider state, bounded owner metadata, verified daemon state, PID/run counters, readiness, and classified termination state; provider environment dumps and owner paths are never returned.

### Candidate activation authentication recovery

Exact candidate activation distinguishes ordinary health from device-authenticated relay readiness. If a current-version candidate receives an explicit authentication rejection before WebSocket admission, activation redeploys the same Worker once with the unchanged selected device identity and retries candidate startup within a three-attempt bound. It does not rotate credentials or create another Worker.

If activation still fails after remote preparation and reports that a compatible candidate service was installed and started, preserve the state root and logs, then inspect:

```sh
machine-mcp service status
machine-mcp status
machine-mcp doctor
```

Do not use secret rotation, state deletion, manual version edits, or repeated forced deployment as a generic repair. The compatible service is forward recovery for an already advanced Worker; the reported primary error still requires diagnosis. Candidate activation checks foreground/unverifiable ownership before any service-manager mutation. If a foreground instance is reported, leave it running until the command prints a verified recovery sequence; only a recovery helper that revalidates the PID, daemon lock, command line, workspace, state root, package name, version, and real entrypoint may name the older CLI used to restore the previous login service. Never substitute the candidate CLI for that older runtime.

## Current upgrade convergence

The current release advertises modern MCP `2026-07-28` as the primary protocol and retains MCP `2025-11-25` only as an initialization-based compatibility adapter. A modern client must send per-request metadata and the required Streamable HTTP headers; it must not expect a session ID, GET stream, or `Last-Event-ID` replay. A legacy client may continue to initialize and use the signed-session recovery contract. Version 3 also requires matching Worker, daemon, CLI, and browser-extension components and may perform a two-phase device-root migration. Preserve the state root and follow [UPGRADING.md](UPGRADING.md); do not delete state to force apparent convergence.

Use this sequence:

1. Install the released version with the documented pinned npm 12 command.
2. Run `machine-mcp --verbose` once. Startup verifies package/Worker versions, performs the ordinary authenticated Worker convergence when needed, stops only a verified service-style old daemon, waits for its lock, and starts the installed version.
3. Run `machine-mcp status` and `machine-mcp doctor`.
4. Reload the unpacked browser extension and revisit the pairing page. Exact package version and capability equality are required before browser readiness is reported.
5. Reconnect MCP clients. Modern clients should rediscover the server and send fresh per-request metadata; legacy clients should reinitialize and retain the returned session only for the legacy connection.

A failed state read, unverifiable process owner, active managed job, Worker authentication failure, or extension version mismatch remains fail closed. Preserve the state root and logs for diagnosis rather than deleting them to force apparent success.

## State-root safety and removal

The state root must be a dedicated directory and must not equal, contain, or be contained by the selected workspace. Do not point `--state-dir` at a project directory. The default profile state is `~/.local/state/machine-bridge-mcp` on POSIX (or the application directory under XDG/APPDATA); the machine-global service lock and owner ledger use a separate sibling control directory ending in `-control`. Never use the control root as `--state-dir` or copy profile state into it. On POSIX, every state, profile, job, service-log, browser-pairing, and temporary-secret directory is descriptor-opened without following the final symlink, restricted to `0700`, and revalidated; failure stops the operation. State/config and lock files are owner-only, bounded, and committed through flushed atomic primitives. A permission, type, symbolic-link, size, encoding, or I/O failure is reported; only successfully read invalid JSON is moved to a bounded `.corrupt-*` backup. Removal applies the same fail-closed rule to global config, every profile state, and daemon ownership records.

Uninstall acquires a state-root `maintenance.lock` that blocks new profile/state operations and state-backed operations from already constructed managed-job/browser managers, then scans all known profiles, active managed jobs, daemon/startup locks, global workspace selection, profile state, daemon lock workspace metadata, the state marker, and directory shape. It rechecks jobs and locks after stopping services/daemons. An unreadable lock is treated as a blocker, not as inactivity. Do not manually delete a lock merely because it looks old; inspect the recorded PID and command first.

## Logs

### Lifecycle and pending-call diagnosis

Remote `diagnose_runtime.runtime.lifecycle` reports `ready`, `starting`, `running`, `failed`, `stopping`, or `stopped`; `diagnose_runtime.observability.in_flight_calls` reports ordinary versus reserved local capacity; and `diagnose_runtime.runtime.processes` distinguishes active calls, draining calls whose protocol result already settled, currently terminating processes, and pending escalation checks. It also returns `runtime.execution_guardrails` and `runtime.security_audit`. Local stdio `server_info` exposes the equivalent fields under `server_info.runtime`, `server_info.observability`, and `server_info.security_audit`. A returned timeout therefore does not claim that all kernel or descendant work has already stopped. Worker `server_info.worker.pending_calls` reports the internal-call index, legacy request-key index, detached-call count, ordinary/control capacity, and current ordinary/control occupancy across transient and durable calls. Modern HTTP stream closure should remove its transient stream owner and pending daemon call; there is no modern replay record or request-key entry. Legacy terminal result, explicit cancellation, timeout, or reconnect-grace expiry must return active/detached/pending-call request-key counts to zero; the stream-level idempotency identity remains only for bounded replay retention. During a brief daemon interruption, legacy `active` and `request_keys` may remain nonzero while `detached` identifies the recoverable subset; after same-instance readiness, `detached` returns to zero without losing those requests. Nonzero legacy request-key counts after active calls reach zero indicate a lifecycle defect rather than normal load. Diagnose late results through `worker.observability.terminal_results`: `owner_missing_acknowledged` is a safely terminated replay or race, while `stale_connection_rejected` is an ownership mismatch. `worker.observability.calls.unmatched_results` is retained only as their compatibility aggregate.

Stable errors include `policy_denied`, `invalid_request`, `timeout`, `cancelled`, `network_error`, `unavailable`, `limit_exceeded`, and `integrity_error`, with retryability metadata. Diagnose by code first; free-form messages are guidance, not an API contract.


Windows Task Scheduler limits the `/TR` action text, so the platform adapter writes a short private `service-launcher.cmd` under the state root rather than embedding the full Node, package, workspace, state, and logging argv in the task action. The launcher uses CRT-compatible argument quoting, sends stdout/stderr to the normal service logs, exits on a successful daemon exit, and restarts a nonzero exit after five seconds. Task creation is accepted only after a separate state query observes the task. Start, stop, and removal likewise query the Task Scheduler state through fixed PowerShell object properties instead of parsing localized `schtasks` messages; an installed `Ready` task is not mislabeled as currently running.

The Windows trigger is current-user `ONLOGON` with `LIMITED` run level. After a reboot, signing in to that user is sufficient; no terminal command is required. Pre-login operation is intentionally not provided by the default design because it would require a different service-account/credential boundary. Remote autostart definitions prefer a stable PATH alias that resolves to the currently running Node executable and persist a sanitized absolute-only service `PATH` containing the current Node/package directories, the operator's inherited absolute PATH entries, and platform defaults. When installation runs through npm, all nested run-script prefixes through the final npm private `node-gyp-bin` marker are discarded; paths belonging to inactive candidate runtimes are also removed. This prevents prerelease activation from persisting source-repository shims or the prior runtime that activation subsequently prunes, while an ordinary user-supplied `node_modules/.bin` remains valid. A private allowlisted `service-environment.json` preserves `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, matching lowercase forms, optional `ALL_PROXY`, Node proxy selection, and custom-CA path variables. Existing saved values survive an environment-free reinstall, while explicitly supplied values replace case-insensitive prior variants. Values may include proxy credentials, so the file stays in owner-only state and is never returned or logged; status exposes key names only. Re-run `machine-mcp service install` after changing Node installation families, PATH layout, proxy, or CA configuration. Custom Windows state paths used for autostart must also remain within the Task Scheduler path limit and must not contain a literal `%`.

A service-style `--daemon-only` start that finds the same workspace daemon already running is an idempotent no-op: it exits successfully without repeating warnings or readiness output; explicit policy/secret/change requests still report that changes were not applied. Autostart logs are stored under the state root in `logs/daemon.out.log` and `logs/daemon.err.log`. Installed services pass `--log-level warn --log-format json`, so each active line is a bounded JSON event suitable for ingestion. Files are owner-only where supported and tail-trimmed before daemon startup and every 15 minutes while the background daemon remains active. Runtime maintenance reuses the same no-follow, regular-file, single-link, `0600`, schema, UTF-8, and line-boundary checks. If the log schema marker does not match the current format, the active files are cleared before startup and the current marker is written. Runtime code reads and maintains only the active filenames.

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
machine-mcp job cancel JOB_ID
machine-mcp job submit plan.json
```

Registry changes apply to newly submitted jobs without restarting the daemon. Active jobs use the resource snapshot accepted with their plan.

Policy changes affect new submissions. Cancel accepted running jobs explicitly when revoking execution authority. A staged plan is a non-running draft and has no terminal promotion path. A trusted owner uses `start_job`; an explicit local operator may submit a reviewed JSON plan with `job submit`. A managed job transitions through `queued`, `running`, `cleaning`, and a terminal status such as `succeeded`, `failed`, or `cancelled`. Cleanup-specific terminal variants report a failed finally phase. If a runner PID dies, the next daemon/job-CLI start marks the job interrupted, removes stale private runtime copies, and runs the finally phase in recovery mode. Automatic recovery is capped at three attempts; persistent failure becomes `recovery_exhausted`.

Use job-scoped `temporary_files` for local helpers. For remote maintenance, prefer `ssh ... sh -s` with the remote script in step `stdin`; this avoids remote temporary scripts. Explicit remote cleanup belongs in idempotent `finally_steps`.

Uninstall refuses to remove local state while any managed job remains active. Active plans are needed for recovery and are owner-only. Terminal jobs delete their full plans. Bounded redacted results and runner-level diagnostics remain for up to seven days/50 jobs. Step output is never copied to ordinary daemon logs.

See [MANAGED_JOBS.md](MANAGED_JOBS.md).

## Hosted OAuth reconnection

Hosted clients may refresh access without asking the user to authorize again. Machine Bridge returns a replacement refresh token on every successful public-client refresh and invalidates the presented token. `invalid_grant` therefore means the token was already rotated, expired, or revoked by an account change or deployment-wide token-version rotation. Remove and reconnect the hosted connector; repeatedly retrying the stale token cannot recover it.

Claude and Copilot Studio call the public Worker from their cloud connectivity layers. Do not add broad Anthropic or Microsoft domains to `MBM_ALLOWED_ORIGINS` as a connectivity workaround; that variable controls browser response sharing, not server-to-server reachability, tenant policy, WAF rules, or Power Platform data policy.

## Reconnect and replacement

The daemon sends heartbeats and reconnects with bounded exponential backoff and jitter. A new socket progresses through candidate, authenticated/probing, and ready states. After `hello_ack`, the Worker sends a random probe that must return through the exact local dispatcher and relay-session result path used by real calls. Only the matching result produces `ready_ack`, `daemon.connected=true`, and tool advertisement. A healthy incumbent remains active until that proof succeeds, so a bad replacement cannot create an avoidable outage.

The Worker tracks inbound `lastSeenAt` and reclaims ready or probing sockets that go silent past their applicable liveness/readiness windows. Diagnose with `daemon.readiness_verified`, `worker.sockets_live.ready`, `worker.sockets_live.probing`, and `daemon.last_seen_at`; cumulative `worker.observability.sockets.authenticated` is an event counter, not current liveness. A state with no ready daemon is unavailable by construction rather than falsely online. Restart the daemon only after inspecting the classified timeout/protocol error; refreshing an MCP client does not repair the local transport.

Pending calls are bound to the socket that received them. Results from another socket are ignored. A lost or replaced socket rejects only its own pending calls and begins termination of locally tracked child process trees. The result/cancellation boundary and the operating-system drain boundary are separate: cleanup ownership remains visible until child close or bounded escalation settlement. Process sessions are in-memory and do not survive daemon restart or replacement.

## Limits

Defense-in-depth limits include:

- Worker MCP body: 8 MiB by default, hard cap 16 MiB;
- stdio JSON-RPC line: 8 MiB, enforced incrementally while reading;
- OAuth body: 64 KiB;
- daemon WebSocket message: 8 MiB, enforced by the local WebSocket parser before string conversion;
- text writes and patch envelopes: 5 MiB;
- images: 4 MiB before base64 encoding;
- shell/argv envelope: 64 KiB;
- public one-shot output preview: 32 KiB per stream; larger output returns an `output_session_id` and remains readable through `read_process`;
- internal bounded subprocess capture: 512 KiB per stream by default;
- running or completed process-session retained output: 1 MiB per stream for up to 30 minutes, best effort subject to the eight-session capacity, with monotonic offsets and lossless base64 fallback for non-UTF-8 slices;
- process sessions: 8 retained per runtime;
- process stdin write: 64 KiB per call;
- local simultaneous tool calls: 16 total, with 14 ordinary slots and two reserved for bounded control-plane diagnosis/recovery;
- Worker pending daemon calls: 32 total, with 30 ordinary slots and two reserved for bounded control-plane diagnosis/recovery;
- synchronous foreground timeout schema on every MCP surface: 1–60 seconds with tool-specific 30- or 60-second defaults; the daemon execution deadline is capped at that value, while the Worker uses a separate deadline five seconds later for terminal settlement; the relay execution boundary reapplies the execution default/ceiling before process spawn, including registered commands whose local manifest is longer; use process sessions or managed jobs for longer remote work;
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

The list above describes bounded application resources, not OS quotas. CPU time shares, resident-memory ceilings, syscall sandboxes, and egress policy must be imposed by the account/container/VM that runs Machine Bridge. Check `diagnose_runtime.runtime.execution_guardrails.operating_system_enforcement` remotely or local stdio `server_info.runtime.execution_guardrails.operating_system_enforcement`; current in-process values are intentionally `not-enforced` rather than inferred from timeouts or output limits.

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

### Remote authority and client trust

The saved profile defines the daemon capability ceiling. Remote authority additionally requires the authenticated account role, trusted OAuth client binding, current account version and refresh family, and ownership of any long-lived object.

Inspect accounts and trusted clients with:

```sh
machine-mcp --workspace /path/to/project account list
machine-mcp --workspace /path/to/project account clients
```

Revoke a compromised or stale client independently:

```sh
machine-mcp --workspace /path/to/project account revoke-client CLIENT_ID --yes
```

Delegated roles cannot be elevated by an approval ID or lease. Legacy version 2 leases may be inspected or removed only for migration cleanup:

```sh
machine-mcp --workspace /path/to/project approval list
machine-mcp --workspace /path/to/project approval revoke LEASE_ID
machine-mcp --workspace /path/to/project approval clear --yes
```

The current runtime never consumes legacy leases. Full details are in [LOCAL_AUTHORIZATION.md](LOCAL_AUTHORIZATION.md).

## Incident response

After suspected credential, client, or device compromise:

1. stop foreground and autostart daemons;
2. revoke the affected OAuth client, or disable/rotate the affected account;
3. clear any legacy version 2 leases as migration hygiene;
4. run `machine-mcp rotate-secrets` when device-root or deployment-wide token compromise is possible;
5. restart with the intended profile, deploy the matching Worker, and reconnect only trusted clients;
6. inspect Cloudflare access, Worker configuration, device-root provider, audit-chain health, local state/resource permissions, process-lock owners, managed-job results, and service logs;
7. cancel active managed jobs and remove compromised resource aliases;
8. remove the Worker and local state if continued remote access is unnecessary.

The detailed 0.12.0 audit record and residual operational limits are in [AUDIT.md](AUDIT.md).
