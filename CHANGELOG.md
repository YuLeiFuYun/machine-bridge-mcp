# Changelog

## 1.0.0 - 2026-07-14

### Current-only protocol and runtime contract

- Declare only MCP protocol `2025-11-25` across shared metadata, stdio, the local runtime, daemon handshakes, and the Cloudflare Worker. Older protocol dates are no longer advertised as supported; clients must negotiate the current protocol before invoking tools.
- Add stateless, HMAC-bound `MCP-Session-Id` issuance. Concurrent chat windows using the same OAuth token now have independent JSON-RPC request-id and cancellation domains; sessionless independent POST requests no longer share a token-wide request-id lock.
- Make terminal relay delivery fail closed: when a completed daemon call cannot return its `tool_result`, the daemon interrupts the ambiguous socket so Worker socket cleanup releases pending calls immediately instead of retaining a phantom active call until its long timeout.
- Remove numeric-only managed-job lock interpretation and the remaining dead compatibility branches, unused imports, unreachable conditions, and stale orchestration variables. Current JSON ownership records with process start identity and random tokens are the only accepted lock contract.
- Keep the current local state schema intact so an existing 0.18.x state root upgrades in place. The source upgrade remains operationally bounded: install the new package, run one normal `machine-mcp` startup to converge Worker and daemon versions, then reload the unpacked browser extension.

### Descriptor-first file and process security

- Centralize regular-file opens behind a no-follow descriptor primitive that validates the opened object, applies permissions through the descriptor, and performs bounded reads without a separate path check. State, privacy scanning, service logs, managed-job diagnostics, and owner-only files now use this boundary.
- Inspect SSH key pairs from private, bounded snapshots copied into a private temporary directory. Fingerprinting and public/private correspondence no longer operate on mutable caller paths, and the original files are revalidated by identity and constant-time byte comparison before success is returned.
- Fix managed-job recovery handoff so the recovery runner must remove `recovery.lock` with the exact handed-off PID and ownership token. It can no longer delete a replacement claim by path alone.
- Separate the internal `runExecutable` argv boundary from explicit shell execution, bound executable/argv sizes, reject NUL bytes, and retain `shell: false` for direct execution. Worker deployment consistency now uses an HMAC fingerprint keyed by deployment secrets rather than an ordinary digest over secret values.

### Enforced security evidence

- Add a SARIF security gate to the required CodeQL workflow. Any new security-tagged result fails the required check; intentional high-authority process boundaries require an exact rule/path exception with a substantive rationale and expiry date.
- Add deterministic property tests over hostile browser-protocol bytes, policy combinations, argv values, and shell-metacharacter arguments. Add production-path service command coverage and remove test-only filesystem check/use patterns that obscured CodeQL results.
- Preserve the complete cross-platform, Worker, stdio, browser, lifecycle, atomic-file, process-tree, package, privacy-history, dependency, and release-integrity suite as the release gate.

## 0.18.1 - 2026-07-14

### Fixed

- Wait for launchd service state to converge after a successful `bootout` before deciding that stop or restart failed. The bounded poll handles macOS's asynchronous unload window while still failing closed when the service remains active.
- Add deterministic coverage for delayed launchd inactivity and for the bounded failure path.

## 0.18.0 - 2026-07-14

### Isolated multi-account authorization

- Replace the workspace-wide shared OAuth password with named accounts and four roles: reviewer, editor, operator, and owner. OAuth codes and tokens are bound to one account id, account version, and role; account changes revoke only that account's credentials.
- Intersect each account role with the connected daemon policy when listing or invoking tools. The Worker rejects unauthorized tools before relay, and every relayed call carries immutable account authorization metadata for a second local enforcement check.
- Add owner-only account administration for listing, creating, enabling, disabling, changing roles, rotating passwords, and removing accounts. Passwords are generated 256-bit tokens stored as independent salted HMAC-SHA-256 verifiers; arbitrary human-chosen passwords are rejected, plaintext tokens are shown once, and they are not retained in local state.
- Upgrade the existing Cloudflare Worker and Durable Object in place. A one-time release operation converts the current shared credential into the initial owner account and annotates existing OAuth codes and tokens without changing their keys or the global token version, preserving the existing ChatGPT connector authorization.

### Runtime reliability and diagnostics

- Cancel all relay-owned local calls immediately when the relay disconnects. Process execution now rejects cancellation before a child emits `close`, while process ownership remains tracked until actual exit, preventing permanently active calls without losing process cleanup.
- Replace prefix-only command capture with bounded beginning-and-end retention. Long stdout and stderr report exact omitted byte counts and preserve the diagnostic tail where test and compiler failures normally appear.
- Consume rejected authenticated MCP request bodies before returning 401, preventing workerd request-stream exceptions after per-account token revocation.

### Breaking state and maintenance model

- Advance local state to schema 6, the state-root marker to schema 2, and policy to revision 5. Final runtime code accepts only the current formats; valid obsolete state is rejected instead of migrated, while syntactically corrupt JSON is isolated and rebuilt as current empty state.
- Remove shared-password CLI flags, policy migration branches, old daemon-lock interpretation, numeric managed-job PID compatibility, and old log-format archival. The one-time in-place release operation updates live state and deletes obsolete artifacts before the final runtime is installed.

## 0.17.1 - 2026-07-14

### Installation and first use

- Add an end-to-end installation and first-use guide covering transport selection, authority profiles, prerequisites, released and source installation, first remote deployment, current ChatGPT developer-mode connection, stdio configuration, existing-profile browser pairing, verification, routine operation, multi-workspace use, upgrades, layered troubleshooting, and fail-closed removal.
- Link the detailed guide from the README while retaining the compact command reference, and clarify how to distinguish package, Cloudflare, daemon, MCP-host, operating-system, and browser failures.

### Multi-client and multi-account boundary

- Document that the existing Worker supports multiple OAuth client registrations and access tokens but does not provide isolated human/service accounts: all successful authorizations use one per-workspace connection password and share the same policy and daemon authority.
- Define a principal-aware evolution path that keeps OAuth clients separate from principals, memberships, and named grants; uses capability intersection and dual Worker/local enforcement; adds targeted revocation and per-principal quotas; and retains one bridge/Durable Object per workspace or trust domain.
- Make the security and architecture contracts explicit: mutually untrusted users require separate bridge instances and preferably separate low-privilege OS, container, or VM boundaries because application-level roles cannot isolate local process, shell, browser, or credential-store authority.

## 0.17.0 - 2026-07-13

### Project governance and contribution flow

- Define a risk-based project standard covering GitHub Flow, Conventional Commits, architecture boundaries, MCP contract ownership, testing, errors, logging, supply-chain security, documentation, review, and explicit exceptions. Add pull-request and structured issue templates plus area ownership through CODEOWNERS.
- Add an executable Conventional Commit policy for pull-request and main-branch commit titles. Keep the repository on squash-based GitHub Flow rather than introducing permanent develop/release branches that do not match its single-maintainer, continuously released operating model.
- Require all repository-host operations to use local `git`, `gh`, and `gh api` through Machine Bridge. Explicitly prohibit hosted GitHub connectors or ChatGPT GitHub plugins so remote mutations, credentials, refs, checks, and recovery remain observable from one local control plane.
- Make repository automation responsible for closing the source-change lifecycle: after all required checks pass it squash-merges the pull request, verifies `main`, creates and pushes the annotated version tag, and creates or updates the matching GitHub Release. npm publication, Worker deployment, credentials, global installation, and daemon/service replacement remain separately authorized live operations.

### Generated contracts and security automation

- Generate a complete MCP tool reference from the shared tool catalog and reject stale output in the required suite. The tool catalog remains the single source for names, availability, annotations, and JSON input schemas; REST-specific Swagger documentation is not duplicated for the MCP surface.
- Add pinned, least-privilege GitHub workflows for CodeQL analysis, pull-request dependency review, OpenSSF Scorecard publication, and governance checks. Preserve exact dependency versions, registry signature/attestation verification, SBOM generation, history privacy scanning, and cross-platform package tests.

