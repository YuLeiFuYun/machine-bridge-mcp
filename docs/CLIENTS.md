# Client configuration and model ownership

## The central distinction

An MCP server is not a model provider. It exposes tools, resources, or prompts. The MCP host is the AI application that owns the conversation, chooses or supplies the model, decides when a tool should be called, sends the tool request, and adds the result back to the model context.

For this project:

```text
Claude Desktop / Cursor / Codex / ChatGPT Desktop / another local MCP host
        owns the model, account, conversation, approvals, and tool-selection loop
                              |
                              | stdio or Streamable HTTP
                              v
machine-bridge-mcp
        exposes local file, Git, image, patch, and process tools
```

A local stdio connection does **not** use the model running in a separate ChatGPT web conversation. It uses whatever model/session the local host is configured to use:

- Claude Desktop uses the Claude account/model available to that application.
- Cursor uses the model/provider configured in Cursor.
- Codex CLI and the Codex IDE integration use their own authenticated Codex/OpenAI configuration.
- ChatGPT Desktop can use its signed-in ChatGPT/Codex host session and can launch local stdio servers on supported hosts.

The MCP protocol itself intentionally does not dictate how the host obtains an LLM. The optional MCP sampling primitive can let a server ask a capable host for a completion, but `machine-bridge-mcp` does not depend on sampling and does not bundle a model SDK.

## Why keep stdio when coding clients already have tools?

For many users, the client's native filesystem, patch, terminal, and approval system is sufficient. In that case, adding Machine Bridge over stdio is redundant and should be skipped.

The stdio mode exists for narrower cases:

1. **One tool contract across several clients.** The same tool names, schemas, patch behavior, Git handling, process sessions, result formats, and logging work in Claude Desktop, Cursor, Codex, ChatGPT Desktop, and other MCP hosts.
2. **Transport parity.** The local client can use essentially the same Machine Bridge runtime that hosted ChatGPT, Claude, Grok, and Copilot Studio connections use, without maintaining a second implementation.
3. **No remote relay for same-machine use.** The host launches the server directly, so no Cloudflare Worker, public URL, OAuth flow, or network round trip is needed.
4. **Capabilities missing from a particular host.** Exact edit semantics, transactional multi-file patches, retained process sessions, image results, or the project's policy profiles may be useful even when the host has basic shell tools.
5. **Durable managed jobs.** The same detached job/resource/finally semantics are available to local and remote hosts, while local CLI remains an operator fallback.
6. **Testing and interoperability.** stdio is a standard MCP transport and provides a direct way to validate the runtime independently of the Worker.

It is therefore an optional compatibility and reuse surface, not a replacement for the native agent tooling in Claude Desktop, Cursor, or Codex.

## Choosing a transport

| Situation | Recommended path |
|---|---|
| ChatGPT, Claude, Grok, Copilot Studio, or another hosted service must reach this computer remotely | Remote Worker with Streamable HTTPS/OAuth |
| A local MCP host needs Machine Bridge-specific tools | stdio |
| The local coding client already provides everything needed | Use the client's native tools; do not configure Machine Bridge stdio |
| Several local clients should share identical tool semantics | stdio |
| Access is required from another device or hosted agent | Remote Worker |

The MCP specification defines stdio and Streamable HTTP as standard transports. In stdio, the host launches the server as a subprocess and exchanges newline-delimited JSON-RPC through stdin/stdout. Streamable HTTP runs the server independently behind an HTTP endpoint.

Machine Bridge uses MCP `2026-07-28` as its native protocol and stdio is current-only. Native requests carry version and capabilities in `_meta`; `server/discover` replaces initialization, there is no MCP protocol session, and an HTTP response stream belongs to exactly one request. Remote Streamable HTTP additionally accepts the bounded stateless initialization-era dates `2025-06-18` and `2025-11-25` for `initialize`, `notifications/initialized`, `ping`, `tools/list`, and `tools/call`; those tool calls still execute through the current controller and never create `Mcp-Session-Id`, recovery GET, `Last-Event-ID`, replay state, or an initialization-owned authorization/session model. Any other removed-session behavior receives bounded upgrade guidance. Closing a native request stream cancels that request, and a connection, process, OAuth token, or stdio lifetime is never treated as conversation identity.

