# Current audit status

The source dependency override and private hardened npm bootstrap pin brace-expansion 5.0.12 with the registry SHA-512 artifact integrity, addressing GHSA-q2hr-2g5m-vwhr, GHSA-qhr7-859c-m2p7, and GHSA-6j4f-fj2g-mc7p. Consumer packages have no postinstall hook. The original upstream cf bundle must pass its pinned integrity check before private CLI execution. Real private builds declare the exact audited Wrangler provider and receive the executable runner.

Both the source and private toolchains also pin transitive `undici 7.30.1` and `zod 4.6.7` through bounded overrides, closing GHSA-4qv8-2p9j-2685, GHSA-f72v-6w45-q472, GHSA-xjj6-f33q-929c, and GHSA-mrhx-c7xc-m3w5 without changing the audited cf/Wrangler providers. Both lockfiles pass `npm audit --audit-level=high`.

Source and private Cloudflare toolchain pin Sharp 0.35.5 (GHSA-wq5f-xc86-pv6w). Integrity checks reject older installs; consumer trees require 0.35.5 or newer. Audit each lock separately.

This file is a compact statement of current cross-cutting audit conclusions and residual limits. It is intentionally version-agnostic: release identity, candidate acceptance, publication state, and soak state are authoritative only in package metadata, release records, Git history/tags, and the external release systems they describe. This file is not a release-state authority.

## Review scope

This review is scoped to source contracts, risk-bearing control paths, isolated local regression fixtures, dependency evidence, and current operational limitations. A passing local gate does not prove installed-browser, hardware-backed key, deployed Worker, cross-platform, or published package behavior. The original failure fixtures remain in tests; prior investigations and superseded candidate details remain in Git history/tags.

## Current conclusions

- **Authority is an intersection.** Account role, daemon capability ceiling, and tool policy apply on every call. Remote arbitrary execution is owner-only; reconnects, discovery and recovery cannot expand access. Current request-scoped MCP metadata is mandatory; removed handshakes remain rejected.
- **Reads and persistence fail closed.** Protected readers enforce canonical paths, regular-file identity, hard-link rejection, encoding and byte budgets. Sensitive-path filtering covers delegated content; filename checks cannot recognize secrets stored under arbitrary names. State-authority failures are never interpreted as empty records, and coercible values cannot become PID, lock or lease authority.
- **Writes retain their generation.** Atomic claims are complete before publication. Bounded sharing-error retries preserve the visible destination and recheck the expected digest. Cross-process optimistic checks do not provide an OS compare-and-swap against uncoordinated external writers; Windows CI supplies provider evidence.
- **Budgets cover allocation and work.** Output buffers trim before retaining backing bytes and copy independent snapshots. The stdio writer has an 8 MiB queue with backpressure and closes input at the hard cap. Context indexing and subscriptions separately bound traversal, input, rendering, retained IDs and count.
- **Durable execution owns continuity.** Managed jobs retain recovery independently of MCP delivery. Idempotency deduplicates only while the original record is retained. Callers recover the same job after ambiguous acceptance. Cancellation, dependencies, terminal persistence, stable file generations and cleanup have distinct ownership. Successful settlement terminates retry classification.
- **Relay generations do not confer replay authority.** Ended transport controls are discarded, reconnects cannot accumulate execution or delivery grace, and unknown mutations are not repeated. Routine retention scans are throttled; pressure and risky retained states force maintenance. Node children use a verified runtime launcher; unavailable executable identity requires service recovery rather than PATH guessing.
- **UI actions consume exact evidence.** Browser actions bind the existing profile, explicit tab and observation generation; desktop actions bind process/window identity and an authorized backend. Timeout, response loss or ambiguous dispatch becomes non-retryable unknown settlement requiring observation. No arbitrary browser/application evaluation is substituted.
- **Diagnostics preserve privacy and time scope.** Logs exclude tool inputs, output, credentials and private identifiers. Audit events retain the settlement observed at recording time; recent unknown/pending counts are historical, while process termination counters describe current state. OS sleep can explain suspension but cannot prove an unrelated network cause or uninterrupted execution.
- **OAuth replay evidence remains narrow.** Refresh retries return only an active derived pair; consumed replacements and revoked families fail. Local regression fixtures do not establish deployed OAuth persistence, which requires the candidate-bound canary.
- **Supply-chain checks include actual bytes.** Consumer runtime excludes cf/Wrangler/Miniflare. The private toolchain checks exact locks, installation policy, registry signatures, audit and the unchanged pinned cf artifact before execution. Authentication must be positive before deployment; deployment identity, snapshot paths/bytes, preserved state and rate-limit bindings remain validated. A zero-vulnerability audit cannot certify bundled code or deployed behavior.
- **Identity and release authority are explicit.** Branch routing and prerelease routing use their own evidence, not directory names or dirty package metadata. Full verification, package integrity, activation, observed acceptance, external checks, publication and soak each require their dedicated records. Audit prose grants none of that authority.

