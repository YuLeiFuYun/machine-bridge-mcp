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
| No structured result because the host rejects the call | Host/connector approval or safety layer, or transport before daemon delivery |
| `mcp-host-to-daemon` passes but `local-filesystem` fails | Local state/runtime permissions, disk policy, sandbox, or endpoint security |
| Filesystem passes but `local-process-spawn` fails | Local executable policy, endpoint security, OS permissions, or damaged Node runtime |
| Direct spawn passes but `local-shell` fails | Shell path/profile/policy problem |
| `managed-job-storage` fails | Owner-only profile/job directory cannot be used |
| Registered resource is unavailable | File moved, permissions changed, size exceeded, or local access denied |

A successful diagnostic result applies only to that probe. An MCP host can still deny a later call based on its own request context.

## Logs

Remote autostart logs are stored under the state root in `logs/daemon.out.log` and `logs/daemon.err.log`. Files are owner-only where supported and tail-trimmed before daemon startup.

Logging is level-based:

```text
error  unrecoverable local/transport failures
warn   failed calls, disconnects, malformed relay events
info   startup/deploy/connect transitions and calls slower than 30 seconds
debug  routine successful calls, shortened correlation IDs, cancellation/reconnect details
```

Foreground mode defaults to `info`; autostart uses `warn`. Use `--verbose` or `--log-level debug` only for diagnosis. `--quiet` is an alias for `--log-level error`.

Normal logs intentionally omit tool arguments, file/patch/image content, command text and argv, stdin/stdout/stderr, OAuth request bodies, connection credentials, authorization codes, and tokens. Unexpected daemon and Worker failures use coarse error classes rather than raw exception messages. Messages and structured fields are bounded and secret-like fields/token formats are redacted.

See [LOGGING.md](LOGGING.md) for the event contract and MCP-host boundary. Cloudflare observability is sampled and is not a complete audit log.

## Managed jobs and local recovery

Register local-only resources from the terminal:

```sh
machine-mcp resource add NAME FILE_PATH
machine-mcp resource list
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
- OAuth body: 64 KiB;
- daemon WebSocket message: 8 MiB;
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
- job-scoped temporary files: 16 files, 512 KiB total content.

## Upgrade behavior

Version 0.5 records policy origin and revision. A state entry matching the exact legacy implicit-default shape—write enabled, shell enabled, workspace-confined paths, isolated environment, and relative output—is migrated once to the current `full` default. Explicit named profiles and identified custom policies are preserved.

`full` enables writes, direct processes, process sessions, shell execution, unrestricted direct filesystem paths, absolute path output, and the complete parent environment. It does not override operating-system access controls or independent MCP-host/platform policy.

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
