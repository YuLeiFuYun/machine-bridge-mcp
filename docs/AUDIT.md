# Current audit status

This file is the current audit summary. Historical findings, closed incidents, and release-by-release evidence are retained by Git tags and repository history rather than repeated in the default maintenance path. For a historical snapshot, inspect this file at the corresponding version tag.

## Current conclusions

- MCP execution is current-protocol-only. Remote HTTP and stdio support MCP `2026-07-28`; removed initialization/session/replay requests fail closed and cannot dispatch old behavior.
- Browser computer observation requires the current atomic observation capability, and desktop visual-point decisions require the formal capability interface. Runtime method-presence fallbacks are not accepted as compatibility.
- Durable managed-job recovery, idempotent submission, ambiguous-side-effect settlement, process-tree termination confirmation, WebSocket/HTTPS relay recovery, authorization intersections, atomic state writes, resource admission, and rollback evidence remain current product guarantees rather than historical compatibility.
- Persisted-state migration is treated separately from protocol compatibility. Browser pairing and OAuth refresh-family readers that protect credential continuity or replay prevention remain until their supported one-way migration can be moved to an explicit upgrade phase and proven complete; they are not deleted merely because the executable protocol is current-only.
- A hosted transient process result promised for recovery remains non-evictable during its fixed 24-hour undelivered-result grace. Delegated pending recovery retains the account-scoped capacity boundary that prevents one principal from exhausting the shared retained-state store.
- Hosted result pressure is now bounded independently from execution correctness: relay `read_file` returns at most a 64 KiB complete serialized result with whole-line continuation, relay `read_process` pages at 32 KiB, and account-owned transient one-step process carriers capture at most 32 KiB aggregate output while retaining explicit truncation counts. Local/stdio capacities are unchanged.
- Owner diagnostics expose only content-free 15-minute result-byte aggregates alongside call density and keep `host_side_events_observable=false`; they cannot prove ChatGPT host-turn termination or final-response receipt.
- Resource-state reads retry only `MBM_IDENTITY_CHANGED` for at most four observations; permission, link, malformed-content, and persistent identity failures remain fail closed.
- Relay application-layer fault domains are now independently configurable: WSS may remain on `MBM_RELAY_PROXY` while signed HTTP fallback uses a distinct `MBM_RELAY_FALLBACK_PROXY` or explicitly returns to standard environment-proxy resolution. This reduces common-mode application-proxy coupling but is not evidence that an operating-system VPN/TUN or shared upstream cannot affect both routes.

## Residual review requirements

A green fast or full suite is necessary but not sufficient security evidence for publication. Release acceptance still requires the package/install/security gates and any hosted or live boundary evidence required by the changed surface. This summary does not authorize deployment or npm publication.

The beta.169 relay-routing repair is driven by an awake owner-machine incident in which repeated ready WebSocket close-1006 events had no matching system sleep or event-loop stall, while the configured WSS and HTTPS fallback shared the same application proxy. Sidecar evidence for that episode showed healthy SSH masters and balanced channel opens/closes rather than capacity exhaustion. The evidence does not identify which upstream component ended the CONNECT streams, so the release claim is limited to removing the avoidable application-layer route coupling; independent failure-domain behavior still requires live/fault-injection verification.
