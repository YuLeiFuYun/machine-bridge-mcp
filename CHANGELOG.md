# Changelog

## 3.0.0-beta.169 - 2026-09-08

- Add `MBM_RELAY_FALLBACK_PROXY` so the signed HTTPS fallback no longer has to share the preferred WebSocket relay's application proxy. The default remains backward compatible: without the new key, `MBM_RELAY_PROXY` still governs both transports. A non-empty fallback value selects a fallback-only HTTP(S) proxy; an explicitly empty value restores standard `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` resolution for only the fallback.
- Preserve fail-closed routing semantics: failure of a configured route never authorizes an undeclared direct retry, and diagnostics continue to expose only coarse route classes rather than proxy identities or credentials. Application-layer path separation does not claim to bypass an operating-system VPN/TUN.
- Drive the change from a live awake incident with repeated ready WebSocket close-1006 interruptions and no matching sleep/event-loop stall. The local sidecar remained healthy with balanced opens/closes during that episode, so beta.169 removes the observed WSS/fallback common-mode application-proxy coupling without claiming to identify the upstream component that emitted the remote EOFs.
- Advance package, Worker, and browser-extension identity to `3.0.0-beta.169`; hosted tool schema generation remains 27 because no MCP tool argument/result contract changes in this release.

## Historical releases

Historical prerelease entries remain available from Git tags and repository release records. From a source checkout, inspect the changelog shipped by a prior release with `git show v<version>:CHANGELOG.md`. This current file intentionally describes only the active candidate and the history location.
