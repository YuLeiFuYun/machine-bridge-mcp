# Engineering and security audit

This document records the cross-cutting audit initiated for version 0.12.0, the 0.12.2 cross-platform CI follow-up, and the 0.13.0 architecture/automatic-routing follow-up, the 0.15.0 daily-browser and cross-platform hardening review, and the 0.16.0 runtime-boundary review. It complements, but does not replace, the continuously enforced contracts in `SECURITY.md`, `docs/ENGINEERING.md`, and the test suite.


## 2026-07-14 version 1.0 security-boundary audit

The 1.0 review began from a clean `0.18.1` main branch whose complete local suite and required GitHub checks passed. The green status was incomplete evidence: GitHub still contained open CodeQL findings because the workflow uploaded SARIF but did not fail on security results. The review separated real path races and one lifecycle defect from intentional high-authority process boundaries and static-analysis noise.

State, service-log, managed-job diagnostic, privacy-scan, and owner-only file operations now open the target directly with no-follow flags where supported, validate the opened descriptor as a regular file, bound work before allocation, and apply modes through that descriptor. SSH inspection snapshots key bytes into a private temporary directory before invoking `ssh-keygen`, then verifies that the original identity and bytes remain unchanged. These changes remove the check/use split without claiming protection against hostile same-user replacement of parent directories on platforms lacking descriptor-relative traversal.

A dormant recovery-safety helper exposed a concrete lifecycle defect: after recovery-lock ownership was handed from the coordinator to a detached runner, the runner removed the path unconditionally instead of verifying the handed-off token. Recovery now uses the existing snapshot/token-aware removal primitive and records a fatal recovery error if ownership cannot be proved. Numeric-only lock content is treated as malformed current state rather than interpreted as a compatible owner.

The process boundary now distinguishes fixed executable plus argv invocation from explicit shell execution. Direct calls reject NULs and oversized executable/argv input and use `spawn(..., { shell: false })`; `exec_command` remains an explicit canonical-full shell capability and is documented as local-user authority. CodeQL exceptions for these intentional boundaries are exact rule/path records with rationales and expiry dates. The CodeQL workflow now parses generated SARIF and fails on every other security-tagged result, preventing a successful analysis upload from masquerading as a clean security gate.

The public contract is current-only: MCP `2025-11-25` is the sole advertised protocol. Existing current-schema local state remains usable, so upgrade safety is provided by bounded daemon/Worker version convergence and exact browser-extension version handshakes rather than by retaining obsolete protocol or lock interpretations. Randomized protocol, policy, argv, and real no-shell-evaluation tests supplement deterministic state-machine and cross-platform integration coverage.

A multi-window concurrency report exposed a correlation defect rather than an execution-capacity limit. The Worker admitted 32 calls and the local runtime admitted 16, but pending-call keys used only OAuth token plus JSON-RPC id. Independent ChatGPT windows commonly reuse small numeric ids, so a second window was rejected before relay and the ordinary internal-error redaction made the failure look like a local execution outage. Version 1 issues stateless HMAC-bound MCP session ids and keys cancellation by token, session, id type, and id value. Real workerd tests run two sessions with the same id concurrently, prove sessionless POST independence, and prove cancellation isolation. A separate fault was fixed by interrupting the relay whenever a completed terminal result cannot be delivered, ensuring socket cleanup releases pending records instead of waiting for the configured tool timeout.


## 2026-07-13 runtime-boundary and lifecycle follow-up

This review confirmed that earlier safety controls existed but were distributed across duplicated policy checks, transport-specific pending maps, message-regex errors, and oversized composition files. It reproduced a production-visible Worker defect where a completed client JSON-RPC request key could remain indexed and cause unrelated later calls to fail as duplicate in-flight IDs. Pending calls now use one atomic double-index registry whose terminal `take` operation clears the internal ID, request key, and timer before resolution or rejection; success, daemon error, cancellation, timeout, send failure, and socket loss have behavior coverage.

