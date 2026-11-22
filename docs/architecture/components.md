# Component reference

> Generated from repository source layout. Do not edit manually; run `npm run components-doc:generate`.

See [Architecture](../ARCHITECTURE.md) for trust boundaries, request lifecycle, and module DAG rules enforced by `tests/architecture/module-boundaries.mjs`.

## Summary

| Area | Files | Source location |
|---|---:|---|
| Local daemon domains | 152 | `src/local/` |
| Cloudflare Worker domains | 57 | `src/worker/` |
| Shared contracts and protocol | 33 | `src/shared/` |
| Packaged Chromium extension | 13 | `browser-extension/` |
| CLI entrypoints | 1 | `bin/` |

## Shared contracts (`src/shared/`)

| Module | Lines | `@ts-check` | Exports |
|---|---:|---:|---:|
| `src/shared/access-contract.json` | 39 | no | 0 |
| `src/shared/activation-recovery.mjs` | 49 | yes | 3 |
| `src/shared/admin-auth.mjs` | 29 | no | 3 |
| `src/shared/authority-revocation.mjs` | 29 | no | 2 |
| `src/shared/daemon-auth.mjs` | 65 | no | 9 |
| `src/shared/device-session-auth.mjs` | 46 | no | 4 |
| `src/shared/error-guidance.mjs` | 61 | yes | 2 |
| `src/shared/foreground-timeout.mjs` | 70 | no | 9 |
| `src/shared/help-resources-content.json` | 6 | no | 0 |
| `src/shared/help-resources.mjs` | 67 | yes | 4 |
| `src/shared/log-redaction.mjs` | 84 | no | 2 |
| `src/shared/mcp-protocol.mjs` | 350 | no | 24 |
| `src/shared/mcp-task-contract.mjs` | 83 | yes | 15 |
| `src/shared/numbers.mjs` | 30 | yes | 3 |
| `src/shared/path-containment.mjs` | 18 | yes | 2 |
| `src/shared/policy-contract.json` | 77 | no | 0 |
| `src/shared/progress-reporter.mjs` | 63 | yes | 3 |
| `src/shared/project-overview-projection.mjs` | 106 | yes | 2 |
| `src/shared/prompt-projection.mjs` | 123 | yes | 5 |
| `src/shared/published-package.mjs` | 23 | no | 3 |
| `src/shared/records.mjs` | 40 | yes | 4 |
| `src/shared/relay-contract.json` | 50 | no | 0 |
| `src/shared/result-projection.json` | 4 | no | 0 |
| `src/shared/result-projection.mjs` | 61 | yes | 3 |
| `src/shared/sensitive-value-patterns.mjs` | 23 | yes | 1 |
| `src/shared/server-metadata.json` | 16 | no | 0 |
| `src/shared/tool-argument-validation.mjs` | 325 | no | 4 |
| `src/shared/tool-call-capacity.mjs` | 48 | no | 4 |
| `src/shared/tool-catalog.json` | 5316 | no | 0 |
| `src/shared/tool-groups.mjs` | 141 | yes | 4 |
| `src/shared/tool-security-contract.json` | 225 | no | 0 |
| `src/shared/tool-security.mjs` | 30 | yes | 1 |
| `src/shared/trusted-origin.mjs` | 22 | yes | 1 |

## Local runtime domains (`src/local/`)

### `src/local/agent/` (6 files)

Project AGENTS/skill/command discovery, capability ranking, routing, symbol outlines, and bounded context projections.

| Module | Lines | `@ts-check` | Exports |
|---|---:|---:|---:|
| `src/local/agent/agent-context.mjs` | 577 | no | 2 |
| `src/local/agent/agent-contract.mjs` | 483 | yes | 24 |
| `src/local/agent/agent-memory.mjs` | 115 | yes | 2 |
| `src/local/agent/agent-skill-discovery.mjs` | 284 | yes | 6 |
| `src/local/agent/default-instructions.mjs` | 258 | no | 2 |
| `src/local/agent/symbol-outline.mjs` | 591 | yes | 5 |

### `src/local/automation/` (22 files)

