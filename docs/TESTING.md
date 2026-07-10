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
- daemon/startup locking and state corruption recovery;
- guarded state-root removal and legacy-state migration;
- log redaction, control-character handling, and service-log trimming;
- CLI parsing, policy profiles, and client configuration boundaries;
- live stdio MCP initialization, discovery, calls, rich content, sessions, cancellation, and continued responsiveness;
- live local Worker OAuth registration, consent, PKCE, token replay rejection, throttling, CORS, protocol negotiation, dynamic tool advertisement, rich content, daemon replacement, and cancellation.

## Additional release checks

```sh
npm run worker:dry-run
npm audit --omit=dev --audit-level=high
npm pack --dry-run
npm run version:check
```

GitHub Actions executes the main suite on Linux, macOS, and Windows. Node 22 and 24 are covered on Linux; Node 22 is covered on macOS and Windows. A separate package-audit job runs production dependency auditing and a dry-run package build. Dependency and GitHub Actions updates are monitored by Dependabot.

## Test design rules

- Tests should exercise the public boundary rather than only helper functions when practical.
- Every permission-expanding feature needs a denial test.
- Every bounded resource needs an over-limit test.
- Every multi-stage mutation needs a no-partial-commit test.
- Every remote call correlation change needs daemon replacement and cancellation coverage.
- Logs and public metadata should be tested for absence of sensitive fields, not only presence of expected fields.
