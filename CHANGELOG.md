# Changelog

## 3.0.0-beta.168 - 2026-09-08

- Retire executable compatibility paths that have a current versioned replacement: require the current browser atomic-observation capability, require the formal desktop visual-point capability interface, and make remote MCP HTTP initialization current-protocol-only while preserving explicit fail-closed upgrade guidance for obsolete protocol/session requests.
- Reduce the default maintenance and installation surface: the changelog now keeps the active release plus a history pointer, the audit file keeps only current conclusions and residual-risk notes, and npm packaging uses explicit runtime/operational-document and release-tool whitelists. Repository-only architecture, engineering, testing, release-governance, and contributor-governance material remains in source control but no longer ships to consumers.
- Replace the GitHub backlog closing-keyword parser's overlapping quantified regular expression with a deterministic separator/issue-number scanner, removing the CodeQL `js/polynomial-redos` release blocker without weakening the SARIF gate.
- Make persistent activation fail closed on a read-only restartability preflight before stopping the existing provider: exact candidate package identity, persisted service-network environment compatibility, and the target platform service definition are validated without creating service artifacts; an unsupported persisted environment key leaves the running provider untouched.
- Advance package/runtime identity to `3.0.0-beta.168`. Hosted tool schema generation advances to 27: relay `read_file` now auto-pages whole lines under a 64 KiB complete-result budget, relay `read_process` pages at 32 KiB, account-owned transient one-step process carriers cap captured output at 32 KiB aggregate, and owner diagnostics report content-free recent result-byte pressure. Local/stdio capacities and the beta.168 activation preflight remain unchanged. No publication or live activation is part of this source change.

## Historical releases

Historical prerelease entries remain available from Git tags and repository release records. From a source checkout, inspect the changelog shipped by a prior release with `git show v<version>:CHANGELOG.md`. This current file intentionally describes only the active candidate and the history location.
