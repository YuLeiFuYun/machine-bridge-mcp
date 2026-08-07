# Logging and observability

Operational logs are a user-facing diagnosis surface. They report meaningful service state without becoming a transcript of user activity or a dump of transport callbacks.

## Goals

Logs should answer:

1. Did deployment and authenticated relay readiness succeed?
2. Is a service persistently degraded, and is recovery automatic?
3. Did the service recover, and how long was it unavailable?
4. Is an infrastructure, protocol, deployment, or local service problem requiring action?
5. When debug logging is explicitly enabled, which bounded implementation event should be correlated?

Logs are not a command history or content transcript. The local security audit provides a SHA-256 hash chain over coarse operation metadata without recording command text, paths, contents, form values, or output. Retention is bounded by both 4,096 events and 4 MiB; byte-driven eviction advances the chain anchor so the retained suffix remains verifiable, and diagnostics expose both ceilings. Audit inputs are projected to an allowlist before crossing to a dedicated Worker thread; batching, atomic replacement, and `fsync` never delay tool-result delivery on the daemon event loop. The audit worker verifies the complete chain on first access and reuses that state only while the regular-file identity and timestamps remain unchanged. Cross-process writes or external alteration force a secure reread and complete verification before another write. Remote `diagnose_runtime.runtime.security_audit` reports worker readiness, queue depth/capacity, dropped records, retained entries, event/byte limits, and chain health; local stdio exposes the same snapshot as `server_info.security_audit`. Before the Worker reports readiness, health is explicitly `audit_initializing`; the daemon thread does not synchronously read the chain. The queue is not a write-ahead log: a process or operating-system crash before persistence can lose queued events, and `dropped_records` counts only failures observed during the current process lifetime. The chain detects local alteration but is not a remote immutable ledger and is not a substitute for OS isolation.

## Levels

The CLI accepts:

```text
--log-level error|warn|info|debug
--quiet      # alias for error
--verbose    # alias for debug
```

Foreground mode defaults to `info` and human-readable text. Platform autostart services use `warn` with newline-delimited JSON. Foreground operators can select JSON explicitly with `--log-format json`.
In JSON mode, every logger entry point—including direct level methods and the persistent daemon-ready transition—emits exactly one timestamped JSON object per line. No operational method may silently fall back to the human formatter.

Human mode treats the message as the primary interface: it uses a natural-language explanation and includes only bounded diagnostic fields that add meaning. It does not repeat the machine event key. JSON mode retains the stable `event` field for ingestion and correlation. Event identifiers such as `relay.tool_result.discarded` are implementation contracts for structured logs, not text that should be shown as the warning itself.

| Level | Intended events |
|---|---|
| `error` | The operation or service cannot continue without intervention |
| `warn` | Persistent relay outage, malformed/oversized protocol data, supersession, or service/autostart degradation |
| `info` | Deployment/startup transitions, authenticated relay readiness, and recovery after a visible outage |
| `debug` | Transport open/close codes and reasons, brief self-healing interruptions, retry timing, per-tool outcomes, and shortened correlation IDs |

## Worker deployment and health event policy

Wrangler upload and `/healthz` verification are logged as separate state transitions. A successful upload followed by ambiguous health failure must say that the deployment fingerprint was retained and that retry will verify rather than redeploy. Existing-state timeout, proxy, TLS, network, and temporary server failures must say that no deployment was attempted. Only a persistent stale identity/version result may emit the ordinary warning that the same Worker is being redeployed. Candidate activation has one narrower exception: an explicit device-authentication rejection after current-version health may emit one warning that the same Worker is being redeployed with the current identity. Routine deployment progress/health logs omit both the workspace-derived Worker name and `workers.dev` endpoint; the explicit ready/connection handoff may print the endpoint because delivering that value is the command purpose. Warnings never include device key ID, public key, signature, certificate, nonce, or secret values.