Policy revision 5 supplies one authorization contract to the local runtime, Worker role intersection, and manager-level checks. The audit found a concrete compound-ACL error: `start_job` was advertised by direct-exec alone even though it creates persistent files. It now requires write plus direct execution; read-only job/resource inspection no longer inherits mutation requirements. Typed errors, shared middleware, explicit runtime lifecycle, process ownership, structured JSON logs, and local/Worker metrics replace ad hoc message parsing and invisible pending state.

The composition roots were reduced by extracting filesystem, process, Git, CLI parsing/admin, ranking, managed-job validation, browser protocol/pairing, Worker HTTP, OAuth, policy, errors, pending calls, and observability. Executable architecture limits prevent these responsibilities from returning. During extraction, a missing local ESM binding was initially hidden by a broad catch and surfaced only as `resource_unavailable`; the catch now rethrows unknown faults, and the stdio generated-resource test exercises the complete state reload path.

Coverage review showed that a large test count had hidden weak orchestration coverage. CI now reports and enforces per-module baselines, while pure policy/CLI/ranking/state modules receive direct branch tests and Worker behavior still runs through workerd. Generated policy documentation eliminates a second hand-maintained ACL description.

## 2026-07-13 daily-browser and cross-platform hardening follow-up

The review first distinguished installation from actual connectivity. The user identified the target as their ordinary Chrome profile and manually loaded the unpacked extension there; it was initially unpaired. After opening the genuine loopback pairing page, a localhost-only live fixture verified that this connected Chrome instance could create and close a real tab, return semantic snapshot refs, traverse an open Shadow DOM, fill a multi-field form, issue trusted text and pointer input, wait for final DOM state, and capture a screenshot without reading unrelated tabs. The product now states the narrower machine-verifiable fact: Machine Bridge does not launch a browser, but an extension cannot infer whether its host profile is the user's daily or isolated profile.

Fault injection then found several state-machine issues that a success-only smoke test could not reveal. WebSocket `open` was treated as extension readiness before protocol validation; pairing state was written before the candidate authenticated; `input_mode: auto` replayed a DOM action after any DevTools failure even when an Input command might already have taken effect; screenshot capture focused the browser window and did not restore the previous active tab; navigation wait used a hidden 30-second deadline independent of the request; and replacement could leave direct/proxied requests pending. Protocol 3 now requires `hello`/`hello_ack` with exact packaged-version/capability equality, persists pairing only after acknowledgement, validates a canonical extension ID plus matching loopback ports, propagates the request deadline, rejects ambiguous post-dispatch retries, restores tab state without stealing focus, and fails interrupted routes with retry guidance.

Hostile-page analysis found that previous limits were result limits rather than work limits: every frame received the full source/element allowance, `outerHTML` was built before truncation, interactive elements and Shadow roots were fully enumerated before slicing, page-controlled strings were not uniformly bounded, and whole-page `innerText` was materialized for waits. Version 0.15.0 applies aggregate budgets across at most 64 frames, uses iterative bounded DOM serialization, limits each page scan to 100,000 nodes, reusable refs to a 10,000-entry LRU, and text search to 2 MiB, bounds metadata, removes URL userinfo, treats secret-like contenteditable controls as sensitive, and reports truncation explicitly. Multi-field failures now identify possible earlier mutations without returning values.

The extension architecture was also corrected: the service worker now owns only pairing/transport/readiness/cancellation/response routing, while fixed `browser-operations.js` owns tab and page orchestration. An executable line-count invariant prevents those concerns from silently merging again. Outside the browser path, the review found that Windows Scheduled Task command construction did not implement CRT backslash-before-quote rules; drive-root or trailing-backslash arguments could be misparsed. A dedicated quoting primitive and platform regression test correct that boundary.

The same pass rechecked Worker OAuth/PKCE, registration/code/token limits, process sessions, managed jobs, state deletion, log redaction/rotation, package contents, dependencies, open issues, and current CI. No additional high-impact code change was justified in those areas. Their documented residuals remain: canonical `full` intentionally exposes the local user's authority, service logs are trimmed at startup rather than continuously, and same-user malicious code or an MCP host can still operate outside Machine Bridge's control.

## 2026-07-13 architecture and automatic-routing follow-up

