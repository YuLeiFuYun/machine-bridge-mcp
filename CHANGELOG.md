# Changelog

## 3.0.0-beta.183 - 2026-09-11

- Let project manifests mark registered commands with `execution_mode=managed_job` plus an explicit managed-job timeout. Capability routing uses that structured metadata for long repository workflows instead of hard-coding this repository's release script names; read-only, negated, hypothetical, interactive, ordinary foreground, and existing-job continuation requests retain their own routes.
- Separate Worker execution/redelivery authority from terminal-result settlement after reconnect. The original execution deadline remains unchanged, while the same in-memory result owner may receive one non-cumulative 15-second delivery-only extension beyond the original settlement deadline, including when that deadline was already at the ordinary tool ceiling.
- Redact managed-job resource bytes before text decoding and make truncated capture fail closed at protected-value boundaries, preventing stdout, stderr, or aggregate capture limits from returning a resource/path prefix that ordinary exact-value replacement cannot recognize.
- Keep saturated managed-job retention available during an active-to-terminal dependency-scan race: if a stale active/staged snapshot loses `plan.json`, re-read status and treat only a same-job terminal transition as resolved; genuinely active or unreadable dependency state still fails closed.
- Expand architecture dependency extraction to multiline static imports/re-exports and add repository-local, fail-closed prerelease worktree resolution so public maintenance guidance no longer depends on a maintainer-home helper. Routing fixtures use synthetic project names and documented retention/process-tree timings match implementation.
- Preserve beta.182 as the reviewed predecessor identity with distinct packaged bytes, and retain its controlled relay A/B evidence without broadening the causal claim: the induced WSS application-proxy failure exercised signed HTTPS standby and durable execution, but does not identify the cause of spontaneous historical 1006 resets.
- Advance package, Worker, and browser-extension identity to `3.0.0-beta.183`. npm publication remains separately gated and is not part of this candidate.

## Historical releases

Historical prerelease entries remain available from Git tags and repository release records. From a source checkout, inspect the changelog shipped by a prior release with `git show v<version>:CHANGELOG.md`. This current file intentionally describes only the active candidate and the history location.
