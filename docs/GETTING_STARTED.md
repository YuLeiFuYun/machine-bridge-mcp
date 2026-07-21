# Installation and first-use guide

This guide covers a clean installation, first remote connections from ChatGPT, Claude, Grok, and Microsoft Copilot Studio, local stdio clients, browser setup, routine operation, upgrades, troubleshooting, and removal.

## 1. Decide which connection mode you need

Machine Bridge has two transports. Choose one before installing:

| Requirement | Use | Cloudflare required | Process that must remain available |
|---|---|---:|---|
| ChatGPT, Claude, Grok, Copilot Studio, a hosted agent, or another device must reach this computer | Remote Streamable HTTPS/OAuth | Yes | Machine Bridge daemon or installed login service |
| Claude Desktop, Cursor, Codex, ChatGPT Desktop, or another local host runs on this computer | Local stdio | No | The MCP host launches Machine Bridge as a subprocess |
| The local coding client already has equivalent file, Git, patch, and terminal tools | Neither | No | None |

Remote and stdio modes use the same local runtime and policy model. The remote Worker authenticates and relays calls; it does not read files or execute processes by itself.

## 2. Understand the authority you are granting

A new workspace uses the `full` profile unless another profile is selected explicitly. `full` preserves the complete tool catalog, shell execution, paths outside the selected workspace, absolute paths, browser/application automation, and the complete parent process environment. It is intended for a trusted owner using a trusted MCP host. Remote high-impact effects additionally require a local time-bounded capability lease; normal workspace reads/edits and project inspection remain automatic. Access to the existing browser profile is covered by one reusable `browser-session` lease rather than per-click approval. See [LOCAL_AUTHORIZATION.md](LOCAL_AUTHORIZATION.md).

For a first connection to an unfamiliar host, start with a narrower profile:

```sh
machine-mcp --workspace /path/to/project --profile review
```

Profiles:

| Profile | Reads | File changes | Direct processes | Shell | Direct filesystem scope |
|---|---:|---:|---:|---:|---|
| `full` | Yes | Yes | Yes | Yes | Unrestricted |
| `agent` | Yes | Yes | Yes | No | Selected workspace |
| `edit` | Yes | Yes | No | No | Selected workspace |
| `review` | Yes | No | No | No | Selected workspace |

A profile is a Machine Bridge policy ceiling. The MCP host, operating system, endpoint-security software, container, and cloud platform may impose additional restrictions.

## 3. Prerequisites

Required for every installation:

- Node.js 26 or newer;
- npm 12 or newer;
- macOS, Linux, or Windows;
- a local user account permitted to read or modify the selected workspace.

Remote mode additionally requires:

- a Cloudflare account permitted to deploy Workers and Durable Objects;
- a browser available for Wrangler sign-in;
- outbound HTTPS and WebSocket access from the computer running the daemon.

Browser automation additionally requires:

- a Chromium-based browser that can load an unpacked Manifest V3 extension;
- the extension loaded into the browser profile whose tabs and login state should be controlled.

Check the installed runtimes:

```sh
node --version
npm --version
```

Do not continue with an older runtime. This repository intentionally rejects unsupported Node/npm versions.

## 4. Install the released package

Use a temporary package-free directory. An older npm front-end can inspect metadata in the current directory before it launches npm 12; the isolated bootstrap prevents an unrelated project configuration from breaking installation.

### macOS and Linux

```sh
install_dir="$(mktemp -d)"
(
  cd "$install_dir"
  npx --yes npm@12.0.1 install --global npm@12.0.1
  npx --yes npm@12.0.1 install --global --omit=optional --allow-scripts=esbuild,workerd,sharp,fsevents machine-bridge-mcp@latest
)
rm -rf "$install_dir"

npm --version
machine-mcp doctor
```

### Windows Command Prompt

```bat
set "MBM_INSTALL_DIR=%TEMP%\machine-bridge-mcp-install-%RANDOM%-%RANDOM%"
mkdir "%MBM_INSTALL_DIR%"
pushd "%MBM_INSTALL_DIR%"
npx --yes npm@12.0.1 install --global npm@12.0.1
npx --yes npm@12.0.1 install --global --omit=optional --allow-scripts=esbuild,workerd,sharp,fsevents machine-bridge-mcp@latest
popd
rmdir /s /q "%MBM_INSTALL_DIR%"

npm --version
machine-mcp doctor
```

Reopen the terminal if `npm --version` still resolves to an older global installation.

### Run from a source checkout

macOS/Linux:

