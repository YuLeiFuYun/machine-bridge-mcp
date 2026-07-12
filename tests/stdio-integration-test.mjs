import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { loadState } from "../src/local/state.mjs";
import { ManagedJobManager } from "../src/local/managed-jobs.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temp = await mkdtemp(join(tmpdir(), "mbm-stdio-test-"));
const workspace = join(temp, "workspace");
const stateDir = join(temp, "state");
const home = join(temp, "home");
await mkdir(workspace, { recursive: true });
await mkdir(join(home, ".config", "machine-bridge-mcp"), { recursive: true });
await writeFile(join(home, "MODEL.md"), "stdio global model instructions\n", "utf8");
await writeFile(join(home, ".config", "machine-bridge-mcp", "agent.json"), JSON.stringify({ version: 1, model_instructions_file: "MODEL.md" }, null, 2), "utf8");
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
  env: { ...process.env, HOME: home, USERPROFILE: home, MBM_STDIO_FULL_ENV_TEST: "visible-through-full-env" },
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
  assert(initialized.result?.instructions?.includes("stdio global model instructions"), "stdio initialize did not inject model_instructions_file into the session context");
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const notificationMarker = join(workspace, "notification-must-not-write.txt");
  send({ jsonrpc: "2.0", method: "tools/call", params: { name: "write_file", arguments: { path: notificationMarker, content: "must-not-run" } } });
  const rejectedNotification = await responseFor(null);
  assert(rejectedNotification.error?.code === -32600, "stdio accepted tools/call without a request id");
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
  let notificationExecuted = false;
  try { await stat(notificationMarker); notificationExecuted = true; } catch {}
  assert(!notificationExecuted, "stdio silently executed a tools/call notification");

  child.stdin.write(`${"x".repeat(8 * 1024 * 1024 + 1024)}\n`);
  const oversizedLine = await responseFor(null, 15_000);
  assert(oversizedLine.error?.code === -32600 && oversizedLine.error?.message.includes("maximum size"), "stdio did not reject an oversized line incrementally");
  send({ jsonrpc: "2.0", id: 199, method: "ping" });
  const pingAfterOversize = await responseFor(199);
  assert(pingAfterOversize.result && typeof pingAfterOversize.result === "object", "stdio did not recover after discarding an oversized line");

  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const listed = await responseFor(2);
  const tools = new Map(listed.result.tools.map((tool) => [tool.name, tool]));
  for (const required of ["server_info", "session_bootstrap", "resolve_task_capabilities", "agent_context", "list_local_skills", "list_local_commands", "list_local_applications", "browser_status", "pair_browser_extension", "browser_get_source", "browser_fill_form", "browser_upload_files", "read_file", "view_image", "write_file", "edit_file", "apply_patch", "diagnose_runtime", "list_local_resources", "generate_ssh_key_resource", "stage_job", "start_job", "list_jobs", "read_job", "cancel_job", "run_process", "start_process", "read_process", "write_process", "kill_process", "exec_command", "git_log", "git_show"]) {
    assert(tools.has(required), `stdio default full profile omitted ${required}`);
  }
  assert(tools.get("write_file")?.annotations?.destructiveHint === true, "tool annotations missing");

  send({ jsonrpc: "2.0", id: 201, method: "tools/call", params: { name: "session_bootstrap", arguments: { path: "." } } });
  const bootstrap = await responseFor(201);
  assert(bootstrap.result?.structuredContent?.instructions?.includes("stdio global model instructions"), "session_bootstrap omitted global model instructions");
  send({ jsonrpc: "2.0", id: 202, method: "tools/call", params: { name: "resolve_task_capabilities", arguments: { path: ".", task: "inspect browser form and edit source files" } } });
  const capabilities = await responseFor(202);
  assert(capabilities.result?.structuredContent?.recommended_tools?.includes("browser_fill_form"), "task capability resolver omitted browser form tools");
  assert(capabilities.result?.structuredContent?.refresh?.strategy === "rescan-on-every-call", "task capability resolver did not advertise live refresh semantics");

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
  assert(serverInfo.result?.structuredContent?.tool_delivery?.host_exposed_tools_known_to_server === false, "server_info incorrectly claimed visibility into host-exposed tools");
  assert(serverInfo.result?.structuredContent?.tool_delivery?.host_may_expose_subset === true, "server_info did not disclose host-side tool filtering");

  send({ jsonrpc: "2.0", id: 602, method: "tools/call", params: { name: "diagnose_runtime", arguments: {} } });
  const diagnostics = await responseFor(602, 10_000);
  assert(diagnostics.result?.structuredContent?.request_reached_local_runtime === true, "runtime diagnostic did not prove daemon reachability");
  assert(diagnostics.result?.structuredContent?.checks?.some((check) => check.layer === "local-process-spawn" && check.ok), "runtime diagnostic did not validate local process spawning");
  send({ jsonrpc: "2.0", id: 603, method: "tools/call", params: { name: "list_local_resources", arguments: {} } });
  const localResources = await responseFor(603);
  assert(localResources.result?.structuredContent?.count === 0 && localResources.result?.structuredContent?.paths_exposed === false, "empty local resource registry was not reported safely");

  const generatedKeyPath = join(temp, "stdio-operator-key");
  send({ jsonrpc: "2.0", id: 604, method: "tools/call", params: { name: "generate_ssh_key_resource", arguments: { name: "stdio-key", path: generatedKeyPath, comment: "stdio-integration" } } });
  const generatedKey = await responseFor(604, 30_000);
  const generatedContent = generatedKey.result?.structuredContent;
  assert(generatedKey.result?.isError === false && generatedContent?.registered === true && generatedContent?.private_key_content_exposed === false, "generate_ssh_key_resource failed or exposed private content");
  assert(generatedContent?.paths_exposed === false && !("private_key_path" in generatedContent) && !JSON.stringify(generatedKey.result).includes(generatedKeyPath), "generate_ssh_key_resource exposed local paths by default");
  assert((await stat(generatedKeyPath)).isFile() && (await stat(`${generatedKeyPath}.pub`)).isFile(), "generate_ssh_key_resource did not create a key pair");
  if (process.platform !== "win32") assert(((await stat(generatedKeyPath)).mode & 0o777) === 0o600, "generated MCP private key mode is not 0600");
  const privateBytes = await readFile(generatedKeyPath);
  assert(!JSON.stringify(generatedKey.result).includes(privateBytes.toString("base64")), "generate_ssh_key_resource returned encoded private key bytes");
  send({ jsonrpc: "2.0", id: 605, method: "tools/call", params: { name: "list_local_resources", arguments: {} } });
  const resourcesAfterGeneration = await responseFor(605);
  assert(resourcesAfterGeneration.result?.structuredContent?.resources?.some((resource) => resource.name === "stdio-key" && resource.available), "generated SSH resource was not immediately visible");

  send({ jsonrpc: "2.0", id: 606, method: "tools/call", params: { name: "generate_ssh_key_resource", arguments: { name: "stdio-key", path: generatedKeyPath, comment: "stdio-integration", expose_paths: true } } });
  const generatedWithPaths = await responseFor(606, 30_000);
  const generatedWithPathsContent = generatedWithPaths.result?.structuredContent;
  assert(generatedWithPathsContent?.paths_exposed === true && generatedWithPathsContent?.private_key_path === generatedKeyPath && generatedWithPathsContent?.public_key_path === `${generatedKeyPath}.pub`, "generate_ssh_key_resource did not honor explicit expose_paths");

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

  const stagedMarker = join(workspace, "staged-job-must-not-run.txt");
  send({ jsonrpc: "2.0", id: 690, method: "tools/call", params: { name: "stage_job", arguments: {
    name: "stdio local approval handoff",
    steps: [{ argv: [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1],'unexpected')", stagedMarker], timeout_seconds: 10 }],
  } } });
  const stagedAccepted = await responseFor(690);
  const stagedJobId = stagedAccepted.result?.structuredContent?.job_id;
  assert(stagedAccepted.result?.structuredContent?.status === "staged" && stagedAccepted.result?.structuredContent?.execution_started === false, "stage_job did not remain non-executing");
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
  try { await readFile(stagedMarker); throw new Error("staged job executed before approval"); } catch (error) {
    if (!String(error?.message || error).includes("ENOENT")) throw error;
  }
  send({ jsonrpc: "2.0", id: 691, method: "tools/call", params: { name: "read_job", arguments: { job_id: stagedJobId } } });
  const stagedRead = await responseFor(691);
  assert(stagedRead.result?.structuredContent?.status === "staged", "read_job did not report staged status");
  send({ jsonrpc: "2.0", id: 692, method: "tools/call", params: { name: "cancel_job", arguments: { job_id: stagedJobId } } });
  const stagedCancelled = await responseFor(692);
  assert(stagedCancelled.result?.structuredContent?.status === "cancelled_before_start" && stagedCancelled.result?.structuredContent?.execution_started === false, "cancel_job did not cancel the staged plan without execution");

  const detachedMarker = join(workspace, "detached-job-marker.txt");
  const detachedCleanup = join(workspace, "detached-job-cleanup.txt");
  const detachedScript = "setTimeout(()=>require('node:fs').writeFileSync(process.argv[1],'detached-complete'),500)";
  send({ jsonrpc: "2.0", id: 700, method: "tools/call", params: { name: "start_job", arguments: {
    name: "survive stdio disconnect",
    steps: [{ argv: [process.execPath, "-e", detachedScript, detachedMarker], timeout_seconds: 10 }],
    finally_steps: [{ argv: [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1],'cleanup-complete')", detachedCleanup], timeout_seconds: 10 }],
  } } });
  const detachedAccepted = await responseFor(700);
  const detachedJobId = detachedAccepted.result?.structuredContent?.job_id;
  assert(detachedAccepted.result?.structuredContent?.continues_without_mcp_connection === true && typeof detachedJobId === "string", "managed job was not accepted as connection-independent");

  child.stdin.end();
  const exit = await waitForExit(child, 10_000);
  assert(exit.code === 0, `stdio server exited with ${exit.code}: ${stderr}`);
  assert(!stderr.includes("tool call completed"), "default stdio logging emitted per-call success noise");
  assert(!stderr.includes("tool call failed"), "default stdio logging emitted per-call failure noise");
  await waitForFile(detachedMarker, 10_000);
  await waitForFile(detachedCleanup, 10_000);
  assert(await readFile(detachedMarker, "utf8") === "detached-complete", "managed job did not survive stdio disconnect");
  assert(await readFile(detachedCleanup, "utf8") === "cleanup-complete", "managed job finally step did not survive stdio disconnect");
  const state = loadState(canonicalWorkspace, { stateDir });
  const jobRoot = await realpath(join(state.paths.profileDir, "jobs"));
  const resultFile = join(jobRoot, detachedJobId, "result.json");
  try {
    await waitForFile(resultFile, 10_000);
  } catch (error) {
    const manager = new ManagedJobManager({
      jobRoot,
      workspace: canonicalWorkspace,
      policy: state.policy,
      resources: state.resources,
      resourceStatePath: state.paths.statePath,
    });
    const diagnostic = manager.read({ job_id: detachedJobId });
    const jobDir = join(jobRoot, detachedJobId);
    const files = {};
    for (const name of ["status.json", "result.json", "runner.out.log", "runner.err.log", "runner.pid"]) {
      try { files[name] = await readFile(join(jobDir, name), "utf8"); } catch {}
    }
    throw new Error(`${error.message}; managed_job=${JSON.stringify(diagnostic)}; files=${JSON.stringify(files)}`);
  }
  const detachedResult = JSON.parse(await readFile(resultFile, "utf8"));
  assert(["succeeded", "recovered"].includes(detachedResult.status), `detached managed job ended as ${detachedResult.status}`);
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

async function waitForFile(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await readFile(path); return; } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`timed out waiting for file: ${path}`);
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
