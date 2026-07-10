# Changelog

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
