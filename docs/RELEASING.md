# Release process

Machine Bridge uses a mandatory prerelease-and-soak process. A release candidate is not a stable release, and a green automated suite is not evidence that a real Worker, daemon, browser extension, service manager, and ordinary client remain healthy over time.

The invariant for version 3 and later is:

1. every package change is first assigned a `dev`, `beta`, or `rc` semantic version;
2. the exact npm tarball is activated on the owner machine with one command that updates the same-name Worker and persistently replaces the login daemon;
3. the coding agent verifies the connected candidate through Machine Bridge before recording package acceptance;
4. the accepted prerelease is published under a non-`latest` npm dist-tag and as a GitHub Prerelease;
5. the owner installs that exact published prerelease and uses it for the required soak period;
6. every blocking defect produces a new prerelease version and restarts the soak clock;
7. stable promotion is allowed only when the packaged functional content matches the soaked prerelease; only synchronized version metadata may differ;
8. the exact stable commit must pass cross-platform CI, CodeQL, Governance, Workflow Policy Gate, and OpenSSF Scorecard before the stable tag and final GitHub Release are created.

## Release channels

Supported versions and registry channels are:

| Version form | npm dist-tag | GitHub release type | Purpose |
|---|---|---|---|
| `x.y.z-dev.n` | `dev` | Prerelease | short-lived development integration |
| `x.y.z-beta.n` | `beta` | Prerelease | normal real-world testing channel |
| `x.y.z-rc.n` | `next` | Prerelease | optional final candidate after beta |
| `x.y.z` | `latest` | final release | stable users only |

Do not assign the final `x.y.z` version while implementation is still under candidate testing. A major or behaviorally risky change normally starts at `beta.1`. A release candidate may use `rc.n` after beta when a final freeze checkpoint is useful.

Minimum published-prerelease soak periods are:

- major release: seven days;
- minor release: three days;
- patch release: one day.

These are lower bounds, not automatic approval. Continue the soak when use has been too light to exercise the changed behavior.

## 1. Prepare an exact prerelease candidate

Complete implementation, tests, documentation, audit notes, and changelog. Set the prerelease version without creating a Git tag:

```sh
npm version 3.0.0-beta.1 --no-git-tag-version
```

The version hook synchronizes package metadata, Worker version, and browser-extension metadata.

When MCP protocol behavior changes, an official conformance checkout may be run without adding the alpha runner to the package dependency graph:

```sh
MBM_OFFICIAL_CONFORMANCE_CHECKOUT=/path/to/modelcontextprotocol-conformance \
MBM_OFFICIAL_CONFORMANCE_SCENARIOS=http-header-validation,caching,server-stateless \
MBM_OFFICIAL_CONFORMANCE_TIMEOUT_MS=75000 \
npm run worker:integration-test
```

The test-only loopback proxy injects the integration account's short-lived bearer token; it must never be enabled in production. Expected failures are check-scoped in `tests/mcp-conformance-baseline.yml` and may cover only intentionally absent capabilities. A new failure or stale baseline blocks release.

Run the complete local gate and inspect the diff:

```sh
npm run check
npm audit --audit-level=high
npm audit --omit=dev --audit-level=high
npm audit signatures
npm run sbom:test
npm run worker:dry-run
npm pack --dry-run
```

The full plan starts with the real CycloneDX `sbom:test` against the current source dependency tree. This intentionally fails before expensive platform and coverage work when ignored `node_modules` no longer matches the committed manifest/lock. Developers should still bootstrap ordinary work with `npm ci`; the later canonical GitHub/npm publication commands independently rebuild the exact tree through hardened npm so release correctness does not depend on an operator remembering an unstated workspace-cleanup step.

A successful `npm run check` / `check:full` writes an ignored owner-local `.project-local/full-verification.json` receipt after the stable-generation guard completes. It records only synthetic verification metadata: the exact source-generation digest, package name/version, Node version, platform/architecture, and verification timestamp. The receipt is valid for at most six hours. Starting another full run deletes the prior receipt before any test executes, and any source/package/runtime drift makes it unusable. This is a local execution cache, not acceptance or publication authority.