### Cohesion, reuse, and runtime reliability

- Extract optional project-metadata reads, strict integer normalization, plain-record validation, and uninstall/service state inventory into focused shared modules. Remove duplicate numeric clamping, record classification, and no-follow UTF-8 metadata readers while preserving the distinct strict validation semantics used by browser/application commands and Agent Context instruction files. Plain-record validation now rejects class instances instead of treating every non-array object as protocol/configuration data.
- Reduce the CLI entrypoint from 1,169 to 1,063 lines by moving profile, Worker, active-job, and process-lock inventory behind a dedicated boundary. Add direct failure-path tests and enforce 91% function/73% branch coverage for the new inventory module; raise the CLI branch floor from 5% to 10%.
- Canonicalize existing state roots before profile enumeration, fixing macOS `/var` versus `/private/var` alias mismatches that could make service removal or lock inspection report inconsistent profile paths. Retry only the final daemon-lock handoff after a verified service stop, and keep daemon fixture subprocesses out of V8 coverage so process teardown does not create platform-timing failures.
- Generate Wrangler environment declarations through a cross-platform script that creates ignored `.wrangler/` state before invoking Wrangler, instead of writing under `src/worker`; packaging tests reject generated type declarations. This removes clean-runner state dependence and reduces the dry-run package from about 410 KB/1.8 MB unpacked to about 314 KB/1.22 MB while retaining every Worker runtime module.
- Replace repeated empty WebSocket send/close catches in the Worker and browser extension with small module-local best-effort helpers whose comments preserve the primary failure semantics. Architecture checks reject unexplained empty catches on those protocol boundaries.

### Tests and documentation

- Extend architecture checks to require generated tool documentation, governance scripts, security workflows, explicit workflow permissions, immutable Action references, and rejection of privileged pull-request triggers or write-all permissions.
- Document why aggregate 80% coverage is not a sufficient quality target, identify the current CLI orchestration branch-coverage weakness, and retain per-module risk thresholds plus behavior-level cross-platform, concurrency, fault-injection, and protocol tests.

## 0.16.2 - 2026-07-13

### Fixed

- Package the entire `src/worker` directory (instead of just `src/worker/index.ts`) in the published npm package so that global installations have all files required to compile/deploy the Worker.
- Add regression coverage in packaging tests to verify all worker modules are present.

## 0.16.1 - 2026-07-13

### Fixed

- Fix `machine-mcp` startup after 0.16.0 by keeping normalized policy capabilities immutable while allowing the sealed CLI-owned state record to update persistence metadata.
- Add regression coverage proving `updatedAt` remains writable without permitting capability fields or undeclared fields to be mutated.

## 0.16.0 - 2026-07-13

### Runtime boundaries and lifecycle

- Replace the monolithic local tool dispatcher with a middleware-based execution pipeline covering policy authorization, bounded call registration, cancellation/deadlines, stable error normalization, structured lifecycle events, and per-tool metrics. Add explicit runtime lifecycle states and a process tracker so stop/cancel paths release calls and child ownership deterministically.
- Extract workspace filesystem transactions, process/shell execution, Git operations, CLI option/policy parsing, local resource/browser/job administration, capability ranking, managed-job plan/resource validation, browser extension protocol handling, and browser pairing persistence into focused modules. Add executable line-count and dependency-direction limits so these responsibilities cannot silently return to `LocalRuntime`, the CLI entrypoint, or browser manager.
- Split the Worker Durable Object into HTTP/CORS boundaries, OAuth state/PKCE helpers, shared policy evaluation, structured errors, pending-call indexing, and observability. Replace the linear pending-call scan with an atomic ID/request-key registry so completed, cancelled, timed-out, send-failed, and disconnected calls clear both indexes before settling; JSON-RPC request IDs can be reused immediately after completion.

### Policy, errors, logging, and observability

- Define policy revision 4 in one shared contract consumed by the local daemon, Worker, generated documentation, tests, and architecture checks. Fix `start_job` to require both write and direct-execution capabilities, keep `cancel_job` write-gated, and expose read-only resource/job inventory to review-mode clients without granting mutation authority.
- Introduce typed `BridgeError`/Worker errors with allowlisted stable codes and retryability. Centralize legacy error classification at adapters instead of making transports and tests depend on free-form English messages. Unknown programming errors are no longer silently converted into ordinary managed-resource unavailability; a failing timeout callback still settles and clears its pending indexes.
- Add structured JSON lifecycle logging and in-memory observability for calls, durations, errors, active processes, pending request indexes, daemon candidates, socket transitions, and per-tool outcomes. Autostart services now use warning-level JSON logs by default while foreground output remains human-readable; local and Worker structured-field redaction is behavior-tested.

### Tests, documentation, and audit follow-up

- Add behavior tests for policy parity, compound ACLs, middleware order, runtime lifecycle transitions, process ownership, pending-ID reuse, socket cleanup, Worker/local error serialization, structured log privacy, bilingual capability ranking, and generated policy documentation. Replace brittle source-string and monkeypatched happy-path tests with production-path deadline, process-tree, OAuth/MCP, and resource-reload coverage.
- Add a critical-module V8 coverage gate with per-module function/branch baselines, rather than a single aggregate percentage that hides weak orchestration coverage. Generate `docs/POLICY_REFERENCE.md` from the shared policy contract and tool catalog; CI rejects stale generated documentation.
- Correct an extraction defect where a re-exported resource inspector was not locally bound and a broad catch disguised the resulting `ReferenceError` as `resource_unavailable`. File availability now degrades only for classified filesystem conditions; unexpected implementation faults remain visible.

## 0.15.0 - 2026-07-13

### Daily-profile browser verification and protocol safety

- Verify the unpacked extension in the user's ordinary Chrome profile with a localhost-only live smoke test covering the acknowledged protocol handshake, real tab lifecycle, semantic inspection, open Shadow DOM, complex form fill, fixed DevTools text/click input, waits, screenshot capture, and cleanup. `browser status` and loopback health now report extension version/protocol, that Machine Bridge did not launch the browser, and the fact that daily-vs-isolated profile identity is not machine-verifiable.
- Upgrade the extension protocol to an acknowledged `hello`/`hello_ack` state machine with exact packaged-version, protocol, and capability equality. WebSocket open is no longer treated as authenticated readiness, pairing material is persisted only after a successful capability handshake, failed candidate pairing preserves the prior configuration, pairing-page and broker ports must match, and extension WebSocket origins require a canonical 32-character Chromium extension ID.
- Prevent duplicate side effects after an ambiguous trusted-input failure. `auto` falls back to DOM only before any DevTools `Input` command starts; after dispatch begins, the operation fails with an explicit unknown-outcome instruction to inspect the page before retrying. Screenshot capture temporarily activates only the requested tab, never focuses its window, and restores the previous active tab unless the user changed it concurrently.

### Bounded page processing and extension architecture

- Apply `max_bytes` and `max_elements` as aggregate request budgets across at most 64 accessible frames. Replace full `outerHTML` construction with a bounded iterative DOM serializer, cap page scans at 100,000 nodes, bound page-controlled metadata/text, cap reusable refs at 10,000 per frame, redact URL userinfo, mark contenteditable secret controls as sensitive, and report frame/node/text/ref truncation explicitly.
- Report partial multi-field form mutation precisely when a later field or submission fails. Navigation waits now inherit the bounded request deadline rather than using a hidden fixed 30-second timer.
- Extract tab/page/wait/source/screenshot orchestration into fixed `browser-operations.js`; the Manifest V3 service worker now owns only pairing, transport, acknowledged readiness, cancellation, and response routing. Architecture tests enforce this responsibility boundary.

### Cross-platform audit and regression coverage

- Replace ad-hoc Windows Scheduled Task argument quoting with the Windows CRT-compatible backslash/quote algorithm, including drive-root and trailing-backslash paths.
- Add behavior tests for handshake readiness, provisional pairing persistence, trusted-input replay prevention, focus restoration, aggregate frame/source budgets, hostile DOM/text bounds, partial form failure, strict extension origins, and Windows command-line quoting. Synchronize architecture, security, operations, testing, audit, and tool documentation.

