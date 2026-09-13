# Changelog

## 3.0.0-beta.189 - 2026-09-13

- Bind signed HTTPS fallback takeover evidence to the exact WebSocket outage number at the ResilientRelay ownership boundary, retain multiple takeover/no-takeover episodes independently in the bounded recent-outage ring, and keep transport behavior unchanged.
- Carry privacy-bounded per-outage `https_fallback_taken_over` / `https_fallback_takeover_ms` through daemon, Worker synthesized recovery, runtime diagnostics, and compact summary correlation; add stale-attribution and invalid-input negative coverage plus documentation contracts.
- Advance package, Worker, and browser-extension prerelease identity to `3.0.0-beta.189`; beta.188 remains the immutable accepted GitHub prerelease. npm publication still requires explicit owner authorization.

## Historical releases

Historical prerelease entries remain available from Git tags and repository release records. From a source checkout, inspect the changelog shipped by a prior release with `git show v<version>:CHANGELOG.md`. This current file intentionally describes only the active candidate and the history location.
