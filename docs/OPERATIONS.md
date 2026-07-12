# Operations

## Health and diagnosis

```sh
machine-mcp status
machine-mcp doctor
machine-mcp service status
```

`status` prints redacted profile state and verifies the deployed Worker version. Resource source paths remain redacted. `doctor` checks Node.js, the package-installed Wrangler binary, Cloudflare login, Worker health, and the same fixed local filesystem/process/shell/job-storage/resource probes exposed by `diagnose_runtime`. Public `/healthz` output contains only server identity and version; daemon details require an authenticated `server_info` call.

### Blocking-layer decision table

| Result | Interpretation |
|---|---|
| `server_info` reports full and all relay tools, but the current session UI exposes fewer tools | Host/connector post-relay filtering; Machine Bridge cannot enumerate or override that subset |
| No structured result because the host rejects the call | Host/connector approval or safety layer, or transport before daemon delivery |
| `mcp-host-to-daemon` passes but `local-filesystem` fails | Local state/runtime permissions, disk policy, sandbox, or endpoint security |
| Filesystem passes but `local-process-spawn` fails | Local executable policy, endpoint security, OS permissions, or damaged Node runtime |
| Direct spawn passes but `local-shell` fails | Shell path/profile/policy problem |
| `managed-job-storage` fails | Owner-only profile/job directory cannot be used |
| Registered resource is unavailable | File moved, permissions changed, size exceeded, or local access denied |

A successful diagnostic result applies only to that probe. An MCP host can still deny a later call based on its own request context. This is expected layering, not a defect in the `full` profile: `full` removes Machine Bridge's own denials, while host delivery remains independent.

### Relay interruption messages

A brief relay interruption is retried automatically and is visible only with `--verbose`. Default logs do not print raw WebSocket values such as `code=1006` with an empty reason. If a transient outage persists for 10 seconds, the daemon emits a readable duration/cause/reconnect summary; later reminders use autonomous exponential backoff capped at 15 minutes, and recovery produces one readable summary. Each transport connection attempt also has a deadline, so a socket stuck in `CONNECTING` cannot freeze retries. Identity/version mismatch, authentication rejection, and unexpected protocol messages are not retried as ordinary network faults: the daemon emits an immediate actionable error and exits, requiring upgrade/redeployment or credential repair. A Worker-side daemon handshake timeout remains retryable.

Use `--verbose` only when close codes, close reasons, heartbeat timeouts, and retry delays are needed for diagnosis. A close code of 1006 means the transport ended without a normal close handshake; it does not by itself identify the cause.

## Browser extension setup and diagnosis

The full-profile daemon starts the loopback browser broker automatically. Install/pair the packaged extension once:

```sh
machine-mcp browser setup
machine-mcp browser status
```

`browser setup` prints the unpacked-extension path and opens the local pairing page. Load that directory from the Chromium extensions page with Developer mode enabled. The pairing page contains the token only in non-cacheable loopback HTML; the CLI and MCP result do not print it. A first pairing is automatic. When local pairing state was reset or moved, click the extension icon on the active pairing page to authorize replacing the extension's previous broker configuration.

Diagnosis:

| Result | Interpretation |
|---|---|
| broker not reachable | no full-profile runtime owns the machine broker, state is stale, or a local security product blocked loopback listening |
| broker running, extension disconnected | extension not loaded/enabled, pairing not completed, browser profile not running, or MV3 worker reconnect failed |
| tab list works but page action fails | restricted browser-internal page, inaccessible frame, stale selector, page navigation, enterprise policy, or page script interference |
| `frame_id` action fails | frame was replaced or is not accessible; inspect frames again |
| resource-backed upload fails | resource unavailable/too large, input is not `type=file`, page replaced the input, or the site rejects the file |

The machine-level broker permits multiple workspace daemons/stdio clients to share one extension. A second runtime becomes an authenticated broker client rather than selecting a new port or replacing the extension. Its owner-only `browser-bridge.json` pairing record is a recognized state-root entry, so validated uninstall can remove the complete Machine Bridge state root without treating the pairing record as unrelated data. Restarting every runtime is not normally required after adding a skill or changing a form page; capability and DOM discovery are live.

