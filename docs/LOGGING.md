# Logging and observability

Operational logs are a user-facing diagnosis surface. They report meaningful service state without becoming a transcript of user activity or a dump of transport callbacks.

## Goals

Logs should answer:

1. Did deployment and authenticated relay readiness succeed?
2. Is a service persistently degraded, and is recovery automatic?
3. Did the service recover, and how long was it unavailable?
4. Is an infrastructure, protocol, deployment, or local service problem requiring action?
5. When debug logging is explicitly enabled, which bounded implementation event should be correlated?

Logs are not a command history, content audit trail, or substitute for MCP client approvals.

## Levels

The CLI accepts:

```text
--log-level error|warn|info|debug
--quiet      # alias for error
--verbose    # alias for debug
```

Foreground mode defaults to `info`. Platform autostart services use `warn`.

| Level | Intended events |
|---|---|
| `error` | The operation or service cannot continue without intervention |
| `warn` | Persistent relay outage, malformed/oversized protocol data, supersession, or service/autostart degradation |
| `info` | Deployment/startup transitions, authenticated relay readiness, and recovery after a visible outage |
| `debug` | Transport open/close codes and reasons, brief self-healing interruptions, retry timing, per-tool outcomes, and shortened correlation IDs |

## Relay connection event policy

A TCP/WebSocket `open` event is only transport availability. The daemon is reported as connected only after the Worker returns `hello_ack` for the authenticated `hello` message.

Brief network interruptions are expected on laptop network changes, Worker deployment, proxy rotation, and ordinary internet transport. They are handled as follows:

- the raw close code, close reason, error class, connected duration, and retry delay are debug-only;
- a brief interruption that reconnects within the grace period produces no `info` or `warn` line;
- an outage that remains unresolved for 10 seconds produces one rate-limited warning stating that automatic reconnection is in progress;
- relay identity/version mismatch and authentication rejection are non-transient: they produce an immediate actionable error and terminate that daemon instead of entering the reconnect loop;
- repeated warnings are rate-limited;
- recovery after a visible outage produces one information summary with outage duration and attempt count;
- an authenticated replacement is a distinct warning and permanently stops the older daemon;
- failure to receive `hello_ack` within the handshake deadline terminates the candidate socket and retries;
- lack of inbound heartbeat activity terminates a half-open socket and reconnects.

A WebSocket close code such as `1006` means the transport ended without a normal close handshake. It is useful for debug diagnosis but not useful as the default user message. Default logs therefore describe the effect and recovery behavior rather than printing `{"code":1006,"reason":""}`.

Examples:

```text
[info] daemon: remote relay connected
[warn] daemon: remote relay is unavailable; automatic reconnection is still in progress {"outage_seconds":12,"attempts":3,"cause":"connection interrupted"}
[info] daemon: remote relay connection restored {"outage_seconds":18,"attempts":4}
```

With `--verbose`, the same incident may additionally include bounded transport diagnostics.

## Tool events

All per-tool starts, successes, failures, cancellations, and timing are debug-only. The MCP response already reports the outcome to the caller; duplicating routine tool traffic at default levels creates noise and can reveal activity patterns.

Debug per-tool fields may include tool name, duration, coarse outcome class, and a shortened random call identifier. The identifier is for correlating adjacent local events and is not a stable audit identifier.

## Data that is never logged

The implementation omits:

- tool arguments and command text or argv;
- stdin, stdout, and stderr;
- file, patch, image, and temporary-file content;
- OAuth request bodies;
- connection passwords, daemon secrets, authorization codes, and access tokens;
- registered resource values and source paths.

Unexpected infrastructure failures are reduced to coarse error classes in normal logs. Client-facing tool errors may contain more detail according to the active path-display policy, but those details are not copied into operational logs.

## Bounding and redaction

Messages, strings, object depth, object key counts, array item counts, and serialized field payloads are bounded. Control characters and Unicode display controls are neutralized. Fields with secret-like names, path-like keys, and known token formats are recursively redacted.

This is defense in depth, not content classification. Unknown secret formats can evade pattern matching, which is why tool arguments and outputs are omitted rather than merely filtered.

## Files

Autostart logs are stored below the owner-only state root:

```text
logs/daemon.out.log
logs/daemon.err.log
```

Existing files are opened without following symbolic links where supported and tail-trimmed on UTF-8/line boundaries before startup. Background services use `warn`, so ordinary tool traffic and brief relay interruptions do not cause sustained growth.

Each managed job has owner-only runner diagnostic logs. Child-step output is retained only in bounded, redacted job results according to `capture_output`; it is not copied into daemon or runner operational logs.

## MCP host boundary

Machine Bridge does not classify filenames as sensitive and does not block credential-looking names under canonical `full`. An MCP host, connector, model provider, desktop application, operating system, or endpoint-security layer may independently reject a request before it reaches Machine Bridge.

Use `server_info`, `machine-mcp status`, `machine-mcp doctor`, and `diagnose_runtime` to distinguish local policy from host-side enforcement. Changing the Machine Bridge profile cannot override another layer.

## Adding or changing logs

A default-level message must be actionable, privacy-preserving, and resistant to repetition. Add a regression test for severity and field visibility. Raw protocol values belong at debug unless a user can act on them without external documentation.

See [ENGINEERING.md](ENGINEERING.md) for the project-wide review rules.
