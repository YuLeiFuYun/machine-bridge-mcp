# Changelog

## 3.0.0-beta.170 - 2026-09-08

- Preserve the existing macOS `activity` policy as the default: authorized remote activity keeps `/usr/bin/caffeinate -i -s -w <owner-pid>` through execution and the fixed thirty-minute inactivity grace, so an ordinary upgrade does not silently change laptop battery behavior.
- Add persistent `ac-continuous` and `continuous` daemon policies, configurable with `machine-mcp idle-sleep show|set MODE`. `ac-continuous` holds a daemon-lifetime `-s` assertion and layers the normal `-i -s` activity assertion while work is active; `continuous` holds `-i -s` for the daemon lifetime and does not arm inactivity grace.
- Make every macOS idle-sleep assertion self-healing. Unexpected `caffeinate` exit/start failure retains desired-state ownership and retries with bounded 1/5/30-second backoff; explicit release or runtime shutdown cancels pending recovery so an intentional stop cannot respawn the child.
- Extend owner diagnostics with the configured mode, assertion generation, restart count, recovery-pending state, and bounded current/last unprotected duration. These fields remain content-free and do not claim to prevent explicit sleep, lid-close sleep, power loss, or operating-system behavior outside `caffeinate` contracts.
- Advance package, Worker, and browser-extension identity to `3.0.0-beta.170`; hosted tool schema generation remains 27 because no MCP tool argument/result contract changes in this release.

## Historical releases

Historical prerelease entries remain available from Git tags and repository release records. From a source checkout, inspect the changelog shipped by a prior release with `git show v<version>:CHANGELOG.md`. This current file intentionally describes only the active candidate and the history location.
