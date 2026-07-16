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
- generated Cloudflare Worker types under ignored `.wrangler/` state and strict TypeScript checking, including unused-local and unused-parameter rejection; packaging rejects generated declarations;
- Conventional Commit title validation, shared Markdown escaping regression coverage, and generated MCP tool-reference drift detection;
- direct tests for shared project-metadata reads, strict integer normalization, plain-record classification, and canonical profile/Worker/job/lock inventory;
- recursive syntax validation for every JavaScript file under the shipped/runtime/test roots plus the shell wrapper;
- shared tool-catalog schema, annotation, and profile-inventory checks;
- default working-agreement injection without user files, bounded automatic project metadata, script-body non-disclosure, user-global opt-out, repository opt-out rejection, global `model_instructions_file` injection in stdio/remote initialization, hierarchical precedence, `.agents/skills` and `.codex/skills` compatibility discovery, live project/skill rescanning and fingerprints, automatic task ranking/loading with English inflection normalization, bounded Chinese/English intent aliases, capability-name weighting, and selected-skill instruction loading; automatic `package.*` commands with English/Chinese workflow-intent matching and Windows command-shim execution, explicit command override/removal, direct argv handling, timeout ceilings, runtime-keyed routing-telemetry privacy, and execution-profile denial;
- concurrent complete-before-visible lock claims, atomic replacement under active readers, malformed-lock grace, snapshot/token-safe reclamation, absolute-age expiry, PID-reuse detection, bounded startup-lock waiting, and wall-clock rollback injection proving duration deadlines remain monotonic;
- foreground takeover of active and orphaned background daemons with current service-lock metadata, foreground-process protection, bounded final lock-handoff retry, actual-PID exit waiting, POSIX non-escalating timeout behavior, Windows verified-daemon stop semantics, daemon lock mode/version/process-start metadata, launchd service-target semantics, and silent idempotent duplicate service starts; daemon fixture subprocesses intentionally do not inherit V8 coverage because their purpose is ownership timing rather than code measurement;
- fail-closed service lifecycle ordering for provider-stop, all-workspace daemon-stop, and definition removal, including platform/daemon/removal failure injection and normalized macOS/systemd/Windows results; Windows coverage reproduces an inline `/TR` command above 262 characters, proves the short launcher action remains bounded, verifies least-privilege logon registration, restart/log routing, language-independent `Ready`/`Running` observation, and state-observed stop/removal despite localized nonzero command output;
- private service-environment capture/load coverage for exact allowlisting, value bounds and control-character rejection, non-proxy secret exclusion, runtime-value precedence, Windows case-insensitive replacement, explicit empty-value clearing, and preservation across a later environment-free startup;
- machine-level browser-broker ownership/client proxying, authenticated extension origin/subprotocol, non-cacheable local pairing, pairing-token non-disclosure, resource-backed upload routing, broker result redaction, pre-registered runtime-handshake listeners, bounded socket/HTTP waits, frozen-wall-clock browser deadline coverage, installed-application discovery caching, and name-based task matching;
- Worker health direct/proxy routing through a real local HTTP CONNECT proxy, `NO_PROXY` bypass, exact `workers.dev` origin/name validation, redirect rejection, body/deadline bounds, error classification, bounded propagation retry, and invalid proxy fail-fast behavior without endpoint or credential disclosure;
- Worker deployment ambiguity/idempotency: a successful Wrangler result followed by health timeout persists the fingerprint, a second start performs no upload, an actual process restart and disk-state reload still performs no upload, definitive stale-version evidence redeploys under the same name, accidental name changes are rejected, forced replacements clear current endpoint state, and prior names remain in uninstall inventory;
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
- managed-job staging/local approval/cancel-before-start, detachment, job-scoped temporary files, resource hash verification/redaction, discard capture, finally execution, descendant-tree escalation, token/snapshot-safe transition locks, runner process identity, plan scrubbing, PID-reuse-safe dead-runner recovery, and rejection of numeric-only runner records;
- daemon/startup locking, successfully-read corrupt-JSON recovery, and explicit propagation/preservation of oversized, symbolic-link, permission, and I/O failures;
- guarded state-root removal, unsafe state-root/workspace overlap rejection before creation, all-profile lock/daemon scanning, strict current-schema validation, corrupt-JSON isolation, and policy-origin persistence;
- no filename-based sensitive-file denial under unrestricted policy;
- log redaction, control-character handling, message/field bounds, suppression of both successful and failed per-tool events outside debug, service warning-level configuration, current-schema reset, and bounded tail trimming;
- deterministic relay connection lifecycle coverage for transport construction/error/deadline, pre-handshake `welcome` validation, authenticated `hello_ack` readiness, identity/version mismatch, retryable Worker handshake errors, fatal protocol errors, autonomous outage-reminder backoff, handshake and heartbeat timeout, brief-outage suppression, sustained-outage escalation, recovery summaries, and supersession;
- shared no-follow bounded-file reads for normal files, over-limit data, directories, and symbolic links;
- owner-only directory enforcement rejecting final symlinks, failing closed on POSIX chmod errors, verifying `0700`, and retaining Windows portability; Worker temporary-secret lifecycle coverage for process-start-bound names, valid stale-owner reclamation, ambiguous-owner retention, `0600` mode, deletion failures, and simultaneous deployment/cleanup failures;
- SARIF security-gate behavior for unknown findings, exact accepted rule/path matches, path mismatch rejection, rationale quality, and exception expiry;
- deterministic property tests over hostile browser-protocol byte strings, canonical/custom policy combinations, argv bounds/NULs, and a real direct process proving shell metacharacters remain literal argv;
- prototype-shaped command, action, role, profile, form-field, keyboard, and resource names proving that inherited object properties are never interpreted as dispatch or authority; current-schema malformed OAuth roles are repaired to disabled reviewer accounts with credential revocation;
- canonical Worker deployment URL extraction proving unrelated `/mcp`, `/healthz`, path-bearing, and wrong-name URLs cannot be persisted as upload evidence;
- byte-exact UTF-8 DOM-source truncation across emoji and Chinese partial-code-point boundaries, including equality between the reported byte count and the encoded returned source;
- independently injected service CLI status/install/start/stop/uninstall/remove paths, including provider failure, no selected workspace, no deployed Worker, aliases, and default output/exit adapters;
- CLI parsing, policy profiles, and client configuration boundaries;
- live stdio MCP initialization with session instructions, capability resolution, discovery, calls, rich content, sessions, cancellation, managed-job acceptance, and a detached job/finally phase that survives stdio shutdown;
- live local Worker OAuth registration, the unauthenticated `resource_metadata` challenge, protected-resource and authorization-server discovery, Streamable transport metadata, consent, URL-constructed `303` callbacks including the ChatGPT and hosted Claude redirect URIs with encoded state, PKCE, `offline_access`, form-encoded authorization-code and refresh-token exchanges, access/refresh rotation, stale refresh replay rejection, account-version refresh revocation, authorization-code replay rejection, pending-registration throttling that excludes already authorized DCR clients, exact built-in ChatGPT/Grok browser origins, additive custom origins, unrelated-origin preflight rejection, no CORS response sharing for unrelated or opaque origins, opaque-origin authorization-form routing, exact per-request redirect-origin CSP with narrowly scoped Microsoft regional-consent and final Copilot Studio handoff exceptions, accessible credential-error rendering, protocol negotiation, HMAC-bound MCP session issuance, two-session same-id concurrency, sessionless same-id independence, session-scoped cancellation isolation, same-session duplicate rejection, daemon-backed session bootstrap, dynamic tool advertisement, rich content, daemon replacement, cancellation, malformed daemon JSON/non-object rejection, duplicate hello rejection, and unknown-message closure. The metadata/refresh contract is the path used by Claude DCR and Copilot Studio Dynamic discovery. The same integration runs an `editor` account against a canonical `full` daemon and proves that `server_info` and remote `project_overview` report effective `edit` authority while retaining the full daemon ceiling only in explicitly scoped fields.
- local runtime proof that one blocked tool handler does not serialize an independent handler, plus relay fault injection proving an undeliverable terminal result interrupts the ambiguous socket and enters reconnect backoff.
- a real headless-Chrome OAuth navigation regression with four cases: `form-action 'self'` blocks the first cross-origin callback, allowing only the registered callback blocks the regional redirect, allowing the registered and regional callbacks blocks the final Copilot Studio redirect, and the complete policy preserves `code` and `state` through all three cross-origin hops. Linux CI fails if Chrome is unavailable; other environments skip only this browser executable check while retaining the Worker CSP assertions.

