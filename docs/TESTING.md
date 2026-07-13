# Testing strategy

The project treats transport, authorization, local authority, and state removal as separate failure domains.

## Required suite

```sh
npm run check
```

The repository requires Node.js 26 and npm 12. `.node-version`, `.nvmrc`, `packageManager`, `devEngines`, and strict engine checks keep local and CI execution on the same baseline.

The suite includes:

- release-impact enforcement requiring a new package version and CHANGELOG section for release-relevant changes;
- release-state diagnostics distinguishing missing local/remote version tags from tags that point to the wrong commit, plus a release-CI gate that rejects missing, pending, failed, pull-request-only, stale, or wrong-commit runs;
- generated Cloudflare Worker types and strict TypeScript checking, including unused-local and unused-parameter rejection;
- recursive syntax validation for every JavaScript file under the shipped/runtime/test roots plus the shell wrapper;
- shared tool-catalog schema, annotation, and profile-inventory checks;
- default working-agreement injection without user files, bounded automatic project metadata, script-body non-disclosure, user-global opt-out, repository opt-out rejection, global `model_instructions_file` injection in stdio/remote initialization, hierarchical precedence, `.agents/skills` and `.codex/skills` compatibility discovery, live project/skill rescanning and fingerprints, automatic task ranking/loading with English inflection normalization, bounded Chinese/English intent aliases, capability-name weighting, and selected-skill instruction loading; automatic `package.*` commands with English/Chinese workflow-intent matching and Windows command-shim execution, explicit command override/removal, direct argv handling, timeout ceilings, runtime-keyed routing-telemetry privacy, and execution-profile denial;
- concurrent complete-before-visible lock claims, atomic replacement under active readers, malformed-lock grace, snapshot/token-safe reclamation, absolute-age expiry, PID-reuse detection, and bounded startup-lock waiting;
- foreground takeover of active and orphaned background daemons, legacy lock identification from canonicalized process arguments, foreground-process protection, actual-PID exit waiting, POSIX non-escalating timeout behavior, Windows verified-daemon stop semantics, daemon lock mode/version/process-start metadata, launchd service-target semantics, and silent idempotent duplicate service starts;
- fail-closed service lifecycle ordering for provider-stop, all-workspace daemon-stop, and definition removal, including platform/daemon/removal failure injection and normalized macOS/systemd/Windows results;
- machine-level browser-broker ownership/client proxying, authenticated extension origin/subprotocol, non-cacheable local pairing, pairing-token non-disclosure, resource-backed upload routing, broker result redaction, pre-registered runtime-handshake listeners, bounded socket/HTTP waits, installed-application discovery caching, and name-based task matching;
- relay environment-proxy direct/bypass/agent selection, unsupported proxy rejection, fail-fast invalid configuration, and route observability without endpoint or credential disclosure;
- canonical path and symbolic-link escape tests;
- relative-path privacy and error-path redaction tests;
- atomic create/update, optimistic hash, exact edit, and patch transaction tests;
- patch ambiguity, canonical collision, rollback, move, and delete tests;
- UTF-8 and binary handling;
- image content formatting;
- nested Git repository detection and helper suppression;
- author-email privacy in `git_log`;
- isolated command HOME/temp/cache behavior;
- one-shot timeout, descendant process-group/tree termination including descendants that ignore graceful shutdown after the direct child has already exited, cancellation, and process-session interaction;
- layered fixed runtime diagnostics for filesystem, direct process, shell, managed-job storage, and resource availability;
- local resource CLI registration, permission checks, dynamic reload, state-path redaction, and content non-disclosure;
- real Ed25519 and RSA generation, idempotent reuse, public/private correspondence, mode enforcement, incomplete/mismatched/symlink rejection, and private-content non-disclosure;
- real-machine canonical-full sandbox acceptance for outside-workspace I/O, direct/shell execution, full environment inheritance, SSH prerequisites, temporary authorized-key writing, and detached cleanup without external state changes;
- deterministic injected atomic-replace failures, sustained transient Windows sharing contention beyond the old retry budget, bounded exponential delay selection, and repeated Windows full-sandbox runs;
- canonical named-profile repair and full-only tool exposure parity between local and Worker policy filters;
- managed-job staging/local approval/cancel-before-start, detachment, job-scoped temporary files, resource hash verification/redaction, discard capture, finally execution, descendant-tree escalation, token/snapshot-safe transition locks, runner process identity, plan scrubbing, PID-reuse-safe dead-runner recovery, and legacy PID-file compatibility;
- daemon/startup locking, successfully-read corrupt-JSON recovery, and explicit propagation/preservation of oversized, symbolic-link, permission, and I/O failures;
- guarded state-root removal, unsafe state-root/workspace overlap rejection before creation, all-profile lock/daemon scanning, schema migration, policy-origin persistence, and legacy implicit-default migration;
- no filename-based sensitive-file denial under unrestricted policy;
- log redaction, control-character handling, message/field bounds, suppression of both successful and failed per-tool events outside debug, service warning-level configuration, and idempotent bounded migration of legacy log formats;
- deterministic relay connection lifecycle coverage for transport construction/error/deadline, pre-handshake `welcome` validation, authenticated `hello_ack` readiness, identity/version mismatch, retryable Worker handshake errors, fatal protocol errors, autonomous outage-reminder backoff, handshake and heartbeat timeout, brief-outage suppression, sustained-outage escalation, recovery summaries, and supersession;
- shared no-follow bounded-file reads for normal files, over-limit data, directories, and symbolic links;
- CLI parsing, policy profiles, and client configuration boundaries;
- live stdio MCP initialization with session instructions, capability resolution, discovery, calls, rich content, sessions, cancellation, managed-job acceptance, and a detached job/finally phase that survives stdio shutdown;
- live local Worker OAuth registration, consent, URL-constructed `303` callbacks including the ChatGPT redirect URI and encoded state, PKCE, token replay rejection, throttling, CORS, protocol negotiation, daemon-backed session bootstrap, dynamic tool advertisement, rich content, daemon replacement, cancellation, malformed daemon JSON/non-object rejection, duplicate hello rejection, and unknown-message closure.

