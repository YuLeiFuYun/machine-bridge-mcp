# Changelog

## 3.0.0-beta.167 - 2026-09-08

- Retire executable compatibility paths that have a current versioned replacement: require the current browser atomic-observation capability, require the formal desktop visual-point capability interface, and make remote MCP HTTP initialization current-protocol-only while preserving explicit fail-closed upgrade guidance for obsolete protocol/session requests.
- Reduce the default maintenance and installation surface: the changelog now keeps the active release plus a history pointer, the audit file keeps only current conclusions and residual-risk notes, and npm packaging uses explicit runtime/operational-document and release-tool whitelists. Repository-only architecture, engineering, testing, release-governance, and contributor-governance material remains in source control but no longer ships to consumers.
- Replace the GitHub backlog closing-keyword parser's overlapping quantified regular expression with a deterministic separator/issue-number scanner, removing the CodeQL `js/polynomial-redos` release blocker without weakening the SARIF gate.
- Advance package/runtime identity to `3.0.0-beta.167`. Hosted tool schema generation remains 26 because these changes do not alter any MCP tool name, input schema, visibility, description, or result shape. No publication or live activation is part of this source change.

## Historical releases

Historical prerelease entries remain available from Git tags and repository release records. From a source checkout, inspect the changelog shipped by a prior release with `git show v<version>:CHANGELOG.md`. This current file intentionally describes only the active candidate and the history location.
