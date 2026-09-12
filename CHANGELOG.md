# Changelog

## 3.0.0-beta.187 - 2026-09-12

- Make exact-main GitHub release CI readiness a bounded continuation state instead of an outer-orchestration failure: `prerelease:release` now waits for missing, queued, or in-progress required push workflows under one shared 30-minute monotonic deadline with 15-second polling, while preserving newest exact-SHA run selection, immediate fail-closed handling for unsuccessful completed runs, and the rule that no tag or GitHub Release mutation occurs before all required workflows succeed. This changes GitHub release orchestration only; npm publication still requires explicit owner authorization.
- Advance package, Worker, and browser-extension prerelease identity to `3.0.0-beta.187`; beta.186 remains the immutable accepted GitHub prerelease.

## Historical releases

Historical prerelease entries remain available from Git tags and repository release records. From a source checkout, inspect the changelog shipped by a prior release with `git show v<version>:CHANGELOG.md`. This current file intentionally describes only the active candidate and the history location.