## Opt-in live desktop and browser validation

The normal suite uses deterministic mocks for macOS Accessibility and an authenticated in-process extension peer for browser routing. Browser contract tests cover acknowledged protocol readiness, provisional pairing commit/rollback boundaries, strict extension IDs and matching loopback ports, stale-extension rejection, compatible replacement without premature displacement, clean rejection of in-flight direct and proxied requests, keepalive handling, trusted-input replay prevention after partial dispatch, focus-safe screenshots, aggregate 64-frame/source/element budgets, bounded hostile DOM/text processing, contenteditable-secret suppression, partial-form failure reporting, stable refs, combined waits, and actionability failures. Before a release that changes local UI automation, run the macOS live smoke test on a machine where the invoking Node/terminal process has Accessibility permission:

```sh
npm run app-automation:live-test
```

It opens Calculator, activates it through the fixed JXA helper, verifies structured JSON output, inspects main-window Accessibility controls with menu recursion disabled, clicks the `One` control, and quits the application. It is intentionally excluded from CI because macOS TCC permission and a graphical login session are host state.

For deterministic release validation, perform an isolated-profile smoke test with the packaged unpacked extension; a Playwright persistent Chromium context is acceptable only as that isolated harness. When the requirement is specifically to prove control of the user's ordinary browser, the user must load the same unpacked directory into that known daily Chromium profile; status can verify the extension version/protocol and that Machine Bridge did not launch a browser, but cannot infer profile identity. Then use a localhost no-store fixture in a newly created tab. Do not enumerate, read, or mutate unrelated existing tabs. In both modes, inspect and reuse refs, exercise waits/forms/trusted input/open Shadow DOM/screenshots, verify final live DOM, and close the fixture tab.


