# Engineering and security audit

## 2026-07-17 version 1.2.2 relay-lifecycle and logging audit

The reported warning was the visible symptom of a call-lifecycle mismatch rather than a failed local tool. The Worker could remove a pending call after MCP cancellation, timeout, daemon disconnect, or client abandonment, while the local runtime still completed its asynchronous operation and entered one unconditional result-delivery path. When the original WebSocket had closed, the daemon emitted one `relay.tool_result.delivery_failed` warning per late completion. More seriously, if a replacement relay had already authenticated, the old result could be written to the new socket; the Worker rejected it because its pending record was socket-bound, but the local transport did not enforce the symmetric session boundary.

The correction gives each authenticated local relay connection a monotonically increasing in-memory generation and captures that generation with every incoming call. A result may be sent only through the generation that delivered the call. Explicit cancellation and relay disconnect also mark the eventual local result for disposal. Expected cancellation/disconnect/reconnect races are therefore debug-only `relay.tool_result.discarded` events, while a synchronous send failure on the still-current socket continues to invalidate the ambiguous transport and enter the ordinary outage state machine.

A second defect existed one layer earlier. The Worker already handled MCP `notifications/cancelled`, but an HTTP client that disconnected without sending that notification could leave the pending internal ID and session request-key index until the tool timeout. The pending-call registry now owns AbortSignal registration and cleanup atomically with its timer and indexes. The Worker deployment explicitly enables Cloudflare `enable_request_signal` and `request_signal_passthrough`, which are both required because the public Worker forwards the request into a named Durable Object. A deterministic registry test covers active and already-aborted requests; the complete local workerd suite continues to cover OAuth, explicit MCP cancellation, WebSocket routing, timeout, and socket loss.

Logging was reviewed as a user interface rather than a serialization dump. Human mode now uses the supplied natural-language explanation and omits the redundant stable event identifier; newline-delimited JSON retains that identifier for ingestion. Tool starts, outcomes, cancellation, timing, and late-result disposal remain debug-only. Worker observability adds an `unmatched_results` counter for a result that arrives after its pending record has been removed, preserving anomaly evidence without storing tool arguments, command text, paths, or result content.

The broader pass rechecked architecture boundaries, cancellation and reconnect branches, release/configuration contracts, privacy redaction, package version convergence, TypeScript and checked-JavaScript contracts, lint, Worker integration, and documentation drift. An additional deployment defect was found during fault reproduction: request cancellation support was implemented in code but the required Cloudflare compatibility flags were absent, so the signal could not reach the Durable Object in production. Architecture tests now make both flags non-optional. Version 1.2.2 retains local state schema 6 and policy revision 5; normal startup must converge the Worker and daemon versions, and the unpacked browser extension must be reloaded. No live deployment, credential rotation, global installation, daemon replacement, npm publication, tag, or GitHub Release is performed by this source change.

## 2026-07-16 version 1.2.1 fail-closed input-contract audit

The review began from clean `v1.2.0` with the complete repository gate, dependency audit, Worker dry run, and package checks passing. Hostile-input reproduction nevertheless found one shared JavaScript failure mechanism outside those gates: ordinary objects were being used as external string-key maps. Inherited names such as `constructor` and `__proto__` were therefore accepted as account roles, policy profiles, top-level commands, resource actions, and keyboard-table entries. The CLI variants could exit successfully without performing a command; a Worker account could persist an invalid role and later fail during authority calculation. Adjacent review found the same semantic hazard in form-field aggregation and valid local-resource names.

The correction removes prototype-chain semantics rather than blacklisting a few names. Command/action dispatch and role registries use `Map` or exact own-key membership; profile and availability contracts use explicit sets/own-key checks; URL-encoded bodies and normalized resource registries use null-prototype records. Regression tests exercise the standard prototype property names at every affected public boundary. A malformed role already persisted under the unchanged current OAuth schema is repaired in place to a disabled `reviewer`, its version advances, and all codes/tokens are pruned. This preserves an operator-recoverable account record while ensuring the upgrade cannot retain or expand authority.

The deployment review found a separate validation split: Wrangler output parsing accepted any HTTPS URL containing `/mcp` or `/healthz`, while the health verifier later required an exact root `workers.dev` origin matching the Worker name. Because successful upload evidence is intentionally saved before secondary verification, unrelated output could persist a URL/fingerprint pair that later starts would refuse to verify. Parsing and verification now share one canonical origin function; nonmatching, path-bearing, credential-bearing, ported, queried, or fragmented candidates are ignored and cannot mutate state.

The browser source limit had an encoding-level off-by-contract defect. Truncating raw UTF-8 bytes inside a code point and decoding non-fatally produced `U+FFFD`, whose re-encoded size could exceed both the returned count and caller budget. The serializer now backs off to the longest valid prefix and reports its actual encoded byte count. Emoji and Chinese fixtures cover every partial boundary and aggregate source budgeting.

Ordinary CLI branching was also brought back into the repository's own architecture standard. Browser actions were split into named handlers; service status/install/start/stop/uninstall/remove moved to an independently injectable adapter with complete action coverage and over ninety percent branch coverage. The former 580-line architecture test was separated into module boundaries, repository hygiene, browser/security structure, and release/documentation contracts. Source-string checks remain useful drift alarms, but the security and lifecycle claims above are enforced by executable behavior and fault-path tests.

Version 1.2.1 retains local state schema 6 and policy revision 5. Existing 1.2.0 state upgrades in place; the versioned Worker is converged by normal startup and the unpacked extension must be reloaded. Historical changelog and audit records remain as history, while obsolete runtime fallback semantics and stale migration wording were removed.

