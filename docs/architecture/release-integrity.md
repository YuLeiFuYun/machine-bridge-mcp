# Release integrity

Detail behind [Architecture](../ARCHITECTURE.md#deployment-toolchain-isolation). The publishing procedure
itself lives in [Releasing](../RELEASING.md); this file records what the artifacts must prove.

## Deployment toolchain isolation

The consumer runtime has three direct dependencies; cf, Wrangler, Miniflare and deployment Undici remain outside that graph.
Source development declares exact cf/Wrangler versions.
Installed runtimes construct an owner-only private toolchain from its packaged manifest and lockfile; Undici is verified as a transitive dependency.
The directory name binds the builder version, templates and original cf bundle hash.
Miniflare and ws overrides keep the two CLI dependency trees deduplicated.

`cf` is the deployment and project-orchestration CLI; it does not contain a Worker bundler. Its build
command detects a project-native builder and delegates to Wrangler when no custom `buildCommand` is
configured. The private toolchain therefore pins both CLIs, and `cf-project.mjs` materializes a
Wrangler `devDependencies` entry plus the toolchain `node_modules` symlink for that delegated build.
The top-level Wrangler development dependency is a separate execution path: repository type
generation and local Worker integration tests invoke it directly. Removing either copy requires
replacing those typegen, local-integration, project-build, deploy and rollback paths together; a
version-only deletion is not an equivalent toolchain.

The reviewed cf artifact is `1.0.0-beta.20`: bundle `dist/dist-CX6dDtzj.mjs` with SHA-256 `d4bb24517159c0b8d799f39b54ebb066fc7933435276f7ff3fdab965b18bb36b`, bundled Undici `8.12.2`, and Miniflare `5.20261019.1-beta` / workerd `1.20261019.1` in the private lock.
`cf-network-integrity.mjs` verifies the package version, the manifest's bundled Undici declaration, the bundle hash and the pinned Undici export before execution.
`cf-build:test` additionally runs a real `cf build` in a private fixture with the top-level toolchain and validates the delegated Wrangler Build Output contract.
One process-identity owner lock protects installation, dependency verification, cf artifact verification and audit refresh.
The immutable upstream bundle must match `cf-network-integrity.mjs`; symlinks, hard links, writable artifacts, unknown bytes and dependency drift fail closed.
Offline behavior tests prove custom connector and TLS-verifier preservation.
No cf bundle rewriting remains.
Integrity corruption in the manifest or dependency tree can trigger reconstruction; operational failures preserve the existing tree, and unknown cf bundle bytes do not trigger destructive replacement.

The shared hardened npm bootstrap downloads exact npm 12.0.2, Undici 6.28.0 and brace-expansion 5.0.12 artifacts with fixed registry SHA-512 SRI, redirect rejection, byte ceilings, no-progress and absolute deadlines, and bounded transient retries.
It replaces the vulnerable stock npm libraries and verifies each identity and the reported npm version.
Runtime deployment, CI, candidate installation, consumer verification and publication use this non-global CLI.
Private launchers bind Node and npm together so nested lifecycle commands cannot reselect an ambient npm.
Temporary launchers are removed on settlement; the verified cache remains.

The installed dependency tree, zero-vulnerability audit and registry signatures are independent requirements.
Audit counts must be native integers with consistent totals; the content-free marker expires after 24 hours.
Build Output validation checks the Worker identity, SQLite Durable Object export, preserved binding types and exact rate-limit parameters before deployment.
Module paths remain inside the bundle, with count and aggregate-byte ceilings.
Private-project and npm-session cleanup preserve primary failures and aggregate cleanup failures.
Candidate-bound deployed-edge acceptance remains necessary.

## Release integrity

Repository-local checks cannot prove the ordinary deployed path.
`local-release-acceptance.mjs` builds, records, and verifies the exact tarball and promotion-content digest through an ephemeral hardened npm session; the guarded first push repeats acceptance/soak verification through the same controlled CLI before remote mutation.
The owner executes `release:candidate:activate`, which installs the tarball under the private state root and invokes the extracted `runtime-activation` state machine.
The transaction acquires the machine-service lock before the workspace startup lock, rejects foreground or unverifiable ownership before provider mutation, authenticates the candidate daemon through the real Worker, and proves relay readiness before writing the service definition.
Installation commits a machine-global owner record for the exact workspace, state root, entrypoint, and version.
The login-service handoff succeeds only when that owner's daemon lock publishes the post-`ready_ack` readiness checkpoint; provider-active state alone cannot satisfy acceptance.
A first explicit device-authentication rejection triggers exactly one same-name, same-identity repair deployment, followed by ten bounded fresh candidate starts with exponential delay.
Timeout, TLS, proxy, health, integrity, and policy failures do not enter that remote-write retry path.

Failure compensation is a separate state machine from normal service start.
If remote preparation has already advanced the deployment and activation still fails, cleanup installs the compatible candidate definition and invokes the platform provider directly rather than restoring an incompatible previous runtime or using the strict owned-service helper that stops a provider after an initial readiness miss.
Compensation then independently waits for the exact candidate entrypoint/version to appear as a verified service daemon, publish post-`ready_ack` readiness, and match the Worker.
A merely loaded/active provider is not recovery evidence.
When the foreground candidate never reached readiness, complete compensation remains diagnostic and the original activation failure is returned.
When the foreground candidate had already completed readiness, recovered success is still restricted to an explicit allowlist of operational handoff codes: relay authentication rejection, autostart installation failure, or autostart start/persistence failure.
Unknown `Error`, `TypeError`, `RangeError`, lock, invariant, and cleanup failures remain nonzero even if the exact service is available.
Successful recovery carries only an allowlisted reason plus its reason-owned canonical detail through CLI JSON, owner output, and activation evidence; raw lower-layer exception text remains local causal/debugging state and cannot become recovered-success evidence.
Before remote transition, a previous service is considered restored only when the same version and entrypoint reappear as a verified service daemon.
That transaction-scoped service identity is distinct from the activation record's optional `global_package_rollback_baseline`, which names only the globally installed npm package available for later operator-directed disaster recovery.
The current activation record contract is schema 2 only.
The activation wrapper has no outer transaction-wide `SIGKILL`; each deployment, network, relay, service-manager, and convergence stage owns its bounded deadline so cleanup cannot be bypassed.
Fault-injection tests cover lock ordering/release, pre-mutation foreground refusal, owner transaction failure, missing/corrupt/pending owner state, readiness failure, authentication repair and exhaustion, compatible-service convergence/non-convergence, service-identity restoration, primary-plus-cleanup aggregation, failed service start, and convergence timeout.
Candidate-wrapper authorization is evaluated before network/setup work, rollback package evidence is read while the temporary npm CLI still exists, install-only uses the disposable foreground prefix, and persistent inactive-runtime pruning accepts only canonical real contained directories.
All blocking cleanup finishes before the activation record is written.

Accepted prereleases use explicit npm/GitHub channels and a registry-verified activation record.
`release-soak.mjs` enforces elapsed major/minor/patch observation windows.
`promotion-digest.mjs` hashes the npm package inventory, file modes, and bytes while normalizing only synchronized version metadata; stable release is blocked if any functional packaged content differs.
Guarded push, portable CI acceptance, GitHub source release, npm publication, and stable publication all validate the relevant acceptance/soak evidence.
GitHub and npm publication both stage the no-follow, single-link accepted candidate into private temporary storage instead of repacking source.
Before upload, npm's dry-run must match accepted name/version/SHA-1/SRI.
After any success or failure result from an irreversible upload, bounded reconciliation requires the exact npm version/SHA-1/SRI/dist-tag/publication metadata or GitHub prerelease/final metadata plus REST SHA-256 asset.
Exact preexisting objects settle idempotently; unresolved outcomes remain explicitly ambiguous and prohibit blind retry.
Published-install and soak checks repeat those identities.
GitHub tag/Release mutation is standing-authorized after exact acceptance, exact `main`/remote state, required exact-commit workflows, digest/reconciliation checks, and the common-Git-dir process-identity publication lock all pass; it does not require a conversational confirmation flag or TTY ceremony. npm registry publication remains the sole explicit current-task owner authorization boundary and requires its `--owner-confirm` entrypoint flag.
Release/acceptance/soak GitHub control paths resolve trusted absolute git/gh executables rather than npm-modified PATH entries, retain Git HTTP/1.1 stabilization for absolute executables, and hard-bound every network attempt.
Release commands require `HEAD === origin/main` and never push `main` implicitly.

Cross-platform evidence is owned by the current repository scripts and GitHub **Workflow Policy Gate**.
`.github/scripts/workflow-policy.mjs`, its single-workflow rules module, and its six-workflow semantic contract module implement that gate without shipping governance code in the npm package.
The old local `.workflow/` bundle is historical only: current build, validation, release, authorization, and agent-routing code must not depend on it, so it may be removed from a working copy without changing product behavior.
Required release commands and action inputs are bound to executable YAML structure; comments, step names, unrelated scalar values, and near-match commands cannot satisfy the contract.
`scripts/github-release.mjs` queries CI, CodeQL, Governance, Workflow Policy Gate, and Scorecard for the exact `origin/main` commit and requires the newest push-triggered run for each workflow to be completed with `success` before it creates or verifies a version tag, GitHub Release, or package asset.
Pull-request runs, older successful runs, pending runs, and successful runs for another SHA do not satisfy the gate.
The workflow selection policy is isolated in `scripts/release-ci.mjs` and tested independently.

Third-party workflow actions are pinned to immutable commit SHAs.
Dependabot groups GitHub Action updates into one reviewed PR so coupled action families cannot drift across versions.
`architecture:test` rejects movable action tags, split update policy, loss of local acceptance verification, or removal of the reachable-history package-audit step.

## Runtime and verification boundaries

Release evidence depends on runtime, delivery, and verification invariants documented in
[Runtime and verification boundaries](runtime-verification.md).
