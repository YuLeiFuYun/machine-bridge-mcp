# Changelog

## 3.0.0-beta.220 - 2026-11-21

- Complete browser `POST /oauth/authorize` submissions (`Accept: text/html`) via a zero-script `200 OK` HTML handoff document (`form-action 'none'`, `Referrer-Policy: no-referrer`, `<meta http-equiv="refresh">`) so multi-hop OAuth callbacks like Gemini's `oauth-redirect.googleusercontent.com` relay navigate cleanly without broadening `form-action` on the credential page (removing the unnecessary `*.google.com` and `*.gemini.google` wildcards).

## Historical releases

Historical prerelease entries remain available from Git tags and repository history. From a source checkout, inspect the changelog of a prior revision with `git show <revision>:CHANGELOG.md`. This current file intentionally describes only the active candidate and the history location.