## 2026-07-16 version 1.2 trustworthy-evolution audit

The review began from clean released commit `58d54c21a0ac37f8e5f82a6f895738508efad0c6` (`v1.1.5`). The complete local gate, exact-commit Linux/macOS/Windows CI, CodeQL, Governance, and OpenSSF Scorecard were green; dependency audits reported zero vulnerabilities; and the GitHub Release asset, npm registry tarball, and a fresh local pack were byte-identical. That evidence ruled out an immediate release-integrity incident but did not answer whether the project could continue evolving safely: the main Worker, runtime, Agent-context, and browser-broker modules were all above ninety-seven percent of their own architecture limits, while high-authority local JavaScript had almost no static shape checking and several critical Worker modules had no branch floor.

The causal correction is responsibility extraction rather than a line-count shuffle. `OAuthController` now owns OAuth persistence, pruning, registration throttling, authorization UI/submission, account administration, exchange delegation, token verification, and its mutation queue. `LocalRuntime` delegates privacy-aware reporting, fixed diagnostics, and capability composition to dedicated services. Agent configuration/path validation and browser MCP action semantics moved into their own domain modules, leaving discovery and loopback transport with one reason to change. Architecture tests lower the old composition-root limits and independently cap every extracted module; source guards reject a return of OAuth, diagnostics, capability scoring, browser operation validation, low-level process, or patch responsibilities to the orchestrators.

Static assurance now follows authority rather than file extension. A focused strict checked-JavaScript gate covers local policy, call registration/cancellation, Agent configuration and path containment, browser handshake parsing, capability ranking, monotonic deadlines, basic normalization, and bounded metadata reads. Worker imports use explicit `.ts` specifiers and JSON attributes, allowing the same OAuth state machine to run directly under the pinned Node 26 baseline and under Wrangler. The new test reproduces registration throttling, invalid and valid authorization, HMAC source identity, resource-bound token authority, token expiry deletion, schema mismatch, and missing identity configuration. No `@ts-ignore`, implicit-`any` waiver, alternative TypeScript runtime, or duplicate test-only implementation was introduced.

Risk-directed coverage now includes the extracted Agent, browser, and runtime services. The runtime composition root rose to roughly eighty-one percent function and sixty-five percent branch coverage; reporting, diagnostics, and capability composition have independent thresholds; Worker pending calls and policy gained branch floors. A new lint pass found thirty-eight concise Promise executors that accidentally returned timer/listener handles and one cleanup throw inside `finally`; all were corrected rather than excepted. The first remote CodeQL pass then found four extraction leftovers; they were removed and `no-unused-vars` became a local failing gate so this class no longer waits for remote analysis. The cleanup test now records a final best-effort deletion failure without replacing the primary browser-test result.

Upgrade safety is intentionally current-only. Version 1.2 retains local state schema 6 and policy revision 5, and does not alter OAuth record formats, resource registrations, managed-job envelopes, Worker identity, or browser pairing. A normal 1.1.5 installation therefore upgrades in place; unsupported older schemas remain rejected rather than guessed. The new upgrade document defines the daemon/Worker/extension as one rollback unit and prohibits hand-editing version fields. No npm publication, Worker deployment, credential rotation, global installation, or live service replacement was performed during source work.

The remaining controls cannot be completed honestly by repository automation alone. npm trusted publishing needs the package owner's external OIDC trust configuration and protected publication environment. Independent review needs a second active human maintainer. Governance now defines admission, succession, and the exact protected paths that must require non-author and last-push approval once that person exists; the existing expiring Scorecard exceptions remain visible until those external conditions change.

## 2026-07-16 Windows autostart, restart, and workspace-identity incident

The reported transcript combined two distinct questions that the previous Worker fix did not answer. The first ordinary `machine-mcp` invocation addressed the remembered workspace, while the next command explicitly supplied another `--workspace`. Machine Bridge intentionally assigns one profile and one Worker to each canonical workspace, so that sequence is not by itself evidence that a retry duplicated the same resource. The existing deployment code did persist successful Wrangler evidence before health verification, but its regression reused one in-memory object. The new test performs an actual atomic state write, reconstructs state from disk as a new process would, repeats an ambiguous timeout, and proves Wrangler deploy is still called exactly once. Documentation now requires comparing canonical workspace, profile, Worker name, and URL before deleting any apparent duplicate.

The Windows autostart warning was a separate confirmed defect. The adapter placed the complete Node executable, globally installed CLI entrypoint, workspace, state root, and logging arguments in `schtasks /TR`. Representative installed paths exceed Task Scheduler's 262-character action-path boundary, so task creation could fail consistently even though foreground relay startup succeeded. The generic startup warning discarded the provider reason, and `service status` compounded diagnosis by equating a successful task query with a running task. Stop and removal also depended on English fragments in `schtasks` output, which is invalid on non-English Windows.

Windows now stores the long invocation in a private state-root launcher and registers only that short launcher path. The launcher uses bounded fixed arguments, redirects to the standard service logs, exits after a successful daemon exit, and restarts a nonzero exit after five seconds. Registration uses the current user and `LIMITED` run level. Creation, start, stop, and removal are accepted only after fixed PowerShell object queries observe the actual Task Scheduler state and last result, so localized text is not a control signal and an installed `Ready` task is no longer reported as active. Tests reproduce an inline action above 262 characters, verify the replacement action is below the limit, exercise running/completed states, and inject localized nonzero command output.