Loopback browser broker, pairing, extension protocol/operations, desktop AppKit/JXA automation, and Computer Use snapshots.

| Module | Lines | `@ts-check` | Exports |
|---|---:|---:|---:|
| `src/local/automation/app-automation.mjs` | 735 | no | 2 |
| `src/local/automation/app-macos-jxa.mjs` | 395 | yes | 4 |
| `src/local/automation/app-support.mjs` | 347 | no | 52 |
| `src/local/automation/browser-bridge.mjs` | 512 | no | 1 |
| `src/local/automation/browser-broker-routes.mjs` | 282 | no | 2 |
| `src/local/automation/browser-broker.mjs` | 439 | no | 22 |
| `src/local/automation/browser-commands.mjs` | 375 | no | 31 |
| `src/local/automation/browser-extension-protocol.mjs` | 265 | yes | 17 |
| `src/local/automation/browser-observation.mjs` | 209 | no | 3 |
| `src/local/automation/browser-operation-service.mjs` | 449 | no | 1 |
| `src/local/automation/browser-pairing.mjs` | 188 | no | 6 |
| `src/local/automation/computer-use-capture.mjs` | 293 | no | 5 |
| `src/local/automation/computer-use-contracts.mjs` | 517 | yes | 39 |
| `src/local/automation/computer-use-dispatch.mjs` | 502 | no | 8 |
| `src/local/automation/computer-use-geometry.mjs` | 552 | no | 32 |
| `src/local/automation/computer-use-observation.mjs` | 909 | no | 7 |
| `src/local/automation/computer-use-policies.mjs` | 429 | no | 17 |
| `src/local/automation/computer-use-result-budget.mjs` | 146 | no | 7 |
| `src/local/automation/computer-use-verification.mjs` | 565 | no | 22 |
| `src/local/automation/computer-use-verify.mjs` | 215 | no | 4 |
| `src/local/automation/computer-use.mjs` | 406 | no | 1 |
| `src/local/automation/macos-background-input.mjs` | 464 | no | 2 |

### `src/local/cli/` (7 files)

Top-level CLI command dispatch, argument parsing, verify/pair admin actions, idle-sleep control, and account management.

| Module | Lines | `@ts-check` | Exports |
|---|---:|---:|---:|
| `src/local/cli/cli-account.mjs` | 155 | no | 4 |
| `src/local/cli/cli-activate.mjs` | 555 | no | 9 |
| `src/local/cli/cli-admin.mjs` | 580 | no | 7 |
| `src/local/cli/cli-idle-sleep.mjs` | 17 | yes | 1 |
| `src/local/cli/cli.mjs` | 864 | no | 16 |
| `src/local/cli/state-inventory.mjs` | 170 | no | 4 |
| `src/local/cli/workspace-profile-migration.mjs` | 606 | yes | 7 |

### `src/local/core/` (13 files)

Policy evaluation, operation risk/reversibility, errors, timing, exclusive files, filesystem identity, and logging primitives.

| Module | Lines | `@ts-check` | Exports |
|---|---:|---:|---:|
| `src/local/core/authority.mjs` | 466 | yes | 16 |
| `src/local/core/errors.mjs` | 248 | yes | 5 |
| `src/local/core/exclusive-file.mjs` | 585 | no | 19 |
| `src/local/core/filesystem-identity.mjs` | 187 | yes | 10 |
| `src/local/core/idle-sleep-assertions.mjs` | 374 | no | 10 |
| `src/local/core/log.mjs` | 181 | no | 5 |
| `src/local/core/operation-risk.mjs` | 541 | no | 10 |
| `src/local/core/patch.mjs` | 324 | no | 2 |
| `src/local/core/policy.mjs` | 280 | yes | 24 |
| `src/local/core/runtime-node.mjs` | 144 | no | 4 |
| `src/local/core/secure-file.mjs` | 184 | no | 11 |
| `src/local/core/timing.mjs` | 47 | yes | 5 |
| `src/local/core/trusted-executable.mjs` | 86 | no | 4 |

### `src/local/deploy/` (15 files)

