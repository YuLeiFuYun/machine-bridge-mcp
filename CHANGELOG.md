# Changelog

## 3.0.0-beta.190 - 2026-09-13

- Reuse generation-bound V8 coverage collected during the authoritative full verification plan so the coverage gate only executes fixtures whose evidence is still missing; standalone coverage verification remains self-contained.
- Make GitHub release publication consume exact-main provider CI instead of repeating a local dependency install and full verification after merge, while retaining synchronized-version checks, accepted-candidate byte and promotion-digest revalidation, exact-main revalidation before remote mutation, and uploaded-asset digest verification.
- Increase only the Windows runtime self-test success-fixture budget for loaded hosted CI; production process and resource-admission deadlines remain unchanged.

## Historical releases

Historical prerelease entries remain available from Git tags and repository release records. From a source checkout, inspect the changelog shipped by a prior release with `git show v<version>:CHANGELOG.md`. This current file intentionally describes only the active candidate and the history location.
