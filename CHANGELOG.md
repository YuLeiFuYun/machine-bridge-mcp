# Changelog

## 3.0.0-beta.196 - 2026-09-21

- Stop verified-WebSocket operation from maintaining a continuously polled HTTPS standby relay; HTTPS fallback now starts only during startup grace, liveness degradation, or actual WebSocket loss, and verified WebSocket recovery stops it.
- Raise ready HTTPS fallback idle polling from one second to five seconds and standby retry from five seconds to thirty seconds while preserving the 750 ms minimum path for handshake and queued outbound work, reducing idle request and replay-nonce traffic. Scenario tests separately count recurring Durable Object alarm mutations; these are not a whole-account billing guarantee.
- Add regression coverage for healthy-day zero fallback polling, direct HTTP and WebSocket-preflight replay-nonce write accounting, daily request/write budgeting, exact-generation failover, late-ready recovery races, and repeated handover behavior.
- Enforce one monotonic HTTP retry deadline across queued work and lifecycle transitions, honor bounded 429/503 `Retry-After`, and reject exact-expiry authentication and delayed preflight consumption without nonce writes.
- Correct stale initialization-compatibility and subscription documentation to match the current-only protocol implementation.
- Independent review removes obsolete `standbyDelayMs` test fixtures and synchronizes README, architecture, operations, logging, testing, privacy, and audit documentation with the quota-bounded fallback behavior and the absence of a checked-in Workers KV binding.

## Historical releases

Historical prerelease entries remain available from Git tags and repository release records. From a source checkout, inspect the changelog shipped by a prior release with `git show v<version>:CHANGELOG.md`. This current file intentionally describes only the active candidate and the history location.