Hardened npm wrapper, Cloudflare project/Worker deployment, platform autostart services, and platform shell helpers.

| Module | Lines | `@ts-check` | Exports |
|---|---:|---:|---:|
| `src/local/deploy/cf-network-integrity.mjs` | 125 | no | 7 |
| `src/local/deploy/cf-project.mjs` | 166 | no | 6 |
| `src/local/deploy/hardened-npm.mjs` | 528 | no | 16 |
| `src/local/deploy/npm.mjs` | 92 | no | 3 |
| `src/local/deploy/service-contracts.mjs` | 101 | yes | 4 |
| `src/local/deploy/service-handoff.mjs` | 112 | no | 4 |
| `src/local/deploy/service-owner.mjs` | 164 | yes | 0 |
| `src/local/deploy/service-platforms.mjs` | 269 | no | 13 |
| `src/local/deploy/service-runtime.mjs` | 152 | yes | 6 |
| `src/local/deploy/service-support.mjs` | 343 | no | 15 |
| `src/local/deploy/service.mjs` | 746 | no | 21 |
| `src/local/deploy/shell.mjs` | 235 | no | 7 |
| `src/local/deploy/windows-service-convergence.mjs` | 48 | yes | 4 |
| `src/local/deploy/worker-deployment.mjs` | 317 | no | 5 |
| `src/local/deploy/wrangler-toolchain.mjs` | 431 | no | 9 |

### `src/local/files/` (6 files)

Canonical workspace path containment, file search, bounded reads/writes, transactional patches, and workspace checkpoints.

| Module | Lines | `@ts-check` | Exports |
|---|---:|---:|---:|
| `src/local/files/project-metadata.mjs` | 68 | yes | 4 |
| `src/local/files/project.mjs` | 194 | no | 6 |
| `src/local/files/workspace-file-service.mjs` | 669 | no | 9 |
| `src/local/files/workspace-paths.mjs` | 103 | yes | 8 |
| `src/local/files/workspace-search.mjs` | 272 | yes | 3 |
| `src/local/files/workspace-transaction.mjs` | 340 | yes | 12 |

### `src/local/git/` (4 files)

Structured Git status/diff/log/show inspection, plumbing, and staged commits.

| Module | Lines | `@ts-check` | Exports |
|---|---:|---:|---:|
| `src/local/git/git-content.mjs` | 77 | no | 3 |
| `src/local/git/git-contracts.mjs` | 117 | yes | 5 |
| `src/local/git/git-safety.mjs` | 262 | no | 4 |
| `src/local/git/git-service.mjs` | 205 | no | 2 |

### `src/local/jobs/` (16 files)

Detached managed-job plans, dependency waits, lock/directory persistence, resource/worktree isolation, runners, and retention.

| Module | Lines | `@ts-check` | Exports |
|---|---:|---:|---:|
| `src/local/jobs/capacity-maintenance.mjs` | 39 | yes | 2 |
| `src/local/jobs/capacity.mjs` | 160 | yes | 9 |
| `src/local/jobs/dependencies.mjs` | 212 | yes | 11 |
| `src/local/jobs/directory.mjs` | 480 | no | 26 |
| `src/local/jobs/execution.mjs` | 303 | no | 13 |
| `src/local/jobs/listing.mjs` | 90 | yes | 4 |
| `src/local/jobs/manager.mjs` | 692 | no | 7 |
| `src/local/jobs/plan.mjs` | 330 | no | 7 |
| `src/local/jobs/projection.mjs` | 281 | yes | 13 |
| `src/local/jobs/redaction.mjs` | 309 | no | 13 |
| `src/local/jobs/retention.mjs` | 248 | no | 7 |
| `src/local/jobs/runner-claim.mjs` | 147 | no | 7 |
| `src/local/jobs/runner-lifecycle.mjs` | 148 | no | 5 |
| `src/local/jobs/runner.mjs` | 808 | no | 0 |
| `src/local/jobs/terminal-base.mjs` | 209 | no | 19 |
| `src/local/jobs/transient-recovery-capacity.mjs` | 143 | no | 3 |

### `src/local/process/` (24 files)