When the frozen full gate is launched remotely through Machine Bridge, do not make the 600-second durable-process ceiling an accidental release deadline. A real install/integration phase can make `check:full` exceed that duration even when every test passes. Owner-authorized remote verification should run the single `npm run check:full` step through detached `start_job` with a larger explicit step timeout and then inspect `read_job`; local terminal execution remains `npm run check:full` directly. The same principle applies to other long release evidence: a multi-stage lifecycle/fault/real-host verifier must be split or given its own credible worst-case step budget rather than killed by an arbitrary shorter command-carrier timeout. Carrier timeout alone is not a product-test verdict. The full-verification receipt is written by the suite only after the exact-tree run succeeds, independent of which valid execution carrier launched it.

Generate the exact tarball. The prepare/record/verify commands bootstrap ephemeral hardened npm and do not regenerate acceptance bytes through the ambient npm bundle:

```sh
npm run release:candidate
```

`release:candidate` consumes the current full-verification receipt instead of running the complete suite a second time. If the receipt is missing, stale, or does not match the frozen tree and runtime, preparation stops before `npm pack` and instructs the agent to run `npm run check:full`. Do not bypass this by calling a lower-level pack command; regenerate full evidence for the current tree.

The candidate manifest records npm SHA-1/SHA-512 values and a promotion-content digest. Any packaged-file change invalidates the candidate. Every candidate start or activation recomputes the current digest and compares package identity before tarball verification, npm installation, Worker deployment, or service mutation; a stale but internally self-consistent tarball cannot be installed. Preparing or testing a candidate never authorizes npm publication; that sole conversational authorization boundary requires an explicit current-task owner request plus the npm-publication confirmation flag. Git/GitHub publication and live activation do not require separate conversational approval. An existing tag, GitHub Release, or npm version is immutable and must never be reused after source changes.

Immediately before crossing the live activation boundary, the coding agent must run the non-live candidate preflight:

```sh
node scripts/start-release-candidate.mjs --install-only
```

This direct-Node path deliberately bypasses npm lifecycle execution and reuses the activation wrapper with `--install-only`. It resolves a validated npm CLI only from the running Node installation layout (not lifecycle `npm_execpath` or unrelated fallback locations), recomputes current package identity and promotion content, verifies the exact tarball, performs a disposable local install, removes that install, and does not deploy the Worker, change the login service, or write prerelease activation evidence. It exists specifically to catch source drift, unexpected package file modes, and installability failures after candidate preparation without mutating live state. If it fails, fix the tree and regenerate `npm run release:candidate`; do not repair the old manifest/tarball in place. Once it succeeds, automation proceeds to the guarded live activation without stopping for another approval.

A blocking external CI or CodeQL result discovered after local acceptance is still a candidate defect. When its repair changes any packaged file, increment the prerelease number, remove the old acceptance record, regenerate the candidate, repeat guarded activation, rerun the candidate-bound deployed OAuth canary, repeat observed live verification, and record a new acceptance before guarded push. Do not preserve an old acceptance or canary evidence merely because the runtime behavior under investigation is unchanged, and do not weaken a platform or security gate to keep the old candidate valid.

Platform fidelity is evidence from the provider environment, not an inference from local success. In particular, Windows filesystem/process semantics and hosted security analyzers must pass on the exact candidate head; local simulations may diagnose or prevent regressions but cannot close those provider gates.

## 2. Automation activates the exact candidate

After the install-only preflight succeeds, repository automation runs exactly:

```sh
npm run release:candidate:activate -- --allow-worker-deploy
```

A TTY is not required and no additional conversational approval is required. If the owner says they will execute the command themselves, the agent must not race that operation.

The **execution carrier is part of the safety contract**. This command intentionally stops and replaces the currently running Machine Bridge login daemon. Do not launch persistent activation through `run_process`, `exec_command`, `run_local_command`, or `start_process`: those children/process sessions belong to the current daemon and are terminated when that daemon drains its process tree. The packaged activation guard rejects those surfaces before Worker or service mutation. A coding agent that executes activation through Machine Bridge must use a detached `start_job` step and inspect it with `read_job`; the managed-job runner is independent of the daemon and continues across the handoff. Running the exact command directly in an ordinary owner terminal is also valid.