Health routing records only `direct` or `proxy` at debug level. Proxy URLs, credentials, request headers, Worker secrets, and raw response bodies are never fields. Repeated per-attempt health failures remain debug-only; the terminal startup error contains one user-readable classification and corrective commands.

Autostart log-schema migration is evidence-preserving. A missing `.log-schema` is first-run state and a successfully read older schema may intentionally reset obsolete-format daemon logs. If an existing marker is oversized, inaccessible, symbolic/hard-linked, or fails any bounded/path-identity read, trimming stops before either daemon log is truncated or the marker is rewritten. Storage failure is not evidence that logs are empty, obsolete, or safe to discard.

Autostart installation and daemon startup may report the names of allowlisted proxy/custom-CA environment variables that were saved or loaded. Their values, source environment, proxy endpoints, embedded credentials, and certificate paths are prohibited log fields. Windows task failures use stable reasons such as `task_create_failed` or `task_status_unavailable`; localized command output is retained only in an explicitly requested service-command result, not repeated in default startup warnings.

## Relay connection event policy

A TCP/WebSocket `open` event is only transport availability, and `hello_ack` proves only authenticated bidirectional control traffic. The daemon is reported as ready only after a random Worker probe returns through the ordinary local dispatcher and ordinary authenticated result path and the Worker sends `ready_ack`.

Brief network interruptions are expected on laptop network changes, Worker deployment, proxy rotation, and ordinary internet transport. They are handled as follows:

- proxy selection records only `direct` or `proxy` at debug level; proxy URLs, usernames, passwords, and headers are never log fields;
- invalid proxy URLs or unsupported schemes fail fast with a sanitized corrective error rather than repeated reconnect warnings;
- the raw close code, close reason, error class, connected duration, and retry delay are debug-only;
- a brief interruption that reconnects within the grace period produces no `info` or `warn` line;
- an outage that remains unresolved for 10 seconds produces a user-readable warning stating the duration, reconnect attempt count, classified cause, and automatic recovery behavior;
- while the outage remains unresolved, reminders are scheduled independently of reconnect callbacks and use exponential backoff capped at 15 minutes;
- a WebSocket that remains in `CONNECTING` beyond its deadline is terminated so one stalled network attempt cannot freeze the reconnect loop;
- relay identity/version mismatch, authentication rejection, and unexpected protocol messages are non-transient: they produce an immediate actionable error and terminate that daemon instead of entering the reconnect loop;
- Worker `daemon_hello_timeout` and `daemon_ready_timeout` errors are transient and follow the normal reconnect path rather than being misclassified as authentication rejection;
- recovery after a visible outage produces one information summary with a human-readable duration and attempt count; exact seconds and error classes remain debug-only;
- a verified replacement is a distinct warning and permanently stops the older daemon;
- failure to receive `hello_ack` within the handshake deadline, or `ready_ack` within the independent end-to-end readiness deadline, terminates the candidate socket and retries;
- lack of inbound heartbeat activity terminates a half-open socket and reconnects;
- the Worker refreshes authenticated socket activity and queues `pong` before Durable Object alarm inspection or mutation, then performs one explicit coalesced schedule; storage latency is not allowed to sit ahead of heartbeat acknowledgement;
- a late local heartbeat tick is classified as `runtime.event_loop.stall`, sends a fresh probe, and defers disconnect for a bounded recovery interval instead of being mislabeled as immediate remote failure; a macOS sleep/wake interval may legitimately produce this warning without a daemon fault.

A WebSocket close code such as `1006` means the transport ended without a normal close handshake. If it recovers inside ten seconds, the warning-level service log is intentionally silent and the authenticated `daemon.relay_transport` snapshot is the post-event evidence surface. It is useful for debug diagnosis but not useful as the default user message. It is not evidence that the daemon process restarted. Worker `daemon_transport_error` / `daemon_liveness_timeout` messages and their 1012 close frames are likewise retryable connection conditions, not upgrade instructions. Only an unknown/incompatible Worker error, authentication failure, or identity/version mismatch may produce the fatal protocol/configuration log and daemon exit. Default logs therefore describe the affected layer, duration, classification, and recovery behavior rather than printing raw close envelopes.

