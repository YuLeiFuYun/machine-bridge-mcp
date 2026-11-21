# Changelog

## 3.0.0-beta.221 - 2026-11-21

- Align `/mcp/gemini` `server_info` projection with the active Gemini endpoint (`mcp_url: .../mcp/gemini`), exclude unexposed MCP Apps job-monitor tools (`render_job_monitor`, `claim_job_monitor`, `read_job_monitor`) from Gemini `server_info` tool counts/lists, and strip `_meta.ui` from `read_job` in Gemini `tools/list` while preserving native `/mcp` behavior.

## Historical releases

Historical prerelease entries remain available from Git tags and repository history. From a source checkout, inspect the changelog of a prior revision with `git show <revision>:CHANGELOG.md`. This current file intentionally describes only the active candidate and the history location.
