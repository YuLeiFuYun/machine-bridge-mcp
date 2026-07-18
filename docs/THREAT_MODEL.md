# Threat model

This document defines the security claims Machine Bridge is designed to make and the claims it explicitly does not make. It complements [SECURITY.md](../SECURITY.md) and the implementation detail in [ARCHITECTURE.md](ARCHITECTURE.md).

## Scope

Machine Bridge combines a remote OAuth relay, a high-authority local runtime, optional local stdio transport, persistent managed jobs, and a browser extension. The primary security objective is to ensure that only explicitly authorized, policy-permitted operations cross those boundaries, with bounded inputs, fail-closed state transitions, and minimal sensitive observability.

The local runtime executes as the current OS user. Policy profiles restrict Machine Bridge behavior; they do not replace kernel, account, VM, container, browser-profile, or endpoint-security isolation.

## Assets

The main protected assets are:

- workspace and local-user-accessible files;
- process execution authority and inherited environment values;
- daemon secret, account administration secret, account password verifiers, OAuth authorization codes, access tokens, and refresh tokens;
- Worker and Durable Object routing state;
- owner-only profile, lock, resource, service, and managed-job state;
- registered local resource contents and paths;
- browser pairing token, browser cookies, authenticated sessions, tabs, page content, and file-upload authority;
- release candidate hashes, observed-verification acceptance records, package contents, and source-release integrity;
- logs and diagnostics that could reveal paths, credentials, arguments, results, or user content.

## Trust boundaries

### Hosted client to Worker

The hosted client and its prompts, tools, extensions, and retrieved content are not automatically trusted. The Worker must validate OAuth state, PKCE, redirect and resource binding, account role/version, token expiry/rotation, MCP session state, request shape, body bounds, and allowed tool exposure.

### Worker to local daemon

The Worker is a relay and authorization layer, not a source of local authority. The daemon accepts only an authenticated, version-compatible relay session. End-to-end readiness requires a local probe result through the active session. Every remote tool call carries bounded account authority that is rechecked locally.

### MCP host to local stdio process

A local MCP host can invoke every tool allowed by the selected daemon policy. The host, model output, repository instructions, and retrieved content may be malicious or prompt-injected. A permissive policy therefore grants meaningful local-user authority.

### Local runtime to operating system

The runtime relies on the OS account, filesystem permissions, macOS TCC/SIP, Windows ACLs, container/VM boundaries, and endpoint controls. Canonical workspace checks prevent path escape only when unrestricted paths are disabled. They do not protect against a malicious process already running with the same OS-user authority.

### Local runtime to browser extension

The broker is loopback-only and pairing-token protected. The extension origin, protocol version, build version, capabilities, and handshake state are validated. The extension still runs inside a real browser profile and can reach the tabs, sessions, and origins granted by browser permissions.

### Local runtime to persistent state

State paths, locks, plans, resources, and service definitions are security-sensitive. Reads are bounded and symlink-aware; writes use owner-only modes where supported and atomic replacement; locks bind tokens to process identity and start time; destructive removal validates ownership and expected layout.

### Maintainer to release infrastructure

Repository checks reduce accidental or malicious package drift, but source hosting, npm ownership, protected environments, maintainer accounts, and human review remain external trust dependencies. Repository automation cannot manufacture independent review or claim live candidate success without observing the owner-started candidate. It may record acceptance after that observed verification.

## Attacker models

Machine Bridge considers the following attackers and failure sources:

1. **Malicious or compromised hosted MCP client** attempting unauthorized tools, token replay, OAuth redirect abuse, request smuggling, duplicate IDs, cancellation races, or excessive resource use.
2. **Malicious local MCP host or model output** attempting to use allowed tools for destructive actions, credential discovery, shell injection, or persistence.
3. **Malicious repository content** including instructions, package scripts, Git configuration, paths, symlinks, generated metadata, or files designed to influence an agent or execution boundary.
4. **Malicious webpage or browser content** attempting prompt injection, deceptive selectors, sensitive-field disclosure, unsafe navigation, replay after ambiguous input dispatch, or extension-protocol abuse.
5. **Local same-user process** attempting to race locks, replace files, impersonate stale processes, read local state, or interfere with loopback services.
6. **Network attacker or misconfigured proxy** attempting interception, redirect manipulation, credential disclosure, stale deployment evidence, or ambiguous timeout outcomes.
7. **Compromised dependency or build input** attempting package substitution, mutable workflow execution, install-script abuse, release drift, or sensitive artifact inclusion.
8. **Operational failure** such as abrupt termination, PID reuse, clock rollback, partial writes, disk/permission errors, service-manager races, stale browser builds, or daemon replacement during active calls.