Cloudflare Wrangler authentication is also a **pre-handoff** requirement. The release wrapper performs a captured `wrangler whoami` before it enters the persistent release-runtime/service transaction. A detached managed job never starts interactive Wrangler login: if the preflight is unauthenticated it fails before Worker or service mutation and the owner completes Wrangler authentication in an ordinary terminal before retrying. An ordinary owner-terminal activation may open Wrangler login at this outer preflight boundary, while the existing login daemon is still untouched, and then requires a second captured `whoami`. Once the inner `machine-mcp activate --json` transaction begins, machine-readable Worker deployment will not open an interactive login; authentication loss at that point fails into the existing rollback path instead of holding the service offline or contaminating the JSON result channel.

The command:

- verifies that the pending manifest still matches the current packaged source, then verifies the exact pending tarball;
- verifies Wrangler authentication before entering the release-runtime/service transaction; managed-job activation fails before live mutation rather than attempting interactive login, while an ordinary owner terminal may authenticate and must pass a post-login `whoami` recheck;
- installs it under the owner-only ordinary Machine Bridge profile state root, separate from both the normal global installation and the machine-service control root;
- acquires the machine-global service lock before the workspace startup lock and rejects a foreground or unverifiable daemon before changing the service manager;
- stops only a verified existing service daemon;
- updates the configured same-name Worker;
- starts the candidate in-process and verifies device authentication plus relay readiness;
- if that current-version candidate receives an explicit device-authentication rejection, redeploys the same Worker once with the unchanged selected identity and retries through ten bounded fresh starts with exponential delay;
- installs the candidate as the login service runtime and atomically commits the canonical workspace/state/entrypoint/version owner record;
- performs a controlled foreground-to-service handoff;
- accepts the background runtime only after its matching daemon lock publishes the post-authentication, post-relay-probe `ready_ack` checkpoint;
- verifies that both the Worker and verified background daemon report the candidate version;
- publishes the exact installed candidate browser extension into the owner-only stable release-channel extension directory, with `manifest.json` committed last, before pruning any prior versioned candidate runtime or writing activation evidence;
- exits while the background daemon continues running.

Service replacement is fail-closed but rollback-aware. If stopping an existing verified provider cannot be conclusively observed, activation does not proceed into candidate takeover. A stop mutation against a previously active service nevertheless creates a rollback obligation because launchd/system service-manager effects may settle after the command response. The activation settlement repeatedly re-establishes and verifies the exact previous service runtime before returning the candidate failure; it must not leave an ambiguous stop as an inactive login daemon. On macOS the launchd stop observer allows a bounded settle window before declaring the stop inconclusive, and previous-service recovery retries idempotent provider start/bootstrap rather than relying on one call that can race a delayed `bootout`.

It may request one macOS user-presence or Touch ID operation to certify the daemon session key. It does not ask for per-tool approval. The wrapper does not impose a transaction-wide hard kill: each internal deployment, health, relay, service-manager, and convergence stage is independently bounded so lock release and compensation cannot be skipped.

The private candidate runtime is not stored under the Git checkout, so cleaning `.release-candidate/`, switching branches, or regenerating a candidate cannot delete the daemon currently under test. The activation wrapper checks `--allow-worker-deploy` before downloads/install, reads the previous global installation while hardened npm is still live, uses the persistent release-channel prefix only for an actual service activation, and prunes only canonical real contained inactive runtime directories after the stable browser-extension copy has converged. `--install-only` uses the disposable foreground prefix. The stable browser-extension path is intentionally outside the versioned runtime directory so Chrome's unpacked-extension source path survives candidate pruning. The previous global installation remains available as recovery information.

## 3. Coding agent runs the deployed OAuth canary and verifies the live candidate

After the activation command completes, the coding agent first runs the candidate-bound synthetic canary:

```sh
node <activated-runtime-package>/scripts/release-oauth-canary.mjs --allow-live-oauth-canary
```

