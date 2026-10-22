import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDeviceIdentity, createDeviceSessionIdentity, publicDeviceJwkJson } from "../src/local/device-identity.mjs";
import serverMetadata from "../src/shared/server-metadata.json" with { type: "json" };
import { openPort, appendBounded, sleep, withTimeout, terminate, configureWorkerIntegration, WORKER_INTEGRATION_WS_MESSAGE_WAIT_MS } from "./fixtures/worker-integration/common.mjs";
import { runOAuthAndProtocolScenarios } from "./fixtures/worker-integration/oauth-and-protocol-scenarios.mjs";
import { runDaemonAndTaskScenarios } from "./fixtures/worker-integration/daemon-and-task-scenarios.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
const TOOL_SCHEMA_GENERATION = Number(serverMetadata.toolSchemaGeneration);
const port = await openPort();
if (port === 0) {
  console.log("worker integration test skipped (loopback listener unavailable)");
  process.exit(0);
}
const base = `http://127.0.0.1:${port}`;
const persistDir = await mkdtemp(path.join(os.tmpdir(), "mbm-worker-test-"));
const wrangler = path.join(packageRoot, "node_modules", "wrangler", "bin", "wrangler.js");
const OWNER_PASSWORD = `integration_owner_${"A".repeat(43)}`;
const REVIEWER_PASSWORD = `integration_reviewer_${"B".repeat(43)}`;
const EDITOR_PASSWORD = `integration_editor_${"E".repeat(43)}`;
const OPERATOR_PASSWORD = `integration_operator_${"O".repeat(43)}`;
const DAEMON_DEVICE_IDENTITY = createDeviceIdentity();
const DAEMON_SESSION_IDENTITY = createDeviceSessionIdentity(DAEMON_DEVICE_IDENTITY, base, "machine-bridge-mcp", pkg.version);
const args = [
  "dev",
  "--local",
  "--ip", "127.0.0.1",
  "--port", String(port),
  "--persist-to", persistDir,
  "--show-interactive-dev-session=false",
  "--var", `DAEMON_DEVICE_PUBLIC_KEY:${publicDeviceJwkJson(DAEMON_DEVICE_IDENTITY)}`,
  "--var", "OAUTH_TOKEN_VERSION:integration-token-version",
  "--var", "MBM_ALLOWED_ORIGINS:http://localhost:3001",
];

let logs = "";
const daemonSockets = [];
const activeHttpRequests = new Set();

configureWorkerIntegration({
  base,
  pkg,
  DAEMON_SESSION_IDENTITY,
  activeHttpRequests,
});

const child = spawn(process.execPath, [wrangler, ...args], {
  cwd: packageRoot,
  env: { ...process.env, NO_COLOR: "1", CI: "1" },
  detached: process.platform !== "win32",
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
const closed = new Promise((resolve) => { child.once("close", (code, signal) => resolve({ code, signal })); });
child.stdout.on("data", (chunk) => { logs = appendBounded(logs, chunk); });
child.stderr.on("data", (chunk) => { logs = appendBounded(logs, chunk); });
child.once("error", (error) => { logs = appendBounded(logs, error.stack || error.message); });

const context = {
  packageRoot, pkg, TOOL_SCHEMA_GENERATION, WORKER_INTEGRATION_WS_MESSAGE_WAIT_MS,
  port, base, persistDir, wrangler, child, closed, logs, daemonSockets, activeHttpRequests,
  OWNER_PASSWORD, REVIEWER_PASSWORD, EDITOR_PASSWORD, OPERATOR_PASSWORD,
  DAEMON_DEVICE_IDENTITY, DAEMON_SESSION_IDENTITY,
};

try {
  const authState = await runOAuthAndProtocolScenarios(context);
  await runDaemonAndTaskScenarios(context, authState);
  console.log("worker OAuth/MCP integration test ok");
} catch (error) {
  process.stderr.write(`${error.stack || error.message}\n--- wrangler output ---\n${logs}\n`);
  process.exitCode = 1;
} finally {
  for (const socket of daemonSockets) {
    try { socket.close(1000, "test complete"); } catch {}
  }
  await terminate(child);
  await Promise.race([closed, sleep(3000)]);
  await withTimeout(Promise.allSettled([...activeHttpRequests]), 3000,
    "outstanding worker integration HTTP requests").catch(() => {});
  await rm(persistDir, { recursive: true, force: true }).catch(() => {});
}
