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
5. **Testing and interoperability.** stdio is a standard MCP transport and provides a direct way to validate the runtime independently of the Worker.

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

- `full` is the default and prioritizes immediate usability. It exposes shell execution, unrestricted direct filesystem paths, absolute path output, and the full parent environment.
- `agent` retains file mutation and direct process execution but removes shell parsing, confines direct filesystem tools to the workspace, and isolates the process environment.
- `edit` permits deterministic file mutation without process execution.
- `review` is read-only and workspace-confined.

A client configuration is an authorization decision. Anyone who controls an authorized host can invoke every tool exposed by the selected profile.

## Host-side safety rules

The local `full` profile controls Machine Bridge's own tool catalog, path resolver, path display, process environment, and shell availability. It does not control the MCP host's model policy, approval UI, connector gateway, or platform execution filters.

Machine Bridge itself does not block files because their names look sensitive. If `server_info` reports `full` and a direct `read_file` request is still rejected as a “sensitive file” by the execution layer, that refusal comes from the host/platform rather than this server. Changing `--profile`, `--unrestricted-paths`, or `--absolute-paths` cannot override it. Use a trusted local client or an operator-controlled local command only where doing so is consistent with the host's terms and the user's security intent.
