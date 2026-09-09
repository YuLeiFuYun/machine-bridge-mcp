# Changelog

## 3.0.0-beta.171 - 2026-09-09

- Keep root-certified daemon session certificates capped at 24 hours while removing the avoidable daemon-stop boundary for the default portable JWK root: the runtime derives a fresh ephemeral session ten minutes before expiry and reconnects the same daemon instance through existing relay reconciliation.
- Make WebSocket preflight/challenge authentication and signed HTTPS fallback polls read one shared current-session provider, so a rollover cannot leave the preferred and fallback transports on different certificate generations.
- Cover delayed timers after system suspension: when an authentication boundary is reached at or after the renewal point, a portable root synchronously renews before signing. Renewal failure retains the previous session, uses bounded 1/5/30/300-second retry, and the existing `relay_device_session_expired` fatal path remains fail closed if no valid renewal is available.
- Do not grant unattended signing to Secure Enclave roots. They retain their user-presence semantics and supervised-restart fallback. Owner runtime info exposes only coarse renewal generation/expiry/due/failure state, never key or certificate material.
- Advance package, Worker, and browser-extension identity to `3.0.0-beta.171`; hosted tool schema generation remains 27 because no MCP tool argument/result contract changes in this release.

## Historical releases

Historical prerelease entries remain available from Git tags and repository release records. From a source checkout, inspect the changelog shipped by a prior release with `git show v<version>:CHANGELOG.md`. This current file intentionally describes only the active candidate and the history location.