## 0.14.0 - 2026-07-13

### Windows installation and OAuth callback reliability

- Bootstrap installation through pinned npm 12.0.1 from an empty temporary directory before using `--allow-scripts`, declare the npm 12 requirement in package `engines`, and make `machine-mcp doctor` verify the active npm version. This removes the unsupported old-npm path shown by Windows and gives accurate diagnostics for `Unknown cli config "--allow-scripts"` and legacy `devEngines.node` errors without guessing which package supplied the invalid metadata.
- Construct OAuth callback destinations with the URL API and return `303 See Other` after consent instead of manually concatenating a `Location` string. Add an end-to-end ChatGPT callback regression with reserved state characters and exact origin/path checks.
- Extend the isolated install smoke test to require npm 12, install from an empty directory, verify the packaged npm engine requirement, and run the test on Linux, macOS, and Windows CI.

### Existing-profile browser automation

- Keep the authenticated Manifest V3 extension as the primary browser backend so automation operates the user's ordinary Chromium profile, tabs, extensions, cookies, and login state instead of launching a separate profile. Add tab creation/activation/closure and explicit combined waits for URL, document readiness, page text, and element state.
- Replace fragile inspect-then-selector flows with bounded semantic snapshots containing stable per-document/frame element references, visibility/enabled/editable state, and viewport geometry. Page actions now wait for attachment, visibility, enabled/editable state, geometric stability, and unobscured pointer hit targets; ambiguous selectors and stale references fail explicitly.
- Add double-click, hover, append-text, and scroll-into-view actions. Top-frame click, double-click, hover, key press, and text input can use fixed short-lived Chromium DevTools Input commands through explicit `auto`, `trusted`, or `dom` modes. The extension exposes no caller-selected CDP method or arbitrary JavaScript and detaches the debugger in `finally`.

### Architecture, security, tests, and documentation

- Extract browser command normalization into a focused local module and isolate trusted input in a fixed extension module. Add a versioned extension capability handshake, stale-build reload guidance, explicit keepalive handling, and replacement validation that preserves the current compatible connection until the candidate is accepted; accepted replacements reject in-flight direct and proxied requests with retry guidance instead of leaving them to time out. Preserve resource-backed secrets/files, strict action/value validation, bounded broker messages, cancellation, source limits, and the existing owner-only pairing model.
- Add behavior-level tests for command contracts, trusted-input command sequences and cleanup, semantic-ref stability, deterministic scrolling, obscured-target waiting, stale refs, broker routing, catalog parity, and architecture invariants. Update browser setup, permission, security, architecture, testing, and tool documentation.

## 0.13.0 - 2026-07-13

### Automatic capability routing and observability

- Register bounded `package.*` commands from safe root `package.json` script names, while preserving explicit manifest override/deletion and never injecting script bodies. Windows uses a fixed `cmd.exe` wrapper for package-manager shims; Unix keeps direct executable argv. Extend default skill discovery to project `.codex/skills` and unrestricted `CODEX_HOME/skills` compatibility roots.
- Match installed applications by their actual names for every canonical-full task instead of requiring generic “app/window” words, with a bounded discovery cache to avoid repeated filesystem scans.
- Normalize a bounded set of common English inflections and Chinese workflow intents before skill/command ranking, and weight capability-name matches above incidental description overlap. This fixes Chinese selection of `skill-creator`, `smart-search-cli`, and `skill-installer` and prevents generic “create” wording from preferring unrelated design skills.
- Record privacy-preserving bootstrap and task-resolution telemetry in `server_info` and `project_overview`: counts, timestamps, source/load flags, selected capability metadata, and a runtime-keyed task fingerprint rather than raw task text. Suppress weak skill-overlap recommendations and clarify that the MCP host still controls whether the resolver and recommended tools are invoked.

### Process and network lifecycle

- Consolidate graceful process-tree termination plus forced escalation. Timeout, cancellation, and replacement now retain the escalation timer after the direct child exits, preventing a SIGTERM-resistant descendant with detached stdio from surviving as an orphan.
- Add relay support for standard `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` routing through a reviewed HTTP(S) proxy agent. Invalid proxy URLs or unsupported proxy protocols fail fast with corrective guidance; status exposes only direct/proxy/invalid route state and never proxy URLs or credentials.

### Architecture, tests, and documentation

- Extract package metadata/command discovery and capability observation into focused modules, add domain-to-adapter import-boundary checks, remove duplicate object fields, and centralize reused metadata parsing.
- Add behavior-level regression coverage for automatic package commands, direct `.codex/skills` compatibility, capability telemetry privacy, application-cache refresh, proxy selection/failure, and the direct-child-exits-first orphan-process boundary. Synchronize architecture, operations, logging, security, testing, and agent-context documentation.

## 0.12.2 - 2026-07-12

### Cross-platform persistence and browser reliability

- Extend transient Windows atomic replacement from eight short linear retries to sixteen bounded exponential retries with jitter. The implementation continues to use one same-directory atomic rename and never falls back to deleting the destination, while tolerating longer antivirus/indexer/reader sharing windows.
- Eliminate a broker-test race that could miss the runtime `hello` message between WebSocket `open` and listener registration. Pairing HTTP requests and WebSocket open/message/close waits are now bounded, and failed proxy candidates are terminated so a handshake cannot retain the test process indefinitely.

### CI, release, and supply-chain integrity

- Require a completed successful push-triggered GitHub Actions run for the exact `origin/main` commit before creating or verifying a version tag, GitHub Release, or release asset. A local test pass is necessary but no longer sufficient for publication.
- Pin all third-party GitHub Actions to immutable commit SHAs, retain Dependabot updates, and enforce the pinning plus the release-CI wiring through architecture and dedicated release-gate tests.
- Run a reachable-history privacy audit in the package-audit job. The scanner covers historical UTF-8 blob contents, historical paths, and commit messages without printing matched values, while narrowly ignoring the standard public Dependabot signing trailer.

### Regression coverage and audit follow-up

- Add deterministic tests for twelve consecutive transient Windows replacement failures, exponential delay selection, lost browser handshakes, bounded socket waits, portable simulated-Linux launcher paths on Windows, POSIX-versus-Windows daemon-stop semantics, deleted historical credential blobs, public automation trailers, and successful/failed/pending release CI states.
- Update the architecture, engineering, privacy, testing, release, security, and audit documentation. Record remaining immutable Git-history identity metadata separately from current-tree and active-credential findings.

## 0.12.1 - 2026-07-12

### Real local automation corrections

- Make the fixed macOS JXA helper return JSON as the top-level `osascript` result instead of using `console.log`, which real `osascript` sends to stderr. Empty helper stdout now fails explicitly rather than being interpreted as a successful empty object.
- Skip recursive macOS menu-bar/menu traversal by default so bounded inspection reaches main-window controls promptly. Add `include_menus` to inspection and actions for explicit menu automation.
- Normalize hyphens, underscores, dots, and spaces during capability ranking, and strongly boost explicitly named skills and commands. Natural-language references such as `agents progressive disclosure` now select `agents-progressive-disclosure` instead of a generic competing skill.

### Live verification and regression coverage

- Add regression coverage for missing JXA output, menu-recursion forwarding, and punctuation-normalized Skill selection. Add an opt-in real macOS Calculator smoke path and document isolated-profile MV3 browser validation.
- Validate the source runtime with a temporary real global instruction file, an existing user Skill, a registered direct-argv command, shell execution, Calculator discovery/open/activation/inspection/click, and a real unpacked browser extension controlling a local form through inspect/fill/click/source/screenshot operations. Test files, browser profiles, temporary global configuration, tabs, and application state are removed afterward.

## 0.12.0 - 2026-07-12

### Locking, persistence, and process lifecycle

