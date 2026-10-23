# Changelog

## 3.0.0 - 2026-10-22

- Stabilize 3.0.0 release with request-scoped MCP 2026-07-28 protocol support across stdio and Cloudflare Worker transports.
- Preserve the nearest project instructions when the shared context budget is exhausted, and report omitted guidance with policy-projected paths.
- Load persistent project memory only on demand (`agent_context` remains strictly read-only), validating versioned metadata, expiry timestamps, and canonical path containment without exposing a dedicated memory-mutation surface.
- Bound asynchronous symbol-outline traversal, file reads, cancellation, rendered lines, and 16 KiB UTF-8 byte ceiling; omit default parameter values and enforce per-file policy checks.
- Require exact editing and patch contexts; add `with_line_numbers` read support, 1-based line-numbered `near_miss` edit candidates, and bounded `conflict_hint` line candidates on `apply_patch` conflicts.
- Share typed instruction, Git-diff, and skill projections across stdio and Worker prompts. Preserve failures, truncation, and sensitive-file omissions instead of reporting missing data as empty results.
- Make optional progressive stdio discovery reachable through nine initial tools, canonical groups, and bounded request-scoped catalog subscriptions. Advertise catalog changes only in this mode; retain the full catalog by default.
- Share reason-level remedies across transports and add interactive prompt stall detection (`[y/N]`, `Password:`) to process failure advisories.
- Gate Worker SSE heartbeat comments on complete frame boundaries (`\n\n` / `\r\n\r\n`) via O(1) tail-byte inspection while keeping heartbeats active across multi-step streams.
- Advance the tool schema generation and bind the catalog digest to its contract (40 verified output schemas and 14 environment-dependent interactive tools across 54 tools).
- Unify MCP Tasks active/terminal/successful job status sets in `src/shared/mcp-task-contract.mjs`, deduplicate resource-request normalization in `src/local/resource-request-contract.mjs`, and centralize loopback origin parsing in `src/shared/trusted-origin.mjs`.
- Move the native development smoke fixture and tool output-schema contract baseline out of the consumer package; verify nested and deduplicated Wrangler 4.151.3 dependencies at their exact locked locations.

## Historical releases

Historical prerelease entries remain available from Git tags and repository history. From a source checkout, inspect the changelog of a prior revision with `git show <revision>:CHANGELOG.md`. This current file intentionally describes only the active candidate and the history location.
