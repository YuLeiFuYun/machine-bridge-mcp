# Changelog

## 3.0.0-beta.216 - 2026-11-20

- Preserve the existing 210,000-round account password verifiers on hosted Workers whose native PBKDF2 rejects the iteration count.

- Correct syntax inspection backend status to report native JSON parser when validating JSON files.
- Fail closed in `verify_syntax` by rejecting unverified parser backends, and remove the remaining `node:vm` import.
- Apply the documented UTF-8 syntax inspection limit to JSON and JavaScript-family files, and reuse the inspection result for each mutation.
- Bound bulk replacement and inherited patch indentation before allocating expanded text. Apply large line insertions without exceeding the JavaScript engine's call argument limit.
- Add automated architectural contract asserting delegated process sandbox remains policy-unreachable across all non-owner roles.
- Check that each account role retains the tools of the previous role and compare Durable Object storage, access origins, and public route settings across deployment configurations.
- Document worker runtime type seed deterministic generation, verification, and refresh lifecycle.

## Historical releases

Historical prerelease entries remain available from Git tags and repository history. From a source checkout, inspect the changelog of a prior revision with `git show <revision>:CHANGELOG.md`. This current file intentionally describes only the active candidate and the history location.
