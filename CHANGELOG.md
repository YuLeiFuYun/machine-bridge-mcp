# Changelog

## 3.0.0-beta.214 - 2026-11-10

- Structural refactoring and consolidation across local runtime, worker modules, and documentation.
- Retain transactional resource locks, audit boundary integrity, and platform compatibility.
- Remove the dormant CodeAct executor: the `node:vm` sandbox was escapable through host objects returned by timers, buffers, and tool calls. A future implementation must use a subprocess boundary.
- Ship `@babel/parser` as a runtime dependency and make syntax inspection authoritative first, with decorators, auto-accessors, and JSX supported; oversized content is reported as skipped instead of valid.
- Fix CommonJS module parsing mode in syntax validation to accept top-level return and reject top-level await for `.cjs` / `.cts` files.
- Expose `verify_syntax` on `write_file`, `edit_file`, and `apply_patch`, and report `syntax_check` when a write cannot be validated.
- Correct Set-of-Marks viewport geometry projection by reading from `observation.semantic.viewport`.
- Round finite float durations in connection and peer diagnostics before clamping so high-resolution timer values are preserved.
- Allow delegated process sandbox status queries to consume cached probe outcomes without re-probing.
- Add macOS root filesystem read permission to the delegated sandbox profile to prevent libSystem startup aborts.
- Store the macOS native input helper in persistent toolchain state to preserve Accessibility (TCC) grants across restarts.
- Derive new account password hashes with PBKDF2-HMAC-SHA256 (210k iterations) while still accepting legacy records.
- Bound the stuck-loop detector to retryable failures so policy denials no longer disclose unavailable tool names.
- Use a stable macOS helper path with a SHA-256 sidecar, document the Command Line Tools requirement, and add a `doctor` prerequisite check.
- Describe delegated-process isolation without running the behavior probe during `server_info`; run it from `diagnose_runtime` instead.
- Escape Set-of-Marks SVG output, expose `set_of_marks`, and give the source and documentation ratchets fixed headroom.

## Historical releases

Historical prerelease entries remain available from Git tags and repository history. From a source checkout, inspect the changelog of a prior revision with `git show <revision>:CHANGELOG.md`. This current file intentionally describes only the active candidate and the history location.