`<activated-runtime-package>` is the package directory containing the activation record's absolute `runtime_entry` (take the parent of its `bin/` directory). The coding agent must execute that packaged canary path as direct Node argv while keeping the Git checkout as the child cwd. This makes the code and all relative imports come from the exact activated package; the checkout is only the candidate/evidence data root. A workspace-relative `node scripts/release-oauth-canary.mjs ...` command and the package script `npm run release:oauth-canary -- --allow-live-oauth-canary` remain source/developer entrypoints with ordinary accounting, but they are not valid prerelease-evidence paths. For prereleases the canary additionally canonicalizes its own package root and requires it to equal the package root containing the activation record's `runtime_entry`; a checkout copy therefore fails before live OAuth mutation even when its source bytes match. The npm form can also be redirected by `script-shell`, and the workspace form would otherwise execute mutable checkout imports before admission could prove their full transitive identity. The canary also refuses Node/native debugging, profiling, TLS, loader, key-log, and resource-startup environment overrides before candidate validation or live OAuth mutation; use a clean process environment.

The command accepts exactly the single `--allow-live-oauth-canary` argument and requires empty `process.execArgv`; Node preload, loader, debugger, profiler, and other runtime CLI options are not valid release evidence. `--state-dir`, `--workspace`, and every other extra argv are refused before state access because canary evidence does not encode alternate local-state identity. It requires the current startup-ready service daemon to pass the hardened daemon-owner identity check with the candidate version, an `entryScript` canonically equal to the executing canary package's `bin/machine-mcp.mjs`, and a canonical Node executable equal to the canary's `process.execPath`, and private daemon-lock Node runtime metadata equal to `process.versions.node`; this requirement applies to stable candidates too. It refuses stale source/candidate identity and the wrong recorded Worker version. For prereleases it also binds to the exact activation record. It creates one random temporary `reviewer` account and one DCR client, performs authorization-code exchange, an authenticated `server_info` MCP call, refresh-token rotation, and a second authenticated MCP call, then revokes the temporary client and removes the temporary account before it writes evidence. Credentials, authorization codes, client/account identifiers, and access/refresh tokens exist only in process memory and are never printed or stored in canary evidence. A main-path failure still attempts both cleanup operations; cleanup failure makes the canary fail closed and prevents evidence creation.

The coding agent then verifies through Machine Bridge:

- `server_info` reports the exact candidate version;
- when tool schemas, descriptions, or hosted orchestration semantics changed, `server_info.tool_delivery.tool_schema_generation` and `tool_schema_server_version` match the candidate, both `discovery_ttl_ms` and `tool_list_ttl_ms` are zero, `host_turn_deadline_observable=false`, `managed_jobs_detached_from_mcp_response=true`, and current 2026-07-28 discovery advertises `tools.listChanged=true`; an actual `subscriptions/listen` request for `toolsListChanged` must receive the supported-subset acknowledgement plus `notifications/tools/list_changed`, while initialization-era 2025 compatibility still reports `listChanged=false`. `tools_list_change_subscription_opened_for_account=true` means only that the Worker successfully constructed an open `toolsListChanged` stream for that account during the current Durable Object lifetime; `tools_list_change_subscription_active_for_account` reports whether such a request-scoped stream is currently open, `tools_list_change_subscription_lease_ms` reports the bounded server-side fail-safe lifetime for an otherwise unobservable disconnect, and `tools_list_change_subscription_client_receipt_observable=false` explicitly records that a server-opened stream does not prove that the external client read either SSE frame; the other subscription diagnostics likewise do not prove host receipt or catalog refresh. Acceptance must observe the stream remain open through a short initial window and release its active capacity no later than the advertised lease when the public client disappears, because Workers HTTP disconnect propagation is not a reliable ownership signal. Do not use the opened flag as product-publication evidence. ChatGPT workspace apps can keep a frozen approved tool/input snapshot rather than automatically replacing published actions when the MCP server changes. When that governance layer is relevant, automation may inspect and operate Workspace Settings -> Apps -> the app -> **Action control** without another conversational approval: use the supported in-place Refresh/review path first and require the expected action count and current generation/semantics. A published Business custom app should be recreated/re-published only when the product itself cannot update that governed snapshot in place or separate workspace governance explicitly requires republication. Opaque ChatGPT-internal cache inspection is not part of release acceptance and must not be added as an alternate freshness gate or remediation trigger. `host_visible_schema_known_to_server=false` still means backend convergence alone is insufficient evidence, so pair the governed Workspace snapshot (where applicable) with harmless invocation-validator/behavior probes that reach Machine Bridge. For beta.112 and later generation-5 candidates, a terminal `read_job` with `wait_ms=40001` must return immediately as a terminal read rather than being rejected either by a stale host validator or by the beta.111 daemon-local static 40,000 ms schema; when validating the six-hour step ceiling, a non-executing `stage_job` with `timeout_seconds=3601` must be accepted and then cancelled/cleaned rather than being rejected by the former one-hour validator. Generation-6 retention semantics additionally require a syntactically valid but unretained `job_id` to return typed non-retryable `not_found`; that proves the changed behavior reached the current runtime while preserving the rule that missing retained evidence is not non-execution proof. For managed-job continuation changes, use an unchanged active fixture longer than the hosted default: a first `read_job` with no explicit `wait_ms` must remain inside one MCP response for the advertised server-side long-poll interval (or return earlier only because real progress occurred), expose the wait metadata, and a second `read_job` in the same assistant response must still be accepted and advance or reach terminal state. The default itself is a host-compatibility claim, not merely a server capability: it must stay at or below a duration the target hosted client has actually carried to a structured Machine Bridge result. Do not raise the default to the protocol maximum solely to reduce call count; beta.109 live probing demonstrated a 40-second read succeeding while the former five-minute omitted-parameter default ended in host `TimeoutError`. A later beta.113 calibration also carried an active explicit 60-second read to a structured running result, which proves only that this host can accept that explicit per-call duration; it does not prove that one assistant response can survive an arbitrary aggregate number or duration of calls. The five-minute maximum may remain as an explicit opt-in only for a client whose longer request lifetime is independently verified. Do not make a fixed-duration >100-minute live managed-job soak a release-acceptance prerequisite. Treat per-call pacing and aggregate host-response lifetime as separate constraints, but verify cross-boundary recovery with bounded live probes tied to the changed failure mode: preserve the same job_id across any real host/tool or daemon/relay boundary exercised by the change and prove recovery after realistic `exec_command`/`run_process` helper churn when that boundary is relevant. A response-count estimate such as `duration / wait interval` is planning data, not cross-boundary recovery evidence. A valid-but-unretained job_id must return typed `not_found`, and that condition must never trigger blind resubmission of the underlying side effect. Completed one-step process helper jobs may share the bounded managed-job store, but capacity pruning must reclaim removable transient helper history before evicting an explicit managed-job terminal result. Relay recovery acceptance must additionally prove that expiry of a completed-but-unacknowledged result disables daemon-proven missing-id automatic redelivery rather than risking duplicate execution. For process-session pacing changes, a first blocking read must arm the cooldown and an immediate second would-block read must be observed remaining inside the same MCP call until output/exit or the cooldown boundary rather than rapidly returning another running checkpoint;
- Worker health reports the same version and deployment identity;
- the connected daemon is the verified login-service process;
- relay readiness succeeds through the deployed Worker;
- a representative read succeeds;
- changed functionality and relevant failure paths succeed;
- browser, application, proxy, credential, service, and platform-specific behavior are tested when affected;
- logs contain no sensitive arguments, output, tokens, or raw user paths.

ChatGPT host-control-plane UI is standing-authorized when release diagnosis or governed schema publication actually requires it. Passive existing MCP discovery and harmless invocation-validator probes remain the first-line evidence. When product governance evidence is needed, automation may inspect and operate the Workspace Action control snapshot without another approval, must prefer in-place refresh/review, and classifies recreation/republication as a last resort only if that governed snapshot cannot be updated in place or remains stale/partial/mixed. Host-internal cache inspection is outside this release workflow, and unknown-outcome UI mutations are inspected before any retry.

