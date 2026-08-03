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
8. the exact stable commit must pass cross-platform CI, CodeQL, Governance, and OpenSSF Scorecard before the stable tag and final GitHub Release are created.

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

Generate the exact tarball:

```sh
npm run release:candidate
```

The candidate manifest records npm SHA-1/SHA-512 values and a promotion-content digest. Any packaged-file change invalidates the candidate. Every candidate start or activation recomputes the current digest and compares package identity before tarball verification, npm installation, Worker deployment, or service mutation; a stale but internally self-consistent tarball cannot be installed. Preparing or testing a candidate never authorizes npm publication; only the repository owner may invoke a publication command. An existing tag, GitHub Release, or npm version is immutable and must never be reused after source changes.

## 2. Owner activates the exact candidate

The coding agent must stop and present this command. The repository owner executes it:

```sh
npm run release:candidate:activate -- --allow-worker-deploy
```

The command:

- verifies that the pending manifest still matches the current packaged source, then verifies the exact pending tarball;
- installs it under the owner-only ordinary Machine Bridge profile state root, separate from both the normal global installation and the machine-service control root;
- acquires the machine-global service lock before the workspace startup lock and rejects a foreground or unverifiable daemon before changing the service manager;
- stops only a verified existing service daemon;
- updates the configured same-name Worker;
- starts the candidate in-process and verifies device authentication plus relay readiness;
- if that current-version candidate receives an explicit device-authentication rejection, redeploys the same Worker once with the unchanged selected identity and retries within a three-start bound;
- installs the candidate as the login service runtime and atomically commits the canonical workspace/state/entrypoint/version owner record;
- performs a controlled foreground-to-service handoff;
- accepts the background runtime only after its matching daemon lock publishes the post-authentication, post-relay-probe `ready_ack` checkpoint;
- verifies that both the Worker and verified background daemon report the candidate version;
- exits while the background daemon continues running.

It may request one macOS user-presence or Touch ID operation to certify the daemon session key. It does not ask for per-tool approval. The wrapper does not impose a transaction-wide hard kill: each internal deployment, health, relay, service-manager, and convergence stage is independently bounded so lock release and compensation cannot be skipped.

The private candidate runtime is not stored under the Git checkout, so cleaning `.release-candidate/`, switching branches, or regenerating a candidate cannot delete the daemon currently under test. The previous global installation remains available as recovery information.

## 3. Coding agent verifies the live candidate

After the owner command completes, the coding agent verifies through Machine Bridge:

- `server_info` reports the exact candidate version;
- Worker health reports the same version and deployment identity;
- the connected daemon is the verified login-service process;
- relay readiness succeeds through the deployed Worker;
- a representative read succeeds;
- changed functionality and relevant failure paths succeed;
- browser, application, proxy, credential, service, and platform-specific behavior are tested when affected;
- logs contain no sensitive arguments, output, tokens, or raw user paths.

Only observed live evidence counts. A green unit suite, prepared tarball, unobserved process, or ambiguous response does not count.

After successful verification, the coding agent records acceptance using the exact phrase emitted by `release:candidate`:

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

The repository owner creates the annotated prerelease tag, GitHub Prerelease, and exact tarball asset from a real interactive terminal:

```sh
npm run prerelease:release -- --owner-terminal-confirm
```

The flag is necessary but not sufficient: stdin, stdout, and stderr must all be TTYs. MCP calls, managed jobs, CI, redirected sessions, and other ordinary background automation fail before fetch, full verification, tag creation, or remote mutation. One common-Git-dir owner-only publication lock serializes tag/Release writes across the main checkout and linked worktrees. This ceremony prevents accidental and standard non-interactive publication; it is not an authentication boundary against arbitrary code already executing as the same OS user, which can emulate a terminal. Adversarial separation requires an external user-presence or isolated release environment.

Historical GitHub Release backfill is governed by the same boundary and must be run by the owner from a real interactive terminal:

```sh
npm run release:backfill -- --owner-terminal-confirm
```

Publish npm through the repository-controlled channel command:

```sh
npm run prerelease:publish
```

The command derives `dev`, `beta`, or `next` from the package version. `prepublishOnly` rejects an incorrect or implicit `latest` tag and rechecks the package, GitHub prerelease, exact commit, and candidate acceptance.

## 5. Activate the published prerelease and begin soak

From the exact accepted source checkout, the owner runs:

```sh
npm run prerelease:install -- --allow-worker-deploy
```

This command verifies that the npm registry tarball SHA-1/SHA-512 and dist-tag match the locally accepted candidate, installs that exact published version globally, updates the Worker and login daemon, verifies both versions, and writes an owner-only `npm-prerelease` activation record. Schema 2 names any retained fallback explicitly as `global_package_rollback_baseline`: it identifies the globally installed npm package and entrypoint available for operator-directed disaster recovery, not the service runtime that was active immediately before activation. The activation transaction captures and verifies that previous service identity separately while the handoff is in progress. Schema 1 records using the legacy `previous` field remain readable and are normalized in memory without rewriting historical evidence. The formal soak clock starts from this activation record, not from a local unpublished candidate.

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
```

The owner activates the exact stable candidate with the same persistent command:

```sh
npm run release:candidate:activate -- --allow-worker-deploy
```

The coding agent verifies the live stable candidate and records its exact acceptance. Then commit, push with `npm run github:push`, and merge. The repository owner runs the following from a real interactive terminal:

```sh
npm run release -- --owner-terminal-confirm
npm run stable:publish
```

`npm run release -- --owner-terminal-confirm` creates the final annotated tag and GitHub Release only after the soak record, promotion digest, exact candidate acceptance, exact `origin/main`, and all required push-triggered checks pass. `stable:publish` always uses `latest` and repeats the same gates.

## Rollback and recovery

Candidate and prerelease activation retain the previous global installation metadata, but rollback across a state or protocol migration is not assumed safe. If activation fails:

- preserve the state root and service logs;
- do not delete locks or edit versions by hand;
- inspect `machine-mcp service status`, `machine-mcp status`, and `machine-mcp doctor` using the intended runtime;
- fix forward when Worker/state protocol has changed;
- restore a complete pre-upgrade backup only when package, Worker, browser extension, service definition, and local state can be restored as one unit.

The activation state machine verifies candidate relay readiness before service handoff and cleans up its temporary runtime and locks on failure. Before remote preparation changes or verifies the candidate deployment, a provider whose verified stop result requires restoration is restarted after lock cleanup. After remote preparation, activation never revives a daemon known to be incompatible with the current Worker: cleanup installs and starts the compatible candidate service definition instead. This is forward recovery, not a fabricated distributed rollback; the primary failure remains visible, and any candidate-service installation or start failure is aggregated with it.

## External credentials and controls

Live npm publication, global installation, and Worker/service replacement require explicit owner authorization. Repository automation does not infer that authorization from a version change.

Required external controls remain:

- authenticated local `git`/`gh` access;
- npm package-owner or maintainer access;
- Cloudflare account protection;
- successful exact-commit CI, CodeQL, Governance, and Scorecard;
- protected npm publication credentials or trusted publishing when configured.

Never place npm, GitHub, Cloudflare, OAuth, account, or device credentials in source files, workflow YAML, acceptance/soak records, logs, screenshots, or project notes.