- Replace partial-write-prone final-path lock creation with fully written, flushed temporary files and atomic same-directory hard-link claims. Record ownership tokens and process start times, detect PID reuse, verify file identity before stale-lock removal, preserve recent malformed locks, and add bounded startup-lock waiting.
- Add a state-root maintenance lock for full uninstall, including checks in already constructed managed-job and browser managers. State roots must be disjoint from selected workspaces, including non-existent paths beneath canonicalized platform aliases; unreadable locks/jobs and ambiguous process identities now block destructive cleanup rather than being treated as inactive.
- Consolidate owner-only state, managed-job, runner, browser-pairing, and service-definition commits on one flushed atomic replacement primitive. Only successfully read invalid JSON is backed up; permission, symbolic-link, size, invalid UTF-8, and I/O failures propagate without silently reconstructing empty state.
- Persist managed-job runner process identity, protect transition/recovery locks with token and file-snapshot checks, hand recovery ownership to the runner without an unconditional delete, and keep timeout/cancellation escalation alive until resistant descendant process trees are terminated.

### Services, uninstall, and cross-platform behavior

- Extract one fail-closed service lifecycle: stop the platform service, stop every verified workspace daemon, and remove the service definition only after all stop phases succeed. Full uninstall scans every profile and rechecks managed jobs and process locks while holding maintenance ownership.
- Normalize launchd, systemd user services, and Windows Scheduled Tasks to a common success/failure contract so non-zero Linux/Windows stop results cannot be mistaken for success. Preserve service definitions and local state whenever stop, verification, definition removal, or remote Worker discovery is incomplete.
- Make CLI helper timeouts terminate process groups/trees rather than only direct children, including forced escalation for descendants that ignore graceful termination.

### Security, privacy, and local automation

- Expand repository privacy and log redaction coverage for npm authentication, common cloud/source-control/chat/payment tokens, JWT-shaped values, embedded-credential URLs, broader private-key headers, credential-shaped filenames, and non-example identities. Scanner read/traversal failures now fail closed without echoing matched values.
- Add final-component no-follow reads in restricted filesystem paths, reject NUL application action values, and normalize browser-upload filenames and MIME types to prevent deceptive metadata or downstream form parsing ambiguity.
- Close authenticated browser broker sockets with protocol-specific WebSocket codes for oversized, invalid UTF-8/JSON, or structurally invalid messages instead of silently retaining faulty clients.

### Tests, architecture, and documentation

- Replace the hand-maintained JavaScript syntax list with recursive entrypoint discovery; remove stale imports and duplicated lifecycle logic. Add executable concurrency, atomicity, PID-reuse, service-failure, process-tree, state-corruption, unsafe-root, unreadable-job, browser-protocol, upload-metadata, and privacy regression tests.
- Add `docs/AUDIT.md` and synchronize architecture, security, operations, logging, privacy, managed-job, local-automation, testing, contribution, and release documentation with the implemented fail-closed behavior and residual OS-level limitations.

## 0.11.1 - 2026-07-12

### Reliable macOS service and orphan-daemon takeover

- Stop launchd jobs by their loaded service target first, with the plist form retained as a compatibility fallback. Treat an already-unloaded job as an idempotent success, verify the post-stop state before reporting success, and prevent `service start` or `service uninstall` from continuing when the existing job remains active.
- Detect legacy daemon locks that predate mode/version metadata by inspecting the live process command line. A process is eligible for takeover only when its PID, daemon purpose, canonical workspace, canonical state root, entrypoint, and `--daemon-only` arguments all match. Foreground or unverifiable processes are never signalled.
- Let normal foreground startup and `machine-mcp service stop` terminate a verified detached/orphan service daemon with `SIGTERM`, wait for the actual PID as well as the lock to disappear, reclaim stale locks through the normal token-aware primitive, and fail with a bounded timeout rather than escalating to a forced kill.
- Extend `machine-mcp service status` to report platform-service state and workspace-daemon state separately, including whether a live legacy process was verified as service-style. This makes a launchd-unloaded but still-running daemon visible instead of presenting a misleading inactive-only status.

### Tests and documentation

- Add real child-process regression coverage for legacy orphan takeover, canonical `/var` versus `/private/var` path aliases, foreground-process protection, non-forcing timeout behavior, launchd service-target generation, and packaged daemon-process module presence. Update upgrade and recovery guidance for the exact npm install command and split service/daemon diagnosis.

## 0.11.0 - 2026-07-12

### Zero-configuration agent working agreements

- Add a package-controlled `machine-bridge://defaults/working-agreements` instruction layer so every stdio and remote MCP session starts with conservative, auditable guidance even when the user and repository provide no `MODEL.md`, `AGENTS.md`, or manifest. The baseline covers inspect-before-editing, minimal coherent changes, preservation of unrelated work, existing-toolchain reuse, tests/documentation synchronization, honest validation reporting, secret handling, safe Git practice, and explicit authorization for publication, deployment, credential rotation, live-data mutation, system-wide installation, and destructive operations.
- Keep the baseline lower precedence than explicit user and root-to-target project instructions. Expose its source, size, hash, precedence, and optional content through `session_bootstrap`, `agent_context`, and `resolve_task_capabilities`; include its hash in live capability fingerprints. The defaults are behavioral guidance rather than a replacement for Machine Bridge policy, host approvals, operating-system permissions, hooks, sandboxes, or external isolation.

### Bounded automatic project context

- Add `machine-bridge://project-context/current`, regenerated on every relevant context scan from bounded repository metadata: target-relative path, recognized project/build entry files, JavaScript package-manager and lockfile facts, package script names, runtime constraints/version hints, common documentation files, and CI entrypoint filenames. The scanner executes nothing, writes no user or repository files, omits script bodies, dependency values, source/document contents, absolute home paths, and command output, and never claims a declared command was validated.
- Harden repository-controlled metadata with strict character/count/byte limits, no-follow regular-file reads, safe workflow-name filtering, independent 16 KiB output bounds, and conservative skipping of symbolic links, invalid UTF-8, oversized files, permission failures, and transient metadata races. Add user-global `builtin_instructions` and `automatic_project_context` boolean opt-outs; project manifests cannot disable the user's baseline controls.

### Documentation and verification

- Document the default instruction model, precedence, opt-outs, privacy data surface, security boundary, recommended `AGENTS.md` content, progressive disclosure, and official cross-agent best-practice sources. Update repository automation guidance, shared MCP tool descriptions, initialization instructions, architecture, clients, logging, privacy, security, testing, and package contents.
- Add regression coverage for no-file defaults, initialization injection over stdio, automatic project refresh/fingerprints, package-manager/lockfile/script/CI discovery, script-body non-disclosure, hostile metadata filtering, global opt-out, project opt-out rejection, precedence, and packaged-module presence.

## 0.10.1 - 2026-07-12

### Foreground startup and upgrade takeover

- Make a normal `machine-mcp` start reliably take over from an active platform autostart daemon: detect whether the service is active, request shutdown, wait up to 15 seconds for the workspace daemon lock to be released, and then continue foreground startup with the newly installed CLI. A failed bounded takeover now exits with explicit `service stop`/`service status` recovery guidance instead of silently leaving the old process in place.
- Record foreground/background mode and package version in new daemon locks. A genuine lock conflict now identifies the running mode/version when known, explains how to stop it, and no longer prints the misleading `[ok] ready` block when no restart or requested change occurred. Service-style duplicate starts remain silent idempotent successes.

### Global instructions and operator guidance

- Add copy-paste setup instructions for `~/.config/machine-bridge-mcp/agent.json` and the global `MODEL.md`, explain global-versus-project precedence, live rescanning, and when a new MCP conversation/reconnection is needed for initialization-time injection.
- Document the foreground/background distinction, safe global upgrade sequence, owner-only instruction-file permissions, background log locations, and the exact optional-dependency install command that avoids the development-only `fsevents` warning.

## 0.10.0 - 2026-07-12

### Session context and capability selection