## Relay quota incident evidence boundary

The prior relay could poll signed HTTPS while WSS was healthy; ready HTTPS polled every second. The current design stops fallback while WSS is verified healthy, uses five-second ready-idle polling and thirty-second successful-standby retries, and retains the 750 ms minimum request-start interval for handshake/queued work. Accepted signed HTTP requests and WebSocket preflights each consume one bounded Durable Object replay-nonce write; rejected replays consume none. The request/nonce regression covers idle polling plus failed WSS reconnects, not all readiness resets or traffic. The separate idle-day regression includes nonce storage and liveness alarms; the repository testing guide records its scope.

The checked-in and inspected deployed bridge use SQLite-backed Durable Objects with no Workers KV namespace binding. Repository evidence establishes Worker request and Durable Object persistence amplification, not the origin of an account-wide dashboard item labeled KV. Attribution requires provider counters by UTC day, script, namespace and deployed bindings; another workload may consume a shared allowance. Provider identifiers, account data and request contents stay outside public evidence. Local counts do not establish billing, candidate-bound deployed behavior or completed soak.

## Security exception review

On 2026-10-17, the retrieved Scorecard report from GitHub Actions run 38581193758 contained only CodeReviewID and CIIBestPracticesID. The expired MaintainedID and SASTID records are removed instead of extended. CodeQL 2.27.2 analysis 1944825726 still reports the three exact accepted rule/file pairs. Their current source was re-reviewed and the expiry is bounded to 2027-01-15. The insufficient-password-hash location is the signed admin request-body digest in accountAdminRequestHeaders, not a password database KDF; its prior rationale is corrected. The other two findings describe the intentional policy-authorized direct-executable boundary with shell=false. No new rule/path exception is introduced.

The fast SARIF regression now loads both real checked-in exception documents against a valid completed zero-finding report. Expired metadata fails before the expensive integration suite even when a particular report has no matching finding. These decisions remain exact, time-bounded exceptions; fresh external security checks are still required for the delivered commit.

## Residual limits

- The default full profile is intentionally powerful. It is appropriate only where the daemon OS user is itself an acceptable trust boundary; stronger hostile-code isolation requires a separate OS account or VM/container.
- The relay can recover from many transport failures, but no software can promise uninterrupted connectivity across machine sleep, host suspension, upstream outages, VPN/TUN behavior, or process replacement. Recovery evidence must not be restated as a no-disconnect guarantee.
- Machine Bridge can observe that a hosted tool call reached the daemon and can retain durable job results, but it cannot prove that a ChatGPT host turn ended normally or that a final UI frame rendered to the user.
- Browser status proves the connected extension identity/capabilities, not that the paired profile is the user's intended daily versus isolated profile. Unpacked extensions may require an explicit reload after upgrades before browser automation counts as exercised.
- Privacy-preserving diagnostics deliberately leave some root causes unassigned. In particular, spontaneous upstream transport resets may remain indistinguishable once exposing packet contents, private URLs, or user traffic would be required to disambiguate them.
- Passing local tests is necessary but not sufficient release evidence. External CI, package integrity, installation, deployment/activation, live boundary tests, and soak requirements remain separate when the changed surface requires them.

## Historical findings

Historical incidents, closed hypotheses, release-by-release evidence, and superseded candidate details belong in Git history/tags and the [changelog](../CHANGELOG.md), not in this current summary. Inspect the file at the corresponding historical revision when reconstructing an old incident or release decision.

## Historical dispositions

The 2026-10-21 follow-up dispositions (findings 01–31) are historical and remain in the tagged revision that produced them; they are not current audit evidence. Use Git history/tags for the numbered findings and the [changelog](../CHANGELOG.md) for release-by-release changes.

The research comparison records 51 distinct pinned upstream project snapshots and 19 foundational/recent papers in [COMPARATIVE_REVIEW.md](https://github.com/YuLeiFuYun/machine-bridge-mcp/blob/main/docs/COMPARATIVE_REVIEW.md). The pinned commits are the reproducibility evidence; separately dated rolling-maintenance notes may record later upstream status without rewriting what a pinned revision proved. This is selected design/documentation evidence with explicit adoption boundaries, not an exhaustive source audit, live model evaluation, or transferred benchmark score.
