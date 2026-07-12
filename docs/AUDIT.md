# Engineering and security audit

This document records the cross-cutting audit initiated for version 0.12.0 and the 0.12.2 follow-up triggered by real cross-platform CI failures. It complements, but does not replace, the continuously enforced contracts in `SECURITY.md`, `docs/ENGINEERING.md`, and the test suite.

## 0.12.2 follow-up findings

The failed `0.12.1` workflow had two independent causes. Windows exhausted the old approximately half-second atomic-replacement retry window while a stress reader repeatedly held the destination open. Linux and macOS lost an immediately emitted browser runtime `hello` between awaiting `open` and registering the message listener, then waited without a deadline until the 20-minute job timeout. The fixes preserve atomic replacement, extend only classified transient retries, pre-register the browser handshake listener, bound all relevant HTTP/WebSocket waits, and terminate failed proxy candidates.

The review also found three governance gaps not represented by the original failure message:

- GitHub Releases could be created from a local pass while the exact cross-platform push CI was failing. Publication now requires successful exact-commit push CI before tagging or release verification.
- Workflow actions used movable major-version tags. They are now pinned to immutable official commit SHAs, with an executable invariant.
- Repository privacy checks covered only the current tree. Package audit now scans reachable historical paths, bounded UTF-8 blobs, and commit messages; deleted credential fixtures fail without echoing their values.

No generic active credential pattern was found in the current tree or reachable history after excluding standard public automation trailers. The developer-local denylist does match legacy historical identifiers, and the Git metadata audit found a legacy non-noreply author/committer identity. These are identity/privacy metadata rather than active credentials. Removing them would require a coordinated history rewrite and force-update of affected refs, which is intentionally not performed as an incidental code fix.

## Scope

The review covered:

- CLI startup, foreground/background takeover, state locks, service installation/removal, and full uninstall;
- canonical paths, state-root deletion, atomic persistence, symbolic links, permissions, and process identity;
- daemon/Worker transport, OAuth, relay replacement, request limits, and failure reporting;
- direct processes, shell execution, interactive sessions, managed jobs, cancellation, recovery, and cleanup;
- browser pairing, broker authentication, uploads, DOM actions, local application automation, and sensitive fields;
- logging, privacy scanning, package contents, release scripts, documentation consistency, CI, and dead code.

The audit used source review, state-machine analysis, hostile-input tests, concurrent-process fixtures, process-tree fixtures, package dry runs, dependency audits, and the existing remote/stdio integration suites.

## High-impact findings and corrections

### Lock and process identity

Process locks were previously created directly at their final path and then populated. A competitor could observe an empty or partial JSON file. Locks also relied primarily on PID liveness, which cannot distinguish PID reuse.

The runtime now:

- writes and `fsync`s a private temporary file before atomically claiming a lock with a same-directory hard link;
- records a random ownership token and process start time;
- validates PID liveness, process start time, lock age, purpose, workspace, and file identity;
- removes a stale lock only when its device, inode, size, modification time, and token still match the inspected snapshot;
- gives a recent malformed lock a grace period rather than deleting a possibly in-progress claim;
- waits a bounded interval for ordinary startup/state operations instead of failing immediately.

Managed-job transition, recovery, and runner identity follow the same principles while retaining compatibility with legacy numeric PID files.

### Service lifecycle

Service providers returned inconsistent result shapes, and removal could continue after an incomplete stop. Full uninstall considered too little profile state.

The lifecycle is now fail-closed and ordered:

1. stop the platform service;
2. stop every verified workspace daemon in scope;
3. confirm each stop result;
4. remove the service definition only after all stops succeed;
5. retain service definitions and state when any phase fails.

macOS, systemd, and Windows Scheduled Tasks now return a common `ok` contract. Full uninstall scans all known profiles and can recover workspace identity from daemon locks when a state file is unavailable.

### State persistence and deletion

State reads previously classified any read error as corrupt JSON and could continue with an empty state. A dangerously selected state root could also overlap a workspace.

The runtime now:

- backs up a file only after it was read successfully and its JSON content is actually invalid;
- propagates permission, type, symbolic-link, size, encoding, and I/O failures;
- uses one shared `fsync` plus atomic-replacement primitive for state, job, runner, browser-pairing, and service-definition writes;
- rejects a state root that overlaps the selected workspace in either direction before creating state;
- acquires a state-root maintenance lock to block new profile/state operations and state-backed operations from already constructed managed-job/browser managers, and cross-checks deletion against global workspace selection, profile state, daemon locks, state markers, and known directory shape;
- treats unreadable process locks as an uninstall blocker rather than evidence of inactivity.

### Process-tree cleanup

CLI helper commands and managed jobs could terminate the direct child while leaving descendants alive. Escalation timers could be cleared or unreferenced before killing a resistant descendant.

Timeout and cancellation now target the process group/tree, keep the escalation timer alive, and issue a bounded `SIGKILL`/Windows tree termination after graceful shutdown. Tests use descendants that deliberately ignore `SIGTERM`.

### Privacy and logging

The privacy gate did not inspect tracked npm authentication configuration or several common credential formats. Free-form log sanitization had corresponding gaps.

Checks and redaction now cover:

- generic, encrypted, OpenSSH, RSA, EC, and DSA private-key headers;
- npm, GitHub, GitLab, Slack, Google API, AWS, live payment, and common API-secret formats;
- JWT-shaped bearer values and URLs with embedded credentials;
- non-example email addresses and absolute user-home paths;
- credential-shaped publication filenames;
- authentication, identity, environment interpolation, and credential URLs in a tracked `.npmrc`.

Findings report only file, line, and rule. The matched value is never printed. A tracked `.npmrc` remains permitted for non-secret repository settings such as `engine-strict=true`.

### Local automation boundaries

Browser upload metadata now requires a safe single-component filename and canonical MIME type. Derived local filenames have controls and separators removed. Application action text rejects NUL bytes. Sensitive browser and Accessibility values remain excluded from results.

Restricted filesystem reads now add `O_NOFOLLOW` for the final path component in addition to canonical workspace containment.

### Test and release integrity

The hand-maintained syntax file list was replaced by a recursive scanner. Package scripts are checked for missing entrypoints, release helper scripts are packaged, npm package modes are validated, and installation guidance is checked across the CLI and documentation. Dedicated tests cover lock concurrency, atomic replacement, PID reuse, malformed locks, service removal ordering, process-tree termination, state read failures, unsafe state roots, browser upload metadata, and expanded privacy patterns.

## Reviewed areas without material code changes

The review also rechecked Worker OAuth/PKCE validation, exact redirect/resource binding, token hashing/version revocation, registration and failure limits, Durable Object serialization, daemon WebSocket authentication/replacement, CSP/no-store response headers, static MCP catalog parity, browser loopback Host/Origin/subprotocol validation, and fixed-code JXA/browser execution. Existing controls and integration coverage were retained.

## Residual limits

No review can prove the absence of all defects. Important residual boundaries are:

- Node.js cannot provide a portable `openat`-style directory capability for every filesystem operation. Canonical containment plus `O_NOFOLLOW` protects the final component, but hostile same-user code can still race parent-directory replacement. Use a dedicated low-privilege account, VM, or container for untrusted repositories.
- Same-user malicious processes can inspect memory, signal processes, alter browser profiles, or manipulate files the user can access. Machine Bridge is not an OS sandbox.
- Hard-link atomic lock claims require a local filesystem that supports same-directory hard links. Failure is explicit; the runtime does not fall back to a partial-write-prone lock.
- Service-manager behavior varies by OS version and local policy. Provider failures remain visible and fail closed, but operator intervention can still be required.
- Browser pages, application UIs, project instructions, skills, command manifests, and command output are untrusted content. Human/host approval remains necessary for consequential actions.
- The MCP host may filter tools, omit server instructions, or block calls before they reach Machine Bridge; the server cannot observe or override that boundary.

## Ongoing review rule

A future change to locks, state deletion, service lifecycle, detached processes, credentials, browser/app authority, package contents, or public transport must add a behavior-level regression test and update the applicable security/operations documentation. String-presence tests may supplement, but must not replace, executable state-transition tests.
