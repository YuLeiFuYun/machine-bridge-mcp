import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temp = await mkdtemp(join(tmpdir(), "mbm-stdio-test-"));
const workspace = join(temp, "workspace");
const stateDir = join(temp, "state");
await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace, { recursive: true }));
await writeFile(join(workspace, "sample.txt"), "one\ntwo\nthree\n", "utf8");
await writeFile(join(workspace, "pixel.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=", "base64"));
await writeFile(join(temp, "passwords.txt"), "stdio-sensitive-name-visible", "utf8");
const canonicalWorkspace = await realpath(workspace);

const child = spawn(process.execPath, [
  join(root, "bin", "machine-mcp.mjs"),
  "stdio",
  "--workspace", workspace,
  "--state-dir", stateDir,
], {
  cwd: root,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
  env: { ...process.env, MBM_STDIO_FULL_ENV_TEST: "visible-through-full-env" },
});

let stderr = "";
child.stderr.on("data", (chunk) => { stderr = appendBounded(stderr, chunk); });
const responses = [];
const waiters = [];
const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
rl.on("line", (line) => {
  let value;
  try { value = JSON.parse(line); } catch (error) {
    fail(`stdio emitted non-JSON stdout: ${line}\n${error.message}`);
  }
  responses.push(value);
  flushWaiters();
});