```sh
git clone https://github.com/YuLeiFuYun/machine-bridge-mcp.git
cd machine-bridge-mcp
npm install
./mbm
```

Windows Command Prompt:

```bat
git clone https://github.com/YuLeiFuYun/machine-bridge-mcp.git
cd machine-bridge-mcp
npm install
.\mbm.cmd
```

Source installs are for development or review. Released installations should normally use the global package command above.

## 5. Interpret the initial doctor result

Run:

```sh
machine-mcp doctor
```

The command checks the local runtime, package layout, Wrangler availability, Cloudflare login state, and known Worker health. Before the first remote deployment, a missing Cloudflare login or Worker is expected; local runtime failures are not.

Common installation failures:

| Message or symptom | Meaning | Corrective action |
|---|---|---|
| `Unknown cli config "--allow-scripts"` | npm 11 or older executed the install | Repeat the isolated npm 12 bootstrap |
| `Invalid property "node"` or `Invalid property "devEngines.node"` | An old npm parser inspected incompatible project metadata | Run the install from a new empty temporary directory |
| `machine-mcp: command not found` | The global npm binary directory is not on `PATH` | Reopen the terminal, inspect `npm prefix -g`, and add its binary directory to `PATH` |
| Native package install warning | npm did not approve reviewed native build scripts | Use the documented `--allow-scripts` and `--omit=optional` command exactly |
| Worker deployment completed, then health verification timed out | The independent `/healthz` route is blocked, mis-proxied, or temporarily unavailable; the upload may already be valid | Keep the recorded Worker name, run `machine-mcp status` and `machine-mcp doctor` from the same proxy environment, then retry normally. Do not invent a suffixed `--worker-name`; the saved fingerprint prevents a duplicate upload. |

## 6. First remote start

Choose the exact workspace to expose. Prefer an explicit path rather than relying on the current directory:

```sh
machine-mcp --workspace /path/to/project
```

For a narrower first run:

```sh
machine-mcp --workspace /path/to/project --profile review
```

The first start performs these operations:

1. canonicalizes and remembers the workspace;
2. creates owner-only per-workspace state and credentials;
3. opens the Wrangler/Cloudflare sign-in flow when required;
4. deploys a Worker and Durable Object for that workspace;
5. installs a platform-native login service unless `--no-autostart` is supplied;
6. starts an outbound authenticated WebSocket from the local daemon to the Worker;
7. creates the initial `owner` account when no account exists and prints its generated password once;
8. prints the remote `/mcp` URL.

The foreground command remains attached to the terminal. Keep it running while testing. The remote Worker cannot execute local tools when no authenticated daemon is connected.

The Worker name is a persistent workspace identity, not a retry counter. A successful Wrangler upload is recorded before health verification, so a later timeout does not require a new name and does not make the next start upload again. Supplying a different `--worker-name` for an initialized workspace requires `--force-worker` because it intentionally creates/replaces a separate Cloudflare Worker identity.

To run only in the background after setup:

```sh
machine-mcp service start
machine-mcp service status
```

To avoid installing autostart during a temporary test:

```sh
machine-mcp --workspace /path/to/project --no-autostart
```

## 7. Connect a hosted MCP client

Machine Bridge prints the remote endpoint and, only when creating the first account, a one-time owner password:

```text
MCP Server URL: https://<worker>.<account>.workers.dev/mcp
Account: owner
Password: account_password_...
```

Save the generated password in a password manager. It is not stored locally or shown again. Do not place it in a repository, issue, screenshot, chat message, shell history note, or shared document.

Current ChatGPT developer-mode flow, as documented in OpenAI's [Connect from ChatGPT](https://developers.openai.com/apps-sdk/deploy/connect-chatgpt) guide:

1. Open ChatGPT settings.
2. Under **Security and login**, enable **Developer mode** if the account or workspace permits it.
3. Open **Plugins** and create a developer-mode app.
4. Enter a descriptive name and the exact printed `/mcp` URL.
5. Start the connection.
6. On the Machine Bridge authorization page, verify the displayed client name, redirect URI, and resource.
7. Enter the Machine Bridge account name and password only after those values are recognized.
8. Create a new chat and enable the app for that conversation.

ChatGPT navigation labels can change. The invariant is that the client must connect to the public `/mcp` endpoint and complete the OAuth authorization page served by the Worker. The same public `/mcp` URL can be entered in Grok where remote MCP configuration is available. Machine Bridge grants CORS response access to the exact `https://grok.com` and `https://x.com` browser origins as well as ChatGPT's current and legacy origins without requiring a Wrangler command. OAuth navigation and form POST requests are not failed solely because an embedded authorization container reports an opaque or different origin. After validation, the consent page CSP includes only the exact registered callback origin so the browser can complete the `303` return.

