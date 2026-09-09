# Changelog

## 3.0.0-beta.173 - 2026-09-09

- Keep root-certified daemon session certificates capped at 24 hours while removing the avoidable daemon-stop boundary for the default portable JWK root: the runtime derives a fresh ephemeral session ten minutes before expiry and reconnects the same daemon instance through existing relay reconciliation.
- Make WebSocket preflight/challenge authentication and signed HTTPS fallback polls read one shared current-session provider, so a rollover cannot leave the preferred and fallback transports on different certificate generations.
- Cover delayed timers after system suspension: when an authentication boundary is reached at or after the renewal point, a portable root synchronously renews before signing. Renewal failure retains the previous session, uses bounded 1/5/30/300-second retry, and the existing `relay_device_session_expired` fatal path remains fail closed if no valid renewal is available.
- Do not grant unattended signing to Secure Enclave roots. They retain their user-presence semantics and supervised-restart fallback. Owner runtime info exposes only coarse renewal generation/expiry/due/failure state, never key or certificate material.
- Raise the reviewed Sharp security floor from 0.35.3 to 0.35.4 in both the main development tree and the private Wrangler control-plane toolchain after the beta.171 live-activation preflight detected a new high-severity libheif advisory chain. The same Wrangler 4.127.1 / workerd 1.20260828.1 control-plane versions remain in place, and fresh production-only audits report zero vulnerabilities.
- Bound process-lock snapshot reads across the daemon's atomic startup-readiness publication. A path/descriptor identity mismatch retries only `MBM_IDENTITY_CHANGED` up to four reads before failing closed; hard-link, symlink, permission, oversized-file, and unrelated storage failures keep their existing immediate failure semantics. This closes the beta.172 post-ready activation race where the candidate Worker/service was already healthy but the activation subprocess failed while observing a concurrently replaced daemon lock.
- Advance package, Worker, and browser-extension identity to `3.0.0-beta.173`; hosted tool schema generation remains 27 because no MCP tool argument/result contract changes in this release.

## Historical releases

Historical prerelease entries remain available from Git tags and repository release records. From a source checkout, inspect the changelog shipped by a prior release with `git show v<version>:CHANGELOG.md`. This current file intentionally describes only the active candidate and the history location.
