# Changelog

## 3.0.0-beta.179 - 2026-09-10

- Supersede the unaccepted beta.178 candidate after owner-machine recovery exposed post-verification lifecycle gaps. A recurring external launchd migration helper repeatedly stopped the Machine Bridge daemon and then exited before restart when the destination profile was populated; that helper is removed and is not an accepted migration mechanism. The evidence supports a runaway recovery task, not malicious intent.
- Retain the compound-task continuity repair from beta.175/beta.176: coherent long-running, multi-step, multi-project, and interruption-sensitive non-interactive work routes toward durable managed-job ownership, same-job recovery is preferred after reconnect, and direct shell remains available as a fallback.
- Add `machine-mcp workspace migrate OLD NEW` as the supported offline workspace-profile relocation path. It accepts an already-missing OLD path only when the retained profile proves that exact historical path/hash; accepts a destination only when absent or provably unpopulated; and refuses active providers, managed jobs, state locks, populated or ambiguous destination collisions, malformed/mismatched state, and ambiguous service-owner identity.
- Verify provider inactivity and source-profile job/lock quiescence before pruning even a proven-empty destination shell. Empty-shell pruning uses only empty-directory removal, so a concurrent population race fails closed rather than recursively deleting state.
- Make targetless `machine-mcp service stop` provider-global and workspace-state-free: with no explicit workspace/state target it stops the installed provider without resolving or loading the selected workspace. Explicit targeted stop retains verified daemon-ownership checks.
- Move the complete profile rather than copying only `state.json`, preserving retained jobs and security-audit state. A crash-recovery marker makes the profile-directory rename/state-envelope rewrite resumable without guessing or merging state.
- Retire a machine-service owner only when its raw committed record exactly matches the historical workspace and state root. A historical entry script that has already disappeared with an archived worktree is tolerated; an entry that still exists must be a real regular file. Canonical path comparison tolerates operating-system aliases through `realpath` when available.
- Include `HOME` in macOS launchd daemon service `EnvironmentVariables` together with the controlled `PATH` so headless/non-interactive service startup has a stable user-home boundary.
- Document that workspace migration must remain inside the supported CLI lifecycle or one bounded handoff. Do not install recurring launchd/cron helpers that repeatedly stop the daemon around migration retries.
- Advance package, Worker, and browser-extension identity to `3.0.0-beta.179`; hosted tool schema generation remains 27 because no MCP tool argument/result contract changes in this release.

## Historical releases

Historical prerelease entries remain available from Git tags and repository release records. From a source checkout, inspect the changelog shipped by a prior release with `git show v<version>:CHANGELOG.md`. This current file intentionally describes only the active candidate and the history location.
