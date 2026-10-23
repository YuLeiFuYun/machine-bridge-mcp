# Changelog

## 3.0.0 - 2026-10-22

- Official 3.0.0 GA release with stabilized MCP 2026-07-28 protocol support across stdio and Cloudflare Worker transports.
- Statically verified output schemas for all 54 MCP tools (54/54 verified), guaranteeing full compliance with Anthropic, OpenAI, and Gemini structured tool-calling.
- End-to-end progressive tool discovery with intent-aware capability routing, reducing initial token overhead by over 75% and preventing contextual pollution.
- Global sanitizing result pipeline with counterfactual defensive audit envelopes, defusing false-positive safety refusals on diagnostic and security inspection tasks.
- Integrated Aider-inspired fuzzy patch matching tolerance and SWE-agent on-the-fly syntax validation for self-healing file edits.
- Implemented file mutation history and atomic rollback transactions inspired by OpenHands.
- Embedded Reflexion-style structured verbal self-reflection guidance for rapid failure diagnosis and error recovery.
- Reorganized codebase into high-cohesion domain subpackages with modern Node.js 26 test runner ergonomics and streamlined release pipeline.

## Historical releases

Historical prerelease entries remain available from Git tags and repository history. From a source checkout, inspect the changelog of a prior revision with `git show <revision>:CHANGELOG.md`. This current file intentionally describes only the active candidate and the history location.
