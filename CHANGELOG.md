# Changelog

## 3.0.0-beta.193 - 2026-09-18

- Isolate daemon resume-handshake state by relay transport and authenticated connection generation so interleaved WebSocket and HTTPS fallback handshakes cannot overwrite or clear one another; acknowledgements return to the originating generation and duplicate resume reconciliation is rejected before it can repeat call ownership changes.
- Fence ended-generation control messages before protocol handling and route current-generation protocol violations and transport interruptions to their source channel, preventing a fallback-channel error from falling through to the primary WebSocket fatal path.
- Persist privacy-safe fatal relay protocol attribution at the default service-log level: sanitized error code, source transport, coarse generation class, handshake stage, and fatal/retry disposition, without raw session IDs, endpoints, credentials, account identity, call IDs, or payload content.
- Add deterministic regressions for handshake interleavings, stale-generation delivery, source-specific interruption, acknowledgement/drain error routing, and default structured-log field retention; relay identity, version, authorization, readiness, and replay-safety validation remain fail closed.

## Historical releases

Historical prerelease entries remain available from Git tags and repository release records. From a source checkout, inspect the changelog shipped by a prior release with `git show v<version>:CHANGELOG.md`. This current file intentionally describes only the active candidate and the history location.
