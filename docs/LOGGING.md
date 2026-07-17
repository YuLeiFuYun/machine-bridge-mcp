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

Foreground mode defaults to `info` and human-readable text. Platform autostart services use `warn` with newline-delimited JSON. Foreground operators can select JSON explicitly with `--log-format json`.

Human mode treats the message as the primary interface: it uses a natural-language explanation and includes only bounded diagnostic fields that add meaning. It does not repeat the machine event key. JSON mode retains the stable `event` field for ingestion and correlation. Event identifiers such as `relay.tool_result.discarded` are implementation contracts for structured logs, not text that should be shown as the warning itself.

| Level | Intended events |
|---|---|
| `error` | The operation or service cannot continue without intervention |
| `warn` | Persistent relay outage, malformed/oversized protocol data, supersession, or service/autostart degradation |
| `info` | Deployment/startup transitions, authenticated relay readiness, and recovery after a visible outage |
| `debug` | Transport open/close codes and reasons, brief self-healing interruptions, retry timing, per-tool outcomes, and shortened correlation IDs |

## Worker deployment and health event policy

Wrangler upload and `/healthz` verification are logged as separate state transitions. A successful upload followed by ambiguous health failure must say that the deployment fingerprint was retained and that retry will verify rather than redeploy. Existing-state timeout, proxy, TLS, network, and temporary server failures must say that no deployment was attempted. Only a persistent stale identity/version result may emit the warning that the same Worker is being redeployed.

Health routing records only `direct` or `proxy` at debug level. Proxy URLs, credentials, request headers, Worker secrets, and raw response bodies are never fields. Repeated per-attempt health failures remain debug-only; the terminal startup error contains one user-readable classification and corrective commands.

Autostart installation and daemon startup may report the names of allowlisted proxy/custom-CA environment variables that were saved or loaded. Their values, source environment, proxy endpoints, embedded credentials, and certificate paths are prohibited log fields. Windows task failures use stable reasons such as `task_create_failed` or `task_status_unavailable`; localized command output is retained only in an explicitly requested service-command result, not repeated in default startup warnings.

## Relay connection event policy

A TCP/WebSocket `open` event is only transport availability. The daemon is reported as connected only after the Worker returns `hello_ack` for the authenticated `hello` message.

Brief network interruptions are expected on laptop network changes, Worker deployment, proxy rotation, and ordinary internet transport. They are handled as follows:

- proxy selection records only `direct` or `proxy` at debug level; proxy URLs, usernames, passwords, and headers are never log fields;
- invalid proxy URLs or unsupported schemes fail fast with a sanitized corrective error rather than repeated reconnect warnings;
- the raw close code, close reason, error class, connected duration, and retry delay are debug-only;
- a brief interruption that reconnects within the grace period produces no `info` or `warn` line;
- an outage that remains unresolved for 10 seconds produces a user-readable warning stating the duration, reconnect attempt count, classified cause, and automatic recovery behavior;
- while the outage remains unresolved, reminders are scheduled independently of reconnect callbacks and use exponential backoff capped at 15 minutes;
- a WebSocket that remains in `CONNECTING` beyond its deadline is terminated so one stalled network attempt cannot freeze the reconnect loop;
- relay identity/version mismatch, authentication rejection, and unexpected protocol messages are non-transient: they produce an immediate actionable error and terminate that daemon instead of entering the reconnect loop;
- a Worker `daemon_hello_timeout` error is transient and follows the normal reconnect path rather than being misclassified as authentication rejection;
- recovery after a visible outage produces one information summary with a human-readable duration and attempt count; exact seconds and error classes remain debug-only;
- an authenticated replacement is a distinct warning and permanently stops the older daemon;
- failure to receive `hello_ack` within the handshake deadline terminates the candidate socket and retries;
- lack of inbound heartbeat activity terminates a half-open socket and reconnects.

A WebSocket close code such as `1006` means the transport ended without a normal close handshake. It is useful for debug diagnosis but not useful as the default user message. Default logs therefore describe the effect and recovery behavior rather than printing `{"code":1006,"reason":""}`.

Examples:

```text
[info] daemon: remote relay connected
[warn] daemon: remote relay unavailable for 12 seconds; reconnecting automatically (3 reconnect attempts; connection interrupted).
[info] daemon: remote relay connection restored after 18 seconds (4 reconnect attempts)
```

With `--verbose`, the same incident additionally includes bounded structured fields such as exact seconds, coarse error class, retry delay, and transport close diagnostics.

## Tool and result-delivery events

All per-tool starts, successes, failures, cancellations, timing, and expected late-result disposal are debug-only. The MCP response already reports the outcome to the caller; duplicating routine tool traffic at default levels creates noise and can reveal activity patterns.