## Critical-module coverage gate

`npm run coverage:test` runs selected in-process and lightweight entrypoint fixtures under V8 coverage and enforces per-module function and branch baselines. The measured set now includes policy, typed errors, call registration, execution middleware, lifecycle/observability, logging, Runtime/CLI orchestration, the independently injected service CLI adapter, Agent configuration, capability ranking, browser protocol/operation boundaries, runtime reporting/diagnostics/capability composition, and Worker pending/policy/error modules. The full stdio and workerd OAuth/MCP integration still runs separately; a focused direct Node test covers `OAuthController` registration throttling, authorization failure/success, resource-bound access tokens, expiry pruning, invalid-state rejection, and identity-key failure.

The gate deliberately reports each module rather than one aggregate percentage. New extracted pure/domain modules carry explicit branch floors, while the broad CLI entrypoint remains reported and locked independently. Worker pending calls and policy now have branch minima instead of function-only gates. A refactor may raise a threshold, but must not lower one merely to make CI green without an explicit audit explanation.

`npm run typecheck` combines strict Worker TypeScript with a focused `tsconfig.local.json` gate. High-risk JavaScript contracts opt in with `// @ts-check` and JSDoc types; the gate currently covers policy, call lifecycle, Agent configuration/path resolution, browser handshake parsing, capability ranking, monotonic deadlines, number/record normalization, and bounded metadata reads. `@ts-ignore`, implicit `any`, or unchecked parallel contract shapes are not accepted as migration shortcuts.

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