## Automatic capability selection

`server/discover` supplies conservative static server guidance, while `session_bootstrap` and `resolve_task_capabilities` explicitly refresh bounded project facts, authority-permitted instructions, skills, explicit/automatic package commands, applications, browser capability, and task-specific execution routes. Use the resolver when that refreshed context or route selection is material; straightforward file, Git, and shell work should use the already exposed tools directly rather than paying an extra discovery round trip. The resolver scores route bundles instead of forcing a single tool: registered commands, Bash/direct argv, process sessions, managed jobs, files/Git, browser, applications, resources, and diagnostics may appear together with ambiguity and fallback metadata. This advice never removes a policy-visible tool; direct Bash remains available under shell-capable authority.

The resolver always rescans task-specific metadata. A client that already holds `refresh.fingerprint` may send it as `known_refresh_fingerprint`; if the static instruction/skill/command identity is unchanged, the response omits that repeated material but still returns fresh skill/command matches, application results, ranked tools, and route advice. Capability results are filtered by effective account authority, so a restricted role does not receive hidden application/browser/shell metadata from a fuller daemon. No instruction file is required for the default layers, and no repository file is written automatically.

The host still owns the agent loop. A hosted client may use the recommendation automatically, ask for confirmation, expose only part of the catalog, or ignore server instructions. No MCP implementation can guarantee automatic invocation from the server side. Machine Bridge models that limitation explicitly instead of treating a recommendation as execution.

For browser tasks, the remote host reaches the local extension through the Worker and daemon. The extension controls the existing Chromium profile; it is not a separate Playwright profile.

## Generate local configuration

The default profile is `full`:

```sh
machine-mcp client-config --client all --workspace /path/to/project
```

The generated command uses the current Node executable and installed entry script as absolute paths so it does not depend on a GUI application's `PATH`.

To reduce authority:

```sh
machine-mcp client-config --client all --workspace /path/to/project --profile agent
machine-mcp client-config --client all --workspace /path/to/project --profile edit
machine-mcp client-config --client all --workspace /path/to/project --profile review
```

## JSON stdio configuration

Claude Desktop, Cursor, and many generic clients use a shape similar to:

```json
{
  "mcpServers": {
    "machine-bridge": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/path/to/machine-mcp.mjs",
        "stdio",
        "--workspace",
        "/path/to/project",
        "--profile",
        "full"
      ]
    }
  }
}
```

Use the exact output of `client-config`; application-specific configuration locations and UI flows can change.

## Codex configuration

Codex supports both local stdio servers and Streamable HTTP servers. A local configuration is:

```toml
[mcp_servers.machine_bridge]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/machine-mcp.mjs", "stdio", "--workspace", "/path/to/project", "--profile", "full"]
```

Codex CLI, the Codex IDE extension, and supported ChatGPT Desktop Codex hosts can share MCP configuration on the same Codex host. ChatGPT web does not read local Codex configuration files; web use requires a hosted plugin/connector or a reachable remote MCP endpoint.

## Remote hosted-client connection

Run:

```sh
machine-mcp --workspace /path/to/project
```

Enter the printed `/mcp` URL in the remote MCP connector. During OAuth authorization, verify the displayed client name and redirect URI before entering a Machine Bridge account name and password. The Worker exposes Streamable HTTP plus protected-resource discovery, authorization-server discovery, dynamic client registration, PKCE S256, `offline_access`, and rotating refresh tokens.

Supported configuration paths are:

