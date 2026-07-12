# Changelog

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
