# Changelog

## 3.0.0-beta.181 - 2026-09-10

- Supersede the activated-but-unaccepted beta.180 candidate after the owner-machine routing canary exposed two semantic false positives: `非交互工作`/`外部输入或授权` were interpreted as current interactive-process intent, and `ImageCraft` weak-matched unrelated installed applications containing the token `Image`.
- Make the machine-readable continuation contract authoritative for route priority: when `continuation.task_supervisor=true`, the durable managed-job route is primary instead of being displaced by incidental capability relevance. Keep genuine REPL/interactive work on the retained process-session route.
- Match partial installed-application names only on lexical task tokens while preserving exact installed-application-name routing. Add direct and resolver-level regressions for the exact Fovea/Akashic/ImageCraft continuation wording.
- Preserve beta.180 warm signed-HTTPS standby, bounded exact-generation takeover, no-replay relay safety, and default continuity agreements unchanged.
- Advance package, Worker, and browser-extension identity to `3.0.0-beta.181`. npm publication remains separately gated and is not part of this candidate.

## Historical releases

Historical prerelease entries remain available from Git tags and repository release records. From a source checkout, inspect the changelog shipped by a prior release with `git show v<version>:CHANGELOG.md`. This current file intentionally describes only the active candidate and the history location.
