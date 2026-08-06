# Project standards

This document defines the repository-wide engineering and collaboration standard. It complements the product and security invariants in [ENGINEERING.md](ENGINEERING.md). A rule is preferred only when it reduces material risk, makes review easier, or can be enforced consistently; ceremony without a credible failure mode is not a quality control.

## 1. Change flow

The repository uses **GitHub Flow**:

1. create a short-lived branch from current `main`;
2. make one coherent change, including tests and documentation;
3. open a pull request and let required checks complete;
4. resolve review conversations and rebase or update the branch when required;
5. squash-merge into `main` and delete the branch.

Permanent `develop`, `feature`, and `release` integration branches are not used. A supported maintenance line may use a temporary `release/x.y` branch only when an older published version must receive fixes independently of `main`.

Branch names use a short category and purpose, for example `feat/browser-downloads`, `fix/relay-timeout`, `docs/release-guide`, or `chore/dependency-policy`.

Direct pushes to `main`, force pushes, and branch deletion are blocked by repository protection. An exception requires an incident record and an explicit owner decision.

### Local repository readiness and release readiness

A review or automation report must state the scope of its readiness claim. `local_repository` readiness means that the current working-tree candidate is bound to its objective revision, has passed every required local and project-native verification stage, has requirement-specific evidence, and has the required reviews. It does not assert that a hosted Worker, browser client, GitHub repository, npm registry, service installation, or production network currently matches that candidate.

`release_ready` is a separate claim. It requires the exact candidate identity plus the applicable independent-environment and independent-authority lifecycle evidence, including hosted CI and security checks, candidate activation where package behavior changed, publication controls, and any required soak. A local simulator, local owner attestation, or absence of a local failure cannot substitute for those external observations.

During a deliberately local-only review, not invoking activation, publication, push, tag, or hosted-mutation commands is evidence that the observed review path did not request those side effects. It is not evidence that external state is healthy or synchronized. Reports must retain that limitation and list missing external stages rather than converting them into local blockers or silently treating them as passed.

### Completion ownership, prerelease activation, and soak

Repository automation owns implementation, local validation, candidate preparation, observed verification, acceptance recording, and pull-request completion. Package work for version 3 or later must use a `dev`, `beta`, or `rc` version before stable promotion. Direct implementation-to-stable release is prohibited.

`npm run release:candidate` creates the exact tarball. The repository owner executes `npm run release:candidate:activate -- --allow-worker-deploy`; the command installs that tarball under the private state root, updates the same-name Worker, verifies candidate relay readiness, replaces the login daemon, verifies the background handoff, and exits. The coding agent then performs observed live verification through Machine Bridge and records acceptance only after that observed success. No per-operation terminal approval is involved.

The tracked `release-acceptance/v<version>.json` binds npm hashes, a portable package digest, and a version-normalized promotion digest. Any packaged change invalidates acceptance. `npm run github:push`, CI, and source-release commands verify the record. Raw pushes of package branches are prohibited.

The accepted prerelease's Git tag and GitHub Prerelease are created only by the repository owner from a real interactive terminal with `npm run prerelease:release -- --owner-terminal-confirm`; npm publication remains a separate explicit owner operation through `npm run prerelease:publish`. The owner installs the exact registry version with `npm run prerelease:install -- --allow-worker-deploy`. Formal soak begins only from this registry-verified activation. Minimum soak is seven days for major, three days for minor, and one day for patch releases. A blocking defect increments the prerelease number and restarts the soak interval.

Stable promotion requires a tracked `release-soak/v<stable>.json` and identical promotion-content digest. Only normalized release metadata may differ from the soaked prerelease. The stable candidate is activated and observed again before the repository owner creates the final Git tag and GitHub Release from a real interactive terminal with `npm run release -- --owner-terminal-confirm`; npm stable publication remains a separate explicit owner operation through `npm run stable:publish`.

GitHub-only repository infrastructure changes that do not alter npm package contents do not require a synthetic version, candidate activation, or soak. They still require review and applicable checks.

### Local GitHub control plane

Before any GitHub read or mutation, repository automation must load the effective project instructions through Machine Bridge. It must then use local `git`, `gh`, and `gh api` commands executed through Machine Bridge for every GitHub read or mutation. A hosted GitHub connector, ChatGPT GitHub plugin, browser-side GitHub integration, or second remote control plane must not be used. If Machine Bridge or the local authenticated CLI is unavailable, the operation stops and reports that boundary rather than falling back. Mixing control planes can produce stale refs, unreviewed remote-only commits, ambiguous credentials, and recovery paths that cannot be reproduced from the maintainer's machine. Fetch before mutation and verify the remote result afterward.