A third lifecycle gap explained why a foreground connection repaired by PowerShell `$env:` variables could fail after reboot. Login managers do not preserve that terminal's process environment. Autostart installation now snapshots only an explicit proxy/custom-CA allowlist into private local state; `--daemon-only` fills missing runtime variables from that snapshot. A later environment-free startup preserves the snapshot, case-insensitive replacements remove stale Windows variants, explicit empty values can clear settings, and status/logging reveal only key names. Tests prove unrelated secret variables are excluded and values are bounded and control-character safe. A proxy URL may contain credentials, so the snapshot is treated as sensitive state rather than a service-definition or log field.

The resulting reboot contract is intentionally narrower than “available before anyone logs in.” The Windows task is `ONLOGON`: after the configured user signs in, no terminal action is required and the launcher self-recovers nonzero daemon exits. Pre-login operation would require a materially different Windows service account, stored-credential, or `SYSTEM` boundary and is not silently introduced. The audit also identified the exposed one-time owner password in the supplied screenshot as compromised operational output; CLI guidance now warns against sharing credential-bearing terminal output, but the affected account must be rotated by the operator because repository changes cannot revoke a displayed live credential.

Dependency review found no npm audit findings in either the complete or production graph. Two exact patch pins were stale: `ws` contained a fragment-limit correction and Wrangler carried a newer `workerd` plus unrelated tooling changes. Both pins were updated, the exact install-script allowlist was advanced to the reviewed `workerd` build, and the full packaging/install/Worker suites remain the acceptance boundary rather than treating “latest” as sufficient evidence.

## 2026-07-15 Windows Worker deployment convergence incident

A Windows report showed Wrangler creating a Worker successfully, followed by `Worker deployment did not become healthy at the expected version: timeout`. Re-running startup, and then changing the name to a suffixed `-r2` variant, left multiple Workers in the Cloudflare account. The causal defect was not Worker creation itself: Wrangler and the long-lived relay already followed standard proxy routing, while the independent health verifier used a direct global `fetch`. On networks where outbound HTTPS required an environment proxy, deployment could succeed and health verification could time out.

The state transition amplified that routing split. The previous path removed or withheld the deployment fingerprint until `/healthz` succeeded. A successful remote write followed by an ambiguous read therefore looked identical to “not deployed” on the next start and caused another Wrangler upload. Supplying another `--worker-name` made the effect more visible by asking Cloudflare for a distinct resource; Machine Bridge did not generate the suffix automatically, but it also did not guard that identity change.

The correction separates upload evidence from verification evidence. `worker-deployment.mjs` persists the detected URL, exact content/secret fingerprint, deployed package version, and timestamp immediately after Wrangler success. `worker-health.mjs` accepts only the recorded HTTPS `workers.dev` origin matching the Worker name, rejects redirects, and performs the bounded request through the same reviewed proxy resolver used by the WebSocket path, with response-size and deadline limits. A subsequent timeout, proxy/TLS/network fault, or temporary 5xx now returns an actionable verification error while preserving the fingerprint, so the next start performs a read-only verification. Persistent version/identity mismatch or `404`/`410` is retried for propagation and is the only automatic same-name redeployment trigger.

Existing Worker names are stable. A different `--worker-name` is rejected unless `--force-worker` explicitly authorizes an identity replacement; the prior validated name is retained in bounded uninstall inventory. The test reproduces the original network topology with a real local CONNECT proxy and an otherwise unresolvable hostname, proves one deployment across repeated health timeouts, proves stale-version convergence, and covers accidental/intentional name transitions. Coverage gates now include the extracted proxy, health, and deployment modules and raise the remaining CLI floors. Live duplicate deletion remains an operator decision because repository code cannot safely infer which pre-fix Worker is externally referenced.

## 2026-07-15 hosted-client OAuth interoperability audit

The Claude and Microsoft Copilot Studio request was first tested against the existing protocol boundary rather than implemented as a brand allowlist. Both clients already use the deployed Streamable HTTP endpoint; the material gap was token continuity. Anthropic's connector contract advertises `offline_access`, performs form-encoded refreshes, and requires public-client refresh-token rotation. Copilot Studio's recommended Dynamic discovery path likewise discovers DCR/OAuth endpoints and exchanges refresh tokens. Adding browser origins alone would not implement either contract: Claude remote connectors originate from Anthropic cloud infrastructure, while Copilot Studio uses Power Platform connectivity. The fixed ChatGPT/Grok browser CORS set therefore remains unchanged.

The Worker now advertises the refresh grant and `offline_access`, stores only hashes of access and refresh tokens, and rotates every refresh token in one Durable Object write with the associated access-token update. Refresh records live under a separate versioned storage key, preserving the current primary OAuth-store schema and avoiding a destructive live migration. Refreshes remain bound to client, account, account version, role, normalized scope, resource, and deployment token version. Old-token replay and account-version changes return `invalid_grant`; account suspension, role/password changes, removal, and global token-version rotation cannot extend authority through refresh. Because both hosted clients may create a new DCR client for a fresh connection, the source throttle now counts only registrations that have not completed authorization; the global retained-client bound is unchanged.

The workerd integration proves the hosted Claude callback, the unauthenticated `resource_metadata` challenge, discovery metadata, DCR grant advertisement, `offline_access`, form-encoded refresh, access/refresh replacement, replay rejection, continued MCP use with the refreshed access token, and targeted account refresh revocation. A live Copilot Studio connection exposed an additional browser boundary: Power Platform redirects the validated global `consent.azure-apim.net` callback to a regional subdomain, while Chromium enforces the originating authorization page's `form-action` policy across that redirect chain. The Worker therefore adds the Microsoft consent-subdomain source and the exact Copilot Studio origin only when the already validated redirect URI is itself on that HTTPS domain; all other clients retain the exact-origin policy. Power Platform data policies, plan availability, tenant administration, and host-side tool filtering remain external controls.

