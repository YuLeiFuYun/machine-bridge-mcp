# Current audit status

This file is the current audit summary. Historical findings, closed incidents, and release-by-release evidence are retained by Git tags and repository history rather than repeated in the default maintenance path. For a historical snapshot, inspect this file at the corresponding version tag.

## Current conclusions

- MCP execution is current-protocol-only. Remote HTTP and stdio support MCP `2026-07-28`; removed initialization/session/replay requests fail closed and cannot dispatch old behavior.
- Browser computer observation requires the current atomic observation capability, and desktop visual-point decisions require the formal capability interface. Runtime method-presence fallbacks are not accepted as compatibility.
- Durable managed-job recovery, idempotent submission, ambiguous-side-effect settlement, process-tree termination confirmation, WebSocket/HTTPS relay recovery, authorization intersections, atomic state writes, resource admission, and rollback evidence remain current product guarantees rather than historical compatibility.
- Persisted-state migration is treated separately from protocol compatibility. Browser pairing and OAuth refresh-family readers that protect credential continuity or replay prevention remain until their supported one-way migration can be moved to an explicit upgrade phase and proven complete; they are not deleted merely because the executable protocol is current-only.
- A hosted transient process result promised for recovery remains non-evictable during its fixed 24-hour undelivered-result grace. Delegated pending recovery retains the account-scoped capacity boundary that prevents one principal from exhausting the shared retained-state store.
- Resource-state reads retry only `MBM_IDENTITY_CHANGED` for at most four observations; permission, link, malformed-content, and persistent identity failures remain fail closed.

## Residual review requirements

A green fast or full suite is necessary but not sufficient security evidence for publication. Release acceptance still requires the package/install/security gates and any hosted or live boundary evidence required by the changed surface. This summary does not authorize deployment or npm publication.

No unresolved defect is known after the beta.167 release-gate fix review. If final verification discovers a defect, it becomes a current item here or in the active changelog rather than another historical narrative.
