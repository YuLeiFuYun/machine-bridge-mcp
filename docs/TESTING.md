# Testing strategy

The project treats transport, authorization, local authority, and state removal as separate failure domains.

## Required suite

```sh
npm run check
```

The suite includes:

- generated Cloudflare Worker types and strict TypeScript checking;
- syntax validation for every shipped JavaScript entry point;
- shared tool-catalog schema, annotation, and profile-inventory checks;
- canonical path and symbolic-link escape tests;
- relative-path privacy and error-path redaction tests;
- atomic create/update, optimistic hash, exact edit, and patch transaction tests;
- patch ambiguity, canonical collision, rollback, move, and delete tests;
- UTF-8 and binary handling;
- image content formatting;
- nested Git repository detection and helper suppression;
- author-email privacy in `git_log`;
- isolated command HOME/temp/cache behavior;
- one-shot timeout, descendant termination, cancellation, and process-session interaction;
- layered fixed runtime diagnostics for filesystem, direct process, shell, managed-job storage, and resource availability;
- local resource CLI registration, permission checks, dynamic reload, state-path redaction, and content non-disclosure;
- managed-job staging/local approval/cancel-before-start, detachment, job-scoped temporary files, resource hash verification/redaction, discard capture, finally execution, cancellation escalation, plan scrubbing, and dead-runner recovery;
- daemon/startup locking and state corruption recovery;
- guarded state-root removal, schema migration, policy-origin persistence, and legacy implicit-default migration;
- no filename-based sensitive-file denial under unrestricted policy;
- log redaction, control-character handling, message/field bounds, default success-log suppression, and service warning-level configuration;
- CLI parsing, policy profiles, and client configuration boundaries;
- live stdio MCP initialization, discovery, calls, rich content, sessions, cancellation, managed-job acceptance, and a detached job/finally phase that survives stdio shutdown;
- live local Worker OAuth registration, consent, PKCE, token replay rejection, throttling, CORS, protocol negotiation, dynamic tool advertisement, rich content, daemon replacement, and cancellation.

## Additional release checks

```sh
npm run worker:dry-run
npm audit --audit-level=high
npm audit --omit=dev --audit-level=high
npm pack --dry-run
npm run version:check
```

GitHub Actions executes the main suite on Linux, macOS, and Windows. Node 22 and 24 are covered on Linux; Node 22 is covered on macOS and Windows. A separate package-audit job audits both the complete dependency graph and the production-only graph, then performs a dry-run package build. Dependency and GitHub Actions updates are monitored by Dependabot.

## Test design rules

- Tests should exercise the public boundary rather than only helper functions when practical.
- Every permission-expanding feature needs a denial test.
- Every bounded resource needs an over-limit test.
- Every multi-stage mutation needs a no-partial-commit test.
- Every remote call correlation change needs daemon replacement and cancellation coverage.
- Every durable workflow needs disconnect, cancellation, cleanup-failure, dead-runner, and plan-scrubbing coverage.
- Secret-bearing resource tests must assert absence of raw, path, base64, and hex forms from MCP-visible results.
- Logs and public metadata should be tested for absence of sensitive fields, arguments, outputs, and routine success noise—not only presence of expected fields.
- Cross-platform tests must avoid shell syntax, URL-path conversion, and executable-shim assumptions specific to one operating system.