This document records the cross-cutting audit initiated for version 0.12.0, its later architecture, browser, lifecycle, authorization, release-gate, and version 1 follow-ups, including the version 1.0.2 elapsed-time review and the version 1.0.3 code-scanning inventory correction. It complements, but does not replace, the continuously enforced contracts in `SECURITY.md`, `docs/ENGINEERING.md`, and the test suite.


## 2026-07-14 version 1.0.3 code-scanning and supply-chain gate audit

After npm 1.0.2 and the live Worker/daemon upgrade succeeded, GitHub still reported nine open code-scanning alerts on the exact released `main` commit: one current CodeQL command-boundary result and eight OpenSSF Scorecard results. This disproved the earlier assumption that green CodeQL and Scorecard jobs implied a clean code-scanning inventory. The CodeQL analysis API reported one result, while the repository gate reported zero because the SARIF emitted to the post-analysis step omitted `tool.driver.rules`; the gate treated missing rule metadata as proof that a result was non-security. Scorecard had no gate at all and uploaded every low-score result while the workflow remained successful.

The process boundary now routes through an isolated `node:child_process.spawn` call that copies only four allowed options, enforces final `shell: false`, and has a production-path metacharacter regression. CodeQL 2.26.0 nevertheless classifies the environment-derived executable path as a shell-command sink even though no shell interprets either the executable or argv. After reproducing the complete flow and eliminating ambiguous option propagation, the repository retains one exact rule/path exception with a short expiry rather than broad command-execution suppressions. The SARIF gate now fails closed for every result whose rule metadata is absent. The same gate runs on Scorecard output before upload. Four remediable Scorecard findings are addressed: source bootstrap uses `npm ci`; CI obtains npm 12.0.1 from an exact registry URL, rejects redirects, verifies a pinned SHA-512 SRI, and exposes the verified CLI without a mutable global install; and the randomized security suite now uses deterministic `fast-check` properties in a `.js` file, matching the pinned Scorecard v5.3.0 detector's `*.js`/`*.jsx` scope. The Scorecard action remains in a signed analysis job containing only pinned `uses` steps; a dependent gate job downloads its SARIF, enforces the accepted inventory, and uploads the reviewed result.

Four Scorecard findings remain explicitly reviewed rather than hidden: the repository is younger than ninety days, historical commits predate mandatory CodeQL, only one human maintainer is available for review, and OpenSSF Best Practices enrollment requires external maintainer attestations. Their exact rule/path exceptions carry short expiry dates, while `PinnedDependenciesID` and `FuzzingID` are forbidden from the accepted inventory. Release orchestration now verifies successful push-triggered CI, CodeQL, Governance, and Scorecard runs for the exact `main` commit instead of checking only the CI workflow. This closes the semantic gap between “a workflow ran” and “the security/governance evidence required for release passed.”


## 2026-07-14 version 1.0.2 elapsed-time and documentation-integrity audit

The review began from exact released commit `10931c11d7cdab1051018059fc461b73bb5505ff` (tag and npm version 1.0.1), with a clean worktree, zero high-severity npm audit findings, no open issue or pull request, and successful required Linux, macOS, Windows, governance, CodeQL, dependency-review, and Scorecard checks. The threat-model pass separated persisted wall-clock facts—token expiry, file age, retention, alarms, and operator timestamps—from in-memory elapsed durations.

A confirmed lifecycle defect remained across otherwise bounded code paths: startup-lock acquisition, verified daemon takeover/stop, process-session exit waits, managed-job recovery-lock release, full-access diagnostics, and browser/page waits calculated deadlines from `Date.now()`. A backward system-clock correction could extend those state machines beyond their documented maximum, while a forward correction could trigger premature timeout. Application-discovery cache freshness and local/Worker duration metrics had the same clock-domain error, with lower impact. One shared Node monotonic-deadline primitive now owns bounded elapsed waits; browser contexts use their native monotonic `performance.now()`. Persisted timestamps deliberately remain wall-clock based. Deterministic tests freeze or roll back wall time while exercising the real startup-lock and extension wait paths, and the shared helper clamps anomalous backward samples.

The same review confirmed architecture-documentation drift introduced by earlier releases. The document still named state schema 5 after schema 6, described OAuth tokens as lacking independently authorized human principals after named accounts and roles shipped, scoped duplicate request IDs to an entire access token after signed MCP sessions shipped, and listed per-principal authorization as absent. The corrected model distinguishes named application-level account principals and targeted revocation from OS/browser-profile tenancy: all authorized accounts still converge on one daemon, workspace, browser profile, and local OS user. Architecture tests now reject the obsolete statements.

External comparison retained the existing conservative product boundary. Current MCP authorization and security guidance supports exact redirect/resource binding, PKCE S256, server-side authorization, and no token passthrough; the implementation already enforces those controls. Browser projects that expose arbitrary page scripts were not copied because Machine Bridge intentionally restricts callers to packaged structured operations. Remaining limits are explicit: a same-user malicious process, MCP host filtering, browser/OS enforcement, Cloudflare lifecycle behavior, and live deployment state are outside repository-only guarantees.


## 2026-07-14 version 1.0.1 installed-startup incident