Streamed-call diagnostics are deliberately coarse. Modern request-scoped stream ownership is memory-only; legacy MCP `2025-11-25` may additionally report aggregate persistent active/detached counts, oldest age, tool-name counts, alarm mutations, unmatched-result counts, opened/coexisting/limited delivery-subscriber counts, terminal publications, live internal-subscriber sends, storage responses, and storage-race sends/failures. These counters describe legacy resumable Worker-internal storage and subscription transport; they do not prove public SSE consumption or MCP-host receipt. Worker event counters are scoped to the current isolate and say so in `metric_scope`; persisted durable calls can begin in one isolate and complete in another, so `started`, `completed`, and `failed` are not algebraically closed process-lifetime totals. The persistent pending-call snapshot is authoritative for current ownership. Logs and `server_info` must not include tool arguments, terminal results, command text, request keys, account identifiers, raw call IDs, raw connection generations, mirrored parameter values, private paths, or subscriber payloads. A stale-generation result is counted as unmatched rather than logged with its envelope.

Examples:

```text
[info] daemon: remote relay connected and end-to-end result delivery verified
[warn] daemon: remote relay unavailable for 12 seconds; reconnecting automatically (3 reconnect attempts; connection interrupted).
[info] daemon: remote relay connection restored after 18 seconds (4 reconnect attempts)
```

With `--verbose`, the same incident additionally includes bounded structured fields such as exact seconds, coarse error class, retry delay, and transport close diagnostics.

## Tool and result-delivery events

All per-tool starts, successes, failures, cancellations, timing, and expected late-result disposal are debug-only. The MCP response already reports the outcome to the caller; duplicating routine tool traffic at default levels creates noise and can reveal activity patterns. Completed one-shot output continuations are not written to daemon logs or disk; their bounded stdout/stderr remains only in the daemon process-session memory and expires with normal session retention.

The layered repository check runner follows the same noise rule. Green child-task output is discarded after the child exits; only task name and elapsed time are printed. Failed tasks expose bounded head/tail stdout and stderr diagnostics. `MBM_CHECK_VERBOSE=1` is an explicit operator choice to stream raw child output and is not used by default or CI.

A completed local result is normally sent on the ready relay connection. If that daemon WebSocket disappears, the runtime may queue the bounded result envelope during the shared two-minute same-daemon reconnect window; this relay-layer queue is independent of the public MCP protocol era. Debug output records only a shortened call ID and queue/reconnect counts. After the same daemon process completes readiness, replay emits one recovery event; a different process cannot inherit the result. For modern MCP `2026-07-28`, closing the public HTTP response stream cancels that request through a random internal capability; the control request contains no Authorization or DPoP header, and the capability is not logged. For legacy MCP `2025-11-25`, disposing the public response does not cancel the session-bound operation because the host may recover it with `Last-Event-ID`; explicit legacy cancellation suppresses eventual delivery. Tool arguments, mirrored header values, validation values, and result content are never logged.

Debug per-tool fields may include tool name, duration, coarse outcome class, and a shortened random call identifier. The identifier is for correlating adjacent local events and is not a stable audit identifier. Authorization failures return a stable denial code and bounded guidance; the current runtime never creates approval IDs or temporary elevation leases. Daemon logs still omit normalized targets and request arguments.

## Data that is never logged

The implementation omits:

- tool arguments and command text or argv;
- stdin, stdout, and stderr;
- file, patch, image, and temporary-file content;
- OAuth request bodies;
- account passwords, root/session signatures, device private keys, authorization codes, access tokens, refresh tokens, DPoP proofs, and legacy-lease target material;
- registered resource values and source paths;
- browser pairing tokens, page URLs/source, DOM metadata, form values, uploaded file bytes, and screenshots;
- application names, Accessibility trees, selectors, and entered values;
- built-in instruction text, automatic project facts, package script names, and explicit instruction-file contents.

Unexpected infrastructure failures are reduced to coarse error classes in normal logs. Client-facing tool errors may contain more detail according to the active path-display policy, but those details are not copied into operational logs.

## Local automation events

Browser broker ownership, extension connection, and persistent unavailability are infrastructure state. Ordinary tab/source/action/form/upload/screenshot calls remain per-tool debug events and never log their arguments or results. Pairing tokens are excluded from all structured fields.

Application discovery and Accessibility operations follow the same rule: permission or runtime failures are classified, while app names, UI trees, selectors, and values are not operational log data.

## Bounding and redaction

Messages, strings, object depth, object key counts, array item counts, and serialized field payloads are bounded. Tool-argument validation reports only a bounded tool name, JSON Pointer path, schema keyword, and constraint message; it never includes the rejected value. Control characters and Unicode display controls are neutralized. Fields with secret-like names and path-like keys are recursively redacted. Free-form sanitization covers generic private-key headers, AWS/GitHub/GitLab/npm/Slack/Google/live-payment/API token forms, JWT-shaped values, URLs with embedded credentials, email addresses, and user-home paths.

Local and Worker free-form strings use the same portable value sanitizer. Worker fields are therefore inspected by content even when their key is not secret-shaped. Both structured loggers assign their authoritative metadata after sanitizing caller fields. Local `timestamp`, `level`, `component`, `message`, and `event`, plus Worker `timestamp`, `level`, `component`, and `event`, therefore cannot be forged or replaced by an event payload. Local-only recursive path-key redaction and environment-derived home aliases remain additional protections around the portable rules.

The logger exposes two intentional plain-output boundaries. `safePlain` sanitizes operational guidance and diagnostic text. Raw `plain` output is reserved for explicitly requested credentials or local paths whose display is the command's purpose; callers must not pass external exception text or tool content to it.

This is defense in depth, not content classification. Unknown, split, transformed, encrypted, or application-specific secret formats can evade pattern matching, which is why tool arguments and outputs are omitted rather than merely filtered.

## Structured lifecycle events


Security-audit enqueue/persistence failures are warning-level operational faults, but repeated failures are rate-limited per event class. The first warning is emitted immediately; duplicates within one minute are suppressed, and the next emitted warning reports the suppressed count. Warning fields contain only the tool name and a coarse error class, never the rejected audit payload or principal identifiers.

The local execution middleware emits bounded events such as `tool.call.started`, `tool.call.completed`, `tool.call.failed`, `tool.call.slow`, and `tool.call.cancel_requested`. Stable fields include a shortened call ID, tool name, origin, duration, error code, and retryability. The Worker emits JSON events for HTTP failures and daemon socket errors. Unexpected HTTP failures carry only a low-cardinality route class (`mcp`, `daemon`, `oauth`, `admin`, or `other`) plus a coarse error class; the raw request pathname is not an operational log field. Structured values still pass through field-name and value redaction; JSON format is not permission to log arguments or results. A retained stale-socket cleanup failure uses `daemon.socket.cleanup.failed` with only `error_class`; it contains no socket identity, endpoint, arguments, or results.

`server_info` is the operational metrics surface. Local metrics include lifecycle state, active and maximum calls, oldest-call age, active-process ownership, per-tool duration buckets, and error-code counts. Worker metrics include HTTP status classes, pending internal/request-key indexes, per-tool outcomes, daemon candidate/authenticated/ready/disconnected event counts, current authenticated/probing/ready socket counts, and protocol-error counts. Metrics contain counts and bounded identifiers, not request arguments or result contents.

## Files

Autostart logs are stored below the owner-only state root:

```text
logs/daemon.out.log
logs/daemon.err.log
```

Existing files are opened without following symbolic links where supported and tail-trimmed on UTF-8/line boundaries before startup. The active background daemon repeats the same secure trim every 15 minutes, so a long-lived process remains bounded even under repeated warning-level failures. Maintenance errors expose only a coarse error class. Background services use `warn`, so ordinary tool traffic and brief relay interruptions do not cause sustained growth.

The log format has an explicit schema marker. If the marker differs from the current format, the daemon clears the active files before startup and writes the current marker. Runtime code recognizes only `daemon.out.log` and `daemon.err.log`; it does not parse or archive other log formats.

Each managed job has owner-only runner diagnostic logs. Child-step output is retained only in bounded, redacted job results according to `capture_output`; it is not copied into daemon or runner operational logs.

## Relay outage records

`network_route` describes only Machine Bridge's application-level proxy decision. `system-network-stack` does **not** mean a direct physical path: an operating-system VPN, TUN, packet tunnel, DNS interceptor, or endpoint-security product may still carry the connection. `network_route_scope` therefore remains `application-proxy-selection-only`.

During an outage, remote `diagnose_runtime.runtime.relay` and local stdio `server_info.runtime.relay` expose bounded live fields: outage count/start/duration, attempts, last close category/code, coarse transport error class, last disconnect/ready time, prior ready duration, and next retry timing. After recovery, authenticated remote `server_info.daemon.relay_transport` retains the bounded preceding episode that the daemon supplied during the current connection handshake, including brief interruptions below the default warning threshold. Promotion to a ready socket sets `outage_active=false`, extends the duration through actual readiness, preserves the preceding healthy-ready duration across failed candidates, canonicalizes timestamps, and accepts only enumerated coarse operational error classes; it does not claim that the recovered connection remains in outage. On macOS, `diagnose_runtime` may also return a coarse default-route class and `operating_system_interception` boolean. That diagnostic is returned on demand and is not promoted to default logs; interface names, IP addresses, DNS answers, proxy endpoints/credentials, Worker endpoints, tool arguments, and results remain absent. `relay.outage.active` and `relay.outage.recovered` carry the existing safe relay fields.

Schema 4 is strict NDJSON. Before daemon startup, both active log files are opened as owner-only regular single-link files. A schema change clears both only after validation and commits the marker only after the transition succeeds. A symlink, multiple-hard-link inode, permission error, or marker-write failure blocks startup rather than mixing formats or repeatedly erasing evidence.

## MCP host boundary

Canonical `full` does not remove tools based on filenames. For remote execution, the operation classifier treats credential-sensitive paths and persistence targets as hard authorization boundaries: delegated roles are denied, while owner requests remain risk-classified and audited. An MCP host, connector, model provider, desktop application, operating system, or endpoint-security layer may independently reject a request before it reaches Machine Bridge.

Use `server_info`, `project_overview`, `machine-mcp status`, `machine-mcp doctor`, and `diagnose_runtime` to distinguish local policy from host-side enforcement. `doctor` explicitly reports that its isolated runtime did not inspect the running service process or remote relay; it must not be used as a substitute for `server_info.daemon.relay_transport`. Capability-routing status is returned on demand rather than written as task logs. The in-memory observer stores a runtime-keyed task fingerprint, selected skill/match counts, recommended tool names, primary route, ambiguity class, and score gap; it never stores raw task text, static instruction content, application inventory, or route explanations. Changing the Machine Bridge profile cannot override another layer.

## Adding or changing logs

A default-level message must be actionable, privacy-preserving, and resistant to repetition. Add a regression test for severity and field visibility. Raw protocol values belong at debug unless a user can act on them without external documentation. New plain-output calls require explicit review of whether `safePlain` is sufficient.

See [ENGINEERING.md](ENGINEERING.md) for the project-wide review rules.
