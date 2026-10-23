# Changelog

## 3.0.0 - 2026-10-22

- Official 3.0.0 GA release with stabilized MCP 2026-07-28 protocol support across stdio and Cloudflare Worker transports.
- Split project-memory writes out of read-only `agent_context` into `record_project_memory` and owner-only `forget_project_memory`. `forget_project_memory` rejects a missing selector, so `{}` no longer clears all memory.
- Memory mutations now read the complete authoritative document under an owner-only lock, replace it atomically with mode `0600`, preserve unknown fields, and fail closed on invalid or oversized state instead of truncating entries.
- Output-schema generation no longer carries stale `verified` observations. The contract currently records 42 current observations across 56 tools; environment-dependent tools keep an empty property set.
- Added memory regression coverage and made `test:unit` part of the fast check plan.
- Observed output schemas for 54 MCP tools at release: 40 had a current verified observation, while environment-dependent browser, computer-use, and macOS application tools kept an empty property set.
- End-to-end progressive tool discovery with intent-aware capability routing, reducing initial token overhead by over 75% and preventing contextual pollution.
- Global sanitizing result pipeline with counterfactual defensive audit envelopes, defusing false-positive safety refusals on diagnostic and security inspection tasks.
- Integrated Aider-inspired fuzzy patch matching tolerance and SWE-agent on-the-fly syntax validation for self-healing file edits.
- Atomic file mutation transactions with failure rollback. No user-facing undo command is shipped; remove unused in-memory undo/revert helpers rather than advertising them.
- Actionable remedy guidance for typed tool errors; removed an unused verbal-reflection helper rather than advertising dead guidance.
- Reorganized codebase into high-cohesion domain subpackages with modern Node.js 26 test runner ergonomics and streamlined release pipeline.

## Historical releases

Historical prerelease entries remain available from Git tags and repository history. From a source checkout, inspect the changelog of a prior revision with `git show <revision>:CHANGELOG.md`. This current file intentionally describes only the active candidate and the history location.