Version 1.0.0 passed the complete repository suite, three operating-system CI jobs, package manifest inspection, and a real isolated global installation, but the installed CLI failed immediately on the documented zero-argument command with `readdirSync is not defined`. The direct cause was a missing `node:fs` import in a function reached only while hashing Worker deployment inputs. The installation smoke test invoked only `--version`, which loaded the module but did not execute the default startup function body; `node --check` validates syntax, not lexical name resolution inside unexecuted branches. A second scan found another latent missing import, `inspectProcessInstance`, in secret rotation.

The correction uses independent evidence layers. ESLint now rejects undefined bindings across Node production code, scripts, tests, and browser-extension code. The real-tarball installation test still verifies package layout and documented npm options, but now replaces only the isolated package's Wrangler JavaScript entrypoint with a deterministic failing executable and starts the installed CLI with no arguments from a package-free workspace and private temporary state root. Success means the process initializes current state, computes the packaged Worker fingerprint, and reaches the controlled Wrangler boundary without `ReferenceError` or any `is not defined` failure. Existing workerd/WebSocket and runtime integration tests continue from that external boundary through authenticated readiness. Both gates are part of `npm run check`, prepublish validation, and every supported OS matrix job; architecture tests reject their removal.

The first Windows run of the new gate found another real production defect: `runWrangler` selected `wrangler.cmd` and passed it to `spawn` with `shell: false`, which Node 26 rejected with `EINVAL`. Runtime execution now uses the current Node binary plus `node_modules/wrangler/bin/wrangler.js` on every platform. This keeps the shell-disabled execution invariant while avoiding platform command-shim semantics; a focused command-boundary test and the final-artifact startup probe enforce the choice.

The incident establishes a release rule: entrypoint existence, module import, `--help`, or `--version` are not startup evidence. Every user-documented primary command must be executed from the final packed artifact far enough to cross its composition root and reach either a verified ready state or a deliberately controlled external boundary.

## 2026-07-14 version 1.0 security-boundary audit

The 1.0 review began from a clean `0.18.1` main branch whose complete local suite and required GitHub checks passed. The green status was incomplete evidence: GitHub still contained open CodeQL findings because the workflow uploaded SARIF but did not fail on security results. The review separated real path races and one lifecycle defect from intentional high-authority process boundaries and static-analysis noise.

State, service-log, managed-job diagnostic, privacy-scan, and owner-only file operations now open the target directly with no-follow flags where supported, validate the opened descriptor as a regular file, bound work before allocation, and apply modes through that descriptor. SSH inspection snapshots key bytes into a private temporary directory before invoking `ssh-keygen`, then verifies that the original identity and bytes remain unchanged. These changes remove the check/use split without claiming protection against hostile same-user replacement of parent directories on platforms lacking descriptor-relative traversal.

A dormant recovery-safety helper exposed a concrete lifecycle defect: after recovery-lock ownership was handed from the coordinator to a detached runner, the runner removed the path unconditionally instead of verifying the handed-off token. Recovery now uses the existing snapshot/token-aware removal primitive and records a fatal recovery error if ownership cannot be proved. Numeric-only lock content is treated as malformed current state rather than interpreted as a compatible owner.

The process boundary now distinguishes fixed executable plus argv invocation from explicit shell execution. Direct calls reject NULs and oversized executable/argv input and use `spawn(..., { shell: false })`; `exec_command` remains an explicit canonical-full shell capability and is documented as local-user authority. CodeQL exceptions for these intentional boundaries are exact rule/path records with rationales and expiry dates. The CodeQL workflow now parses generated SARIF and fails on every other security-tagged result, preventing a successful analysis upload from masquerading as a clean security gate.

The public contract is current-only: MCP `2025-11-25` is the sole advertised protocol. Existing current-schema local state remains usable, so upgrade safety is provided by bounded daemon/Worker version convergence and exact browser-extension version handshakes rather than by retaining obsolete protocol or lock interpretations. Randomized protocol, policy, argv, and real no-shell-evaluation tests supplement deterministic state-machine and cross-platform integration coverage.

A follow-up control-plane and credential-lifecycle review found four issues outside the original concurrency report. The repository already prohibited hosted GitHub connectors, but that rule was available only after project context loading; shared initialization and built-in instructions now state the fail-closed local `git`/`gh` rule before any GitHub operation. `ENGINEERING.md` and `CONTRIBUTING.md` also contradicted the newer source-release contract by assigning tags and GitHub Releases to the human operator; all normative files now distinguish automated GitHub source completion from explicitly authorized npm and live-machine operations.

Owner-only directory enforcement previously swallowed `chmod(0700)` failures on every platform and accepted a final symlink path, allowing state, job, service-log, or temporary-secret storage to continue without a proven private directory. The shared secure-file boundary now rejects symlinks/non-directories, fails closed on POSIX permission errors, verifies that group/other bits are clear, and tolerates unsupported chmod semantics only on Windows. Worker deployment temporary-secret cleanup was extracted from the CLI: filenames now bind process-start identity, stale cleanup deletes only positively reclaimable owners, ambiguous live identities are retained, and removal failures are surfaced. The previous stale-secret test used a non-hex suffix that did not match the production filename parser and therefore exercised no cleanup branch; a dedicated lifecycle test covers valid names, permissions, reclaimability, ambiguity, deletion failure, and dual primary/cleanup failure.