Argv execution contracts, settlement classification, tree signals/supervision, interactive sessions, and resource admission.

| Module | Lines | `@ts-check` | Exports |
|---|---:|---:|---:|
| `src/local/process/execution-limits.mjs` | 62 | yes | 13 |
| `src/local/process/execution.mjs` | 372 | no | 10 |
| `src/local/process/identity.mjs` | 345 | no | 18 |
| `src/local/process/process-sessions.mjs` | 323 | no | 1 |
| `src/local/process/resource-admission-policy.mjs` | 220 | no | 10 |
| `src/local/process/resource-admission.mjs` | 486 | no | 5 |
| `src/local/process/resource-build-concurrency.mjs` | 278 | no | 10 |
| `src/local/process/resource-command-profile.mjs` | 477 | no | 30 |
| `src/local/process/resource-host-window.mjs` | 33 | yes | 2 |
| `src/local/process/resource-host.mjs` | 292 | no | 10 |
| `src/local/process/resource-lang-concurrency.mjs` | 237 | no | 6 |
| `src/local/process/resource-leases.mjs` | 332 | no | 17 |
| `src/local/process/resource-light-command.mjs` | 30 | yes | 2 |
| `src/local/process/resource-metrics.mjs` | 141 | yes | 9 |
| `src/local/process/resource-process-admission.mjs` | 60 | no | 4 |
| `src/local/process/resource-release-control.mjs` | 108 | no | 4 |
| `src/local/process/resource-waiters.mjs` | 461 | no | 19 |
| `src/local/process/resource-xcode.mjs` | 39 | yes | 2 |
| `src/local/process/session-helpers.mjs` | 210 | no | 9 |
| `src/local/process/settlement.mjs` | 492 | yes | 21 |
| `src/local/process/tracker.mjs` | 194 | no | 1 |
| `src/local/process/tree-facade.mjs` | 16 | yes | 9 |
| `src/local/process/tree-snapshot.mjs` | 136 | yes | 6 |
| `src/local/process/tree.mjs` | 138 | no | 5 |

### `src/local/runtime/` (15 files)

LocalRuntime orchestrator, tool-executor pipeline, loop/taint detection, observability metrics, diagnostics, and SHA-256 audit log.

| Module | Lines | `@ts-check` | Exports |
|---|---:|---:|---:|
| `src/local/runtime/call-helpers.mjs` | 361 | no | 24 |
| `src/local/runtime/call-registry.mjs` | 570 | yes | 9 |
| `src/local/runtime/full-access-probe.mjs` | 239 | no | 1 |
| `src/local/runtime/observability.mjs` | 217 | no | 17 |
| `src/local/runtime/resource-operations.mjs` | 80 | no | 1 |
| `src/local/runtime/runtime-activation.mjs` | 686 | no | 2 |
| `src/local/runtime/runtime-diagnostics.mjs` | 488 | no | 15 |
| `src/local/runtime/runtime-projections.mjs` | 364 | yes | 16 |
| `src/local/runtime/runtime-relay-drain.mjs` | 53 | no | 2 |
| `src/local/runtime/runtime-relay.mjs` | 330 | no | 8 |
| `src/local/runtime/runtime-services.mjs` | 307 | no | 5 |
| `src/local/runtime/runtime.mjs` | 678 | no | 5 |
| `src/local/runtime/security-audit-log.mjs` | 384 | no | 4 |
| `src/local/runtime/security-audit-store.mjs` | 466 | no | 16 |
| `src/local/runtime/tool-executor.mjs` | 446 | no | 4 |

### `src/local/state/` (12 files)

Workspace state persistence, multi-account access control, device-root identity, locking, and OAuth/Worker secret storage.

