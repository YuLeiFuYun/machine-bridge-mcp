# Changelog

## 3.0.0-beta.222 - 2026-11-21

- Refactor `src/local/` and `src/worker/` into focused domain submodules (`src/local/{agent,automation,cli,core,deploy,files,git,jobs,process,runtime,state,transport}`, `src/worker/{daemon,mcp,oauth,room}`), expand `@ts-check` coverage, and split large automation/runtime/job modules into single-purpose units.
- Add `browser_network_log` (bounded 200-entry CDP ring buffer with credential/header redaction and 10 s command timeout), per-caller `tab_owner` / `owned_by_caller` tracking, `computer_observe` `include_marks` Set-of-Marks and `unlabeled_interactive_count` DOM telemetry, plus standalone `verify` and `pair` CLI commands.
- Add operation reversibility classification (`classifyReversibility`), cached privacy denylist loading (`loadPrivacyDenylistCached`), session taint advisories, 4-pattern `StuckLoopDetector` loop detection, bounded per-tool telemetry and `cost_warning`, `server_info` `schema_drift` / `authority_delta`, and detached `isolated_worktree` support for managed jobs.
- Deduplicate operator docs (`PROJECT_STANDARDS.md` merged into `ENGINEERING.md`, generated `docs/architecture/components.md`, externalized `docs/help/*.md` resources), sync architecture/coverage/budget guards, and remove redundant scripts and catalog boilerplate.

## 3.0.0-beta.221 - 2026-11-21

- Align `/mcp/gemini` `server_info` projection with the active Gemini endpoint (`mcp_url: .../mcp/gemini`), exclude unexposed MCP Apps job-monitor tools (`render_job_monitor`, `claim_job_monitor`, `read_job_monitor`) from Gemini `server_info` tool counts/lists, and strip `_meta.ui` from `read_job` in Gemini `tools/list` while preserving native `/mcp` behavior.

## Historical releases

Historical prerelease entries remain available from Git tags and repository history. From a source checkout, inspect the changelog of a prior revision with `git show <revision>:CHANGELOG.md`. This current file intentionally describes only the active candidate and the history location.
