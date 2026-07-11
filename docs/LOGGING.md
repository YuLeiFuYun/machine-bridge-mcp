# Logging and observability

## Goals

Operational logs should answer four questions without becoming a transcript of user activity:

1. Did deployment and relay connection succeed?
2. Is the daemon reconnecting, superseded, or unhealthy?
3. Is an infrastructure, protocol, deployment, or relay failure occurring?
4. When debug logging is explicitly enabled, which bounded per-tool event should be correlated?

Logs are not a command history, content audit trail, or substitute for MCP client approvals.

## Levels

The CLI accepts:

```text
--log-level error|warn|info|debug
--quiet      # alias for error
--verbose    # alias for debug
```

The default foreground level is `info`. Platform autostart services use `warn`.

| Level | Intended events |
|---|---|
| `error` | Broken request handlers, relay transport errors, unrecoverable local failures |
| `warn` | Relay disconnections/send failures, malformed or oversized messages, superseded daemons, service/autostart problems |
| `info` | Deployment/startup transitions and successful relay connection |
| `debug` | Every per-tool start/success/failure/cancellation/timing event, shortened correlation IDs, reconnect timing |

All per-tool outcomes are deliberately absent from `info`, `warn`, and `error`. The MCP response already reports success or failure to the caller; duplicating ordinary failures in daemon logs creates noise without adding operational information. A normal sequence of hundreds of successful or failed tool invocations should not fill the user's terminal or service logs.

## Event fields

Default operational events may include component, relay close code, bounded reconnect delay, provider name, or a coarse infrastructure error class. Per-tool fields—tool name, duration, outcome class, and shortened call identifier—are debug-only. Call identifiers are useful only for correlating adjacent local events and are not stable audit identifiers.

The implementation intentionally omits:

- tool arguments;
- command text or argv;
- stdin, stdout, and stderr;
- file, patch, or image content;
- OAuth request bodies;
- connection passwords, daemon secrets, authorization codes, and access tokens.

Unexpected daemon, service, and Worker infrastructure failures are reduced to coarse error classes in normal logs. Client-facing tool errors may contain more detail according to the active path-display policy, but ordinary tool failures and those details are not copied into normal operational logs.

## Bounding and redaction

Messages, strings, object depth, object key counts, array item counts, and serialized field payloads are bounded. Control characters are neutralized. Fields with secret-like names and known token formats are recursively redacted.

This is defense in depth, not content classification. A previously unknown secret format embedded in an ordinary non-secret-named field may evade pattern redaction. For that reason, tool arguments and outputs are omitted rather than merely filtered.

## Files

Autostart logs are stored below the state root:

```text
logs/daemon.out.log
logs/daemon.err.log
```

They are owner-only where the platform supports Unix-style permissions. Existing files are tail-trimmed on UTF-8/line boundaries before daemon startup. Because background services use `warn` and per-tool events are debug-only, neither successful nor failed ordinary tool traffic should cause sustained log growth.

Each managed job also has owner-only `runner.out.log` and `runner.err.log` files for runner startup/crash diagnostics. Child-step stdout and stderr are captured into bounded job results according to `capture_output`; they are not copied into runner or daemon operational logs. Runner logs are retained with the bounded job directory and removed by job retention cleanup.

## MCP host boundary

Machine Bridge does not classify filenames as sensitive and does not block `.env`, password, key, or credential-looking names. The active local policy, local OS permissions, and endpoint-security controls determine what the server itself can read or execute.

An MCP host, model provider, desktop application, or platform execution layer may independently deny a request involving credentials or sensitive files. Such a denial occurs before or outside Machine Bridge's file resolver and cannot be disabled by selecting the local `full` profile. Use `server_info`, `machine-mcp status`, and `machine-mcp doctor` to distinguish the active local policy from host-side enforcement.

## Privacy filtering

Structured fields whose names indicate a local path, workspace, working directory, home, or state root are replaced with `<local-path>`. Free-form log text removes known home-directory prefixes, email addresses, common bearer/cloud/API token forms, private-key headers, control characters, and Unicode bidirectional/zero-width formatting controls. Explicit command output and JSON command results are not operational logs and retain their documented opt-in disclosure semantics.