try {
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "stdio-test", version: "1" } } });
  const initialized = await responseFor(1);
  assert(initialized.result?.protocolVersion === "2025-11-25", "stdio protocol negotiation failed");
  assert(initialized.result?.capabilities?.tools, "stdio initialize omitted tools capability");
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const listed = await responseFor(2);
  const tools = new Map(listed.result.tools.map((tool) => [tool.name, tool]));
  for (const required of ["server_info", "read_file", "view_image", "write_file", "edit_file", "apply_patch", "run_process", "start_process", "read_process", "write_process", "kill_process", "exec_command", "git_log", "git_show"]) {
    assert(tools.has(required), `stdio default full profile omitted ${required}`);
  }
  assert(tools.get("write_file")?.annotations?.destructiveHint === true, "tool annotations missing");

  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "read_file", arguments: { path: "sample.txt", start_line: 2, end_line: 2 } } });
  const read = await responseFor(3);
  assert(read.result?.isError === false, "read_file returned an error");
  assert(read.result?.structuredContent?.path === join(canonicalWorkspace, "sample.txt"), "read_file did not use the default full profile's canonical absolute path output");
  assert(read.result?.structuredContent?.content === "two\n", "read_file line slice was incorrect");

  send({ jsonrpc: "2.0", id: 30, method: "tools/call", params: { name: "read_file", arguments: { path: join(temp, "passwords.txt") } } });
  const sensitiveNamedRead = await responseFor(30);
  assert(sensitiveNamedRead.result?.isError === false && sensitiveNamedRead.result?.structuredContent?.content.includes("stdio-sensitive-name-visible"), "default full profile blocked a sensitive-looking filename outside the workspace");

  send({ jsonrpc: "2.0", id: 31, method: "tools/call", params: { name: "view_image", arguments: { path: "pixel.png" } } });
  const image = await responseFor(31);
  assert(image.result?.content?.[0]?.type === "image", "view_image did not return native MCP image content");
  assert(image.result?.content?.[0]?.mimeType === "image/png", "view_image returned the wrong MIME type");
  assert(image.result?.structuredContent?.path === join(canonicalWorkspace, "pixel.png"), "view_image did not use the default full profile's canonical absolute path output");
  assert(!JSON.stringify(image.result).includes("$mcp"), "internal rich-result envelope leaked to the client");

  send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "edit_file", arguments: { path: "sample.txt", old_text: "two", new_text: "TWO" } } });
  const edited = await responseFor(4);
  assert(edited.result?.structuredContent?.replacements === 1, "edit_file failed");

  send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "apply_patch", arguments: { patch: "*** Begin Patch\n*** Update File: sample.txt\n@@\n one\n-TWO\n+second\n three\n*** Add File: added.txt\n+added\n*** End Patch" } } });
  const patched = await responseFor(5);
  assert(patched.result?.isError === false, "apply_patch failed");
  assert((await readFile(join(workspace, "sample.txt"), "utf8")).includes("second"), "apply_patch did not update file");
  assert(await readFile(join(workspace, "added.txt"), "utf8") === "added\n", "apply_patch did not add file");

  send({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "run_process", arguments: { argv: [process.execPath, "-e", "process.stdout.write('direct-ok')"], timeout_seconds: 5 } } });
  const processResult = await responseFor(6);
  assert(processResult.result?.structuredContent?.stdout === "direct-ok", "run_process failed");

  send({ jsonrpc: "2.0", id: 600, method: "tools/call", params: { name: "run_process", arguments: { argv: [process.execPath, "-e", "process.stdout.write(process.env.MBM_STDIO_FULL_ENV_TEST || 'missing')"], timeout_seconds: 5 } } });
  const fullEnvResult = await responseFor(600);
  assert(fullEnvResult.result?.structuredContent?.stdout === "visible-through-full-env", "default full profile did not inherit the parent environment");

  send({ jsonrpc: "2.0", id: 60, method: "tools/call", params: { name: "server_info", arguments: {} } });
  const serverInfo = await responseFor(60);
  const defaultPolicy = serverInfo.result?.structuredContent?.policy;
  assert(defaultPolicy?.profile === "full" && defaultPolicy?.origin === "default", "stdio did not use full as the default profile");
  assert(defaultPolicy?.execMode === "shell" && defaultPolicy?.unrestrictedPaths === true && defaultPolicy?.minimalEnv === false && defaultPolicy?.exposeAbsolutePaths === true, "stdio default full profile is not maximum permission");
  assert(serverInfo.result?.structuredContent?.enforcement?.sensitive_filename_filter === false, "server_info did not disclose the absence of a sensitive-filename filter");
  assert(serverInfo.result?.structuredContent?.enforcement?.host_policy_is_independent === true, "server_info did not disclose the independent host-policy boundary");

  send({ jsonrpc: "2.0", id: 601, method: "tools/call", params: { name: "exec_command", arguments: { command: "printf shell-ok", timeout_seconds: 5 } } });
  const shellResult = await responseFor(601);
  assert(shellResult.result?.structuredContent?.stdout === "shell-ok", "default full profile shell execution failed");

  const sessionScript = "process.stdin.setEncoding('utf8'); console.log('ready'); process.stdin.on('data', d => { console.log('echo:' + d.trim()); if (d.includes('quit')) process.exit(0); });";
  send({ jsonrpc: "2.0", id: 61, method: "tools/call", params: { name: "start_process", arguments: { argv: [process.execPath, "-e", sessionScript] } } });
  const startedSession = await responseFor(61);
  const sessionId = startedSession.result?.structuredContent?.session_id;
  assert(typeof sessionId === "string", "start_process did not return a session id");
  send({ jsonrpc: "2.0", id: 62, method: "tools/call", params: { name: "read_process", arguments: { session_id: sessionId, wait_ms: 5000 } } });
  const initialSessionOutput = await responseFor(62, 10_000);
  assert(initialSessionOutput.result?.structuredContent?.stdout?.data.includes("ready"), "read_process did not return initial output");
  const stdoutOffset = initialSessionOutput.result.structuredContent.stdout.next_offset;
  const stderrOffset = initialSessionOutput.result.structuredContent.stderr.next_offset;
  send({ jsonrpc: "2.0", id: 63, method: "tools/call", params: { name: "write_process", arguments: { session_id: sessionId, data: "hello\n" } } });
  const wroteSession = await responseFor(63);
  assert(wroteSession.result?.structuredContent?.bytes_written === 6, "write_process reported the wrong byte count");
  send({ jsonrpc: "2.0", id: 64, method: "tools/call", params: { name: "read_process", arguments: { session_id: sessionId, stdout_offset: stdoutOffset, stderr_offset: stderrOffset, wait_ms: 5000 } } });
  const echoedSession = await responseFor(64, 10_000);
  assert(echoedSession.result?.structuredContent?.stdout?.data.includes("echo:hello"), "process session did not preserve interactive stdin/stdout");
  send({ jsonrpc: "2.0", id: 65, method: "tools/call", params: { name: "write_process", arguments: { session_id: sessionId, data: "quit\n", close_stdin: true } } });
  await responseFor(65);
  send({ jsonrpc: "2.0", id: 66, method: "tools/call", params: { name: "read_process", arguments: { session_id: sessionId, stdout_offset: echoedSession.result.structuredContent.stdout.next_offset, wait_ms: 5000, wait_for_exit: true } } });
  const exitedSession = await responseFor(66, 10_000);
  assert(exitedSession.result?.structuredContent?.running === false, "process session did not record exit state");
  send({ jsonrpc: "2.0", id: 67, method: "tools/call", params: { name: "kill_process", arguments: { session_id: sessionId, force: true } } });
  const killedExitedSession = await responseFor(67);
  assert(killedExitedSession.result?.structuredContent?.termination_requested === false, "kill_process was not idempotent for an exited session");

  send({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "run_process", arguments: { argv: [process.execPath, "-e", "setTimeout(() => {}, 30000)"], timeout_seconds: 60 } } });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7, reason: "test" } });
  const cancelled = await responseFor(7, 10_000);
  assert(cancelled.result?.isError === true, "cancelled process did not return a tool error");
  assert(JSON.stringify(cancelled.result).includes("cancelled"), "cancelled process returned the wrong error");

  send({ jsonrpc: "2.0", id: 8, method: "ping", params: {} });
  const ping = await responseFor(8);
  assert(ping.result && Object.keys(ping.result).length === 0, "stdio server did not remain responsive after cancellation");

  child.stdin.end();
  const exit = await waitForExit(child, 10_000);
  assert(exit.code === 0, `stdio server exited with ${exit.code}: ${stderr}`);
  assert(!stderr.includes("tool call completed"), "default stdio logging emitted per-call success noise");
  console.log("stdio MCP integration test ok");
} finally {
  if (child.exitCode === null) child.kill("SIGKILL");
  rl.close();
  await rm(temp, { recursive: true, force: true }).catch(() => {});
}

