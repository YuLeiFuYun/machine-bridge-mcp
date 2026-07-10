# Client configuration

## Choosing a transport

Use remote HTTPS/OAuth when the client cannot launch a local stdio process or must reach the machine from another device. Use stdio when the client runs on the same machine and supports local MCP processes.

| Client class | Recommended transport | Reason |
|---|---|---|
| ChatGPT remote connector / Developer Mode | Remote Worker | Public HTTPS endpoint and OAuth authorization |
| Claude Desktop | stdio | Local process transport; no cloud relay required |
| Cursor | stdio | Local process transport and direct workspace lifecycle |
| Codex CLI | stdio | Local MCP server configuration |
| Other MCP clients | stdio when local; remote when necessary | Minimize the trust and network boundary |

## Generate configuration

```sh
machine-mcp client-config --client all --workspace /path/to/project --profile agent
```

The generated command uses the current Node executable and installed entry script as absolute paths so it does not depend on GUI application PATH configuration.

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
        "agent"
      ]
    }
  }
}
```

Use the exact output of `client-config`; application-specific configuration locations change over time.

## Codex CLI TOML

```toml
[mcp_servers.machine_bridge]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/machine-mcp.mjs", "stdio", "--workspace", "/path/to/project", "--profile", "agent"]
```

## ChatGPT remote connection

Run:

```sh
machine-mcp --workspace /path/to/project --profile review
```

Enter the printed `/mcp` URL in the remote MCP connector. During OAuth authorization, verify the displayed client name and redirect URI before entering the connection password.

## Profile guidance

- Begin with `review` for an unfamiliar client or repository.
- Use `edit` when the client needs deterministic file mutation but no process execution.
- Use `agent` for normal coding work. It permits direct executables and process sessions, which remain powerful.
- Use `full` only when shell syntax is required and the client/instructions are trusted.

A client configuration is an authorization decision. Anyone who controls an authorized client can invoke every tool exposed by its selected profile.
