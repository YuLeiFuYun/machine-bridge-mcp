# Changelog

## 3.0.0-beta.188 - 2026-09-12

- Refactor runtime diagnostics so bounded macOS `pmset` sleep-history collection is explicit auxiliary causality evidence rather than a core health gate: timeout/unavailability remains visible as `runtime.system_sleep.available=false` with `error_class` and a skipped `system-sleep-history` check, while relay, filesystem, process, shell, managed-job storage, resource-admission, and registered-resource failures remain fail-closed.
- Add direct forced-macOS and end-to-end regression/negative coverage for the auxiliary sleep-history boundary, and document the distinction between unavailable causal evidence and unhealthy runtime state.
- Advance package, Worker, and browser-extension prerelease identity to `3.0.0-beta.188`; beta.187 remains the immutable accepted GitHub prerelease. npm publication still requires explicit owner authorization.

## Historical releases

Historical prerelease entries remain available from Git tags and repository release records. From a source checkout, inspect the changelog shipped by a prior release with `git show v<version>:CHANGELOG.md`. This current file intentionally describes only the active candidate and the history location.
