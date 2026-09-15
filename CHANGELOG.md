# Changelog

## 3.0.0-beta.191 - 2026-09-15

- Keep durable managed-job execution available across in-place Node package-manager upgrades by falling back from a removed daemon `process.execPath` only to the still-executable absolute Node launcher that originally started the daemon; diagnostics expose provenance/availability without local paths.
- Make macOS sleep diagnosis retain actual timestamped `Sleep` records with a bounded 15-second power-log probe, avoiding the previous five-second timeout and broad filter that could hide evidence explaining relay suspension.
- Add regressions for stale runtime launcher recovery and sleep-probe boundaries; relay authentication, replay, duplicate-side-effect prevention, and reconnect policy are unchanged.

## Historical releases

Historical prerelease entries remain available from Git tags and repository release records. From a source checkout, inspect the changelog shipped by a prior release with `git show v<version>:CHANGELOG.md`. This current file intentionally describes only the active candidate and the history location.
