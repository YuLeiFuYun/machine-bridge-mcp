# Changelog

## 3.0.0-beta.206 - 2026-10-20

- Fix minute-boundary calculation in progress reporter elapsed formatting to prevent overflow past 60 seconds.
- Wire progressToken through Worker MCP HTTP contract handling and streamed response dispatch.
- Remove redundant duplicate self-comparison import in records test suite.
- Enforce `package.json`/`package-lock.json` root version parity in the version-sync gate and package test.
- Run progress reporter unit tests against the shared production module, retaining only a local compatibility re-export.
- Remove the legacy stdio handshake and metadata-normalization mode, including the CLI option and environment switch.
- Document that multi-file patch rollback covers ordinary operation failures but is not crash-atomic across files; single-file write/edit visibility remains atomic.
- Add a child-process regression that reproduces the multi-file patch crash window and verifies retained backup/staging artifacts.
- Expand recursive-search control-plane filtering tests to cover security, browser-pairing, and service-control roots, and test stdio EOF cancellation and output-write failure.
- Add regression coverage for bounded stdio error responses and serialized concurrent task-state updates.
- Expand stdio output queue limit and reservation to safely process concurrent maximum-size tool results without dropping the transport.
- Implement remote Worker MCP Tasks operations (`tasks/get`, `tasks/update`, `tasks/cancel`) for clients that advertise the Tasks extension; local stdio intentionally does not advertise it, `tasks/list`/`tasks/result` aliases are unsupported, project cleanup/interrupted recovery states as active tasks, and tasks without a persisted terminal result fail explicitly if their backing job record disappears before result capture.
- Centralize MCP task job-ID validation in the shared task contract so task creation, dispatch and durable-record validation use one pattern.
- Add actionable error guidance (actionable_remedy) for agent reflexion on tool execution failures.
- Expand local TypeScript type checking coverage to 74 checked modules with strict JSDoc typing.
- Consolidate cross-module integer validation helpers into shared runtime modules.
- Add standard npm test script mapped to the verification runner.
- Tighten TypeScript compiler checks with noFallthroughCasesInSwitch, noImplicitReturns, and noUncheckedIndexedAccess.
- Include previously orphaned tests into the check runner plan.

## Historical releases

Historical prerelease entries remain available from Git tags and repository history. From a source checkout, inspect the changelog of a prior revision with `git show <revision>:CHANGELOG.md`. This current file intentionally describes only the active candidate and the history location.