### Claude custom connector

For an individual Pro or Max account, Anthropic currently documents this flow:

1. Open **Customize > Connectors**.
2. Select **+ > Add custom connector**.
3. Enter the exact printed `/mcp` URL.
4. Leave optional static OAuth client credentials empty; Machine Bridge supports dynamic client registration.
5. Add the connector, select **Connect**, and complete the Machine Bridge authorization page.
6. Enable the connector for a conversation from the chat's connector menu.

For Team and Enterprise organizations, an Owner first adds **Custom > Web** under **Organization settings > Connectors**, after which members connect individually. Hosted Claude surfaces register `https://claude.ai/api/mcp/auth_callback`, request `offline_access` when advertised, and refresh tokens before or after access-token expiry. Machine Bridge accepts that callback and rotates each public-client refresh token exactly once. See Anthropic's [custom connector guide](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) and [connector authentication requirements](https://claude.com/docs/connectors/building/authentication).

### Microsoft Copilot Studio

Microsoft currently recommends the MCP onboarding wizard:

1. Open the agent's **Tools** page.
2. Select **Add a tool > New tool > Model Context Protocol**.
3. Enter a server name, description, and the exact printed `/mcp` URL.
4. Select **OAuth 2.0**, then **Dynamic discovery**.
5. Select **Create**, then **Next**.
6. Create or select a connection and choose **Add to agent**.

Copilot Studio supports Streamable transport rather than the obsolete SSE transport. Its dynamic-discovery path uses the Worker's protected-resource metadata, authorization-server metadata, DCR endpoint, authorization-code exchange, and refresh-token exchange. The authorization page also permits Power Platform's global `consent.azure-apim.net` callback to hand the browser to its regional consent endpoint and then to Copilot Studio's `/connection/oauth/redirect` page. See Microsoft's [existing MCP server guide](https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-add-existing-server-to-agent). Power Platform data policies and tenant administration can still block a connection independently of Machine Bridge.

Claude remote connectors originate from Anthropic's cloud, and Copilot Studio reaches the endpoint through Power Platform connectors. Those server-to-server paths do not require adding Claude or Microsoft browser domains to `MBM_ALLOWED_ORIGINS`; widening CORS would not solve tenant, firewall, or Power Platform policy failures.

## 8. Verify the first connection

Ask the MCP host to call these tools in order:

1. `server_info` — proves the request reached the Worker and reports whether a daemon is authenticated;
2. `project_overview` — proves the relay reached the selected local runtime;
3. `diagnose_runtime` — runs fixed policy, filesystem, process, shell, managed-job, and resource probes permitted by the active profile.

For an explicit local acceptance test of the canonical `full` profile:

```sh
machine-mcp full-test --workspace /path/to/project
```

A successful local test does not prove that a hosted MCP client exposes every advertised tool. Hosts can independently hide tools or require approvals.

## 9. Configure a local stdio client

Generate configurations rather than manually guessing the Node path or package entrypoint:

```sh
machine-mcp client-config --client all --workspace /path/to/project
```

Use a narrower policy when appropriate:

```sh
machine-mcp client-config --client all --workspace /path/to/project --profile agent
machine-mcp client-config --client all --workspace /path/to/project --profile edit
machine-mcp client-config --client all --workspace /path/to/project --profile review
```

The generated command uses absolute executable paths so GUI applications do not depend on a shell-specific `PATH`.

A generic stdio invocation is:

```sh
machine-mcp stdio --workspace /path/to/project --profile full
```

The host owns the model, conversation, tool-selection loop, and approvals. Machine Bridge supplies tools; it is not a model provider.

## 10. Enable existing-browser automation

Run once after installation:

```sh
machine-mcp browser setup
machine-mcp browser status
```

Then:

1. Open the extensions page in the Chromium profile you actually use.
2. Enable Developer mode.
3. Load the unpacked extension directory printed by `browser setup`.
4. Complete the local pairing page.
5. Confirm that `machine-mcp browser status` reports the expected packaged version, protocol, and an authenticated connection.

Machine Bridge does not launch a separate browser profile. The extension controls the profile into which it was loaded, including its open tabs and logged-in sessions. Reload the unpacked extension after every Machine Bridge upgrade.

## 11. Routine commands

