# Multi-client, multi-account, and tenancy architecture

## The actual question

The important question is not whether several OAuth clients can obtain tokens. The important question is:

> Can independently managed principals share one Machine Bridge deployment without inheriting the same local-machine authority or being able to affect one another?

The current release answers **no**. It supports multiple client registrations and multiple access tokens, but it does not model human or service accounts as independent security principals. Anyone who completes authorization with the shared workspace connection password receives the same workspace-level Machine Bridge authority.

This distinction must remain explicit because an OAuth `client_id` identifies client software, not the person or service using it.

## Terms

| Term | Meaning in this document |
|---|---|
| OAuth client | A registered MCP host/application with redirect URIs and a `client_id` |
| Principal/account | A human or service identity that may receive authority |
| Grant | A named, versioned set of capabilities assigned to a principal for one bridge |
| Bridge | One canonical workspace, local runtime, Worker, Durable Object, policy ceiling, and credential set |
| Trust domain | Principals that may safely share the same local OS/runtime authority |
| Tenant | An independently administered trust domain requiring isolation from other tenants |

## Current behavior

| Scenario | Current support | Security meaning |
|---|---:|---|
| Several MCP applications or installations connect to one Worker | Yes | Each can register a client and receive separate tokens |
| Several ChatGPT accounts connect using the same connection password | Technically yes | They receive the same workspace authority; no account isolation |
| Several active OAuth tokens for one client | Yes | Tokens are distinct but share the same authorization semantics |
| Per-account roles, capability grants, suspension, or revocation | No | Only workspace-wide policy and token-version revocation exist |
| Revoke one principal while preserving all others | No | The current emergency mechanism rotates the workspace token version and invalidates all access tokens |
| Several independent workspaces | Yes | Each canonical workspace has independent state, policy, Worker name, secrets, resources, jobs, and locks |
| Several mutually untrusted users in one local runtime | No | Process and browser authority remain local-user authority |
| Multi-user tenancy in one Worker deployment | No | The architecture currently has one shared password, one policy, one active daemon, and one default Durable Object route |

Relevant current implementation:

- `src/worker/oauth-state.ts` stores OAuth clients, authorization codes, and tokens by `client_id` but has no principal or membership record.
- `src/worker/index.ts` accepts one `MCP_OAUTH_PASSWORD`, validates one `OAUTH_TOKEN_VERSION`, routes the deployment to the Durable Object named `default`, and selects one authenticated daemon.
- `src/local/state.mjs` creates independent credentials and state per canonical workspace.
- [ARCHITECTURE.md](ARCHITECTURE.md) explicitly excludes multi-user tenancy in one Worker deployment.

## Safe deployment choices today

### Same owner and same trust domain

Use one bridge and authorize multiple MCP clients. This is appropriate when every client/account is controlled by the same person or team and all may receive the same workspace authority.

Examples:

- the same owner connects ChatGPT web and a local Codex client;
- one trusted team uses several MCP host installations with an identical role;
- a user reconnects after replacing a device.

The separate tokens improve protocol hygiene and cancellation correlation, but they are not separate authorization domains.

### Different workspaces with the same owner

Run one bridge identity per canonical workspace. This preserves independent state, credentials, Workers, policies, resources, and jobs. It is preferable to exposing one broad parent directory solely for convenience.

### Different trust domains or mutually untrusted users

Do not share one `full` runtime. Use a separate bridge instance per trust domain, preferably with:

1. a dedicated low-privilege OS account, container, or VM;
2. a narrow workspace mounted or accessible only to that identity;
3. an independent state root and Worker credential set;
4. a separate Worker/deployment identity where administrative separation matters;
5. a profile no broader than the required workflow.

This external boundary is necessary because direct processes, package scripts, shells, browser sessions, Accessibility actions, credential stores, and network access inherit the local user's authority. A per-account row in Worker storage cannot turn Node.js process execution into an OS sandbox.

## Recommended future architecture

The least coupled design is **principal-aware authorization inside one bridge, while retaining one bridge per workspace/trust domain**. Do not begin by turning the Worker into a global router for every workspace, machine, and tenant.

