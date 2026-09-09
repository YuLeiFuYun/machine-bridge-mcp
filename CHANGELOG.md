# Changelog

## 3.0.0-beta.174 - 2026-09-09

- Harden brief same-daemon relay interruptions after a live beta.173 incident showed WebSocket close `1006` on the application-proxy route and one reconnect attempt returning HTTP `502`, while local daemon, filesystem/process, resource-admission, event-loop, and sleep evidence remained healthy. The evidence locates the failure at the relay/proxy transport boundary but does not identify a specific upstream provider.
- Preserve an in-memory pending result owner for up to 15 additional seconds after its original Worker settlement deadline when the same daemon reconnects, capped by the tool's existing maximum settlement lifetime. This delivery-only grace lets an already-executed terminal result settle the original request instead of turning a short transport outage into a user-visible timeout.
- Keep execution authority separate from result delivery: transparent redelivery after `resume_calls_ack.missing_ids` still uses the original daemon execution deadline, so the longer settlement owner cannot authorize a new execution, duplicate a side effect, or create client-visible MCP replay state. Repeated same-instance handovers cannot cumulatively extend the absolute delivery deadline.
- Add deterministic coverage for late terminal-result delivery, reconnect-expiry classification, repeated handover, the existing 50-second ordinary settlement ceiling, and the negative case where the original execution budget has expired but the result owner is still intentionally retained.
- Keep relay recovery observability content-free: normal logs and public diagnostics do not gain call IDs, arguments, results, credentials, proxy endpoints, raw socket errors, or personal paths from this recovery path.
- Advance package, Worker, and browser-extension identity to `3.0.0-beta.174`; hosted tool schema generation remains 27 because no MCP tool argument/result contract changes in this release.

## Historical releases

Historical prerelease entries remain available from Git tags and repository release records. From a source checkout, inspect the changelog shipped by a prior release with `git show v<version>:CHANGELOG.md`. This current file intentionally describes only the active candidate and the history location.