Only observed live evidence counts. A green unit suite, prepared tarball, unobserved process, or ambiguous response does not count. `release:accept` also requires the `.release-candidate/oauth-canary.json` evidence to match the pending candidate; regenerating the candidate removes the evidence and forces a new deployed canary.

After successful canary and live verification, the coding agent records acceptance using the exact phrase emitted by `release:candidate`:

```sh
npm run release:accept -- --confirm "I VERIFIED machine-bridge-mcp <version> CANDIDATE ON THE OWNER MACHINE AND IT WORKS"
```

The resulting `release-acceptance/v<version>.json` binds the exact tarball hashes, portable Git package digest, promotion-content digest, timestamp, and fixed verification marker. It contains no personal machine path, command output, account credential, or user content.

## 4. Review and publish the prerelease

Commit the prerelease changes and acceptance record. Push only through:

```sh
npm run github:push
```

Create/update the pull request, satisfy required checks, squash-merge, fetch, and fast-forward local `main`.

After exact-commit checks pass, repository automation creates the annotated prerelease tag, GitHub Prerelease, and exact tarball asset through the local control plane without another conversational approval:

```sh
npm run prerelease:release
```

The command still fails closed on dirty state, wrong branch/version channel, missing exact acceptance, incomplete exact-commit CI, digest mismatch, conflicting tags/releases, or concurrent publication. Before running its frozen full verification, it creates the integrity-pinned hardened npm session and executes lockfile-only `npm ci` against the checkout, then rechecks that the tracked tree is still clean. Its long npm lifecycle stages use process-tree hard-timeout settlement, so a deadline cannot be reported as terminal while npm descendants continue running. One common-Git-dir publication lock serializes tag/Release writes across the main checkout and linked worktrees. No TTY or owner-confirmation ceremony is part of the GitHub publication contract.

The command resolves trusted absolute git and GitHub CLI executables, creates a private staging copy of the accepted candidate, and never runs a new `npm pack` for the Release asset. After upload it queries the GitHub REST asset record and requires its SHA-256 digest to equal the current accepted artifact before reporting success.

Historical GitHub Release backfill uses the same evidence/lock boundary and does not require conversational authorization:

```sh
npm run release:backfill
```

Publish npm through the repository-controlled channel command only after explicit current-task owner authorization:

```sh
npm run prerelease:publish -- --owner-confirm
```

The command derives `dev`, `beta`, or `next` from the package version. It constructs an ephemeral integrity-pinned hardened npm before any package regeneration; the ambient npm process only launches the repository script. Hardened npm first runs lockfile-only `npm ci`, then regenerates/verifies current acceptance bytes and runs `prepublishOnly`, which rejects an incorrect or implicit `latest` tag and rechecks the package, GitHub prerelease, exact commit, and candidate acceptance. That full prepublication gate has its own thirty-minute process-tree deadline rather than inheriting the ordinary ten-minute npm-stage deadline; timeout hard-terminates the complete isolated npm lifecycle tree before failure is returned, so a timed-out parent cannot leave verification descendants printing or executing after the publication command has failed. POSIX uses the isolated process-group hard-signal boundary; Windows waits for the forced `taskkill /T /F` helper itself to settle successfully, and an unconfirmed tree termination is reported distinctly instead of being treated as an ordinary completed timeout. npm then dry-runs publication of the private staged candidate and requires the reported name, version, SHA-1, and SRI to match acceptance before uploading that same tarball with lifecycle scripts disabled. Before upload it refuses a conflicting immutable registry object; after every upload result it waits for exact version/SHA-1/SRI/dist-tag/timestamp convergence. A matching preexisting object is idempotent, while an unresolved outcome is explicitly ambiguous: inspect registry state and do not rerun publication blindly. GitHub Release creation follows the same rule using release metadata and REST SHA-256 asset convergence.