```text
MCP host / OAuth client
        |
        | authorization code + PKCE
        v
Principal authentication
        |
        v
Bridge membership ------> named grant + revision
        |
        v
OAuth code/token bound to principal + grant + resource
        |
        v
Worker authorization gate
        |
        | bounded auth context + tool call
        v
Local daemon authorization gate
        |
        v
Workspace / process / browser operation
```

The design has five distinct concepts:

1. **Client registration** identifies the MCP application and its redirect URIs.
2. **Principal authentication** establishes the human or service identity.
3. **Membership** says that a principal may access one bridge.
4. **Grant** defines the exact capabilities and constraints available to that membership.
5. **OAuth tokens** carry a revocable reference to the principal, membership, grant revision, and protected resource.

Keeping these concepts separate prevents `client_id`, email address, connection password, and policy profile from becoming overloaded pseudo-identities.

## Data model

A minimal Worker-side model can remain inside the existing per-bridge Durable Object:

```text
principals
  principal_id
  display_label
  status
  authentication_method
  credential_reference_or_subject
  revocation_version
  created_at
  last_authenticated_at

memberships
  membership_id
  principal_id
  bridge_id
  grant_id
  grant_revision
  status
  expires_at
  created_at

clients
  client_id
  client_name
  redirect_uris
  registration_identity
  created_at
  last_used_at

authorization_codes
  code_hash
  client_id
  principal_id
  membership_id
  grant_id
  grant_revision
  redirect_uri
  code_challenge
  scope
  resource
  expires_at

access_tokens
  token_hash
  client_id
  principal_id
  membership_id
  grant_id
  grant_revision
  principal_revocation_version
  scope
  resource
  expires_at
```

Use random opaque identifiers. Do not use an email address, OAuth source address, client name, or browser fingerprint as the primary authorization key.

The current `OAuthClient`, `OAuthCode`, and `OAuthToken` records can be migrated by adding optional principal/grant fields and treating legacy records as the single-owner principal until reauthorization. Avoid a flag day that silently changes existing users' authority.

## Grant model

A grant should reference capabilities rather than duplicate an arbitrary list of tool names. The current shared policy contract already provides the correct vocabulary and compound requirements.

Example conceptual grants:

| Grant | Capabilities | Typical use |
|---|---|---|
| `reviewer` | read-only, workspace-confined | inspection and review |
| `editor` | read/write, no process execution | deterministic file changes |
| `agent` | workspace-confined writes and direct processes, isolated environment | trusted coding automation |
| `operator` | canonical `full` | single-owner or highly trusted administration |

The effective authorization must be the intersection of all applicable ceilings:

```text
local workspace policy ceiling
AND principal membership grant
AND OAuth scopes/resource binding
AND any MCP-host-side restrictions
```

A grant must never widen the locally selected workspace policy. For example, assigning `operator` cannot make a daemon started under `review` execute a process.

Do not create a second independently maintained permission matrix. Grant resolution should consume the same shared capability contract used by local policy, Worker tool advertisement, and runtime execution.

## Dual enforcement without two sources of truth

Worker-only filtering is insufficient because a protocol bug, stale token, alternate transport, or compromised relay must not bypass local authority. Local-only filtering is also insufficient because unauthorized tools should not be advertised or relayed.

Use the following contract:

1. The local daemon owns the machine policy ceiling and the canonical grant catalog it is willing to honor.
2. On authenticated `hello`, the daemon advertises a bounded grant-catalog revision/digest plus the policy ceiling and tool catalog.
3. The Worker owns principals, memberships, OAuth codes, and access tokens for that bridge.
4. A membership references only a grant ID/revision present in the daemon-advertised catalog.
5. The Worker filters `tools/list` and rejects `tools/call` using the membership grant.
6. Every relayed call includes a bounded authorization context containing opaque principal, membership, grant, and revision identifiers plus scopes.
7. The local daemon independently resolves the grant and rechecks the operation against the current local ceiling before execution.
8. A missing grant, stale revision, digest mismatch, suspended membership, or revoked principal fails closed.

This is not duplicated policy: the shared contract defines capability semantics; the Worker and daemon enforce the same resolved grant at separate trust boundaries.

## Authentication choices

Authentication should be an adapter behind the principal model, not embedded in tool authorization.

Reasonable progression:

1. **Compatibility mode:** retain the existing shared connection password and map it to one owner principal.
2. **Local managed accounts:** create separate high-entropy one-time invitations or passkey/WebAuthn credentials for principals.
3. **External identity provider:** accept OIDC identities from a configured issuer and map stable issuer/subject pairs to principals.
4. **Service principals:** use separately rotated non-human credentials with narrow grants and explicit expiry.

Do not issue one static password per person while leaving tokens unbound to a principal. That changes credential distribution but does not create account semantics.

For external identity, key principals by the pair `(issuer, subject)`, not by mutable email or display name. Keep identity-provider integration optional so a self-hosted single-owner installation remains simple.

## OAuth and MCP authorization rules

A principal-aware implementation should preserve the current authorization-code and PKCE flow and add these rules:

- the authorization code is bound to the authenticated principal, membership, client, redirect URI, PKCE challenge, scope, and resource;
- access tokens are audience/resource restricted to the exact bridge `/mcp` endpoint;
- tokens contain no raw credentials and are stored only as hashes;
- requested scopes are intersected with the membership grant rather than accepted as authority by themselves;
- dynamic client registration limits remain independent of principal limits;
- token and authorization-code quotas are enforced per principal and client as well as globally;
- cancellation/request correlation includes the token identity but never treats it as the principal database key;
- token validation checks principal status, membership status/expiry, principal revocation version, grant revision, token expiry, and resource binding.

The MCP authorization specification uses OAuth protected-resource metadata and resource indicators; OAuth security best practice requires exact redirect matching, PKCE, and audience-restricted tokens. Preserve those properties when adding identity rather than inventing a parallel session protocol.

## Revocation

The current `OAUTH_TOKEN_VERSION` is useful as an emergency whole-bridge kill switch but too coarse for ordinary account management.

Add four independent revocation levels:

1. revoke one access token/session;
2. revoke all tokens issued to one OAuth client for a principal;
3. increment one principal's revocation version or suspend the principal;
4. change or revoke one membership/grant revision.

Keep whole-bridge secret rotation for suspected deployment compromise. Ordinary account removal should not disconnect every other principal.

Managed jobs require separate treatment: a running job snapshots authority at acceptance and can outlive an MCP token. Revoking an account should block new calls immediately and provide an explicit option to cancel active jobs accepted by that membership. Silent automatic cancellation may be unsafe when cleanup/finally steps are required.

## Administration surface

Account management is an operator function, not an ordinary MCP tool available to every account. A future CLI could expose:

```text
machine-mcp account invite
machine-mcp account list
machine-mcp account show ACCOUNT_ID
machine-mcp account set-grant ACCOUNT_ID GRANT
machine-mcp account suspend ACCOUNT_ID
machine-mcp account revoke ACCOUNT_ID
machine-mcp account sessions ACCOUNT_ID
machine-mcp account revoke-session SESSION_ID
```

These names are a design proposal, not current commands.

Administrative mutations should require local operator access or a separately protected admin plane. Do not let a normal `full` MCP session implicitly create additional principals merely because it can execute shell commands; that would make account administration indistinguishable from local-machine takeover.

## Concurrency and quotas

The existing global bounds should remain. Add fair per-principal limits for:

- concurrent relay calls;
- OAuth clients and active tokens;
- authorization failures;
- process sessions;
- accepted managed jobs;
- response bytes and rate windows where needed.

A principal limit must not replace a global limit. Otherwise many accounts can exhaust one daemon collectively.

A single local daemon still serializes or coordinates operations that mutate shared workspace state. Account support does not make concurrent Git operations, patches, browser actions, or service changes conflict-free. Existing mutation locks and transactional checks remain authoritative.

## Audit and privacy

Operational logs must continue to omit credentials, tool arguments, file contents, process output, browser content, and personal identifiers.

For account diagnosis, log only bounded pseudonymous identifiers such as an HMAC-derived principal handle, grant ID/revision, event class, and outcome. Store a separate owner-only administrative audit record only when there is a concrete operator requirement, with explicit retention and access controls.

Do not expose account lists, emails, identity-provider subjects, or session inventories through ordinary `server_info`. A principal may see its own effective grant and token expiry; only the local administrator should see cross-account inventory.

## Cloudflare Durable Object topology

Retain one Durable Object instance per bridge/workspace. It already provides a serializable state and WebSocket coordination boundary for that bridge.

