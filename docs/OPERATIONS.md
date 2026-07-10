# Operations

## Health and diagnosis

```sh
machine-mcp status
machine-mcp doctor
machine-mcp service status
```

`status` prints redacted profile state and verifies the deployed Worker version. `doctor` checks Node.js, the package-installed Wrangler binary, Cloudflare login, and Worker health. Public `/healthz` output contains only server identity and version; daemon details require an authenticated `server_info` call.

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
- recursive walk: 200,000 visited entries.

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
4. inspect Cloudflare account access, Worker configuration, local state permissions, and service logs;
5. remove the Worker and local state if continued remote access is unnecessary.