function send(value) {
  child.stdin.write(`${JSON.stringify(value)}\n`);
}

function responseFor(id, timeoutMs = 5_000) {
  const existingIndex = responses.findIndex((item) => item.id === id);
  if (existingIndex >= 0) return Promise.resolve(responses.splice(existingIndex, 1)[0]);
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      const index = waiters.indexOf(waiter);
      if (index >= 0) waiters.splice(index, 1);
      rejectPromise(new Error(`timed out waiting for JSON-RPC id ${id}; stderr=${stderr}`));
    }, timeoutMs);
    const waiter = { id, resolve(value) { clearTimeout(timer); resolvePromise(value); } };
    waiters.push(waiter);
  });
}

function flushWaiters() {
  for (const waiter of [...waiters]) {
    const responseIndex = responses.findIndex((item) => item.id === waiter.id);
    if (responseIndex < 0) continue;
    const [value] = responses.splice(responseIndex, 1);
    waiters.splice(waiters.indexOf(waiter), 1);
    waiter.resolve(value);
  }
}

function waitForExit(processChild, timeoutMs) {
  if (processChild.exitCode !== null) return Promise.resolve({ code: processChild.exitCode, signal: processChild.signalCode });
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(`stdio child did not exit; stderr=${stderr}`)), timeoutMs);
    processChild.once("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal });
    });
  });
}

function appendBounded(current, chunk) {
  const next = current + String(chunk);
  return next.length > 64_000 ? next.slice(-64_000) : next;
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function fail(message) {
  throw new Error(message);
}