GitHub Actions executes the main suite on Linux, macOS, and Windows using the pinned Node 26/npm 12 baseline. Because Node 26 currently bundles npm 11, CI downloads the exact npm 12.0.1 tarball from the canonical registry, rejects redirects, verifies its recorded SHA-512 SRI, and exposes that verified CLI through `GITHUB_PATH` before any project-local npm command can trigger strict `devEngines`. Checkout fetches version tags so the release-impact gate can compare the branch with the latest release. A separate package-audit job scans reachable Git history, audits both the complete dependency graph and the production-only graph, verifies registry signatures and attestations, validates a CycloneDX SBOM written under the runner temporary directory, exercises the documented isolated global installation, then performs a dry-run package build. Separate pinned workflows validate governance titles, review dependency changes, run CodeQL over JavaScript/TypeScript and GitHub Actions, and run OpenSSF Scorecard. The SARIF gate fails closed when rule metadata is absent, CodeQL permits only one exact, expiring non-shell process-boundary result, and Scorecard permits only exact reviewed governance/time-dependent findings; new dependency-pinning, fuzzing, or other supply-chain results fail before upload. Scorecard's signed analysis job contains only pinned `uses` steps, while a dependent gate job downloads the SARIF, enforces the accepted inventory, and uploads it to code scanning. Security property tests use a `.js` `fast-check` suite with deterministic seeds because the pinned Scorecard scanner recognizes JavaScript property testing only in `*.js`/`*.jsx`. The installed zero-argument startup smoke test also verifies that Windows creates and remembers `%USERPROFILE%\MachineBridge` while other platforms retain the package-free current directory. The macOS matrix job also runs the installation smoke test because Wrangler's optional `fsevents` resolution is platform-specific. Third-party Actions are pinned to immutable 40-character commit SHAs; architecture tests reject movable tags, and Dependabot monitors both action and dependency updates. Source release creation additionally requires successful push-triggered CI, CodeQL, Governance, and Scorecard runs for the exact `main` commit.

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

`npm run package:test` executes a real silent `npm pack --dry-run --json`, requires clean parseable JSON, rejects sensitive local artifacts, credential-like file classes, and generated Worker type declarations, validates every packaged mode as `0644` or `0755`, and verifies that privacy/engineering guidance, runtime/relay/secure-file/lock/service/browser/app modules, all package-script helpers, the packaged browser extension, contribution discipline, and privacy/release-impact checkers are present. `npm run install:test` requires npm 12, installs the real tarball from a package-free directory into an isolated global prefix with the documented options, verifies the packaged npm engine requirement, rejects blocked-script warnings, confirms optional `fsevents` is absent, verifies `--version`, then runs the installed CLI with zero arguments from an isolated workspace/state root. A fake Wrangler JavaScript entrypoint terminates at a controlled deployment boundary, so the probe executes default command normalization, state initialization, deployment fingerprint collection, and Wrangler dispatch without changing a live account; any undefined identifier or earlier crash fails the release. The test is part of `npm run check` and runs on Linux, macOS, and Windows CI.

`npm run lint` uses ESLint as a semantic JavaScript correctness gate rather than a style formatter. It covers the Node CLI/runtime, repository scripts, tests, and packaged browser extension and rejects undefined identifiers in function bodies that `node --check` cannot detect. A dedicated lint-gate self-test proves that both Node and browser configurations reject a synthetic undefined binding while accepting the service-worker `importScripts` global. A focused `shell:test` requires Wrangler to run through the current Node executable and its package JavaScript entrypoint rather than a `.cmd` or shell shim. Architecture tests require `shell:test`, `lint:test`, `lint`, and `install:test` to remain in the complete check pipeline and reject non-exact direct dependency ranges.

The stdio integration test also sends an oversized line, verifies bounded rejection, and confirms that the next valid request is still processed.

## Architecture and documentation regression checks

`npm run architecture:test` runs independent module-boundary, repository-hygiene, browser/security-structure, and release/documentation-contract checks. It rejects movable GitHub Action references and loss of the CI history scan, release-gate script drift, local-module dependency cycles, missing static or dynamic relative imports, package scripts that reference missing files, drift from the recursive syntax scanner, incomplete executable package directories, inconsistent installation guidance, obsolete `LocalDaemon`/`daemon.mjs` naming, broken relative Markdown links, invisible ASCII control bytes in repository text, removal of the owner-required default-`full` engineering invariant, and accidental publication of `.project-local/` notes.
