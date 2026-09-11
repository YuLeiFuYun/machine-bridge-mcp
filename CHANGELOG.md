# Changelog

## 3.0.0-beta.185 - 2026-09-11

- Preserve interrupted workspace-profile migration after a source-profile rename when Windows exposes the same state root through a different long/short or junction-equivalent path: relocated historical proof canonicalizes only the nearest existing ancestor, still requires the exact historical profile hash plus `state.json` suffix, and rejects a different canonical ancestor.
- Normalize Windows native-path identity during workspace migration so active locks and relocated historical profile state remain comparable across ordinary drive paths and native namespace-prefixed forms without weakening containment checks.
- Keep hosted validation compatible with CodeQL by replacing dynamic resolver regular-expression construction with fixed token parsing while retaining the same release-carrier and worktree-selection behavior.
- Invalidate the stale beta.184 acceptance after the packaged migration repair and advance package, Worker, and browser-extension identity to `3.0.0-beta.185`; fresh activation, deployed OAuth canary evidence, and observed live verification are required before recording acceptance.

## Historical releases

Historical prerelease entries remain available from Git tags and repository release records. From a source checkout, inspect the changelog shipped by a prior release with `git show v<version>:CHANGELOG.md`. This current file intentionally describes only the active candidate and the history location.
