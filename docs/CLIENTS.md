# Client configuration and model ownership

## The central distinction

An MCP server is not a model provider. It exposes tools, resources, or prompts. The MCP host is the AI application that owns the conversation, chooses or supplies the model, decides when a tool should be called, sends the tool request, and adds the result back to the model context.

For this project:

```text
Claude Desktop / Cursor / Codex / ChatGPT Desktop / another MCP host
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
2. **Transport parity.** The local client can use essentially the same Machine Bridge runtime that remote ChatGPT access uses, without maintaining a second implementation.
3. **No remote relay for same-machine use.** The host launches the server directly, so no Cloudflare Worker, public URL, OAuth flow, or network round trip is needed.
4. **Capabilities missing from a particular host.** Exact edit semantics, transactional multi-file patches, retained process sessions, image results, or the project's policy profiles may be useful even when the host has basic shell tools.
5. **Durable managed jobs.** The same detached job/resource/finally semantics are available to local and remote hosts, while local CLI remains an operator fallback.
6. **Testing and interoperability.** stdio is a standard MCP transport and provides a direct way to validate the runtime independently of the Worker.

It is therefore an optional compatibility and reuse surface, not a replacement for the native agent tooling in Claude Desktop, Cursor, or Codex.

## Choosing a transport

| Situation | Recommended path |
|---|---|
| ChatGPT web or another service must reach this computer remotely | Remote Worker with HTTPS/OAuth |
| A local MCP host needs Machine Bridge-specific tools | stdio |
| The local coding client already provides everything needed | Use the client's native tools; do not configure Machine Bridge stdio |
| Several local clients should share identical tool semantics | stdio |
| Access is required from another device or hosted agent | Remote Worker |

The MCP specification defines stdio and Streamable HTTP as standard transports. In stdio, the host launches the server as a subprocess and exchanges newline-delimited JSON-RPC through stdin/stdout. Streamable HTTP runs the server independently behind an HTTP endpoint.

## Automatic capability selection

MCP initialization and `resolve_task_capabilities` give the host a current view of conservative built-in working agreements, bounded project facts, explicit global/project instructions, skills, explicit/automatic package commands, applications, and browser capability. The resolver rescans rather than relying on a stale dynamic tool list and can return the best matching skill instructions in one call. No instruction file is required for the default layers, and no repository file is written automatically.

The host still owns the agent loop. ChatGPT web may use the recommendation automatically, ask for confirmation, expose only part of the catalog, or ignore server instructions. No MCP implementation can guarantee automatic invocation from the server side. Machine Bridge models that limitation explicitly instead of treating a recommendation as execution.

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

## Remote ChatGPT connection

Run:

```sh
machine-mcp --workspace /path/to/project
```

Enter the printed `/mcp` URL in the remote MCP connector. During OAuth authorization, verify the displayed client name and redirect URI before entering the connection password.

## Profile guidance

- `full` is the default and prioritizes immediate usability. It is a canonical contract exposing every catalog tool, shell execution, unrestricted direct filesystem paths, absolute path output, and the full parent environment. Any individual narrowing is represented as `custom`.
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

The local `full` profile controls Machine Bridge's own tool catalog, path resolver, path display, process environment, and shell availability. It does not control the MCP host's model policy, approval UI, connector gateway, or platform execution filters.

Machine Bridge itself does not block files because their names look sensitive. If `server_info` reports `full` and a direct call is still rejected before a structured tool result, the host/connector may have blocked delivery. If `diagnose_runtime` responds but its fixed process or shell probe fails, the likely source is local OS policy, endpoint-security software, permissions, or shell configuration. Changing `--profile`, `--unrestricted-paths`, or `--absolute-paths` cannot override either layer.

Do not attempt to evade a host refusal by renaming, encoding, or switching to another arbitrary execution tool. Instead:

1. register credentials locally as resource aliases so their values never enter MCP arguments;
2. submit a complete `start_job` plan before the workflow depends on later cleanup calls, or use `stage_job` plus local `job approve` when execution-class tools are unavailable;
3. use job-scoped temporary files or remote stdin scripts;
4. put idempotent cleanup in `finally_steps`;
5. inspect/cancel through `machine-mcp job ...` if the host later denies tools.

The initial `start_job` request is still subject to host approval. If it is blocked, the operator can review and submit the same JSON plan locally with `machine-mcp job submit plan.json`. See [MANAGED_JOBS.md](MANAGED_JOBS.md).