## Opt-in live desktop and browser validation

The normal suite uses deterministic mocks for macOS Accessibility and an authenticated in-process extension peer for browser routing. Browser contract tests cover acknowledged protocol readiness, provisional pairing commit/rollback boundaries, strict extension IDs and matching loopback ports, stale-extension rejection, compatible replacement without premature displacement, clean rejection of in-flight direct and proxied requests, keepalive handling, trusted-input replay prevention after partial dispatch, focus-safe screenshots, aggregate 64-frame/source/element budgets, bounded hostile DOM/text processing, contenteditable-secret suppression, partial-form failure reporting, stable refs, combined waits, and actionability failures. Before a release that changes local UI automation, run the macOS live smoke test on a machine where the invoking Node/terminal process has Accessibility permission:

```sh
npm run app-automation:live-test
```

It opens Calculator, activates it through the fixed JXA helper, verifies structured JSON output, inspects main-window Accessibility controls with menu recursion disabled, clicks the `One` control, and quits the application. It is intentionally excluded from CI because macOS TCC permission and a graphical login session are host state.

For deterministic release validation, perform an isolated-profile smoke test with the packaged unpacked extension; a Playwright persistent Chromium context is acceptable only as that isolated harness. When the requirement is specifically to prove control of the user's ordinary browser, the user must load the same unpacked directory into that known daily Chromium profile; status can verify the extension version/protocol and that Machine Bridge did not launch a browser, but cannot infer profile identity. Then use a localhost no-store fixture in a newly created tab. Do not enumerate, read, or mutate unrelated existing tabs. In both modes, inspect and reuse refs, exercise waits/forms/trusted input/open Shadow DOM/screenshots, verify final live DOM, and close the fixture tab.

