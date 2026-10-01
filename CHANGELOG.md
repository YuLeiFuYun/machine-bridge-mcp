# Changelog

## 3.0.0-beta.197 - 2026-09-30

- Pin source tooling and the integrity-verified hardened npm bootstrap to brace-expansion 5.0.12, fixing the newly disclosed parser denial-of-service advisories. Preserve clean global consumer installs without postinstall hooks; declare the audited private Wrangler build provider and supply its executable runner before native cf builds.

- Migrate Worker builds and deployments to native cf configuration and prebuilt artifacts; preserve the Worker name, SQLite Durable Object export, rate-limit namespaces, existing variables, and secrets.
- Require structured cf authentication before unattended activation and bind deployment fingerprints to the exact private source snapshot and pinned toolchain.

- Add an isolated, exact cf deployment toolchain with a compatible Wrangler builder and patched Undici.
- Verify the deterministic compatibility artifact for cf beta.5 before its network factory runs; reject unknown or tampered bundle bytes.
- Synchronize the package, Worker, and browser extension prerelease version declarations.

## Historical releases

Historical prerelease entries remain available from Git tags and repository release records. From a source checkout, inspect the changelog shipped by a prior release with `git show v<version>:CHANGELOG.md`. This current file intentionally describes only the active candidate and the history location.