The follow-up then traced the same invariant through adjacent modules. Browser pairing now restricts an already-existing permissive state root before writing its bearer token. Managed-job runner-log trimming ignores only `ENOENT`; other failures block launch, and a large-log fixture proves bounded tail retention. Workspace atomic writes and patch transactions no longer swallow POSIX chmod failures before commit. Recursive state-root validation no longer treats unreadable or malformed config/profile/lock data as “not a workspace”; these conditions block deletion. Finally, the audit removed an unused error factory and account-role constant and narrowed internal-only exports, reducing accidental module surface without changing the package CLI contract.

A subsequent Windows PR run reproduced a longer `EPERM` sharing interval in the existing concurrent-reader atomic-replacement fixture. The prior 16-attempt budget was therefore not a sufficient platform boundary even though the same test had passed earlier runs. The default remains bounded and preserves atomic rename semantics, but now allows 32 attempts; deterministic testing requires success after 24 consecutive classified failures before the 25th attempt.

A multi-window concurrency report exposed a correlation defect rather than an execution-capacity limit. The Worker admitted 32 calls and the local runtime admitted 16, but pending-call keys used only OAuth token plus JSON-RPC id. Independent ChatGPT windows commonly reuse small numeric ids, so a second window was rejected before relay and the ordinary internal-error redaction made the failure look like a local execution outage. Version 1 issues stateless HMAC-bound MCP session ids and keys cancellation by token, session, id type, and id value. Real workerd tests run two sessions with the same id concurrently, prove sessionless POST independence, and prove cancellation isolation. A separate fault was fixed by interrupting the relay whenever a completed terminal result cannot be delivered, ensuring socket cleanup releases pending records instead of waiting for the configured tool timeout.


## 2026-07-13 runtime-boundary and lifecycle follow-up

This review confirmed that earlier safety controls existed but were distributed across duplicated policy checks, transport-specific pending maps, message-regex errors, and oversized composition files. It reproduced a production-visible Worker defect where a completed client JSON-RPC request key could remain indexed and cause unrelated later calls to fail as duplicate in-flight IDs. Pending calls now use one atomic double-index registry whose terminal `take` operation clears the internal ID, request key, and timer before resolution or rejection; success, daemon error, cancellation, timeout, send failure, and socket loss have behavior coverage.

Policy revision 5 supplies one authorization contract to the local runtime, Worker role intersection, and manager-level checks. The audit found a concrete compound-ACL error: `start_job` was advertised by direct-exec alone even though it creates persistent files. It now requires write plus direct execution; read-only job/resource inspection no longer inherits mutation requirements. Typed errors, shared middleware, explicit runtime lifecycle, process ownership, structured JSON logs, and local/Worker metrics replace ad hoc message parsing and invisible pending state.

The composition roots were reduced by extracting filesystem, process, Git, CLI parsing/admin, ranking, managed-job validation, browser protocol/pairing, Worker HTTP, OAuth, policy, errors, pending calls, and observability. Executable architecture limits prevent these responsibilities from returning. During extraction, a missing local ESM binding was initially hidden by a broad catch and surfaced only as `resource_unavailable`; the catch now rethrows unknown faults, and the stdio generated-resource test exercises the complete state reload path.

Coverage review showed that a large test count had hidden weak orchestration coverage. CI now reports and enforces per-module baselines, while pure policy/CLI/ranking/state modules receive direct branch tests and Worker behavior still runs through workerd. Generated policy documentation eliminates a second hand-maintained ACL description.

## 2026-07-13 daily-browser and cross-platform hardening follow-up

The review first distinguished installation from actual connectivity. The user identified the target as their ordinary Chrome profile and manually loaded the unpacked extension there; it was initially unpaired. After opening the genuine loopback pairing page, a localhost-only live fixture verified that this connected Chrome instance could create and close a real tab, return semantic snapshot refs, traverse an open Shadow DOM, fill a multi-field form, issue trusted text and pointer input, wait for final DOM state, and capture a screenshot without reading unrelated tabs. The product now states the narrower machine-verifiable fact: Machine Bridge does not launch a browser, but an extension cannot infer whether its host profile is the user's daily or isolated profile.

Fault injection then found several state-machine issues that a success-only smoke test could not reveal. WebSocket `open` was treated as extension readiness before protocol validation; pairing state was written before the candidate authenticated; `input_mode: auto` replayed a DOM action after any DevTools failure even when an Input command might already have taken effect; screenshot capture focused the browser window and did not restore the previous active tab; navigation wait used a hidden 30-second deadline independent of the request; and replacement could leave direct/proxied requests pending. Protocol 3 now requires `hello`/`hello_ack` with exact packaged-version/capability equality, persists pairing only after acknowledgement, validates a canonical extension ID plus matching loopback ports, propagates the request deadline, rejects ambiguous post-dispatch retries, restores tab state without stealing focus, and fails interrupted routes with retry guidance.

Hostile-page analysis found that previous limits were result limits rather than work limits: every frame received the full source/element allowance, `outerHTML` was built before truncation, interactive elements and Shadow roots were fully enumerated before slicing, page-controlled strings were not uniformly bounded, and whole-page `innerText` was materialized for waits. Version 0.15.0 applies aggregate budgets across at most 64 frames, uses iterative bounded DOM serialization, limits each page scan to 100,000 nodes, reusable refs to a 10,000-entry LRU, and text search to 2 MiB, bounds metadata, removes URL userinfo, treats secret-like contenteditable controls as sensitive, and reports truncation explicitly. Multi-field failures now identify possible earlier mutations without returning values.

The extension architecture was also corrected: the service worker now owns only pairing/transport/readiness/cancellation/response routing, while fixed `browser-operations.js` owns tab and page orchestration. An executable line-count invariant prevents those concerns from silently merging again. Outside the browser path, the review found that Windows Scheduled Task command construction did not implement CRT backslash-before-quote rules; drive-root or trailing-backslash arguments could be misparsed. A dedicated quoting primitive and platform regression test correct that boundary.