| Module | Lines | `@ts-check` | Exports |
|---|---:|---:|---:|
| `src/local/state/account-admin.mjs` | 313 | no | 14 |
| `src/local/state/device-identity.mjs` | 227 | no | 13 |
| `src/local/state/device-root-provider.mjs` | 75 | no | 5 |
| `src/local/state/macos-trust-broker.mjs` | 417 | no | 8 |
| `src/local/state/ssh-key.mjs` | 298 | no | 3 |
| `src/local/state/state-locks-meta.mjs` | 27 | yes | 1 |
| `src/local/state/state-locks.mjs` | 437 | no | 15 |
| `src/local/state/state-secrets.mjs` | 136 | no | 4 |
| `src/local/state/state-storage.mjs` | 481 | no | 31 |
| `src/local/state/state.mjs` | 192 | no | 34 |
| `src/local/state/worker-identity-contract.mjs` | 19 | yes | 3 |
| `src/local/state/worker-secret-file.mjs` | 163 | no | 2 |

### `src/local/transport/` (12 files)

WebSocket relay connection lifecycle, liveness/heartbeat monitoring, HTTP fallback, call recovery, proxy selection, and stdio transport.

| Module | Lines | `@ts-check` | Exports |
|---|---:|---:|---:|
| `src/local/transport/daemon-http-relay-protocol.mjs` | 197 | no | 6 |
| `src/local/transport/daemon-http-relay.mjs` | 399 | no | 1 |
| `src/local/transport/daemon-process.mjs` | 322 | no | 4 |
| `src/local/transport/network-proxy.mjs` | 572 | no | 18 |
| `src/local/transport/relay-classification.mjs` | 349 | no | 28 |
| `src/local/transport/relay-connection.mjs` | 705 | no | 8 |
| `src/local/transport/relay-diagnostics.mjs` | 265 | no | 10 |
| `src/local/transport/relay-heartbeat.mjs` | 583 | no | 10 |
| `src/local/transport/relay-recovery.mjs` | 553 | yes | 15 |
| `src/local/transport/resilient-relay.mjs` | 328 | no | 1 |
| `src/local/transport/stdio-task-projection.mjs` | 114 | yes | 5 |
| `src/local/transport/stdio.mjs` | 715 | no | 2 |

## Cloudflare Worker domains (`src/worker/`)

### `src/worker/index.ts` (1 files)

Worker Durable Object entrypoint and bindings.

| Module | Lines | Exports |
|---|---:|---:|
| `src/worker/index.ts` | 605 | 1 |

### `src/worker/daemon/` (12 files)

Connected daemon registry, channel readiness probing, ready waiters, and Worker-side continuity evidence.

| Module | Lines | Exports |
|---|---:|---:|
| `src/worker/daemon/auth.ts` | 181 | 7 |
| `src/worker/daemon/channel.ts` | 111 | 11 |
| `src/worker/daemon/continuity-evidence.ts` | 177 | 9 |
| `src/worker/daemon/http-channel.ts` | 207 | 2 |
| `src/worker/daemon/http-controller.ts` | 306 | 4 |
| `src/worker/daemon/liveness.ts` | 72 | 11 |
| `src/worker/daemon/ready-messages.ts` | 139 | 9 |
| `src/worker/daemon/ready-waiters.ts` | 210 | 17 |
| `src/worker/daemon/registry.ts` | 103 | 2 |
| `src/worker/daemon/relay-diagnostics.ts` | 348 | 4 |
| `src/worker/daemon/sockets.ts` | 142 | 2 |
| `src/worker/daemon/websocket-controller.ts` | 337 | 1 |

### `src/worker/mcp/` (17 files)

MCP HTTP contract, JSON-RPC framing, tool catalog projection, SSE response proxy, and Jobs UI Monitor integration.

| Module | Lines | Exports |
|---|---:|---:|
| `src/worker/mcp/access.ts` | 59 | 2 |
| `src/worker/mcp/controller.ts` | 320 | 3 |
| `src/worker/mcp/http-contract.ts` | 323 | 11 |
| `src/worker/mcp/job-monitor-store.ts` | 172 | 3 |
| `src/worker/mcp/job-monitor.ts` | 336 | 32 |
| `src/worker/mcp/jsonrpc.ts` | 79 | 9 |
| `src/worker/mcp/prompts.ts` | 40 | 2 |
| `src/worker/mcp/request-cancellation.ts` | 113 | 2 |
| `src/worker/mcp/response-proxy.ts` | 229 | 12 |
| `src/worker/mcp/response-stream.ts` | 124 | 3 |
| `src/worker/mcp/stale-schema.ts` | 128 | 1 |
| `src/worker/mcp/subscriptions.ts` | 242 | 8 |
| `src/worker/mcp/task-store.ts` | 340 | 6 |
| `src/worker/mcp/tasks.ts` | 194 | 12 |
| `src/worker/mcp/tool-authority.ts` | 35 | 2 |
| `src/worker/mcp/tool-call-dispatch.ts` | 114 | 4 |
| `src/worker/mcp/tool-catalog.ts` | 246 | 11 |

