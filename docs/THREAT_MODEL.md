# Threat model

This document defines the security claims Machine Bridge is designed to make and the claims it explicitly does not make. It complements [SECURITY.md](../SECURITY.md), [LOCAL_AUTHORIZATION.md](LOCAL_AUTHORIZATION.md), and [ARCHITECTURE.md](ARCHITECTURE.md).

## Scope

Machine Bridge combines:

- a public OAuth and MCP endpoint on a Cloudflare Worker;
- an authenticated relay to a high-authority local daemon;
- optional local stdio transport;
- filesystem, Git, process, browser, and application automation;
- persistent managed jobs and registered local resources;
- a browser extension operating in an existing user profile.

The local runtime executes as the current OS user. Application policies restrict Machine Bridge behavior, but they do not replace kernel, account, VM, container, browser-profile, or endpoint-security isolation.

## Assets

Protected assets include:

- workspace files and other files reachable by the local OS user;
- process execution authority, process sessions, retained output, and inherited environment values;
- the device root, root-certified ephemeral session keys, OAuth account password verifiers, authorization codes, access tokens, refresh-token families, DPoP bindings, and trusted-client records;
- Machine Bridge state, locks, service metadata, native broker files, audit-chain state, registered-resource metadata, and managed-job plans/output;
- browser pairing state, cookies, authenticated sessions, tabs, page content, form values, screenshots, and upload authority;
- Worker and Durable Object routing, nonce, account, client, token, and pending-call state;
- release candidate hashes, package contents, acceptance records, and source-release integrity;
- logs and diagnostics that could reveal paths, credentials, arguments, output, or user content.

## Trust boundaries

### Hosted client to Worker

The hosted MCP client, its prompts, tools, extensions, and retrieved content are not automatically trusted. The Worker validates:

- OAuth state, PKCE, redirect URI, resource binding, and request size;
- account status, account version, account role, trusted client binding, token expiry, and refresh-family state;
- DPoP proof method, target URL, timestamp, unique identifier, access-token hash, and key thumbprint when DPoP is used;
- MCP session state, protocol version, method shape, request IDs, cancellation, and allowed tool exposure.

A client registration is not authority. Authority begins only after successful account authorization binds the client to one account and role version.

### Worker to local daemon

The Worker is a relay and authorization layer, not the source of local OS authority.

The daemon connection requires:

1. a root-signed ephemeral device-session certificate;
2. a signed, nonce-bound WebSocket preflight using that session key;
3. a fresh Worker challenge bound to the daemon instance;
4. version compatibility;
5. an end-to-end readiness probe delivered through the same result path as real calls.

A replacement candidate does not displace a healthy daemon until those checks complete.

Each remote tool call carries account ID, account version, OAuth client ID, refresh-family ID, and role. The local runtime recomputes effective authority and applies object ownership and operation classification before dispatch.

### MCP host to local stdio process

Stdio is a local-owner transport. It does not use remote OAuth accounts or the relay device root. The local MCP host can invoke every tool allowed by the selected local policy.

The host, model output, repository instructions, and retrieved content may be malicious or prompt-injected. A permissive local policy therefore grants meaningful local-user authority.

### Local runtime to operating system

The runtime relies on OS-user identity, filesystem permissions, process controls, macOS TCC/SIP, Windows ACLs, endpoint controls, and any VM/container boundary.

For delegated process execution, Machine Bridge requires a behaviorally verified OS sandbox. If the negative boundary cannot be demonstrated, delegated execution fails closed. Owner execution is not sandboxed by Machine Bridge. Fixed implementation-owned Git metadata probes are not caller-selected process authority: they use code-constructed argv, no shell, an isolated minimal environment, bounded deadlines/output, and ordinary cancellation/process tracking.

### Local runtime to browser extension

The broker is loopback-only and pairing-token protected. Extension origin, protocol/build version, capabilities, owner/client route, and handshake state are validated.

The extension still operates inside a real browser profile. It can reach tabs, authenticated sessions, and origins granted by browser permissions. Only the `owner` role may use browser-session control or export local data into it.

### Local runtime to persistent state

State paths, roots, locks, plans, resources, native broker files, and service definitions are security-sensitive.

Machine Bridge uses bounded reads, canonical path resolution, owner-only modes where supported, atomic replacement, process-identity locks, schema validation, and explicit lifecycle transitions. Generic path-based tools cannot target Machine Bridge control-plane roots, even under `owner/full`. An authorized owner shell remains equivalent to same-user code execution and is outside that path boundary.

### Device root to ephemeral session

The default root is portable owner-only P-256 material, including on macOS, and is therefore readable by a determined same-user process. A non-exportable Secure Enclave root is available only through an explicitly configured app-like broker with provisioning-profile-validated Keychain access, a strict Apple code signature, stable Team ID, canonical non-symlink path with no group/other write access, and a successful real key probe. Either root signs one bounded ephemeral session certificate at daemon startup. WebSocket reconnect and account-administration requests use the in-memory session key, not the root.

