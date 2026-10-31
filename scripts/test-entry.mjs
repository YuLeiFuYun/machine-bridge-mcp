#!/usr/bin/env node

// Source checkouts run the full fast verification plan. The published package
// intentionally does not ship tests/ or the verification runner, so it runs a
// self-contained runtime smoke instead of failing with MODULE_NOT_FOUND.
//
// The installed-package smoke must exercise the real stdio boundary: discovery,
// tool enumeration, and one tool call. A bare `--version` exit would let a
// package with a broken runtime, missing catalog, or unusable protocol layer
// report a passing `npm test`.
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const root = fileURLToPath(new URL("../", import.meta.url));
const runChecks = fileURLToPath(new URL("./run-checks.mjs", import.meta.url));

if (existsSync(runChecks)) {
  const result = spawnSync(process.execPath, [runChecks, "fast"], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}

const PROTOCOL_VERSION = "2026-07-28";
const REQUEST_TIMEOUT_MS = 60_000;
const binary = fileURLToPath(new URL("../bin/machine-mcp.mjs", import.meta.url));
const marker = `installed-package-smoke-${process.pid}-${Date.now()}`;

function requestMeta() {
  return {
    "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
    "io.modelcontextprotocol/clientCapabilities": {},
    "io.modelcontextprotocol/clientInfo": { name: "machine-bridge-installed-smoke", version: "1" },
  };
}

async function main() {
  const workspace = await mkdtemp(join(tmpdir(), "mbm-installed-smoke-workspace-"));
  const stateDir = await mkdtemp(join(tmpdir(), "mbm-installed-smoke-state-"));
  const child = spawn(process.execPath, [
    binary, "stdio", "--workspace", workspace, "--state-dir", stateDir,
  ], { cwd: workspace, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

  let stderr = "";
  const pending = new Map();
  const childClosed = new Promise((resolve) => { child.once("close", (code, signal) => resolve({ code, signal })); });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      fail(`installed package emitted non-JSON stdout during the stdio smoke: ${JSON.stringify(line.slice(0, 200))}`);
    }
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      waiter(message);
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-16 * 1024);
  });

  try {
    await writeFile(join(workspace, "smoke.txt"), `${marker}\n`, "utf8");
    const call = (id, method, params) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`installed package did not answer ${method} within ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

    const discovered = await call(1, "server/discover", { _meta: requestMeta() });
    if (discovered.error) throw new Error(`server/discover failed: ${JSON.stringify(discovered.error)}`);
    if (discovered.result?.resultType !== "complete") {
      throw new Error("server/discover did not return a complete result");
    }
    const serverInfo = discovered.result?._meta?.["io.modelcontextprotocol/serverInfo"];
    if (serverInfo?.name !== "machine-bridge-mcp") {
      throw new Error(`server/discover returned unexpected serverInfo: ${JSON.stringify(serverInfo)}`);
    }

    const listed = await call(2, "tools/list", { _meta: requestMeta() });
    if (listed.error) throw new Error(`tools/list failed: ${JSON.stringify(listed.error)}`);
    const tools = listed.result?.tools;
    if (!Array.isArray(tools) || !tools.some((tool) => tool?.name === "read_file")) {
      throw new Error("tools/list did not expose read_file");
    }

    const read = await call(3, "tools/call", {
      _meta: requestMeta(),
      name: "read_file",
      arguments: { path: "smoke.txt", start_line: 1, end_line: 1 },
    });
    if (read.error) throw new Error(`tools/call read_file failed: ${JSON.stringify(read.error)}`);
    if (read.result?.isError !== false || read.result?.resultType !== "complete") {
      throw new Error(`tools/call read_file did not succeed: ${JSON.stringify(read.result).slice(0, 500)}`);
    }
    if (read.result?.structuredContent?.content !== `${marker}\n`) {
      throw new Error(`tools/call read_file returned unexpected content: ${JSON.stringify(read.result?.structuredContent).slice(0, 500)}`);
    }

    child.stdin.end();
    const closed = await Promise.race([
      childClosed,
      new Promise((resolve) => { setTimeout(() => resolve({ code: "timeout" }), 10_000); }),
    ]);
    if (closed.code !== 0) {
      throw new Error(`installed package stdio server exited with ${JSON.stringify(closed)}${stderr ? `; stderr: ${stderr.trim()}` : ""}`);
    }
    console.log(`installed package smoke passed: ${tools.length} tools, discovery, and read_file round-trip`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    lines.close();
    await rm(workspace, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

main().catch((error) => {
  console.error(`installed package smoke failed: ${error?.message || String(error)}`);
  process.exitCode = 1;
});