The same pass rechecked Worker OAuth/PKCE, registration/code/token limits, process sessions, managed jobs, state deletion, log redaction/rotation, package contents, dependencies, open issues, and current CI. No additional high-impact code change was justified in those areas. Their documented residuals remain: canonical `full` intentionally exposes the local user's authority, service logs are trimmed at startup rather than continuously, and same-user malicious code or an MCP host can still operate outside Machine Bridge's control.

## 2026-07-13 architecture and automatic-routing follow-up

A new behavior-level review found that the existing global/project instruction path was functioning, but three gaps explained weak user-visible automation: direct `.codex/skills` compatibility depended on user-created symlinks, root package scripts were described but not executable through the registered-command surface, and the runtime provided no proof that the host had called bootstrap or task resolution. The review added direct compatibility roots, bounded automatic package commands, and privacy-preserving routing telemetry while retaining the host/model invocation boundary.

The review also reproduced a lifecycle defect not covered by the previous descendant test: when a direct child exited after group `SIGTERM` while a detached-stdio descendant ignored the signal, `runProcess` cleared the pending `SIGKILL` escalation and left the descendant alive. Timeout/cancellation/replacement now use one escalation primitive whose forced phase remains referenced independently of direct-child tracking. A dedicated real-process regression covers that exact ordering.

Relay routing now honors standard HTTP(S) proxy environment variables and `NO_PROXY`, rejects invalid/unsupported proxy configuration before reconnect, and exposes only coarse route state. Package metadata parsing and capability observation were extracted from orchestration code, and architecture tests now reject domain-to-adapter imports.

A real macOS stdio smoke test used the user's actual global instructions, repository instructions, installed skills, package scripts, and installed applications with an isolated temporary state root. Initialization advertised 49 tools and contained all four instruction layers. A Chinese skill-creation task selected `skill-creator` at score 16 and loaded 22,047 bytes of instructions; 42 automatic package commands were discovered and `package.version-check` executed with exit code 0; 100 applications were discovered, `Chess` matched at score 15, opened in the background, was observed running, then quit cleanly. Capability telemetry recorded bootstrap plus three task resolutions without retaining raw task text.

The same review reproduced two daily-use ranking failures before the fix: Chinese tasks did not match English skill metadata, and an English skill-creation request tied several generic “create” descriptions and selected `frontend-design` alphabetically. Cross-platform CI then exposed a separate Windows execution defect: automatic commands spawned `npm` as if it were a native executable, but Windows provides `npm.cmd`, producing `spawn npm ENOENT`. Windows package commands now use one fixed command-shell wrapper built from allowlisted manager and validated script names. Bounded bilingual intent normalization plus capability-name weighting corrected both cases. Residual limits remain external: the MCP host can filter initialization instructions or tools, a package manager can execute arbitrary repository script bodies, HTTP(S) proxy support is not SOCKS support, and OS process-tree guarantees remain platform dependent. In the observed remote ChatGPT path, the 0.12.2 relay advertised 49 tools while the host made only 11 available to this conversation, demonstrating that server-side discovery cannot by itself guarantee host invocation.

## 0.12.2 follow-up findings

The failed `0.12.1` workflow had two independent causes. Windows exhausted the old approximately half-second atomic-replacement retry window while a stress reader repeatedly held the destination open. Linux and macOS lost an immediately emitted browser runtime `hello` between awaiting `open` and registering the message listener, then waited without a deadline until the 20-minute job timeout. The fixes preserve atomic replacement, extend only classified transient retries, pre-register the browser handshake listener, bound all relevant HTTP/WebSocket waits, and terminate failed proxy candidates.

The review also found three governance gaps not represented by the original failure message:

- GitHub Releases could be created from a local pass while the exact cross-platform push CI was failing. Publication now requires successful exact-commit push CI before tagging or release verification.
- Workflow actions used movable major-version tags. They are now pinned to immutable official commit SHAs, with an executable invariant.
- Repository privacy checks covered only the current tree. Package audit now scans reachable historical paths, bounded UTF-8 blobs, and commit messages; deleted credential fixtures fail without echoing their values.

No generic active credential pattern was found in the current tree or reachable history after excluding standard public automation trailers. The developer-local denylist does match historical identifiers, and the Git metadata audit found an older non-noreply author/committer identity. These are identity/privacy metadata rather than active credentials. Removing them would require a coordinated history rewrite and force-update of affected refs, which is intentionally not performed as an incidental code fix.

## Scope

The review covered:

- CLI startup, foreground/background takeover, state locks, service installation/removal, and full uninstall;
- canonical paths, state-root deletion, atomic persistence, symbolic links, permissions, and process identity;
- daemon/Worker transport, OAuth, relay replacement, request limits, and failure reporting;
- direct processes, shell execution, interactive sessions, managed jobs, cancellation, recovery, and cleanup;
- browser pairing, broker authentication, uploads, DOM actions, local application automation, and sensitive fields;
- logging, privacy scanning, package contents, release scripts, documentation consistency, CI, and dead code.

The audit used source review, state-machine analysis, hostile-input tests, concurrent-process fixtures, process-tree fixtures, package dry runs, dependency audits, and the existing remote/stdio integration suites.

## High-impact findings and corrections

### Lock and process identity

Process locks were previously created directly at their final path and then populated. A competitor could observe an empty or partial JSON file. Locks also relied primarily on PID liveness, which cannot distinguish PID reuse.