- **ChatGPT and Grok:** enter the `/mcp` URL in the corresponding remote connector. The Worker has exact built-in CORS response support for `https://chatgpt.com`, `https://grok.com`, and the X-hosted Grok surface at `https://x.com`.
- **Claude custom connectors:** add the exact `/mcp` URL under Claude's connector settings and leave static OAuth client credentials empty so Claude can use DCR. Hosted Claude surfaces use `https://claude.ai/api/mcp/auth_callback`; the Worker accepts that exact registered redirect and rotates refresh tokens for the public client. See Anthropic's [remote custom connector guide](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) and [authentication contract](https://claude.com/docs/connectors/building/authentication).
- **Microsoft Copilot Studio:** from the agent's **Tools** page, select **Add a tool > New tool > Model Context Protocol**, enter the `/mcp` URL, then select **OAuth 2.0 > Dynamic discovery**. Create the connection and add it to the agent. See Microsoft's [existing MCP server guide](https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-add-existing-server-to-agent).

OAuth navigations and form submissions from opaque or client-specific browser containers are routed normally but receive no cross-origin response-sharing permission unless their exact origin is allowed. The authorization page permits form navigation only to itself and the validated redirect origin. For a validated Microsoft `consent.azure-apim.net` callback, the form policy also permits HTTPS subdomains of that same Microsoft consent domain and the exact Copilot Studio origin because Power Platform redirects its global callback to a regional endpoint and then back to Copilot Studio. Claude remote connectors originate from Anthropic infrastructure, while Copilot Studio connectivity runs through Power Platform connectors, so neither is a reason to broaden the browser CORS allowlist.

Several OAuth clients and named accounts can coexist. Accounts have independent passwords, roles, active state, versions, authorization codes, access tokens, refresh tokens, and targeted revocation. Their effective tool sets are intersected with the connected daemon policy. All accounts still share one daemon and OS user, so hard tenant isolation requires separate deployments; see [MULTI_ACCOUNT.md](MULTI_ACCOUNT.md).

## Profile guidance

- `full` is the default capability ceiling and prioritizes immediate usability. It is a canonical contract exposing every catalog tool, shell execution, unrestricted direct filesystem paths, absolute path output, and the full parent environment. Any individual narrowing is represented as `custom`. Remote accounts remain further constrained by immutable role, trusted-client, token-family, operation-invariant, and object-ownership checks.
- `agent` retains file mutation and direct process execution but removes shell parsing, confines direct filesystem tools to the workspace, and isolates the process environment.
- `edit` permits deterministic file mutation without process execution.
- `review` is read-only and workspace-confined.

A client configuration is an authorization decision. Anyone who controls an authorized host can invoke every tool exposed by the selected profile.

Before connecting a host, verify the local implementation directly:

```sh
machine-mcp full-test --workspace /path/to/project
```

A passing result proves that Machine Bridge and the local OS allowed its temporary file/process/shell/key/job probes at that time. It does not prove that a hosted MCP connector will expose every relay-advertised tool, deliver a later request, or that a cloud/remote account will authorize it.

For SSH automation, prefer `generate_ssh_key_resource` under canonical full, or `machine-mcp resource generate-ssh-key` from the terminal. The private key remains a local resource; private bytes and local paths are omitted by default, while metadata and the bare public fingerprint are returned. Paths require an explicit disclosure option. Installation of the public key into Google OS Login or a remote `authorized_keys` file remains an explicit external action.

## Host-side safety rules

The local `full` profile controls Machine Bridge's own tool catalog, path resolver, path display, process environment, and shell availability. For remote transport, the local transaction gate additionally controls when high-impact effects may run. It does not control the MCP host's model policy, approval UI, connector gateway, or platform execution filters. See [LOCAL_AUTHORIZATION.md](LOCAL_AUTHORIZATION.md).

Host-rendered tool invocation chips, status lines, or labels such as “called tool” are presentation owned by the MCP host, not Machine Bridge log records. Machine Bridge can suppress its own routine per-tool logs outside debug and can reduce unnecessary calls, but it cannot hide or restyle host-owned tool indicators. A host-side UI setting, if one exists, is the only layer that can change that presentation. Prefer fewer, coarser calls and avoid unnecessary capability-resolution calls when direct tools already suffice.

Hosts may also cache MCP discovery metadata and input schemas independently of the running server, and may keep conversation/surface app-routing state separately from the workspace-level app definition. For routine health checks, call `server_info` with `detail: "summary"`; it keeps the effective policy/count, account role without account ID, daemon readiness/relay state, pending/socket capacity, and foreground/settlement limits while omitting OAuth metadata, exact tool arrays, and full observability. The empty/default call returns the current `full` projection and is the cold path when an exact effective-tool list, account identity, or detailed counters are required. In that full projection, `server_info.tool_delivery.remote_foreground_execution_max_ms` is authoritative for the connected runtime. If a host still advertises an older or larger foreground timeout after the server reports 60,000 ms, refresh/review the workspace app or reconnect/recreate the connector so the host refreshes discovery; Machine Bridge cannot invalidate a host-owned schema/action cache from inside an already cached tool definition.

For routine workspace inventory, prefer `project_overview` with `detail: "summary"`. It keeps workspace/Git identity, effective and daemon policy/tool counts, compact capability-routing status, and up to 40 top-level names/types, while omitting account ID, exact tool arrays, routing fingerprints, and repeated entry paths/sizes. Request full detail only when those exact diagnostic fields are needed. As with `server_info`, summary is a presentation projection after authorization, not a lower-authority mode.


Machine Bridge itself does not block files because their names look sensitive. In remote mode, use the compact projection to inspect `server_info.authorization.effective_policy`; request full detail when exact `effective_tools` membership is required. `daemon.policy` is only the local ceiling. If the effective profile is `full` and the effective tool is present but a direct call is rejected before a structured result, Machine Bridge has no observation of that rejected request and cannot identify the cause from server-side evidence alone; conversation/surface app-routing state, a stale host action/tool snapshot, host tool filtering, connector-gateway policy, client routing, and platform policy are possibilities, not a diagnosis. Conversely, a successful `diagnose_runtime` response proves that request reached the local daemon through the currently used connector path and therefore does not support a blanket claim that Machine Bridge is currently disabled by the platform. A successful same-tool invocation in a fresh supported conversation is additional host-side evidence against a blanket outage when an older conversation still fails before dispatch; treat the difference as a host conversation/surface/snapshot issue until stronger evidence identifies the exact layer. If `diagnose_runtime` arrives but its fixed process or shell probe fails, the likely source moves downstream to local OS policy, endpoint-security software, permissions, shell configuration, or Machine Bridge policy. If an execution tool instead returns a child exit code plus bounded stdout/stderr, the child did start; for nested commands such as `ssh`, a remote forced-command usage screen or allowlist refusal in that output is target-side authorization evidence, not a local spawn or Machine Bridge policy denial. Changing `--profile`, `--unrestricted-paths`, or `--absolute-paths` cannot override host-side, operating-system, or remote-target enforcement.

Expected file-operation failures arrive as ordinary MCP tool-error results, not JSON-RPC transport failures. Clients should branch first on `structuredContent.error.code`, then optionally on the bounded `details.reason`. For example, `conflict/already_exists`, `conflict/hash_mismatch`, `conflict/text_ambiguous`, and `conflict/context_not_found` require a fresh read and reconciliation; `not_found/text_not_found` means the requested edit fragment is absent; `invalid_request` means the request or patch syntax must change. Do not log or display tool arguments to reconstruct diagnostics: public error details intentionally omit paths, file content, edit fragments, and compared hashes.

Remote configurable foreground tools advertise a 60-second maximum while preserving each tool’s 30- or 60-second default. That value bounds daemon execution; the Worker records its settlement deadline five seconds later. Admission and transport latency may consume part of that interval, and it is not a guarantee of host receipt. Missing or role-hidden tools, non-object arguments, and requests above that limit fail at the shared Worker schema boundary before daemon dispatch; schema failures include `side_effects_started=false`. SSE-capable current requests receive the same pre-dispatch validation as JSON responses and never allocate a recovery stream. Do not treat this as a retry invitation for the same oversized mutation, and do not attempt to evade a host refusal by renaming, encoding, or switching to another arbitrary execution tool. Instead:

1. register credentials locally as resource aliases so their values never enter MCP arguments;
2. submit a complete owner-authorized `start_job` plan before the workflow depends on later cleanup calls; `stage_job` is only a non-running draft, while an explicit local operator may use `machine-mcp job submit PLAN.json`;
3. use job-scoped temporary files or remote stdin scripts;
4. put idempotent cleanup in `finally_steps`;
5. inspect/cancel through `machine-mcp job ...` if the host later denies tools.

The initial `start_job` request is still subject to host approval. If it is blocked, the operator can review and submit the same JSON plan locally with `machine-mcp job submit plan.json`. See [MANAGED_JOBS.md](MANAGED_JOBS.md).