Avoid these two extremes:

- **One Durable Object per access token:** this fragments the one-daemon call registry and complicates global limits, cancellation, and grant updates.
- **One global Durable Object for every workspace and tenant:** this increases blast radius, couples unrelated deployments, creates a central routing/credential registry, and makes local lifecycle operations harder to reason about.

If a future shared control plane is required, keep it limited to account discovery/invitations and route each request to the bridge-specific Durable Object. Local tool calls should still terminate at the bridge boundary.

## Rejected designs

### Treat `client_id` as the account

Rejected because one application may serve many users and one user may use many applications. Client rotation or reinstall would also appear to create a new person.

### Give each user a different connection password only

Rejected because credentials, tokens, grants, revocation, quotas, and audit events still lack a stable principal binding.

### Enforce grants only in the Worker

Rejected because the local runtime is the final filesystem/process boundary and must fail closed independently.

### Enforce grants only in the daemon

Rejected because the Worker would advertise and relay tools to unauthorized callers, increasing leakage and attack surface.

### Put all machines and workspaces behind one tenant router immediately

Rejected as unnecessary coupling. The existing per-workspace lifecycle is a useful security and operational boundary.

### Share `full` among mutually untrusted accounts

Rejected because `full` exposes local-user process, shell, browser, and filesystem authority. Application-level role checks cannot provide OS isolation.

## Incremental delivery plan

### Phase 0: make the boundary explicit

- document current multi-client behavior and lack of account isolation;
- recommend separate bridge/OS boundaries for different trust domains;
- keep current behavior unchanged.

### Phase 1: principal records and targeted revocation

- add owner principal migration;
- bind codes/tokens to principal and membership IDs;
- add per-principal suspension and revocation version;
- preserve one common grant initially;
- add migration, expiry, quota, and revocation tests.

### Phase 2: named grants and dual enforcement

- derive grant capabilities from the shared policy contract;
- advertise grant catalog revision/digest in the daemon handshake;
- filter tool lists/calls in the Worker and recheck locally;
- add stale-revision, reconnect, policy-narrowing, cancellation, and managed-job tests.

### Phase 3: operator account lifecycle

- add invitation, list, suspension, grant, and session-revocation CLI commands;
- add owner-only persistence and administrative audit retention;
- add concurrent and fault-injection tests for account mutations.

### Phase 4: optional external identity

- add passkey/WebAuthn or configured OIDC adapters only after the principal/grant model is stable;
- keep single-owner password compatibility simple;
- do not require a central SaaS account service.

## Acceptance criteria for claiming multi-account support

The project should not advertise isolated multi-account support until tests prove all of the following:

- two principals can authorize through the same client and receive different grants;
- one principal can use two clients without becoming two accounts;
- revoking one principal leaves another principal's sessions valid;
- narrowing the local policy immediately prevents a broader account grant from executing;
- a stale grant revision fails in both Worker and daemon paths;
- `tools/list` and `tools/call` enforce the same effective grant;
- disconnect, daemon replacement, token expiry, and secret rotation converge safely;
- account quotas cannot bypass global bounds;
- managed jobs are attributed to a membership and have an explicit revocation/cancellation policy;
- logs and public status do not expose personal identifiers or credentials;
- different trust domains remain externally isolated when process/browser authority is available.

Until those conditions are implemented, the accurate product statement is:

> Machine Bridge supports multiple OAuth clients and tokens for one trusted workspace owner or trust domain. It does not yet provide isolated multi-user tenancy in one deployment.

## Standards and implementation references

- [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [OAuth 2.0 Security Best Current Practice (RFC 9700)](https://www.rfc-editor.org/rfc/rfc9700)
- [OAuth 2.0 Authorization Server Issuer Identification (RFC 9207)](https://www.rfc-editor.org/rfc/rfc9207)
- [OAuth 2.0 Resource Indicators (RFC 8707)](https://www.rfc-editor.org/rfc/rfc8707)
- [OAuth 2.0 Protected Resource Metadata (RFC 9728)](https://www.rfc-editor.org/rfc/rfc9728)
- [Cloudflare Durable Objects documentation](https://developers.cloudflare.com/durable-objects/)
- [Security policy](../SECURITY.md)
- [Architecture](ARCHITECTURE.md)
