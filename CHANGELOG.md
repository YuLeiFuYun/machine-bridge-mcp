# Changelog

## 3.0.0-beta.215 - 2026-11-20

- Correct syntax inspection backend status to report native JSON parser when validating JSON files.
- Fail closed in `verify_syntax` by rejecting unverified parser backends, and remove the remaining `node:vm` import.
- Add automated architectural contract asserting delegated process sandbox remains policy-unreachable across all non-owner roles.
- Document worker runtime type seed deterministic generation, verification, and refresh lifecycle.

## Historical releases

Historical prerelease entries remain available from Git tags and repository history. From a source checkout, inspect the changelog of a prior revision with `git show <revision>:CHANGELOG.md`. This current file intentionally describes only the active candidate and the history location.