- Add a global `model_instructions_file` in `~/.config/machine-bridge-mcp/agent.json`. Stdio and remote MCP initialization append the bounded user-designated instructions when the local runtime is reachable; `session_bootstrap` exposes the same content explicitly. Project manifests cannot override the global file.
- Add `resolve_task_capabilities`, which rescans effective instructions, filesystem skills, and registered commands for every task, returns a refresh fingerprint, ranks relevant capabilities, optionally loads the best skill, and recommends application/browser/file/Git/process tools. Newly added or edited skills are visible without daemon restart or dynamic MCP tool registration. Multilingual tokenization avoids weak single-character Chinese overlap when automatically selecting a skill.
- Preserve the host boundary: Machine Bridge automates discovery, refresh, ranking, and progressive loading, while the ChatGPT/MCP host still decides whether a tool is exposed, approved, or invoked.

### Existing-profile browser and local applications

- Add a packaged Manifest V3 Chromium extension and authenticated loopback machine broker for the user's existing browser profile, windows, tabs, cookies, extensions, and login state. Multiple workspace or stdio runtimes share one extension connection through authenticated broker clients.
- Add structured browser tools for tab listing, current DOM source, frame-aware and open-Shadow-DOM interactive-element inspection, navigation/actions, complex multi-field forms, visible screenshots, and resource-backed file inputs. Page operations run through a fixed packaged module injected into the target frame rather than caller-provided or service-worker-closure code. Registered local resources can provide sensitive field text or upload bytes without returning those values through MCP results.
- Add installed-application discovery/opening and structured macOS Accessibility inspection/actions. The implementation uses fixed JXA code and does not accept caller-supplied JavaScript, AppleScript, JXA, or browser-extension source. Application paths are normalized to process names, selector indices apply to filtered matches, Linux desktop launchers use `gio launch`, Windows discovery prioritizes Start Menu launchers, and secure Accessibility fields never return values.
- Add `machine-mcp browser status|setup|pair|path` for one-time unpacked-extension setup and diagnosis. Pairing tokens remain in owner-only state and non-cacheable loopback HTML rather than MCP output, browser URL fragments, or operational logs. Established pairing is replacement-locked and requires a browser-action click on the active local pairing page before switching broker state. The extension badge reports connection state and its action opens the saved pairing page; signed browser-store packaging is the intended mass-market distribution path.

### Architecture, security, and verification

- Split agent context, application automation, and browser broker into dedicated local domain modules while retaining one static catalog shared by Worker and stdio. Bound Worker initialization bootstrap to a short failure-tolerant daemon call.
- Add loopback Host validation, extension-origin checks, authenticated extension/runtime WebSocket subprotocols, bounded messages/concurrency/source/forms/uploads, proxy timeout/cancellation cleanup, restricted-page handling, secret/value/result non-disclosure, and full-profile gating. Treat the owner-only browser pairing file as a recognized state-root entry so safe uninstall remains available.
- Extend version synchronization to the browser-extension manifest and add broker owner/client proxy, pairing-token, resource-upload, stdio initialization, live skill refresh, and remote initialization regression coverage. Update architecture, security, operations, logging, privacy, testing, client, release, and user documentation.

## 0.9.0 - 2026-07-12

### Agent context and local workflows

- Add `agent_context`, a bounded bootstrap tool with Codex-compatible instruction precedence: unrestricted `CODEX_HOME`/`~/.codex` guidance, then project root-to-target scopes, selecting the first non-empty `AGENTS.override.md` or `AGENTS.md` candidate per directory under a default 32 KiB combined budget. Add hierarchical `.machine-bridge/agent.json` manifests plus an optional unrestricted user manifest at `~/.config/machine-bridge-mcp/agent.json` for custom candidate priority and bounds.
- Add `list_local_skills` and `load_local_skill` with Codex-style progressive disclosure. Default discovery scans target-to-root `.agents/skills`, unrestricted user/admin roots, and canonicalized symlinked skill directories; invalid metadata is skipped with bounded warnings. Skill loading returns instructions and a relative file inventory without implicitly executing scripts.
- Add `list_local_commands` and direct-argv `run_local_command`. Nearest manifests can override or remove inherited commands, caller arguments require manifest opt-in, and callers cannot increase the manifest timeout ceiling.

### Architecture, security, and tests

- Extract agent discovery into `AgentContextManager` rather than expanding transport or runtime dispatch responsibilities. Keep a static MCP catalog across Worker and stdio transports so host-side caching and filtering do not require dynamic per-skill tools.
- Reject escaping instruction/config paths, unknown manifest fields, out-of-policy skill symlink targets, symbolic-link skill entrypoints, ambiguous skill names, oversized content/argv, and execution attempts under non-execution profiles. Document that repository instructions and skills are untrusted content and that registered commands are convenience aliases, not a sandbox or approval boundary.
- Add regression coverage for global/project override selection, empty-candidate fallback, custom priority, instruction-byte ceilings, target-to-root skill discovery, symlinked skill folders, invalid metadata warnings, command override/removal, literal argument handling without shell parsing, timeout ceilings, path escape denial, and execution-profile denial. Update server instructions, architecture, security, testing, and operator documentation for the new bootstrap workflow.

## 0.8.2 - 2026-07-11

### Relay reliability and protocol correctness

- Add a deadline for WebSocket connection establishment so a transport stuck in `CONNECTING` cannot freeze automatic reconnection indefinitely. Sustained-outage reminders now run on an independent exponential-backoff timer capped at 15 minutes instead of appearing only when another reconnect event happens.
- Handle Worker `{type:"error"}` messages explicitly. A daemon hello timeout is classified as transient and retried; unknown protocol errors, duplicate hello messages, identity/version mismatch, and authentication rejection terminate with actionable guidance instead of becoming an `unknown websocket message` warning.
- Validate daemon WebSocket JSON as a non-array object before field access. Invalid JSON closes with code 1007, non-object/unknown/duplicate protocol messages close with code 1002, and active daemon replacement semantics remain unchanged.

### Logging, tests, and documentation

- Replace default outage/recovery JSON field dumps with readable duration, attempt, cause, automatic-recovery, and long-outage action text. Exact seconds, error classes, retry delays, and raw transport details remain debug-only. Advance the autostart log schema so historical 0.8.1-format lines are separated into the bounded owner-only legacy snapshot. Treat a service-style daemon-only start that finds the workspace daemon already running as a silent idempotent success, preventing repeated lock warnings and duplicate readiness output from accumulating in service logs.
- Add deterministic tests for stalled connection attempts, autonomous reminder backoff, retryable versus fatal relay error messages, close-reason classification, and runtime control-message routing. Extend live Worker integration coverage to invalid JSON, non-object messages, duplicate hello, and unknown authenticated messages. Enable TypeScript unused-local and unused-parameter checks to prevent dead Worker code from accumulating.
- Update architecture, operations, logging, testing, and README guidance to match the implemented state machine and operator-facing behavior. Add a repository automation contract separating code/test/commit/push work from npm publication, global CLI installation, Worker deployment, credential rotation, and daemon/service operations; the owner performs those live release steps explicitly. Improve release-check diagnostics so a missing local or remote version tag is reported distinctly from a tag pointing at the wrong commit, with the required `release:publish` step named directly.

## 0.8.1 - 2026-07-11

### Fixed

- Recognize and validate the Worker's pre-handshake `welcome` control message instead of reporting it as an unknown WebSocket warning. A valid welcome remains debug-only and does not imply authenticated readiness; identity or version mismatch still fails immediately.
- Add a versioned autostart-log schema migration. On the first daemon start after this logging-format change, bounded prior logs are copied to owner-only `daemon.*.legacy.log` snapshots and the active logs are cleared, preventing historical raw close-code lines from appearing to be current behavior.

### Tests and documentation

- Add relay/runtime regression coverage for valid welcome handling and welcome metadata validation, plus service tests for one-time bounded legacy-log migration and schema-marker idempotence.
- Record the protocol producer/consumer contract rule and document how current and legacy daemon logs are separated.

## 0.8.0 - 2026-07-11

### Architecture