The portable provider stores an exportable private JWK in owner-only state and therefore provides weaker theft resistance. `server_info` reports the provider and exportability.

Broker binding detects path, identifier, Team ID, signature, and capability drift. It does not protect against a malicious replacement signed by the same trusted Apple team and identifier. Production broker installations should therefore be root-owned or otherwise non-writable by the daemon user, with signing-key protection and update governance treated as external trust dependencies.

### Maintainer to release infrastructure

Repository checks reduce package drift and accidental release mistakes. Source hosting, npm ownership, Apple signing identities, protected environments, maintainer accounts, and independent review remain external trust dependencies.

The local signature binds the self-hosted broker bytes used by this installation. Public third-party binary distribution would be a separate trust model and is outside the current package workflow.

## Attacker models

Machine Bridge considers:

1. **A malicious or compromised hosted MCP client** attempting unauthorized tools, account switching, token theft/replay, OAuth redirect abuse, request duplication, cancellation races, or resource exhaustion.
2. **A malicious local MCP host or model output** attempting destructive operations, credential access, shell injection, persistence, or data export through an allowed local-owner policy.
3. **Malicious repository content** including instructions, package scripts, Git hooks/configuration, symlinks, generated metadata, or files designed to influence an agent or execution boundary.
4. **Malicious web or browser content** attempting prompt injection, deceptive selectors, sensitive-field disclosure, unsafe navigation, ambiguous input dispatch, or extension-protocol abuse.
5. **A local same-user process** attempting to read state, race locks, replace files, inspect memory, impersonate stale processes, or interfere with loopback services.
6. **A network attacker or misconfigured proxy** attempting interception, redirect manipulation, stale deployment evidence, connection truncation, replay, or ambiguous timeout outcomes.
7. **A compromised dependency or build input** attempting package substitution, install-script abuse, workflow mutation, release drift, or sensitive artifact inclusion.
8. **Operational faults** including abrupt termination, PID reuse, clock anomalies, partial writes, permission errors, Keychain failures, service-manager races, stale extension builds, and daemon replacement during active calls.

## Security objectives

The implementation aims to preserve these invariants:

- unknown, malformed, stale, replayed, duplicated, unauthorized, and over-limit input is rejected;
- remote authority is the intersection of daemon policy and account role, never the union;
- no approval record, token refresh, or local migration state can elevate a delegated role;
- OAuth clients are bound to one account/version/role and can be revoked independently;
- long-lived runtime objects are bound to account, account version, OAuth client, and refresh family;
- generic path-based remote tools cannot target Machine Bridge control-plane state;
- sensitive paths, persistence targets, browser/desktop control, data export, and persistent job creation are owner-only;
- delegated process execution is accepted only when an OS sandbox is behaviorally verified;
- direct argv execution is used unless the explicit shell tool is authorized;
- confined paths are canonicalized and symbolic-link write escape is rejected;
- request bodies, files, messages, output, logs, state, retained results, concurrency, and error-cause traversal are bounded; byte limits stop further source consumption rather than merely truncating retained data;
- cancellation, timeout, disconnect, replacement, and shutdown have explicit process ownership and cleanup semantics;
- candidate daemons and browser extensions cannot replace healthy incumbents before compatibility and readiness verification;
- default logs, audit records, discovery warnings, browser responses, and administration errors omit secrets, arguments, contents, raw paths, form values, raw local exception text, and output;
- multi-stage mutations are atomic or recoverable and do not silently claim partial success;
- device-root rotation is two-phase and does not promote an undeployed key;
- supply-chain actions are pinned, minimally permissioned, reviewed, and separately gated.

## Non-goals

Machine Bridge does not claim to provide:

- kernel-enforced sandboxing for `owner`, universal syscall filtering, or universal network isolation;
- OS CPU, memory, disk, or bandwidth quotas;
- hard multi-tenant isolation between mutually untrusted humans sharing one daemon and OS account;
- protection from root, an administrator, or a fully compromised same-user account;
- complete prevention of prompt injection when an authorized tool can perform the requested action;
- semantic detection of every secret, transformed credential, private document, or dangerous command;
- proof that the browser extension is loaded in an isolated profile;
- rollback of a browser or external-system action after ambiguous dispatch;
- an atomic rollback transaction spanning Cloudflare Worker deployment and every local service manager;
- repair or node selection inside a third-party system VPN/TUN;
- guaranteed cleanup after power loss, kernel failure, filesystem corruption, or an uncooperative external platform;
- hardware-backed key storage on every operating system;
- third-party public binary-store identity or independent distributor attestations;
- independent human review while the project has only one active maintainer.

## Residual risks

### Owner and canonical `full`