TTY presence is not an npm-publication authorization signal; the explicit owner request plus `--owner-confirm` remains the authorization boundary. npm 12's Web OTP challenge is nevertheless process-scoped. When a real owner terminal runs the canonical command, npm can open the browser challenge, wait, obtain the one-time proof, and retry the same upload in that process. A non-TTY automation carrier cannot complete that npm flow. It therefore captures rather than inherits upload output, reduces `EOTP` to a fixed non-secret classification, performs the same registry reconciliation before deciding that the rejected upload did not create the exact candidate, and instructs the operator to rerun the canonical command in a real owner TTY. The publication lifecycle also passes `--logs-max=0` to prepublication, dry-run, and upload npm invocations so challenge material is not persisted in npm's cache log directory. Never copy an OTP, access token, npm challenge URL, challenge id, or done-URL session value into an MCP argument, managed-job plan, log, or chat message.

The release checks also perform an ordinary install of the exact tarball into an empty consumer project, including optional production dependencies, run a zero-vulnerability production audit, validate that deployment-only Wrangler/Miniflare packages are absent from the published runtime tree, and generate a CycloneDX SBOM with a complete closed dependency record for every component. Root-workspace overrides, workspace audit output, and the workspace SBOM do not satisfy this consumer-artifact gate. CI npm execution uses the same integrity-pinned hardened npm bootstrap as runtime deployment, with fixed replacements for the vulnerable stock undici and brace-expansion bundles. Nested npm operations remove dry-run, workspace, global/prefix, save, omit/include, package-lock-only, and script-control modes case-insensitively. Critical pack/install/publish commands also pass explicit non-dry-run/non-workspace flags, so parent lifecycle variables or user npm execution modes cannot produce a false success.

## 5. Activate the published prerelease and begin soak

From the exact accepted source checkout, run the following automatically after authorized npm publication succeeds:

```sh
npm run prerelease:install -- --allow-worker-deploy
```

This command verifies that the GitHub Prerelease asset SHA-256 and npm registry tarball SHA-1/SHA-512/dist-tag all match the locally accepted candidate, resolves the owner's current global npm prefix, creates a temporary hardened npm, installs that exact published version into the same global prefix, updates the Worker and login daemon, verifies both versions, and writes an owner-only `npm-prerelease` activation record. Schema 2 may preserve recovered-activation evidence only as an allowlisted reason plus its fixed canonical detail; lower-layer exception text is neither required nor persisted by the current writer. The record names any retained fallback explicitly as `global_package_rollback_baseline`: it identifies the globally installed npm package and entrypoint available for operator-directed disaster recovery, not the service runtime that was active immediately before activation. The activation transaction captures and verifies that previous service identity separately while the handoff is in progress. The current activation reader accepts schema 2 only; older schema-1 `previous` records are historical evidence, not a supported operational input to current release commands. The formal soak clock starts from this activation record, not from a local unpublished candidate.

The activation also publishes the exact packaged browser-extension files into the stable release-channel extension directory. Chromium does not hot-reload an unpacked extension merely because its source files changed, so browser soak evidence is valid only after the extension has been reloaded/re-paired as needed and `browser_status` reports the expected version/capability handshake as connected. A pending `extension_reload_required=true` is an explicit incomplete browser-test surface, not evidence that package/Worker/service activation failed.

Use the prerelease normally. Exercise the changed areas under real workloads. A crash, authorization anomaly, data-loss risk, repeated relay failure, incorrect service lifecycle, significant compatibility regression, or security/privacy defect is blocking.

When a blocking problem is found:

1. fix it on a new branch;
2. increment `beta.n` or `rc.n`;
3. regenerate and reactivate the exact candidate;
4. repeat live verification and prerelease publication;
5. install the new published prerelease;
6. restart the full minimum soak interval.

Never edit or replace an already published prerelease version.

## 6. Record successful soak

After the minimum interval and adequate real use, the owner reports that no blocking issue remains. The coding agent records that explicit result with the exact phrase printed by the command, for example:

```sh
npm run prerelease:soak:accept -- --confirm "I SOAK-TESTED machine-bridge-mcp 3.0.0-beta.1 FOR AT LEAST 7d WITH NO BLOCKING ISSUES"
```

The command verifies:

- the installed activation came from the published npm prerelease, not a local candidate;
- the published npm hashes and dist-tag match the accepted tarball;
- the GitHub release is marked prerelease;
- the required elapsed time has passed;
- the promotion-content digest still matches;
- no blocking issue is recorded.