## Security objectives

The implementation aims to preserve these invariants:

- deny unknown, malformed, stale, duplicated, unauthorized, or over-limit requests;
- intersect remote account authority with the daemon capability ceiling in both Worker and local runtime;
- keep transport authentication separate from tool authorization and OS authority;
- use direct argv execution without shell interpretation unless the explicit shell tool is authorized;
- canonicalize confined paths and reject symlink-based write escape;
- bound request bodies, messages, files, output, logs, state, retained results, and concurrency;
- ensure cancellation, timeout, disconnect, replacement, and shutdown have explicit process ownership and cleanup semantics;
- prevent a candidate daemon or extension from displacing a healthy incumbent before compatibility/readiness validation;
- avoid exposing secrets, arguments, results, resource contents, account credentials, or raw local paths in default logs and public metadata;
- make multi-stage state and file mutations atomic or recoverable without silent partial success;
- bind managed-job plans and release acceptance to cryptographic content hashes;
- fail closed when state, ownership, permissions, process identity, or destructive cleanup cannot be verified;
- keep supply-chain actions pinned, minimally permissioned, reviewed, and separately gated.

## Non-goals

Machine Bridge does **not** claim to provide:

- kernel-enforced sandboxing, CPU/memory quotas, syscall filtering, or network isolation;
- hard multi-tenant isolation between mutually untrusted users sharing one daemon and OS account;
- protection from root, an administrator, or a fully compromised same-user account;
- complete prevention of prompt injection or malicious instructions when an authorized tool can perform the requested action;
- semantic detection of every secret, transformed credential, private document, or dangerous command;
- proof that the browser extension is loaded in a safe or isolated profile;
- rollback of a browser or external-system action after an ambiguous dispatch failure;
- guaranteed cleanup after power loss, kernel failure, filesystem corruption, or an uncooperative external platform;
- independent human code review while the project has only one active maintainer;
- npm trusted publishing until the package owner configures external OIDC trust and a protected publication environment.

## Residual risks

### Canonical `full` profile

`full` intentionally exposes the complete catalog, unrestricted local-user paths, shell execution, parent environment, and absolute path output. A malicious authorized client can use that authority destructively. The mitigation is a narrower profile or a separate low-privilege OS boundary, not additional warning text.

### Application and browser automation

UI state can change between inspection and action. Pages can present deceptive content, and an authenticated browser profile may contain high-value sessions. Trusted input and replay controls reduce specific failure modes but do not make arbitrary web content trustworthy.

### Package scripts and registered commands

Automatic command discovery does not inject script bodies into prompts, but invoking a package script still executes repository-controlled code. The active policy and human approval remain decisive.

### Same-user interference

Owner-only permissions and process-identity locks reduce accidental and cross-account interference. They cannot reliably defend against a determined process running as the same OS user with equivalent filesystem and process rights.

### Availability and resource exhaustion

Concurrency, message, output, and timeout limits bound many application-level resources. The daemon does not enforce OS CPU, memory, disk, or network quotas, so an authorized process can still consume host resources.

### External governance and publication

Code cannot create a second independent reviewer, npm OIDC trust relationship, protected environment, or OpenSSF Best Practices registration. Those controls remain explicit external work rather than simulated repository compliance.

## Validation map

The main regression suites cover:

- OAuth, account, policy, MCP session, daemon readiness, and relay replacement;
- path confinement, atomic writes, state locks, service lifecycle, managed-job recovery, and destructive cleanup;
- direct process boundaries, shell separation, process-tree termination, timeout, cancellation, and disconnect;
- browser pairing, version/capability handshake, owner/client broker routing, sensitive-field handling, trusted input, and CSP navigation;
- privacy redaction, package contents, release impact, interactive candidate acceptance, dependency integrity, CodeQL, and Scorecard findings;
- malformed, over-limit, concurrent, replayed, stale, and fault-injected inputs.

See [TESTING.md](TESTING.md) for the complete test inventory and [AUDIT.md](AUDIT.md) for reviewed failures and residual limitations.

## Reporting

Report suspected vulnerabilities through the private process in [SECURITY.md](../SECURITY.md). Do not include real credentials, private user data, browser session material, or sensitive local paths in public issues or test fixtures.