`full` intentionally preserves the complete catalog, unrestricted local-user paths, shell execution, parent environment, browser/application authority, managed jobs, and absolute path output.

A compromised active owner client can exercise the daemon ceiling without a second per-operation prompt. The design reduces prompt fatigue and avoids insecure copy-and-retry approval ceremonies, but it makes client trust, token protection, DPoP support, account revocation, and endpoint isolation critical.

Use a narrower profile, separate OS account, container, or VM when prompts, repositories, clients, or workloads are mutually untrusted.

### Public Worker endpoint and quota guards

The default public endpoint remains the automatically provisioned `workers.dev` origin so ordinary users need no DNS zone or custom domain. The in-Worker Rate Limiting binding is deliberately a Durable Object burst guard, not an authentication boundary or an exact global quota accountant. It runs after a Worker invocation begins, is scoped by Cloudflare location, and currently uses one deployment-wide stateful bucket per location. A concentrated source can therefore cause a temporary localized denial for other clients sharing that location, while distributed traffic can still consume the account-wide Workers request allowance. Binding failure is fail-open to avoid turning a quota helper into an account outage. Operators who already control an external edge may add pre-Worker filtering independently, but the public package does not require or assume a private domain.

### Bearer clients

DPoP is optional for interoperability. A Bearer token can be used by whoever possesses it until expiry or revocation. Short access-token lifetime, rotating refresh families, client binding, account versioning, a bounded identity-equivalent concurrency window, and post-window replay-family revocation reduce but do not eliminate token theft risk.

### Same-user interference

Owner-only permissions, optional provisioned Secure Enclave roots, control-plane path denial, process-identity locks, and audit chains reduce several attacks. They cannot prevent a determined same-user process from reading portable credentials, inspecting process memory, changing source before execution, or interfering with local services.

### Delegated sandbox availability

Delegated execution is unavailable when the platform sandbox cannot pass the negative-boundary probe. This is an intentional availability trade-off. Replacing fail-closed behavior with an unverified path blacklist would create false isolation.

### Browser and application automation

UI state can change between inspection and action. Pages can present deceptive content, and authenticated profiles may contain high-value sessions. Protocol checks and trusted-input handling do not make arbitrary web content trustworthy.

### Managed jobs

Managed jobs outlive MCP calls and daemon reconnects. Plans and resources are validated and ownership-bound, but an authorized owner plan can still consume resources or perform destructive work. Finally steps must be idempotent because recovery may retry them.

### Availability and resource exhaustion

Application-level limits bound many requests and outputs. An authorized owner process can still exhaust CPU, memory, disk, network, or external service quotas.

### System VPN/TUN and distributed activation

A system VPN/TUN can remain administratively connected while its selected upstream route, synthetic DNS mapping, or transport path is temporarily unusable. Machine Bridge can detect missing inbound relay traffic, classify the socket close, bound retry delay, and report outage history, but it cannot select or repair a third-party VPN node. `system-network-stack` is therefore not a claim of direct routing.

Candidate activation verifies the foreground candidate before service handoff and records exact package/deployment evidence. It does not provide an atomic transaction spanning Cloudflare deployment and every local service manager. If the Worker changes and the local handoff later fails, the operator may need the recorded previous runtime/deployment evidence to complete rollback. Local cleanup errors are aggregated rather than hidden, but remote rollback is not fabricated.

### External governance and publication

Code cannot create a second independent reviewer, npm OIDC trust relationship, protected publication environment, Apple Developer identity, or external certification. These remain explicit operational requirements.

## Validation map

Regression suites cover:

- account roles, trusted clients, account-version revocation, refresh-family rotation/replay, DPoP proofs, and non-escalatable effective authority;
- root-certified ephemeral sessions, preflight nonce replay, daemon challenge binding, readiness, reconnect, and candidate replacement;
- signed account administration, client revocation, bounded strict-JSON administration responses, and removal of the long-lived administration secret;
- control-plane path denial, path canonicalization, symlink handling, sensitive/persistence targets, and object ownership;
- delegated sandbox behavior and fail-closed platform detection;
- process/session cleanup, generated-key rollback including cleanup failure, managed-job lifecycle and recovery, state locks, atomic persistence, and destructive removal;
- browser pairing, version/capability handshake, broker routing, independent concurrency limits, public-error redaction, sensitive input, and navigation controls;
- audit-chain integrity, privacy redaction, package contents, installation, release impact, dependency integrity, CodeQL, and Scorecard findings;
- malformed, over-limit, concurrent, replayed, stale, and fault-injected inputs.

See [TESTING.md](TESTING.md) for the test inventory and [AUDIT.md](AUDIT.md) for historical findings and residual limitations.

## Reporting

Report suspected vulnerabilities through the private process in [SECURITY.md](../SECURITY.md). Do not include real credentials, private user data, browser session material, or sensitive local paths in public issues or test fixtures.