A completed local result is bound to the authenticated relay session that delivered its call. If the caller cancelled, the relay disconnected, or a replacement relay session became active, the result is discarded rather than sent to a different session. This is a normal terminal race and does not emit a warning. Debug output records only a shortened call ID and a coarse reason such as `caller_cancelled`, `relay_disconnected`, or `session_ended`. A synchronous send failure on the still-current socket is different: the socket is invalidated because delivery is ambiguous, but the per-call detail remains debug-only while the normal relay-outage state machine decides whether a user-visible warning is warranted.

Debug per-tool fields may include tool name, duration, coarse outcome class, and a shortened random call identifier. The identifier is for correlating adjacent local events and is not a stable audit identifier.

## Data that is never logged

The implementation omits:

- tool arguments and command text or argv;
- stdin, stdout, and stderr;
- file, patch, image, and temporary-file content;
- OAuth request bodies;
- account passwords, account-administration secrets, daemon secrets, authorization codes, access tokens, and refresh tokens;
- registered resource values and source paths;
- browser pairing tokens, page URLs/source, DOM metadata, form values, uploaded file bytes, and screenshots;
- application names, Accessibility trees, selectors, and entered values;
- built-in instruction text, automatic project facts, package script names, and explicit instruction-file contents.

Unexpected infrastructure failures are reduced to coarse error classes in normal logs. Client-facing tool errors may contain more detail according to the active path-display policy, but those details are not copied into operational logs.

## Local automation events

Browser broker ownership, extension connection, and persistent unavailability are infrastructure state. Ordinary tab/source/action/form/upload/screenshot calls remain per-tool debug events and never log their arguments or results. Pairing tokens are excluded from all structured fields.

Application discovery and Accessibility operations follow the same rule: permission or runtime failures are classified, while app names, UI trees, selectors, and values are not operational log data.

## Bounding and redaction

Messages, strings, object depth, object key counts, array item counts, and serialized field payloads are bounded. Control characters and Unicode display controls are neutralized. Fields with secret-like names and path-like keys are recursively redacted. Free-form sanitization covers generic private-key headers, AWS/GitHub/GitLab/npm/Slack/Google/live-payment/API token forms, JWT-shaped values, URLs with embedded credentials, email addresses, and user-home paths.

The logger exposes two intentional plain-output boundaries. `safePlain` sanitizes operational guidance and diagnostic text. Raw `plain` output is reserved for explicitly requested credentials or local paths whose display is the command's purpose; callers must not pass external exception text or tool content to it.

This is defense in depth, not content classification. Unknown, split, transformed, encrypted, or application-specific secret formats can evade pattern matching, which is why tool arguments and outputs are omitted rather than merely filtered.

## Structured lifecycle events

The local execution middleware emits bounded events such as `tool.call.started`, `tool.call.completed`, `tool.call.failed`, `tool.call.slow`, and `tool.call.cancel_requested`. Stable fields include a shortened call ID, tool name, origin, duration, error code, and retryability. The Worker emits JSON events for HTTP failures and daemon socket errors. Structured values still pass through field-name and value redaction; JSON format is not permission to log arguments or results.

`server_info` is the operational metrics surface. Local metrics include lifecycle state, active and maximum calls, oldest-call age, active-process ownership, per-tool duration buckets, and error-code counts. Worker metrics include HTTP status classes, pending internal/request-key indexes, per-tool outcomes, daemon candidate/authenticated/disconnected counts, and protocol-error counts. Metrics contain counts and bounded identifiers, not request arguments or result contents.

## Files

Autostart logs are stored below the owner-only state root:

```text
logs/daemon.out.log
logs/daemon.err.log
```

Existing files are opened without following symbolic links where supported and tail-trimmed on UTF-8/line boundaries before startup. Background services use `warn`, so ordinary tool traffic and brief relay interruptions do not cause sustained growth.

The log format has an explicit schema marker. If the marker differs from the current format, the daemon clears the active files before startup and writes the current marker. Runtime code recognizes only `daemon.out.log` and `daemon.err.log`; it does not parse or archive other log formats.

Each managed job has owner-only runner diagnostic logs. Child-step output is retained only in bounded, redacted job results according to `capture_output`; it is not copied into daemon or runner operational logs.

## MCP host boundary

Machine Bridge does not classify filenames as sensitive and does not block credential-looking names under canonical `full`. An MCP host, connector, model provider, desktop application, operating system, or endpoint-security layer may independently reject a request before it reaches Machine Bridge.

Use `server_info`, `project_overview`, `machine-mcp status`, `machine-mcp doctor`, and `diagnose_runtime` to distinguish local policy from host-side enforcement. Capability-routing status is returned on demand rather than written as task logs; it stores a runtime-keyed task fingerprint, not raw task text. Changing the Machine Bridge profile cannot override another layer.

## Adding or changing logs

A default-level message must be actionable, privacy-preserving, and resistant to repetition. Add a regression test for severity and field visibility. Raw protocol values belong at debug unless a user can act on them without external documentation. New plain-output calls require explicit review of whether `safePlain` is sufficient.

See [ENGINEERING.md](ENGINEERING.md) for the project-wide review rules.