It writes `release-soak/v<stable-version>.json`. This record is reviewable, contains no private machine path, and is excluded from the npm package.

## 7. Promote to stable

Create a stable-promotion branch. Change only synchronized release metadata from `x.y.z-beta.n` or `x.y.z-rc.n` to `x.y.z`, retain the same functional package content, add the tracked soak record, and update release wording only where it is normalized by the promotion digest.

Any source, runtime, dependency, packaged documentation, script, policy, browser-extension behavior, or Worker behavior change causes `release:soak:verify` to fail. Such a change requires a new prerelease and a new soak period.

Verify the promotion:

```sh
npm run release:soak:verify
npm run check
npm run release:candidate
node scripts/start-release-candidate.mjs --install-only
```

After the stable candidate preflight succeeds, activate it automatically with the same persistent command:

```sh
npm run release:candidate:activate -- --allow-worker-deploy
```

The coding agent reruns `node <activated-runtime-package>/scripts/release-oauth-canary.mjs --allow-live-oauth-canary`, verifies the live stable candidate, and records its exact acceptance only after both succeed. Then commit, push with `npm run github:push`, and merge. GitHub publication proceeds automatically; stop only for npm publication authorization:

```sh
npm run release
npm run stable:publish -- --owner-confirm
```

`npm run release` creates the final annotated tag and GitHub Release only after the soak record, promotion digest, exact candidate acceptance, exact `origin/main`, and all required push-triggered checks pass. `stable:publish -- --owner-confirm` always uses `latest` and repeats the same gates after explicit npm-publication authorization.

## Rollback and recovery

Candidate and prerelease activation retain the previous global installation metadata, but rollback across a state or protocol migration is not assumed safe. If activation fails:

- preserve the state root and service logs;
- do not delete locks or edit versions by hand;
- inspect `machine-mcp service status`, `machine-mcp status`, and `machine-mcp doctor` using the intended runtime;
- fix forward when Worker/state protocol has changed;
- restore a complete pre-upgrade backup only when package, Worker, browser extension, service definition, and local state can be restored as one unit.

The activation state machine verifies candidate relay readiness before service handoff and cleans up its temporary runtime and locks on failure. Candidate and published-prerelease activation operate on an existing deployment, so their remote-preparation path deliberately skips first-run initial-owner provisioning; normal interactive startup remains responsible for checking account inventory and creating the first owner. Do not add account-list/create probes to candidate activation as a substitute for relay readiness: account administration is an independent authenticated control plane and can fail before the candidate daemon has been observed ready. Before remote preparation changes or verifies the candidate deployment, a provider whose verified stop result requires restoration is restarted after lock cleanup and its prior runtime identity must reconverge. After remote preparation, activation never revives a daemon known to be incompatible with the current Worker: cleanup installs the compatible candidate definition and starts the platform provider without the strict normal-start helper immediately stopping it after an initial readiness miss. Recovery then independently requires the exact candidate service daemon, post-`ready_ack` checkpoint, and Worker version. This is forward recovery, not a fabricated distributed rollback. If the foreground candidate never completed readiness, the owner command remains nonzero even when compensation restores control. If readiness had already been proven and a later handoff-stage failure is completely recovered, the command exits zero with explicit recovered-activation metadata and warning. Any installation, provider-start, daemon-readiness, Worker-version, cleanup, or lock-release failure is aggregated and remains nonzero. An owner command that exits unsuccessfully or writes no activation record cannot be accepted even when an operator later restores service manually.

## External credentials and controls

Live npm package publication is the sole operation that requires explicit current-task owner authorization. Global installation, Worker/service replacement, Git/GitHub publication, and other task-relevant release mutations proceed automatically under the effective local/account authority when their repository safeguards pass.

Required external controls remain:

- authenticated local `git`/`gh` access;
- npm package-owner or maintainer access;
- Cloudflare account protection;
- successful exact-commit CI, CodeQL, Governance, Workflow Policy Gate, and Scorecard;
- protected npm publication credentials or trusted publishing when configured.

Never place npm, GitHub, Cloudflare, OAuth, account, or device credentials in source files, workflow YAML, acceptance/soak records, logs, screenshots, or project notes.