### `src/worker/oauth/` (15 files)

OAuth 2.1/PKCE controller, client registration, DPoP proof verification, sharded token issuance, and account administration.

| Module | Lines | Exports |
|---|---:|---:|
| `src/worker/oauth/account-admin.ts` | 198 | 4 |
| `src/worker/oauth/authority-revocations.ts` | 216 | 10 |
| `src/worker/oauth/authority.ts` | 278 | 12 |
| `src/worker/oauth/authorization-page.ts` | 130 | 3 |
| `src/worker/oauth/client-admin.ts` | 49 | 1 |
| `src/worker/oauth/contracts.ts` | 97 | 27 |
| `src/worker/oauth/controller.ts` | 406 | 2 |
| `src/worker/oauth/device-session-verifier.ts` | 128 | 6 |
| `src/worker/oauth/dpop.ts` | 240 | 6 |
| `src/worker/oauth/legacy-pbkdf2.ts` | 134 | 1 |
| `src/worker/oauth/oauth-tokens.ts` | 300 | 4 |
| `src/worker/oauth/refresh-families.ts` | 276 | 9 |
| `src/worker/oauth/state.ts` | 553 | 38 |
| `src/worker/oauth/store-validation.ts` | 133 | 1 |
| `src/worker/oauth/token-issuance.ts` | 293 | 16 |

### `src/worker/room/` (12 files)

BridgeRoom Durable Object fetch/alarm routing, pending-call lifecycle, policy enforcement, and server_info projections.

| Module | Lines | Exports |
|---|---:|---:|
| `src/worker/room/entry.ts` | 306 | 19 |
| `src/worker/room/errors.ts` | 136 | 9 |
| `src/worker/room/http.ts` | 391 | 35 |
| `src/worker/room/managed-job-contract.ts` | 99 | 5 |
| `src/worker/room/managed-job-hosted.ts` | 140 | 3 |
| `src/worker/room/observability.ts` | 214 | 3 |
| `src/worker/room/pending-calls.ts` | 472 | 25 |
| `src/worker/room/policy.ts` | 83 | 4 |
| `src/worker/room/runtime-alarm.ts` | 176 | 4 |
| `src/worker/room/server-info.ts` | 350 | 12 |
| `src/worker/room/tool-timeout.ts` | 121 | 12 |
| `src/worker/room/websocket-protocol.ts` | 48 | 7 |

## Browser extension (`browser-extension/`)

| Module | Lines | Exports |
|---|---:|---:|
| `browser-extension/broker-auth.js` | 85 | 0 |
| `browser-extension/broker-liveness.js` | 35 | 0 |
| `browser-extension/browser-error-boundary.js` | 113 | 0 |
| `browser-extension/browser-operation-contract.js` | 100 | 0 |
| `browser-extension/browser-operations.js` | 1803 | 0 |
| `browser-extension/devtools-input.js` | 312 | 0 |
| `browser-extension/devtools-observation.js` | 686 | 0 |
| `browser-extension/devtools-session.js` | 63 | 0 |
| `browser-extension/manifest.json` | 34 | 0 |
| `browser-extension/page-automation.js` | 1195 | 0 |
| `browser-extension/pairing-bootstrap.js` | 41 | 0 |
| `browser-extension/pairing.js` | 65 | 0 |
| `browser-extension/service-worker.js` | 367 | 0 |

## CLI entrypoints (`bin/`)

| Module | Lines | Exports |
|---|---:|---:|
| `bin/machine-mcp.mjs` | 21 | 0 |
