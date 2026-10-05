# Changelog

## 3.0.0-beta.198 - 2026-10-03

- Redact macOS temporary-path aliases and truncated Windows case aliases from managed-job output.
- Decode sensitive URL parameter names before log redaction; redact complete and truncated private-key bodies.
- Reject coerced Cloudflare account identifiers and malformed token-validity evidence.
- Stream deployment-source enumeration with entry, depth, file-count and byte budgets.
- Persist confirmed Worker upload evidence before endpoint parsing or staging cleanup can fail; reconcile unknown endpoints instead of automatically uploading again.
- Consolidate duplicate engineering release guidance under the canonical releasing procedure.
- Drain durable authority revocations in bounded HTTPS batches without losing acknowledgements or invalidating healthy channels; include sequence/envelope overhead in response budgets and atomically persist replay-capacity family eviction with its revocation.
- Preserve replacement WebSocket connection deadlines when stale events arrive, and settle asynchronous gateway/signature failures through typed responses.
- Reject malformed revocation/OAuth/DPoP inputs, non-boolean account activation values and inherited enum keys; revalidate current authority and respect pre-existing cancellation before daemon dispatch.
- Preserve monitor transitions across sequence rollover and bound observability overflow without recursive failure.
- Bind instruction/skill reads, file rollback, lock recovery, directory traversal, SSH publication and state cleanup to verified identities; validate config paths before reading and preserve unrelated replacements and failure evidence.
- Keep process, session and runtime ownership through asynchronous settlement and retain candidate daemon ownership after failed shutdown; close late-spawn shutdown races, terminate SSE encoding/projection failures, bound invocation inputs, and give isolated jobs private runtime directories.
- Fence browser renderer mutations by cancellation/deadline authority, including asynchronous actionability waits and socket replacement.
- Verify Secure Enclave provenance before native export, signing or deletion; reject oversized signing input before EOF or Keychain access.
- Sanitize default CLI errors and reject incomplete, failed, inconsistent or scalar-coerced SARIF evidence; prevent conformance credentials from reaching child environments and release proxy readers after disconnect.
- Implement the declared empty resource-template list, remove stale resource conformance exclusions, and keep unknown-resource errors bounded without reflecting their URI.
- Apply path-display policy before skill warning sanitization/truncation and preserve dollar signs as literal text in path projections and file edits.
- Harden generated Worker type recovery with bounded no-follow reads; share strict consumer/deployment audit validation and fixed Worker persistence error classes without copying arbitrary exception names.
- Wait for the full-access fixture's verified runner exit before deleting job state, restore its environment on shutdown failure, and use the production Swift driver for native provenance tests.
- Remove arbitrary peer-supplied WebSocket close reasons from debug logs while retaining fixed protocol classifications and outage recovery summaries.
- Use locked dependency installation in the Windows checkout launcher and fail on setup errors without stale exit-code expansion; share private npm launchers across CI and temporary toolchains so nested lifecycle calls retain the pinned CLI.
- Correct the public validator's readonly-array declaration and inspect dependencies through one syntax-aware source graph, including escaped paths and declaration files.
- Share bounded child readiness, capture and exit cleanup across managed-job/process-lock fixtures, with one deadline for preparation and settlement. Prove recovery-lock handoff before corruption assertions and descendant readiness before publication timeout assertions; await runtime teardown and consolidate screenshot rejection setup while retaining distinct cleanup assertions and browser limits.
- Require both markers in source-order guards and share exact script checks/source reads. Reject event-derived shell expressions with a bounded scan and alternate YAML mappings before dependency-free workflow policy reads.
- Recheck Git metadata directory identity after opening and traversal, and preserve cancellation during empty-directory opening.
- Share bounded browser screenshot validation and one observation decode; assert fixture outcomes and clear failed-handshake deadlines.
- Reject coerced or malformed consumer dependency/SBOM evidence and duplicate graph edges without string normalization.
- Replace the repeated test-case inventory with a current regression map, and remove repeated overview/release/install instructions while retaining canonical recovery, authority and privacy contracts.

## Historical releases

Historical prerelease entries remain available from Git tags and repository release records. From a source checkout, inspect the changelog shipped by a prior release with `git show v<version>:CHANGELOG.md`. This current file intentionally describes only the active candidate and the history location.