- Rename the transport-independent tool engine from `LocalDaemon`/`daemon.mjs` to `LocalRuntime`/`runtime.mjs`, reserving daemon terminology for the background process and relay attachment.
- Extract authenticated WebSocket lifecycle into `relay-connection.mjs`, separating transport state, handshake readiness, heartbeat liveness, reconnect backoff, and outage observability from local file/Git/process execution.
- Add `docs/ENGINEERING.md` as the normative record for product invariants, architectural boundaries, logging semantics, resilience, testing, documentation, and public-versus-local project knowledge. Record the owner-required default `full` profile as an explicit invariant.

### Logging and operator experience

- Replace raw default-level relay close output such as `{"code":1006,"reason":""}` with a state-transition policy: brief self-healing interruptions are debug-only, sustained outages produce one rate-limited actionable warning, and recovery produces one duration/attempt summary.
- Keep WebSocket close codes, reason strings, retry delays, heartbeat details, and brief recoveries at debug level. Expand coarse operational error classification for network and authentication failures; treat authentication and relay identity/version mismatch as immediate actionable fatal errors rather than retryable network outages.
- Add an ignored `.project-local/` area for machine-specific maintenance notes while keeping reusable decisions in tracked documentation and credentials out of both.

### Reliability and correctness

- Treat a WebSocket `open` event only as transport availability; authenticated relay readiness now requires `hello_ack`. Remove the startup path that printed `Remote MCP bridge is ready` after a timeout even when authentication had not completed.
- Terminate and retry candidates that do not acknowledge the daemon handshake, detect silent half-open connections through inbound heartbeat timeouts, and preserve bounded exponential reconnect backoff.
- Handle Cloudflare Durable Object `webSocketError` as well as `webSocketClose`, immediately rejecting pending calls bound to the failed socket through one idempotent cleanup path.
- Consolidate managed-job transition/recovery locking into one stale-PID-aware primitive and manager/runner regular-file reads into one no-follow bounded helper, with direct regression tests.
- Replace mechanical runtime/CLI switch and conditional routing with catalog-checked handler tables and named command phases while preserving explicit patch, runner, and recovery state machines.
- Replace technical Worker health warning details at default level with a user-facing reason while retaining the raw health code at debug.

### Installation, tests, and documentation

- Use the empirically verified npm 12 global install command with `--omit=optional` and the reviewed `esbuild,workerd,sharp,fsevents` script names. Add an isolated tarball/global-install smoke test that rejects blocked-script warnings, verifies `fsevents` is absent from the installed runtime, and executes the installed CLI.
- Add deterministic relay lifecycle tests for authenticated readiness, brief-interruption suppression, persistent-outage escalation, recovery summaries, handshake/heartbeat timeout, transport construction/error paths, supersession, acknowledgement identity/version mismatch, and close-code classification. Add architecture/documentation regression checks for module cycles, obsolete naming, broken links, invisible ASCII controls, and retained engineering invariants.
- Update architecture, operations, logging, privacy, testing, contribution, README, and CLI guidance to match the implemented behavior.

## 0.7.1 - 2026-07-11

### Fixed

- Persist a sanitized absolute-only command `PATH` in launchd and systemd service definitions, always including the stable Node and CLI directories plus platform defaults. This restores Homebrew/npm/git command resolution for background canonical `full` daemons without accepting empty or relative PATH entries.
- Align `doctor` with the declared sole runtime baseline by requiring Node.js 26 instead of reporting Node.js 22-25 as supported.

### Tests and documentation

- Add service-definition regression tests for PATH preservation, duplicate removal, relative-entry rejection, and launchd/systemd emission; document why `machine-mcp service install` should be rerun after PATH layout changes.

## 0.7.0 - 2026-07-11

### Runtime and dependencies

- Raise the sole supported runtime baseline to Node.js 26 and npm 12, add exact local version files and strict engine checks, update Node type definitions to 26.1.1, and run the cross-platform CI suite on Node 26, and disable setup-node's automatic package-manager cache, and bootstrap npm 12 outside the repository before strict project engine checks apply.
- Confirm Wrangler 4.110.0, ws 8.21.0, and TypeScript 7.0.2 are current; retain exact reviewed dependency versions and zero known audit findings.
- Accept both legacy array and npm 12 keyed-object `npm pack --json` metadata, invoke the active npm CLI through Node on Windows, keep generated CI SBOM files outside the repository privacy/publication surface, and retry only classified transient GitHub network failures with Git forced to HTTP/1.1. Release creation verifies server state after an ambiguous response before proceeding.

### Security and privacy

- Replace private environment-derived aliases in public examples with synthetic identifiers and add a repository privacy gate covering tracked and unignored new files, file names, common credential forms, local home paths, SSH host identifiers, and an ignored machine-specific denylist without echoing matched values. Reject publication-surface symbolic links instead of following their targets.
- Hide local resource and generated-key paths by default; require explicit `--show-paths` or `expose_paths=true`, return only bare SSH fingerprints, and broaden operational-log redaction for paths, email addresses, token forms, key headers, and Unicode display controls.
- Separate unrestricted filesystem access from absolute-path display, dynamically redact requested external paths from tool errors, harden autostart files/logs against permissive modes and symbolic links, canonicalize OAuth redirect URIs, and remove bidirectional/zero-width controls from authorization-page display text.

### Correctness and durability

- Verify staged managed-job hashes during inspection, approval, and runner startup; serialize approve/cancel transitions and reclaim stale transition/recovery locks even after PID reuse; reject direct execution of unapproved staged plans; remove stale runner claims during recovery; and redact registered-resource source-path aliases from retained output.
- Clear delayed force-kill timers after process exit, enforce the stdio line limit during incremental reads, reject oversized local WebSocket payloads before string conversion, reject ID-less `tools/call` notifications instead of silently executing them, and accept actual collision-suffixed corrupt-config backups during guarded state removal.
- Make autostart prefer a stable PATH alias that resolves to the active Node executable instead of a versioned package-manager Cellar path, preventing minor Node upgrades from leaving launchd/systemd definitions pointing at removed binaries.
- Open and trim managed-job runner diagnostic logs through no-follow file descriptors, rejecting symbolic-link targets instead of following them.

### Release governance and diagnostics

- Add a release-impact gate requiring a newer package version and matching CHANGELOG section for every tracked or nonignored repository change after the latest version tag. Document that reviewed changes must be pushed to GitHub and followed by a matching npm release.
- Clarify in `server_info`, runtime diagnostics, and operations documentation that canonical `full` controls the local daemon and relay catalog only. A connector host can expose a smaller subset, and that host-side subset is not observable or overrideable by Machine Bridge.

### Tests and documentation

- Add regression coverage for privacy scanning of new files, clean/parseable package manifests and sensitive-artifact exclusion, default path omission and explicit disclosure, hidden unrestricted paths, plan tampering, direct staged-runner invocation, transition locks, source-path redaction, symlink log targets, corrupt-state cleanup, Unicode authorization spoofing, oversized stdio recovery, ID-less tool calls, and comment-free SSH fingerprints.
- Make release packaging resilient to lifecycle output by using silent JSON mode, and document repository privacy incident response, immutable history/package limitations, explicit path disclosure, plan integrity enforcement, same-user filesystem race residuals, and privacy checks in the release process.

## 0.6.2 - 2026-07-10

### Fixed

- Retry atomic JSON file replacement with bounded backoff for transient Windows sharing failures (`EPERM`, `EACCES`, `EBUSY`, and `ENOTEMPTY`). State, managed-job manager, and detached runner commits now use one shared implementation.
- Prevent an intermittent Windows `runner_failed` result caused by a transient status-file replacement failure after the same commit had passed the protected pull-request checks.
- Preserve immediate failure for non-transient filesystem errors and keep temporary-file cleanup behavior unchanged.
- Restore corrupt-state backup creation through the shared replacement primitive, add collision-resistant backup names, and verify that recovery preserves the original corrupt bytes.

### Tests and diagnostics

- Add deterministic injected transient/non-transient atomic replacement tests.
- Run the full real-machine sandbox three consecutive times on Windows, exercising repeated detached runner, status, result, and finally-step commits.
- Include managed-job error and cleanup classifications in `full-test` output when a lifecycle check fails.

## 0.6.1 - 2026-07-10