## 2. Commits and pull requests

Commit and squash-merge subjects follow Conventional Commits:

```text
<type>[optional scope][optional !]: <imperative description>
```

Allowed types are `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `security`, `release`, and `revert`. `feat` and `fix` carry their normal semantic-version meaning. A breaking change uses `!` and explains upgrade impact in the body or a `BREAKING CHANGE:` footer.

A good change explains both **what changed and why**. Commits should be logically coherent, but intermediate branch history may be amended because the final pull request is squash-merged. Pull-request titles must satisfy the same format because they become the `main` commit subject.

Pull requests must state:

- the problem and causal mechanism;
- the chosen solution and important rejected alternatives;
- user-visible, compatibility, security, privacy, and operational risk;
- tests and manual verification performed;
- documentation, release, and rollback consequences.

Keep a pull request small enough to review as one argument. Generated files, mechanical renames, or dependency lockfile changes should be isolated when they obscure substantive behavior. Large changes should be split by a stable contract, not into dependent fragments that cannot be evaluated independently.

## 3. Architecture and dependency direction

The architectural dependency direction in [ENGINEERING.md](ENGINEERING.md) is normative. In addition:

- A module owns one coherent reason to change. Related state-machine transitions may stay together when ordering is part of the safety argument.
- Domain modules do not import CLI, transport, service, presentation, or deployment adapters.
- Cross-layer calls go through an explicit interface or orchestration boundary; no adapter reaches through another layer to mutate its internals.
- Policy, schemas, error codes, protocol metadata, and capability inventories have one authoritative source. Adapters translate them but do not maintain parallel copies.
- Side effects are isolated behind small interfaces so policy and lifecycle behavior can be tested deterministically.
- Dependency cycles are prohibited. Hidden global state and import-time operational side effects are avoided.
- Line-count and complexity thresholds are diagnostic guardrails, not design goals. A threshold may not be satisfied by moving incoherent code into a generic utility module.
- **High cohesion and low coupling:** one source file or function owns one coherent responsibility and reason to change; collaboration occurs through narrow explicit contracts rather than cross-layer reach-through.
- **KISS:** prefer the simplest explicit implementation that satisfies current requirements. Do not introduce factories, registries, inheritance, generic frameworks, or configuration layers without an observed variation that needs them.
- **DRY:** extract repeated business rules, validation, security boundaries, or lifecycle logic into one authoritative implementation. Do not merge merely similar code when its semantics or failure policy differ.
- **Exact key membership:** external string keys used for dispatch, enums, ACLs, forms, or registries use `Map`, `Set`, `Object.hasOwn`, or null-prototype records. Prototype-chain membership and truthy ordinary-object lookup are not contract validation.
- Design patterns are used only when they remove an observed variation or coupling. A direct function or small module is preferred over speculative abstractions.

Any deliberate boundary exception must document the dependency, reason, owner, test coverage, and removal condition.

## 4. Public contracts and generated documentation

The MCP tool catalog in `src/shared/tool-catalog.json` is the authoritative public API description. Tool names, availability, annotations, and JSON input schemas are rendered into [TOOL_REFERENCE.md](TOOL_REFERENCE.md); CI rejects stale generated documentation.

Swagger/OpenAPI is required only if the project later exposes a user-facing HTTP REST API. It is not a substitute for MCP tool schemas or end-to-end MCP protocol tests. Hand-maintained copies of generated contracts are prohibited.

A public contract change must address:

- backward and forward compatibility;
- bounded input and output behavior;
- authorization and destructive-operation annotations;
- stable error classification;
- protocol negotiation or versioning when peers may differ;
- documentation, tests, changelog, and semantic-version impact.

## 5. Testing and quality gates

Tests follow risk rather than a repository-wide aggregate percentage:

- Every defect fix includes a regression test that fails for the original causal reason.
- Pure policy and normalization logic is tested directly; adapters receive integration coverage proving that they use the policy correctly.
- Permission expansion includes denial tests. Bounded resources include over-limit tests. Multi-stage mutations include partial-failure and rollback tests.
- Concurrency, locking, process trees, persistence, cancellation, retry, and recovery require behavior-level or fault-injection coverage.
- Protocol changes include producer-consumer contract tests and malformed-input tests.
- Supported operating systems run the required suite in CI.
- Critical modules have explicit function and branch baselines. Thresholds may rise after better tests or extraction; lowering one requires an audit note explaining why the old measurement was misleading.
- High-risk JavaScript contract modules opt into strict TypeScript checking through `tsconfig.local.json`; implicit `any`, `@ts-ignore`, and untyped duplicate protocol/configuration shapes are not acceptable substitutes for a defined boundary.

An 80% aggregate coverage target is not a repository requirement: it can hide untested critical branches behind trivial files. New or materially changed pure business modules should normally achieve at least 80% function coverage and meaningful branch coverage, but risk-specific tests remain the acceptance criterion.

Flaky tests are defects. A retry may diagnose environmental instability but may not be used to make a nondeterministic test appear healthy.

## 6. Errors, retries, and logs

- Expected operational failures use typed stable error codes and concise operator messages.
- Unexpected programming errors remain distinguishable from ordinary unavailability.
- Request boundaries normalize errors once. Lower layers preserve causes and do not repeatedly translate them.
- Cleanup catches may be best effort only when the primary failure is retained and cleanup failure is observable where useful.
- Empty catches and catch-and-continue behavior are prohibited unless a comment explains why the event is intentionally irrelevant.
- Retries require positive transient classification, bounded attempts, backoff, and idempotency or authoritative state reconciliation.
- Unhandled process-level exceptions are logged with redaction and cause controlled termination; continuing in an unknown state is not a recovery strategy.
- Operational logs follow [LOGGING.md](LOGGING.md), remain structured, bounded, actionable, and free of secrets or user content.

## 7. Security and software supply chain

- GitHub workflow permissions default to read-only and are expanded per job only when required.
- Third-party Actions are pinned to immutable commit SHAs and reviewed when Dependabot updates them. GitHub Action updates are grouped into one atomic pull request so coupled suites such as CodeQL cannot be split across incompatible versions.
- npm dependencies use exact versions and a committed lockfile. Source bootstrap uses `npm ci`; the CI npm baseline itself is downloaded from an exact URL and verified against a pinned SHA-512 SRI before use. Registry signatures and attestations are verified in CI.
- Dependency review blocks newly introduced vulnerable dependencies. CodeQL performs JavaScript/TypeScript and workflow analysis. OpenSSF Scorecard audits supply-chain posture, and both SARIF streams are failing gates with exact, expiring exceptions rather than advisory-only uploads.
- CI generates and validates a CycloneDX SBOM. Release artifacts must match the repository-owner-tested tarball hash, be reproducible from a reviewed commit, and be tied to successful exact-commit CI, CodeQL, Governance, Workflow Policy Gate, and Scorecard evidence.
- Secret scanning and push protection are enabled. Repository examples use synthetic identities and reserved domains; reachable history is scanned before release.
- Long-lived publication tokens should be replaced by npm trusted publishing with GitHub OIDC. Until that external registry configuration is completed, release credentials remain an explicit operator responsibility and must never be stored in the repository.
- Security reports follow [SECURITY.md](../SECURITY.md), not public issue templates.

## 8. Documentation and comments

- README covers supported setup, operation, major capabilities, limitations, and risk.
- Architecture, security, testing, operations, logging, policy, upgrade, support, governance, and release documents each own their designated concern; avoid repeating whole procedures across files.
- Documentation claims a guarantee only when code, configuration, or a test enforces it.
- Public behavior changes update the changelog and relevant user documentation in the same pull request.
- Comments explain non-obvious **why**, invariants, external constraints, and safety ordering. They do not narrate self-explanatory syntax.
- Temporary workarounds state the triggering condition and removal criterion; use an issue reference when one exists.

## 9. Review and ownership

`CODEOWNERS` identifies responsible areas and requests informed review. It does not prove independent review when author and owner are the same person.

Review examines correctness, causal completeness, security/privacy boundaries, compatibility, failure paths, observability, test evidence, and maintainability. Style preferences do not override a simpler correct design without a documented project rule.

This repository currently has one human maintainer. Requiring one independent approval would deadlock maintenance and therefore is not enabled. [GOVERNANCE.md](../GOVERNANCE.md) defines admission, succession, release authority, and the first mandatory control after another active maintainer is added: one non-author approval plus last-push approval for security-sensitive, release, policy, Worker, browser, state, and execution changes.

## 10. Exceptions and evolution

A standard may be changed when evidence shows that it creates more risk or cost than it removes. The change must update this document, relevant automation, and the changelog together. Silent exceptions and permanently waived failing checks are prohibited.