A new behavior-level review found that the existing global/project instruction path was functioning, but three gaps explained weak user-visible automation: direct `.codex/skills` compatibility depended on user-created symlinks, root package scripts were described but not executable through the registered-command surface, and the runtime provided no proof that the host had called bootstrap or task resolution. The review added direct compatibility roots, bounded automatic package commands, and privacy-preserving routing telemetry while retaining the host/model invocation boundary.

The review also reproduced a lifecycle defect not covered by the previous descendant test: when a direct child exited after group `SIGTERM` while a detached-stdio descendant ignored the signal, `runProcess` cleared the pending `SIGKILL` escalation and left the descendant alive. Timeout/cancellation/replacement now use one escalation primitive whose forced phase remains referenced independently of direct-child tracking. A dedicated real-process regression covers that exact ordering.

Relay routing now honors standard HTTP(S) proxy environment variables and `NO_PROXY`, rejects invalid/unsupported proxy configuration before reconnect, and exposes only coarse route state. Package metadata parsing and capability observation were extracted from orchestration code, and architecture tests now reject domain-to-adapter imports.

A real macOS stdio smoke test used the user's actual global instructions, repository instructions, installed skills, package scripts, and installed applications with an isolated temporary state root. Initialization advertised 49 tools and contained all four instruction layers. A Chinese skill-creation task selected `skill-creator` at score 16 and loaded 22,047 bytes of instructions; 42 automatic package commands were discovered and `package.version-check` executed with exit code 0; 100 applications were discovered, `Chess` matched at score 15, opened in the background, was observed running, then quit cleanly. Capability telemetry recorded bootstrap plus three task resolutions without retaining raw task text.

The same review reproduced two daily-use ranking failures before the fix: Chinese tasks did not match English skill metadata, and an English skill-creation request tied several generic “create” descriptions and selected `frontend-design` alphabetically. Cross-platform CI then exposed a separate Windows execution defect: automatic commands spawned `npm` as if it were a native executable, but Windows provides `npm.cmd`, producing `spawn npm ENOENT`. Windows package commands now use one fixed command-shell wrapper built from allowlisted manager and validated script names. Bounded bilingual intent normalization plus capability-name weighting corrected both cases. Residual limits remain external: the MCP host can filter initialization instructions or tools, a package manager can execute arbitrary repository script bodies, HTTP(S) proxy support is not SOCKS support, and OS process-tree guarantees remain platform dependent. In the observed remote ChatGPT path, the 0.12.2 relay advertised 49 tools while the host made only 11 available to this conversation, demonstrating that server-side discovery cannot by itself guarantee host invocation.

## 0.12.2 follow-up findings

The failed `0.12.1` workflow had two independent causes. Windows exhausted the old approximately half-second atomic-replacement retry window while a stress reader repeatedly held the destination open. Linux and macOS lost an immediately emitted browser runtime `hello` between awaiting `open` and registering the message listener, then waited without a deadline until the 20-minute job timeout. The fixes preserve atomic replacement, extend only classified transient retries, pre-register the browser handshake listener, bound all relevant HTTP/WebSocket waits, and terminate failed proxy candidates.

The review also found three governance gaps not represented by the original failure message:

- GitHub Releases could be created from a local pass while the exact cross-platform push CI was failing. Publication now requires successful exact-commit push CI before tagging or release verification.
- Workflow actions used movable major-version tags. They are now pinned to immutable official commit SHAs, with an executable invariant.
- Repository privacy checks covered only the current tree. Package audit now scans reachable historical paths, bounded UTF-8 blobs, and commit messages; deleted credential fixtures fail without echoing their values.

No generic active credential pattern was found in the current tree or reachable history after excluding standard public automation trailers. The developer-local denylist does match historical identifiers, and the Git metadata audit found an older non-noreply author/committer identity. These are identity/privacy metadata rather than active credentials. Removing them would require a coordinated history rewrite and force-update of affected refs, which is intentionally not performed as an incidental code fix.

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

Managed-job transition, recovery, and runner identity follow the same ownership and process-start-time rules. Numeric-only runner records are rejected.

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