```sh
machine-mcp status
machine-mcp doctor
machine-mcp workspace show
machine-mcp service status
machine-mcp browser status
machine-mcp account list
```

Useful operational actions:

```sh
machine-mcp service stop
machine-mcp service start
machine-mcp rotate-secrets
machine-mcp account add alice reviewer
machine-mcp account rotate-password alice
machine-mcp resource list
machine-mcp job list
```

`rotate-secrets` invalidates every account access token and requires all clients to authorize again. For targeted revocation, disable an account, change its role, rotate its password, or remove it.

## 12. Work with more than one workspace

Each canonical workspace receives independent state, policy, credentials, Worker name, resource registry, job directory, startup lock, and daemon lock. Select workspaces explicitly:

```sh
machine-mcp --workspace /path/to/project-a
machine-mcp --workspace /path/to/project-b
```

Do not point two logical trust domains at one broad parent directory merely to reduce configuration. A workspace is an authorization boundary for confined profiles and an operational identity even when `full` permits paths outside it.

## 13. Upgrade

Version 1 supports only MCP protocol `2025-11-25`; upgrade or reconnect clients that still request an older date. The current 0.18.x state schema remains valid and should be preserved.


Repeat the isolated global installation, then start Machine Bridge in the target workspace:

```sh
install_dir="$(mktemp -d)"
(
  cd "$install_dir"
  npx --yes npm@12.0.1 install --global npm@12.0.1
  npx --yes npm@12.0.1 install --global --omit=optional --allow-scripts=esbuild,workerd,sharp,fsevents machine-bridge-mcp@latest
)
rm -rf "$install_dir"

machine-mcp --workspace /path/to/project --verbose
```

The foreground start performs bounded takeover of an earlier verified daemon when safe. If it refuses:

```sh
machine-mcp service status
machine-mcp service stop
machine-mcp --workspace /path/to/project --verbose
```

After upgrading, reload the unpacked browser extension before relying on browser tools.

## 14. Troubleshooting by layer

Use the first failing layer rather than changing unrelated settings.

### Package or runtime layer

```sh
node --version
npm --version
which machine-mcp       # macOS/Linux
where machine-mcp       # Windows
machine-mcp doctor
```

### Cloudflare/deployment layer

```sh
machine-mcp doctor
machine-mcp status
machine-mcp --workspace /path/to/project --force-worker --verbose
```

A forced deployment changes cloud state. Use it only when the normal deployment hash/health reconciliation is insufficient.

### Local service/daemon layer

```sh
machine-mcp service status
machine-mcp service stop
machine-mcp service start
```

A connected Worker with no authenticated daemon can authorize OAuth successfully but cannot execute local tools.

### MCP-host layer

If `server_info` or `project_overview` never returns a structured Machine Bridge result, the host may not have delivered the call. Check the host's plugin/app enablement, tool permissions, approval UI, connection status, tenant policy, and whether its configured server URL exactly ends in `/mcp`.

An OAuth refresh response of `invalid_grant` is intentional after refresh-token rotation, account suspension, role change, password rotation, removal, or deployment-wide token-version rotation. Remove and reconnect the hosted connector rather than retrying the stale refresh token.

### Operating-system layer

If `diagnose_runtime` reaches the daemon but a probe fails, inspect filesystem permissions, macOS TCC/SIP, Windows ACLs, endpoint-security policy, shell availability, or container restrictions. Changing Machine Bridge to `full` cannot override the operating system.

### Browser layer

```sh
machine-mcp browser status
machine-mcp browser setup
```

Verify that the extension is loaded in the intended profile, its version matches the installed package, and its badge reports authenticated readiness.

For detailed recovery procedures, see [OPERATIONS.md](OPERATIONS.md).

## 15. Remove Machine Bridge

Remove the selected deployment, service, and local state:

```sh
machine-mcp uninstall
npm uninstall -g machine-bridge-mcp
```

Keep the deployed Worker while removing local state and autostart:

```sh
machine-mcp uninstall --keep-worker
```

Uninstall is fail-closed. If a verified daemon, active managed job, unreadable lock, or service removal cannot be resolved safely, Machine Bridge retains state for diagnosis instead of deleting only part of the installation.

## 16. Before sharing access

The current release supports named accounts with targeted revocation and four roles: `reviewer`, `editor`, `operator`, and `owner`. Roles are enforced in the Worker and local runtime, but all accounts still share one daemon and OS user. Use separate deployments and external isolation for mutually untrusted users or hard tenant boundaries. Read [MULTI_ACCOUNT.md](MULTI_ACCOUNT.md) before sharing a deployment.