### Full-profile contract and operator workflows

- Make named profiles canonical capability contracts. A stored `full` label is repaired to writes, shell execution, unrestricted paths, full parent environment, absolute path output, and the complete tool catalog; deliberate individual overrides remain `custom`. Advance the policy revision to 3 and expose the contract in `server_info` and `doctor`.
- Add `machine-mcp full-test`, a real local-machine acceptance suite using disposable directories. It verifies outside-workspace I/O, direct and shell execution, parent-environment inheritance, SSH key generation, sandbox `authorized_keys`, SSH client parsing, Google OS Login command availability, a non-mutating sudo probe, and detached finally cleanup without changing cloud or remote state.
- Add `machine-mcp resource generate-ssh-key NAME [PATH]` and the canonical-full-only MCP tool `generate_ssh_key_resource`. Both generate or reuse an Ed25519 pair locally, register the private file as a resource, and return only paths, modes, key type, and public fingerprint.

### Logging

- Remove every ordinary per-tool event from default `info`/`warn` logs. Starts, successes, failures, cancellations, durations, slow calls, tool names, coarse outcome classes, and call correlation are now debug-only in both remote daemon and stdio transports.
- Keep default logs focused on deployment, connection, protocol, relay, service, and infrastructure health. Tool arguments, command text, inputs, outputs, and results remain omitted at all levels.

### Security, correctness, and portability

- Verify that an existing SSH public key matches its private key and that the private key is usable non-interactively before reuse. Reject incomplete pairs and symbolic links, enforce owner-only private modes where supported, and never return private bytes.
- Fix the previously untested RSA key-generation argument order and add real RSA coverage.
- Centralize CLI and MCP key generation/registration in one locked state transaction. Roll back a newly created pair if state persistence fails, handle canonical path aliases, and reapply permissions after cross-filesystem installation.
- Validate the resource state layout before deriving its root and restrict the MCP key generator to the complete canonical `full` profile.
- Avoid reading user SSH configuration during `full-test`, canonicalize temporary path aliases, and report sudo/cloud prerequisites separately from core Machine Bridge capability.

### Tests and documentation

- Add real Ed25519/RSA generation, reuse, mismatch, incomplete-pair, symlink, mode, private-content, CLI, stdio, Worker-policy, and real-machine full-profile regression coverage.
- Update logging, architecture, operations, client, managed-job, security, and testing documentation to match the canonical-full and debug-only per-tool event contracts.

## 0.6.0 - 2026-07-10

### Added

- Add `diagnose_runtime`, a fixed-input layered diagnostic that distinguishes requests reaching the daemon from Machine Bridge policy, local filesystem, process-spawn, shell, managed-job storage, and registered-resource failures. `machine-mcp doctor` runs the same local probes.
- Add operator-registered local file resources. Credentials and other local-only files can be referenced by alias and injected into managed steps through a private copied path, stdin, or an environment variable without sending file contents or source paths through MCP.
- Add durable managed jobs with ordered argv steps, bounded output, job-scoped temporary files, detached execution, cancellation, idempotent `finally_steps`, dead-runner detection, bounded recovery, and local CLI inspection/cancellation.
- Add two-phase handoff: `stage_job` persists a validated non-running plan for operator review, and `machine-mcp job approve JOB_ID` provides explicit local authorization when a host blocks execution-class tools.
- Add a local JSON fallback with `machine-mcp job submit plan.json` for situations where the MCP host cannot deliver an execution request.

### Security and privacy

- Keep resource values out of MCP plans and results. Referenced files are reopened, bounded, hashed at acceptance, verified before use, copied with owner-only permissions, and removed after cleanup.
- Redact exact resource paths, exact UTF-8 values, and bounded exact base64/hex forms from retained output. Add `capture_output: "discard"` for credential-consuming commands where output must not be retained.
- Delete active job plans, runner PID files, temporary helper contents, argv, stdin, environment overrides, resource source paths, and hashes after terminal commit. Retain only bounded status/redacted results for up to seven days and 50 jobs.
- Enforce canonical managed-job cwd containment in restricted profiles, bounded per-job resources/temporary files/output, no-follow plan/resource reads, owner-only job state, bounded runner diagnostics, recovery mutual exclusion, and a three-attempt automatic recovery limit.
- Refuse uninstall while detached jobs remain active. Later profile changes affect new submissions; accepted running jobs require explicit cancellation.
- Clarify that managed jobs are durability and local-authorization mechanisms, not a bypass for MCP-host, operating-system, or endpoint-security policy.

### Operations and tests

- Add local resource commands: `resource add`, `list`, `check`, and `remove`.
- Add local managed-job commands: `job submit`, `inspect`, `approve`, `list`, `read`, and `cancel`. Approval is interactive by default; `--yes` is required for non-interactive JSON approval.
- Add state schema version 5 for resource registry metadata while redacting resource source paths from normal status output.
- Add regression coverage for staging/approval/cancel-before-start, stdio disconnect survival, resource replacement races and output redaction, job-scoped helper cleanup, failure/timeout/cancellation finally paths, concurrent recovery, corrupt plans, output budgets, local CLI fallback, uninstall refusal, and cross-profile tool exposure.
- Add a dedicated managed-jobs/resource operations and threat-model guide.

## 0.5.0 - 2026-07-10

### Changed

- Replace routine per-tool success chatter with explicit log levels. Foreground mode defaults to `info`, autostart uses `warn`, fast successful calls are debug-only, and successful calls over 30 seconds remain visible as slow-call events. `--verbose` maps to `debug`; `--quiet` maps to `error`; `--log-level` accepts `error`, `warn`, `info`, or `debug`.
- Record policy origin and revision in state and daemon metadata. The exact legacy implicit-default policy shape is migrated once to the current maximum-permission `full` profile, while explicit named profiles and identified custom policies are preserved.
- Redact JSON connection credentials and standalone secret-rotation output by default. Printing the client connection password now requires the explicit reconnect flag; the daemon secret is never printed in full.
- Centralize server name, MCP protocol versions, and instructions in shared metadata consumed by both Worker and local transports.
- Reject obsolete removed-local-API flags instead of silently accepting them.

### Security and privacy

- Upgrade and pin `ws` to 8.21.0 to address current memory-disclosure and denial-of-service advisories; pin the reviewed Wrangler runtime version.
- Bind text, image, and search reads to an opened file handle, enforce limits against that handle, and avoid `stat`/read growth races.
- Bound state, configuration, marker, lock, service-command, log-message, and structured-log sizes. Reject symbolic-link state files, use no-follow reads where supported, and make service-log tail trimming UTF-8 and line safe.
- Remove stale temporary Worker secret files when their owner process is gone, not only after an age threshold.
- Document and expose that Machine Bridge has no sensitive-filename blacklist. Local `full` permits any OS-readable UTF-8 regular file, but cannot override operating-system or independent MCP-host/platform policy.

### Tests and operations

- Add regression coverage for legacy policy migration, sensitive-looking files outside the workspace, inherited full-profile environment, default daemon/stdio log suppression, log bounding, state write bounds, service warning-level configuration, and shared metadata drift.
- Audit both complete and production-only dependency graphs in GitHub Actions.
- Document npm's scoped install-script approval for Wrangler native dependencies and add a dedicated logging/observability reference.

## 0.4.2 - 2026-07-10

### Fixed

- Canonicalize the configured workspace and requested targets through the same asynchronous `realpath` path on Windows, while retaining a native synchronous initial value. This prevents Windows short-path/long-path aliases for the same temporary directory from being misclassified as a workspace escape.
- Keep workspace confinement unchanged: only the representation comparison changed, and targets outside the canonical workspace remain rejected in restricted profiles.

### Verification

- Preserve the existing cross-platform path-boundary regression, which exposed the issue on the Windows GitHub Actions runner while Linux and macOS passed.
- Make the minimal-environment shell regression use a cross-platform Node command instead of POSIX parameter-expansion syntax under PowerShell.
- Convert test entry-point file URLs with `fileURLToPath()` so Windows does not interpret `/D:/...` URL paths as `C:\D:\...` filesystem paths.
- Launch Wrangler's JavaScript entry point through the active Node executable in integration tests instead of directly spawning the Windows `.cmd` shim.