The runtime now:

- writes and `fsync`s a private temporary file before atomically claiming a lock with a same-directory hard link;
- records a random ownership token and process start time;
- validates PID liveness, process start time, lock age, purpose, workspace, and file identity;
- removes a stale lock only when its device, inode, size, modification time, and token still match the inspected snapshot;
- gives a recent malformed lock a grace period rather than deleting a possibly in-progress claim;
- waits a bounded interval for ordinary startup/state operations instead of failing immediately.

Managed-job transition, recovery, and runner identity follow the same ownership and process-start-time rules. Numeric-only runner records are rejected.

### Service lifecycle

Service providers returned inconsistent result shapes, and removal could continue after an incomplete stop. Full uninstall considered too little profile state.

The lifecycle is now fail-closed and ordered:

1. stop the platform service;
2. stop every verified workspace daemon in scope;
3. confirm each stop result;
4. remove the service definition only after all stops succeed;
5. retain service definitions and state when any phase fails.

macOS, systemd, and Windows Scheduled Tasks now return a common `ok` contract. Full uninstall scans all known profiles and can recover workspace identity from daemon locks when a state file is unavailable.

### State persistence and deletion

State reads previously classified any read error as corrupt JSON and could continue with an empty state. A dangerously selected state root could also overlap a workspace.

The runtime now:

- backs up a file only after it was read successfully and its JSON content is actually invalid;
- propagates permission, type, symbolic-link, size, encoding, and I/O failures;
- uses one shared `fsync` plus atomic-replacement primitive for state, job, runner, browser-pairing, and service-definition writes;
- rejects a state root that overlaps the selected workspace in either direction before creating state;
- acquires a state-root maintenance lock to block new profile/state operations and state-backed operations from already constructed managed-job/browser managers, and cross-checks deletion against global workspace selection, profile state, daemon locks, state markers, and known directory shape;
- treats unreadable process locks as an uninstall blocker rather than evidence of inactivity.

### Process-tree cleanup

CLI helper commands and managed jobs could terminate the direct child while leaving descendants alive. Escalation timers could be cleared or unreferenced before killing a resistant descendant.

Timeout and cancellation now target the process group/tree, keep the escalation timer alive, and issue a bounded `SIGKILL`/Windows tree termination after graceful shutdown. Tests use descendants that deliberately ignore `SIGTERM`.

### Privacy and logging

The privacy gate did not inspect tracked npm authentication configuration or several common credential formats. Free-form log sanitization had corresponding gaps.

Checks and redaction now cover:

- generic, encrypted, OpenSSH, RSA, EC, and DSA private-key headers;
- npm, GitHub, GitLab, Slack, Google API, AWS, live payment, and common API-secret formats;
- JWT-shaped bearer values and URLs with embedded credentials;
- non-example email addresses and absolute user-home paths;
- credential-shaped publication filenames;
- authentication, identity, environment interpolation, and credential URLs in a tracked `.npmrc`.

Findings report only file, line, and rule. The matched value is never printed. A tracked `.npmrc` remains permitted for non-secret repository settings such as `engine-strict=true`.

### Local automation boundaries

Browser upload metadata now requires a safe single-component filename and canonical MIME type. Derived local filenames have controls and separators removed. Application action text rejects NUL bytes. Sensitive browser and Accessibility values remain excluded from results.

Restricted filesystem reads now add `O_NOFOLLOW` for the final path component in addition to canonical workspace containment.

### Test and release integrity

The hand-maintained syntax file list was replaced by a recursive scanner. Package scripts are checked for missing entrypoints, release helper scripts are packaged, npm package modes are validated, and installation guidance is checked across the CLI and documentation. Dedicated tests cover lock concurrency, atomic replacement, PID reuse, malformed locks, service removal ordering, process-tree termination, state read failures, unsafe state roots, browser upload metadata, and expanded privacy patterns.

## Reviewed areas without material code changes

The review also rechecked Worker OAuth/PKCE validation, exact redirect/resource binding, token hashing/version revocation, registration and failure limits, Durable Object serialization, daemon WebSocket authentication/replacement, CSP/no-store response headers, static MCP catalog parity, browser loopback Host/Origin/subprotocol validation, and fixed-code JXA/browser execution. Existing controls and integration coverage were retained.

## Residual limits

No review can prove the absence of all defects. Important residual boundaries are:

- Node.js cannot provide a portable `openat`-style directory capability for every filesystem operation. Canonical containment plus `O_NOFOLLOW` protects the final component, but hostile same-user code can still race parent-directory replacement. Use a dedicated low-privilege account, VM, or container for untrusted repositories.
- Same-user malicious processes can inspect memory, signal processes, alter browser profiles, or manipulate files the user can access. Machine Bridge is not an OS sandbox.
- Hard-link atomic lock claims require a local filesystem that supports same-directory hard links. Failure is explicit; the runtime does not fall back to a partial-write-prone lock.
- Service-manager behavior varies by OS version and local policy. Provider failures remain visible and fail closed, but operator intervention can still be required.
- Browser pages, application UIs, project instructions, skills, command manifests, and command output are untrusted content. Human/host approval remains necessary for consequential actions.
- The MCP host may filter tools, omit server instructions, or block calls before they reach Machine Bridge; the server cannot observe or override that boundary.

## Ongoing review rule

A future change to locks, state deletion, service lifecycle, detached processes, credentials, browser/app authority, package contents, or public transport must add a behavior-level regression test and update the applicable security/operations documentation. String-presence tests may supplement, but must not replace, executable state-transition tests.
