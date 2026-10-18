# Changelog

## 3.0.0-beta.202 - 2026-10-18

- Prevent delegated search, project instruction loading, skill discovery, and structured Git history/diff output from exposing sensitive paths or hard-linked files; make skipped search inputs explicitly mark results as incomplete and preserve match text in long-line snippets.
- Make arbitrary remote process execution and process-session controls owner-only because workspace-scoped execution can still read workspace credentials and exfiltrate them over the network.
- Reject stale refresh-token retries after their replacement has been consumed, prevent retries from reviving revoked families, and validate access-token family revocation on every authorization check.
- Expand sensitive filename classification for common private keys, key containers, and infrastructure state files; make network retries opt-in for operations known to be safe to replay.
- Add regression coverage for the security boundaries, install redacted fail-fast process handlers, throttle platform-service crash loops, and expand strict local type checking with a guard against silently omitted checked modules.
- Make workspace listing and literal search ignore common generated/dependency directories by default, with an explicit include-ignored override; add relative glob filtering, case-insensitive matching, and bounded context lines.
- Consolidate numeric parsing and plain-record validation into shared primitives while retaining the existing local import paths; reject non-record objects in tool-capacity accounting.
- Expand strict local type checking to 62 modules, including Computer Use argument validation, execution routing, managed-job dependency handling, workspace transactions, and public runtime projections; extract workspace transaction cleanup/error helpers behind a narrow module boundary, and keep the high-risk workspace-profile migration explicitly queued for a dedicated type-contract review.
- Add a regression assertion that the product default remains the full-authority profile.
- Bring workspace-profile migration into strict local type checking with explicit contracts for state envelopes, migration markers, service-provider state, and active-job/lock inventory; keep migration behavior unchanged.
- Preserve exact branch selection across pending version edits without weakening prerelease conflict checks; prevent empty delegated Git path enumeration from falling back to an unfiltered content command.
- Keep arbitrary rejection content out of fatal logs and guarantee termination when rejection inspection or logging throws; synchronize the remote-execution security and threat-model documentation.

## Historical releases

Historical prerelease entries remain available from Git tags and repository history. From a source checkout, inspect the changelog of a prior revision with `git show <revision>:CHANGELOG.md`. This current file intentionally describes only the active candidate and the history location.