## 0.4.1 - 2026-07-10

### Changed

- Make `full` the default policy for newly selected workspaces and generated client configurations, prioritizing immediate usability. The default now enables all tools, unrestricted direct filesystem paths, absolute path output, shell execution, process sessions, and the complete parent environment; existing saved workspace policies remain unchanged.
- Reframe stdio as an optional local transport rather than a model provider or a replacement for native Claude, Cursor, Codex, or ChatGPT Desktop tooling. Expand client documentation to distinguish the MCP host/model from the Machine Bridge tool server and explain when stdio is redundant or useful.
- Activate cross-platform GitHub Actions checks on Linux, macOS, and Windows, update official actions to the current major releases, disable checkout credential persistence, and retain production dependency/package auditing.

### Tests and documentation

- Add regression coverage for the maximum-permission default and for `client-config` emitting `full` when no profile is supplied.
- Update architecture, operations, security, and client guidance for profile-dependent path display, filesystem scope, and environment inheritance.

## 0.4.0 - 2026-07-10

### Architecture and compatibility

- Refactor the project into one transport-independent local runtime shared by the existing OAuth-protected Cloudflare relay and a new local MCP stdio server.
- Update MCP negotiation to `2025-11-25` while retaining compatibility with `2025-06-18` and `2025-03-26`; validate protocol-version headers and implement cancellation in both transports.
- Add ready-to-paste stdio configuration generation for Claude Desktop, Cursor, Codex CLI, and generic MCP clients.
- Replace duplicated Worker/runtime tool declarations with one schema-and-annotation catalog, tested for drift and policy consistency.

### Security and privacy

- Make the least-privilege `review` profile the default for newly selected workspaces; preserve stored pre-0.4 permissions during upgrade.
- Add explicit `review`, `edit`, `agent`, and `full` profiles plus `off`, direct-argv, and shell execution modes.
- Return workspace-relative paths by default, redact canonical/platform-alias paths from tool errors, omit Git author email unless requested, and reduce operational failures to coarse error classes.
- Replace the previous minimal environment with isolated HOME, temp, and cache directories; retain full parent environment only through explicit opt-in.
- Reject duplicate in-flight JSON-RPC IDs, canonical patch-path collisions, stale edits, unsupported image signatures, oversized session data, and ambiguous patch context.
- Make create-only writes atomic against concurrent destination creation and strengthen multi-file patch staging, revalidation, rollback, and mutation serialization.

### Tools and runtime

- Add bounded line-range reads, native MCP raster-image results, exact text editing, and structured multi-file add/update/move/delete patches.
- Add staged diffs, structured Git log, bounded Git show, and privacy-aware author metadata.
- Add direct argv execution and bounded interactive process sessions with retained offsets, stdin, output/exit waits, cancellation, tree termination, and disconnect cleanup.
- Return structured tool content alongside text compatibility output and expose tool annotations for client planning.

### Reliability, testing, and operations

- Add live stdio integration coverage for initialization, tool discovery, structured/image content, edits, patches, direct execution, sessions, cancellation, and post-cancellation health.
- Expand Worker integration coverage for latest protocol negotiation, disconnected tool advertisement, rich content, exact daemon tool sets, and remote cancellation.
- Add catalog, policy-profile, canonical-collision, no-partial-patch, Git privacy, path-redaction, isolated-environment, and session tests.
- Add a Linux/macOS/Windows GitHub Actions template, Node 22/24 coverage, package/audit checks, and Dependabot configuration.
- Rewrite architecture, security, client, operations, and testing documentation around explicit trust boundaries and non-goals.

## 0.3.3 - 2026-07-10

### Security

- Add an exact-version npm `allowScripts` policy for the reviewed Wrangler runtime/build binaries (`esbuild@0.28.1`, `sharp@0.34.5`, and `workerd@1.20260708.1`) and explicitly deny the optional `fsevents` install script. Dependency upgrades therefore require renewed script approval.

### Changed

- Exclude the development-only Worker integration test from the published npm package while retaining it in the repository and CI.
- Add a fail-closed release command that synchronizes `main`, the version tag, the GitHub Release, and its npm tarball; block `npm publish` when those artifacts do not match.

## 0.3.2 - 2026-07-10

### Fixed

- Keep the healthy daemon active until a replacement connection completes its authenticated `hello` handshake; enforce the candidate deadline with a Durable Object alarm so it survives WebSocket hibernation, and reject stale or non-handshaking candidates without disrupting the active connection.
- Send the candidate acknowledgement before closing the previous daemon, expire failed acknowledgements, clean up duplicate authenticated sockets on subsequent handshakes, and reject pre-handshake messages without changing active tool metadata.

## 0.3.1 - 2026-07-10

### Security

- Replace reversible unsalted source-address hashes used for OAuth registration limits and password throttling with deployment-keyed HMAC identifiers; stop persisting User-Agent-derived identities, remove legacy unsalted identifiers during store migration, and fail closed if no identity key is configured.

### Fixed

- Preserve timeout escalation after the direct child exits so a process-group `SIGKILL` still removes descendants that ignore `SIGTERM`; add a regression test for the orphan-process boundary.
- Replace legacy unsalted source-identity hashes with deployment-keyed HMAC identifiers, prune legacy stored identifiers, and add integration coverage for registration quotas and login throttling.

## 0.3.0 - 2026-07-10

### Security

- Confine filesystem tools to the canonical workspace by default; add explicit `--unrestricted-paths` opt-in and symbolic-link escape protection.
- Make `write_file` bounded and atomic, reject symbolic-link/non-regular destinations, and enforce optimistic hashes consistently.
- Add recursive log-field and token redaction, control-character neutralization, owner-only service logs, and bounded log trimming.
- Harden OAuth with strict PKCE/resource/client/redirect validation, validated client disclosure on the consent page, password-failure throttling, bounded dynamic registration, per-source and per-client limits, inactive-client cleanup, strict HTTP methods/UTF-8 handling, and security response headers.
- Minimize unauthenticated and relay metadata disclosure: remove workspace name/path hash/process ID from the daemon handshake, reduce default observability sampling, and bind pending calls to their originating daemon socket.
- Bound Worker/daemon request sizes and concurrency; serialize OAuth mutations; isolate WebSocket generations; serialize per-workspace startup/deploy/rotation operations; terminate timed-out or disconnected child processes and bound Wrangler subprocesses.

### Changed

- Raise the minimum Node.js version to 22 because the current Wrangler release no longer runs on Node 20; require the installed Wrangler dependency instead of falling back to an implicit network `npx` execution.
- Remove the experimental local OpenAI-compatible `/v1` API and MCP sampling proxy.
- Detect nested Git repositories for `git_status` and `git_diff`, while disabling repository-configured external diff, text conversion, and filesystem-monitor hooks for bridge Git operations.
- Use atomic local state/config writes, bounded corrupt-state backups, strict adoption/migration of dedicated state roots, and guarded state-root deletion during uninstall, including refusal while active daemon/startup locks remain.
- Reject unknown, duplicate, malformed, and command-inapplicable CLI options; fix boolean options consuming positional workspaces.
- Verify the expected Worker version before accepting a deployment hash.
- Reduce the default Worker request-body limit to 8 MiB; bound command length, directory results, recursive traversal, and path-result payloads; provide exact-origin CORS while rejecting implicit loopback browser origins.
- Update Wrangler to 4.110.x, TypeScript to 5.9.x, and Node type definitions to the supported Node 22 API line.

### Tests and documentation

- Expand self-tests across path boundaries, symlinks, writes, UTF-8, nested Git, environment isolation, locking, CLI parsing, state recovery/removal guards, logging, service logs, and Worker hardening invariants.
- Add a live local Worker OAuth/MCP integration test, verified Node 22/24 compatibility, a Worker build dry-run, dependency audit, security policy, and architecture document.

## 0.2.5

- Previous release.
