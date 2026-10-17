# Changelog

## 3.0.0-beta.201 - 2026-10-17

- Stop successful network commands before transient-output classification so application text cannot replay completed side effects.
- Bound process-output and diagnostic-buffer allocation before copying; retain independent snapshots without holding oversized producer buffers, and remove unreachable overflow handling.
- Preserve nested npm configuration/engine failure diagnostics while keeping successful verification output concise.
- Make workflow-policy fault injection independent of historical action commit strings; apply the reviewed grouped Action updates.
- Reconcile cf 1.0.0-beta.18, Wrangler 4.151.1, ESLint 10.13.0 and Node types 26.6.5 across exact source/private dependency contracts, Miniflare/workerd pins, install-script approvals, network artifact integrity and runtime type generation.
- Exercise the upstream cf exported network factory directly instead of injecting an internal minifier symbol into a copied module.
- Record a revision-bound comparison of 37 related projects, adopted improvements and retained compatibility/security boundaries.

- Retire expired Scorecard exceptions no longer present in the latest provider report; re-review the three exact CodeQL findings, correct the admin request-body digest rationale, and validate checked-in exception expiry in the fast suite.
- Preserve explicit native lifecycle contracts after verifying the controller's automatic inference; use a clean worktree to keep unrelated helper languages out of project verification.

## Historical releases

Historical prerelease entries remain available from Git tags and repository history. From a source checkout, inspect the changelog of a prior revision with `git show <revision>:CHANGELOG.md`. This current file intentionally describes only the active candidate and the history location.