## Additional release checks

```sh
npm run privacy:history
npm run worker:dry-run
npm audit --audit-level=high
npm audit --omit=dev --audit-level=high
npm audit signatures
npm sbom --sbom-format cyclonedx
npm pack --dry-run
npm run version:check
npm run release-impact:check
```

GitHub Actions executes the main suite on Linux, macOS, and Windows using the pinned Node 26/npm 12 baseline. Because Node 26 currently bundles npm 11, CI explicitly disables setup-node's automatic package-manager cache and upgrades npm from the runner temporary directory before any project-local npm command can trigger strict `devEngines`. Checkout fetches version tags so the release-impact gate can compare the branch with the latest release. A separate package-audit job scans reachable Git history, audits both the complete dependency graph and the production-only graph, verifies registry signatures and attestations, validates a CycloneDX SBOM written under the runner temporary directory, exercises the documented isolated global installation, then performs a dry-run package build. The macOS matrix job also runs the installation smoke test because Wrangler's optional `fsevents` resolution is platform-specific. Third-party Actions are pinned to immutable 40-character commit SHAs; architecture tests reject movable tags, and Dependabot monitors both action and dependency updates.

## Test design rules

- Tests should exercise the public boundary rather than only helper functions when practical.
- Lock, service lifecycle, state deletion, detached process, and credential changes require behavior-level concurrent or fault-injection coverage; source-string assertions are supplementary only.
- Every permission-expanding feature needs a denial test. Browser/application features also require a token/value/content non-disclosure assertion.
- Every bounded resource needs an over-limit test.
- Every multi-stage mutation needs a no-partial-commit test.
- Every remote call correlation change needs daemon replacement and cancellation coverage.
- Every durable workflow needs disconnect, cancellation, cleanup-failure, dead-runner, and plan-scrubbing coverage.
- Secret-bearing resource tests must assert absence of raw, path, base64, and hex forms from MCP-visible results.
- Logs and public metadata should be tested for absence of sensitive fields, arguments, outputs, and routine success noise—not only presence of expected fields.
- Cross-platform tests must avoid shell syntax, URL-path conversion, and executable-shim assumptions specific to one operating system.

## Privacy hygiene

Run `npm run privacy:check` before committing and before packaging. Run and review `npm run privacy:history` before release; local denylist findings may require an explicit owner decision because ordinary commits cannot remove public history. Developers should maintain an ignored owner-only `.privacy-denylist` for machine aliases, usernames, internal codenames, and other private identifiers that a generic scanner cannot know. See [Repository privacy hygiene](PRIVACY.md).

## Package manifest

`npm run package:test` executes a real silent `npm pack --dry-run --json`, requires clean parseable JSON, rejects sensitive local artifacts and credential-like file classes, validates every packaged mode as `0644` or `0755`, and verifies that privacy/engineering guidance, runtime/relay/secure-file/lock/service/browser/app modules, all package-script helpers, the packaged browser extension, contribution discipline, and privacy/release-impact checkers are present. `npm run install:test` requires npm 12, installs the real tarball from a package-free directory into an isolated global prefix with the documented options, verifies the packaged npm engine requirement, rejects blocked-script warnings, confirms optional `fsevents` is absent, and runs the installed CLI. The test runs on Linux, macOS, and Windows CI.

The stdio integration test also sends an oversized line, verifies bounded rejection, and confirms that the next valid request is still processed.

## Architecture and documentation regression checks

`npm run architecture:test` rejects movable GitHub Action references and loss of the CI history scan, release-gate script drift, local-module dependency cycles, missing static or dynamic relative imports, package scripts that reference missing files, drift from the recursive syntax scanner, incomplete executable package directories, inconsistent installation guidance, obsolete `LocalDaemon`/`daemon.mjs` naming, broken relative Markdown links, invisible ASCII control bytes in repository text, removal of the owner-required default-`full` engineering invariant, and accidental publication of `.project-local/` notes.