## macOS application automation

Application UI inspection/actions require Accessibility permission for the Node/Machine Bridge process. Grant it in macOS Privacy & Security, then retry `inspect_local_application`. Opening applications does not require the same Accessibility authority. If an app changes UI hierarchy or localizes labels, inspect again and use role/identifier/index selectors instead of assuming a stale title.

## Logs

Remote autostart definitions prefer a stable PATH alias that resolves to the currently running Node executable and persist a sanitized absolute-only service `PATH` containing the Node/CLI directories, the installer's absolute PATH entries, and platform defaults. This avoids versioned Homebrew-style paths becoming invalid after upgrades and prevents launchd/systemd from falling back to a minimal system-only PATH. Re-run `machine-mcp service install` after changing Node installation families or PATH layout. A service-style `--daemon-only` start that finds the same workspace daemon already running is an idempotent no-op: it exits successfully without repeating warnings or readiness output; explicit policy/secret/change requests still report that changes were not applied. Autostart logs are stored under the state root in `logs/daemon.out.log` and `logs/daemon.err.log`. Files are owner-only where supported and tail-trimmed before daemon startup. On a logging-schema upgrade, bounded prior content is moved into `daemon.out.legacy.log` and `daemon.err.legacy.log`; use the active filenames when diagnosing current behavior.

Logging is level-based:

```text
error  unrecoverable local/transport/service failures
warn   persistent retryable relay degradation, supersession, and service problems
info   startup/deploy/connect transitions
debug  all per-tool starts/successes/failures/cancellations/timing, correlation and reconnect details
```

Foreground mode defaults to `info`; autostart uses `warn`. Use `--verbose` or `--log-level debug` only for diagnosis. `--quiet` is an alias for `--log-level error`.

Normal logs intentionally omit tool arguments, file/patch/image content, command text and argv, stdin/stdout/stderr, OAuth request bodies, connection credentials, authorization codes, and tokens. Unexpected daemon and Worker failures use coarse error classes rather than raw exception messages. Messages and structured fields are bounded and secret-like fields/token formats are redacted.

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

## Reconnect and replacement

The daemon sends heartbeats and reconnects with bounded exponential backoff and jitter. A new socket remains a candidate until it authenticates and sends a valid `hello`; only then does it replace the previous daemon.

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
- process-session read wait: at most 30 seconds;
- direct directory result: 10,000 entries and 4 MiB of path metadata;
- recursive walk: 200,000 visited entries;
- managed jobs: 50 retained, seven-day retention;
- managed-job steps: 16 main plus 16 finally;
- managed-job timeout: 1–3,600 seconds per step;
- managed-job output: 64 KiB per stream and 256 KiB total captured across one job;
- registered resources: 64, 1 MiB each, 8 MiB referenced per job;
- browser source: 4 MiB; browser WebSocket messages: 8 MiB; pending browser requests: 32 per runtime;
- browser forms: 200 fields, 128 KiB per text value, and 4 MiB aggregate text; upload: eight resources and 5 MiB total;
- application Accessibility inspection: 500 elements and depth 12; action text: 4,000 characters;
- job-scoped temporary files: 16 files, 512 KiB total content.

## Upgrade behavior

Policy revision 3 makes named profiles canonical. A state entry labelled `full` is repaired to writes, direct processes, process sessions, shell execution, unrestricted direct filesystem paths, absolute path output, the complete parent environment, and the complete tool catalog. CLI capability overrides are stored as `custom`. The exact pre-0.4 implicit-default shape is still migrated to the current `full` default; explicit restrictive and identified custom profiles remain preserved.

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
4. inspect Cloudflare account access, Worker configuration, local state/resource permissions, managed-job results, and service logs;
5. cancel active managed jobs and remove compromised resource aliases;
6. remove the Worker and local state if continued remote access is unnecessary.
