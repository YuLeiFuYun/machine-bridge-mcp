# Testing strategy

The project treats transport, authorization, local authority, and state removal as separate failure domains.

## Required suite

```sh
npm run check
```

The repository requires Node.js 26 and npm 12. `.node-version`, `.nvmrc`, `packageManager`, `devEngines`, and strict engine checks keep local and CI execution on the same baseline.

The suite includes:

- release-impact enforcement requiring a new package version and CHANGELOG section for release-relevant changes;
- release-state diagnostics distinguishing missing local/remote version tags from tags that point to the wrong commit, including the required publication order;
- generated Cloudflare Worker types and strict TypeScript checking, including unused-local and unused-parameter rejection;
- syntax validation for every shipped JavaScript entry point;
- shared tool-catalog schema, annotation, and profile-inventory checks;
- hierarchical agent-context precedence, custom instruction ordering, local skill discovery/loading, command override/removal, direct argv argument handling, timeout ceilings, and execution-profile denial;
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
- real Ed25519 and RSA generation, idempotent reuse, public/private correspondence, mode enforcement, incomplete/mismatched/symlink rejection, and private-content non-disclosure;
- real-machine canonical-full sandbox acceptance for outside-workspace I/O, direct/shell execution, full environment inheritance, SSH prerequisites, temporary authorized-key writing, and detached cleanup without external state changes;
- deterministic injected atomic-replace failures and repeated Windows full-sandbox runs to catch transient file-sharing races;
- canonical named-profile repair and full-only tool exposure parity between local and Worker policy filters;
- managed-job staging/local approval/cancel-before-start, detachment, job-scoped temporary files, resource hash verification/redaction, discard capture, finally execution, cancellation escalation, plan scrubbing, and dead-runner recovery;
- daemon/startup locking and state corruption recovery;
- guarded state-root removal, schema migration, policy-origin persistence, and legacy implicit-default migration;
- no filename-based sensitive-file denial under unrestricted policy;
- log redaction, control-character handling, message/field bounds, suppression of both successful and failed per-tool events outside debug, service warning-level configuration, and idempotent bounded migration of legacy log formats;
- deterministic relay connection lifecycle coverage for transport construction/error/deadline, pre-handshake `welcome` validation, authenticated `hello_ack` readiness, identity/version mismatch, retryable Worker handshake errors, fatal protocol errors, autonomous outage-reminder backoff, handshake and heartbeat timeout, brief-outage suppression, sustained-outage escalation, recovery summaries, and supersession;
- shared no-follow bounded-file reads for normal files, over-limit data, directories, and symbolic links;
- CLI parsing, policy profiles, and client configuration boundaries;
- live stdio MCP initialization, discovery, calls, rich content, sessions, cancellation, managed-job acceptance, and a detached job/finally phase that survives stdio shutdown;
- live local Worker OAuth registration, consent, PKCE, token replay rejection, throttling, CORS, protocol negotiation, dynamic tool advertisement, rich content, daemon replacement, cancellation, malformed daemon JSON/non-object rejection, duplicate hello rejection, and unknown-message closure.

## Additional release checks

```sh
npm run worker:dry-run
npm audit --audit-level=high
npm audit --omit=dev --audit-level=high
npm audit signatures
npm sbom --sbom-format cyclonedx
npm pack --dry-run
npm run version:check
npm run release-impact:check
```

GitHub Actions executes the main suite on Linux, macOS, and Windows using the pinned Node 26/npm 12 baseline. Because Node 26 currently bundles npm 11, CI explicitly disables setup-node's automatic package-manager cache and upgrades npm from the runner temporary directory before any project-local npm command can trigger strict `devEngines`. Checkout fetches version tags so the release-impact gate can compare the branch with the latest release. A separate package-audit job audits both the complete dependency graph and the production-only graph, verifies registry signatures and attestations, validates a CycloneDX SBOM written under the runner temporary directory, exercises the documented isolated global installation, then performs a dry-run package build. The macOS matrix job also runs the installation smoke test because Wrangler's optional `fsevents` resolution is platform-specific. Dependency and GitHub Actions updates are monitored by Dependabot.

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

## Privacy hygiene

Run `npm run privacy:check` before committing and before packaging. Developers should maintain an ignored owner-only `.privacy-denylist` for machine aliases, usernames, internal codenames, and other private identifiers that a generic scanner cannot know. See [Repository privacy hygiene](PRIVACY.md).

## Package manifest

`npm run package:test` executes a real silent `npm pack --dry-run --json`, requires clean parseable JSON, rejects sensitive local artifacts and credential-like file classes, and verifies that privacy/engineering guidance, the runtime/relay/secure-file modules, contribution discipline, and privacy/release-impact checkers are present in the published package. `npm run install:test` packs the real tarball, installs it into an isolated global prefix with the documented npm 12 options, rejects blocked-script warnings, confirms optional `fsevents` is absent, and runs the installed CLI.

The stdio integration test also sends an oversized line, verifies bounded rejection, and confirms that the next valid request is still processed.

## Architecture and documentation regression checks

`npm run architecture:test` rejects local-module dependency cycles, missing relative imports, obsolete `LocalDaemon`/`daemon.mjs` naming, broken relative Markdown links, invisible ASCII control bytes in repository text, removal of the owner-required default-`full` engineering invariant, and accidental publication of `.project-local/` notes.
