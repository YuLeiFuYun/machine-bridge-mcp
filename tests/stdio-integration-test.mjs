import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { loadState } from "../src/local/state.mjs";
import { ManagedJobManager } from "../src/local/managed-jobs.mjs";
import { readBoundedRegularFileWithInfoSync } from "../src/local/secure-file.mjs";
import serverMetadata from "../src/shared/server-metadata.json" with { type: "json" };

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const MANAGED_JOB_SETTLEMENT_WAIT_MS = 5 * 60_000;
const PROCESS_TOOL_RESPONSE_WAIT_MS = 20_000;
const TOOL_SCHEMA_GENERATION = Number(serverMetadata.toolSchemaGeneration);
const temp = await mkdtemp(join(tmpdir(), "mbm-stdio-test-"));
const workspace = join(temp, "workspace");
const stateDir = join(temp, "state");
const home = join(temp, "home");
await mkdir(workspace, { recursive: true });
await mkdir(join(home, ".config", "machine-bridge-mcp"), { recursive: true });
await writeFile(join(home, "MODEL.md"), "stdio global model instructions\n", "utf8");
await writeFile(join(home, ".config", "machine-bridge-mcp", "agent.json"), JSON.stringify({ version: 1, model_instructions_file: "MODEL.md" }, null, 2), "utf8");
await writeFile(join(workspace, "package-lock.json"), "{}\n", "utf8");
await writeFile(join(workspace, "package.json"), JSON.stringify({
  packageManager: "npm@12.1.0",
  scripts: { check: "node private-script-body.mjs" },
}, null, 2), "utf8");
await writeFile(join(workspace, "sample.txt"), "one\ntwo\nthree\n", "utf8");
await writeFile(join(workspace, "pixel.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=", "base64"));
await writeFile(join(temp, "passwords.txt"), "stdio-sensitive-name-visible", "utf8");
const canonicalWorkspace = await realpath(workspace);
const currentMeta = Object.freeze({
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "stdio-current-test", version: "1" },
});

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
  const modernMeta = currentMeta;
  send({ jsonrpc: "2.0", id: 900, method: "server/discover", params: { _meta: modernMeta } });
  const discovered = await responseFor(900);
  assert(discovered.result?.resultType === "complete", "modern stdio discovery omitted resultType");
  assert(JSON.stringify(discovered.result?.supportedVersions) === JSON.stringify(["2026-07-28"]), "modern stdio discovery advertised a legacy retry version");
  assert(discovered.result?.cacheScope === "public" && discovered.result?.ttlMs >= 0, "modern stdio discovery omitted cache policy");
  assert(discovered.result?._meta?.["io.modelcontextprotocol/serverInfo"]?.name === "machine-bridge-mcp", "modern stdio discovery omitted server identity");

  send({ jsonrpc: "2.0", id: 901, method: "tools/list", params: { _meta: modernMeta } });
  const modernTools = await responseFor(901);
  assert(modernTools.result?.resultType === "complete", "modern stdio tools/list omitted resultType");
  assert(modernTools.result?.cacheScope === "private" && Array.isArray(modernTools.result?.tools), "modern stdio tools/list omitted private cache semantics");

  send({ jsonrpc: "2.0", id: 902, method: "subscriptions/listen", params: {
    _meta: modernMeta,
    notifications: { toolsListChanged: true },
  } });
  const subscriptionCompleted = await responseFor(902);
  assert(subscriptionCompleted.result?.resultType === "complete",
    "modern stdio did not gracefully complete an empty accepted subscription");
  assert(subscriptionCompleted.result?._meta?.["io.modelcontextprotocol/subscriptionId"] === 902,
    "modern stdio subscription completion omitted the subscription id");
  const acknowledgementIndex = responses.findIndex((message) => (
    message.method === "notifications/subscriptions/acknowledged"
      && message.params?._meta?.["io.modelcontextprotocol/subscriptionId"] === 902
  ));
  assert(acknowledgementIndex >= 0, "modern stdio subscription omitted the acknowledgement notification");
  const [acknowledgement] = responses.splice(acknowledgementIndex, 1);
  assert(Object.keys(acknowledgement.params?.notifications ?? {}).length === 0,
    "modern stdio acknowledged a notification capability the server does not advertise");
  send({ jsonrpc: "2.0", id: 909, method: "subscriptions/listen", params: { _meta: modernMeta } });
  const invalidSubscription = await responseFor(909);
  assert(invalidSubscription.error?.code === -32602, "modern stdio accepted a subscription without notifications");

  send({ jsonrpc: "2.0", id: 903, method: "tools/call", params: {
    _meta: modernMeta,
    name: "read_file",
    arguments: { path: "sample.txt", start_line: 1, end_line: 1 },
  } });
  const modernRead = await responseFor(903);
  assert(modernRead.result?.resultType === "complete" && modernRead.result?.isError === false, "modern stdio tool call failed");
  assert(modernRead.result?.structuredContent?.content === "one\n", "modern stdio tool call returned the wrong result");

  send({ jsonrpc: "2.0", id: 906, method: "tools/call", params: {
    _meta: modernMeta,
    name: "read_file",
    arguments: { path: "sample.txt", unexpected: "must-not-run" },
  } });
  const invalidModernArguments = await responseFor(906);
  assert(invalidModernArguments.error?.code === -32602
    && invalidModernArguments.error?.data?.validation_issues?.[0]?.instancePath === "/unexpected",
  "modern stdio malformed tool arguments were not a protocol error");
  send({ jsonrpc: "2.0", id: 907, method: "tools/call", params: {
    _meta: modernMeta,
    name: "missing_tool",
    arguments: {},
  } });
  const unknownModernTool = await responseFor(907);
  assert(unknownModernTool.error?.code === -32602, "modern stdio unknown tool was not a protocol error");

  send({ jsonrpc: "2.0", id: 908, method: "initialize", params: { _meta: modernMeta } });
  const modernInitialize = await responseFor(908);
  assert(modernInitialize.error?.code === -32601, "modern stdio initialize entered the legacy adapter");

  send({ jsonrpc: "2.0", id: 904, method: "ping", params: { _meta: modernMeta } });
  const removedPing = await responseFor(904);
  assert(removedPing.error?.code === -32601, "modern stdio retained removed ping semantics");

  send({ jsonrpc: "2.0", id: 905, method: "tools/list", params: { _meta: {
    "io.modelcontextprotocol/protocolVersion": "1900-01-01",
    "io.modelcontextprotocol/clientCapabilities": {},
  } } });
  const unsupportedModern = await responseFor(905);
  assert(unsupportedModern.error?.code === -32022
    && unsupportedModern.error?.data?.supported?.[0] === "2026-07-28",
  "modern stdio unsupported-version error is invalid");

  sendRaw({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "stdio-removed-test", version: "1" } } });
  const removedInitialize = await responseFor(1);
  assert(removedInitialize.error?.code === -32601
    && removedInitialize.error?.message?.includes("upgrade the client")
    && JSON.stringify(removedInitialize.error?.data?.supported) === JSON.stringify(["2026-07-28"]),
  "stdio removed protocol did not return bounded current-version upgrade guidance");
  sendRaw({ jsonrpc: "2.0", id: 198, method: "tools/list", params: {} });
  const missingMetadata = await responseFor(198);
  assert(missingMetadata.error?.code === -32602 && missingMetadata.error?.message?.includes("protocolVersion"),
    "stdio accepted a current request without per-request protocol metadata");

  const notificationMarker = join(workspace, "notification-must-not-write.txt");
  send({ jsonrpc: "2.0", method: "tools/call", params: { name: "write_file", arguments: { path: notificationMarker, content: "must-not-run" } } });
  const rejectedNotification = await responseFor(null);
  assert(rejectedNotification.error?.code === -32600, "stdio accepted tools/call without a request id");
  await new Promise((resolvePromise) => { setTimeout(resolvePromise, 150); });
  let notificationExecuted = false;
  try { await stat(notificationMarker); notificationExecuted = true; } catch {}
  assert(!notificationExecuted, "stdio silently executed a tools/call notification");

  child.stdin.write(`${"x".repeat(8 * 1024 * 1024 + 1024)}\n`);
  const oversizedLine = await responseFor(null, 15_000);
  assert(oversizedLine.error?.code === -32600 && oversizedLine.error?.message.includes("maximum size"), "stdio did not reject an oversized line incrementally");
  send({ jsonrpc: "2.0", id: 199, method: "server/discover" });
  const discoverAfterOversize = await responseFor(199);
  assert(JSON.stringify(discoverAfterOversize.result?.supportedVersions) === JSON.stringify(["2026-07-28"]), "stdio did not recover after discarding an oversized line");

  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const listed = await responseFor(2);
  const tools = new Map(listed.result.tools.map((tool) => [tool.name, tool]));
  for (const required of ["server_info", "session_bootstrap", "resolve_task_capabilities", "agent_context", "list_local_skills", "list_local_commands", "list_local_applications", "browser_status", "pair_browser_extension", "browser_manage_tabs", "browser_wait", "browser_get_source", "browser_fill_form", "browser_upload_files", "read_file", "view_image", "write_file", "edit_file", "apply_patch", "diagnose_runtime", "list_local_resources", "generate_ssh_key_resource", "stage_job", "start_job", "list_jobs", "read_job", "cancel_job", "run_process", "start_process", "read_process", "write_process", "kill_process", "exec_command", "git_log", "git_show"]) {
    assert(tools.has(required), `stdio default full profile omitted ${required}`);
  }
  assert(tools.get("write_file")?.annotations?.destructiveHint === true, "tool annotations missing");
  assert(tools.get("read_job")?.inputSchema?.properties?.wait_ms?.default === 0
    && tools.get("read_job")?.inputSchema?.properties?.wait_ms?.maximum === 40_000,
  "stdio read_job lost its local immediate-default / bounded optional-wait contract");
  for (const jobTool of ["stage_job", "start_job"]) {
    const schema = tools.get(jobTool)?.inputSchema;
    assert(schema?.properties?.steps?.items?.properties?.timeout_seconds?.maximum === 21_600
      && schema?.properties?.finally_steps?.items?.properties?.timeout_seconds?.maximum === 21_600,
    `${jobTool} no longer permits one continuous managed-job step beyond 100 minutes`);
  }

  send({ jsonrpc: "2.0", id: 201, method: "tools/call", params: { name: "session_bootstrap", arguments: { path: "." } } });
  const bootstrap = await responseFor(201);
  assert(bootstrap.result?.structuredContent?.builtin_instructions?.source === "machine-bridge://defaults/working-agreements", "session_bootstrap omitted built-in instruction metadata");
  assert(bootstrap.result?.structuredContent?.automatic_project_context?.source === "machine-bridge://project-context/current", "session_bootstrap omitted automatic project-context metadata");
  assert(bootstrap.result?.structuredContent?.instructions?.includes("stdio global model instructions"), "session_bootstrap omitted global model instructions");
  send({ jsonrpc: "2.0", id: 202, method: "tools/call", params: { name: "resolve_task_capabilities", arguments: { path: ".", task: "inspect browser form and edit source files" } } });
  const capabilities = await responseFor(202);
  assert(capabilities.result?.structuredContent?.recommended_tools?.includes("browser_fill_form"), "task capability resolver omitted browser form tools");
  assert(capabilities.result?.structuredContent?.execution_routing?.routes?.some((route) => route.id === "browser")
    && capabilities.result?.structuredContent?.execution_routing?.routes?.some((route) => route.id === "shell"),
  "task capability resolver did not return set-level browser routing with a direct-shell alternative");
  assert(capabilities.result?.structuredContent?.execution_routing?.enforcement?.startsWith("advisory_only"),
    "task capability routing did not expose its non-enforcement boundary");
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

  send({ jsonrpc: "2.0", id: 32, method: "tools/call", params: { name: "write_file", arguments: { path: "sample.txt", content: "must-not-overwrite", create_only: true } } });
  const createConflict = await responseFor(32);
  const createConflictError = createConflict.result?.structuredContent?.error;
  assert(createConflict.result?.isError === true
    && createConflictError?.code === "conflict"
    && createConflictError?.retryable === false
    && createConflictError?.details?.reason === "already_exists"
    && !JSON.stringify(createConflictError).includes(canonicalWorkspace),
  "write_file create-only conflict lost its stable private error contract");
  assert(await readFile(join(workspace, "sample.txt"), "utf8") === "one\ntwo\nthree\n", "create-only conflict overwrote the existing file");

  send({ jsonrpc: "2.0", id: 33, method: "tools/call", params: { name: "edit_file", arguments: { path: "sample.txt", old_text: "missing-text", new_text: "replacement" } } });
  const missingEditText = await responseFor(33);
  const missingEditError = missingEditText.result?.structuredContent?.error;
  assert(missingEditText.result?.isError === true
    && missingEditError?.code === "not_found"
    && missingEditError?.details?.reason === "text_not_found",
  "edit_file missing text lost its stable error contract");

  send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "edit_file", arguments: { path: "sample.txt", old_text: "two", new_text: "TWO" } } });
  const edited = await responseFor(4);
  assert(edited.result?.structuredContent?.replacements === 1, "edit_file failed");

  send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "apply_patch", arguments: { patch: "*** Begin Patch\n*** Update File: sample.txt\n@@\n one\n-TWO\n+second\n three\n*** Add File: added.txt\n+added\n*** End Patch" } } });
  const patched = await responseFor(5);
  assert(patched.result?.isError === false, `apply_patch failed: ${JSON.stringify(patched.result?.structuredContent || patched)}`);
  assert(patched.result?.structuredContent?.files?.every((file) => Object.values(file).every((value) => value !== undefined)),
    "apply_patch returned undefined fields outside the JSON result contract");
  assert((await readFile(join(workspace, "sample.txt"), "utf8")).includes("second"), "apply_patch did not update file");
  assert(await readFile(join(workspace, "added.txt"), "utf8") === "added\n", "apply_patch did not add file");

  send({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "run_process", arguments: { argv: [process.execPath, "-e", "process.stdout.write('direct-ok')"], timeout_seconds: 5 } } });
  const processResult = await responseFor(6, PROCESS_TOOL_RESPONSE_WAIT_MS);
  assert(processResult.result?.structuredContent?.stdout === "direct-ok", "run_process failed");

  send({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "run_process", arguments: { argv: [process.execPath, "-e", "process.stdout.write('L'.repeat(100000) + 'STDIO-LARGE-END')"], timeout_seconds: 5 } } });
  const largeProcess = await responseFor(7, PROCESS_TOOL_RESPONSE_WAIT_MS);
  const largeProcessId = largeProcess.result?.structuredContent?.output_session_id;
  assert(typeof largeProcessId === "string" && largeProcess.result.structuredContent.stdout_truncated_bytes > 0, "stdio large process did not return a continuation session");
  assert(Buffer.byteLength(largeProcess.result?.content?.[0]?.text || "") < 512, "stdio large process duplicated output into MCP text");
  send({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "read_process", arguments: { session_id: largeProcessId, stdout_offset: 0, stderr_offset: 0, max_bytes: 262144 } } });
  const largePage = await responseFor(8);
  assert(largePage.result?.structuredContent?.stdout?.data.endsWith("STDIO-LARGE-END"), "stdio process continuation lost the retained output tail");

  send({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "run_process", arguments: { argv: [process.execPath, "-e", "process.stderr.write('F'.repeat(100000) + 'STDIO-FAIL-END'); process.exitCode = 7"], timeout_seconds: 5 } } });
  const failedProcess = await responseFor(9, PROCESS_TOOL_RESPONSE_WAIT_MS);
  const failedDetails = failedProcess.result?.structuredContent?.error?.details?.process;
  assert(failedProcess.result?.isError === true && typeof failedDetails?.output_session_id === "string", "stdio process failure lost typed continuation details");
  assert(Buffer.byteLength(failedProcess.result.structuredContent.error.message) < 2300, "stdio process failure returned unbounded stderr in its message");
  send({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "read_process", arguments: { session_id: failedDetails.output_session_id, stdout_offset: 0, stderr_offset: 0, max_bytes: 262144 } } });
  const failedPage = await responseFor(10);
  assert(failedPage.result?.structuredContent?.stderr?.data.endsWith("STDIO-FAIL-END"), "stdio failure continuation lost the retained stderr tail");

  send({ jsonrpc: "2.0", id: 600, method: "tools/call", params: { name: "run_process", arguments: { argv: [process.execPath, "-e", "process.stdout.write(process.env.MBM_STDIO_FULL_ENV_TEST || 'missing')"], timeout_seconds: 5 } } });
  const fullEnvResult = await responseFor(600, PROCESS_TOOL_RESPONSE_WAIT_MS);
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
  assert(serverInfo.result?.structuredContent?.tool_delivery?.tool_schema_generation === TOOL_SCHEMA_GENERATION
    && serverInfo.result?.structuredContent?.tool_delivery?.discovery_ttl_ms === 0
    && serverInfo.result?.structuredContent?.tool_delivery?.tool_list_ttl_ms === 0
    && serverInfo.result?.structuredContent?.tool_delivery?.host_turn_deadline_observable === false
    && serverInfo.result?.structuredContent?.tool_delivery?.managed_jobs_detached_from_mcp_response === true,
  "stdio server_info lost schema freshness or external-host/durable-job boundary evidence");
  send({ jsonrpc: "2.0", id: 6000, method: "tools/call", params: { name: "server_info", arguments: { detail: "summary" } } });
  const compactServerInfo = await responseFor(6000);
  const compactInfo = compactServerInfo.result?.structuredContent;
  assert(compactInfo?.detail === "summary" && compactInfo?.policy?.profile === "full"
    && compactInfo?.runtime?.lifecycle && compactInfo?.tool_delivery?.daemon_advertised_tool_count === serverInfo.result?.structuredContent?.tool_delivery?.daemon_advertised_tool_count
    && compactInfo?.tool_delivery?.tool_schema_generation === TOOL_SCHEMA_GENERATION
    && compactInfo?.tool_delivery?.host_turn_deadline_observable === false,
  "stdio compact server_info omitted core health or policy state");
  assert(!("tools" in compactInfo) && !("observability" in compactInfo) && !("security_audit" in compactInfo) && !("trust" in compactInfo)
    && JSON.stringify(compactInfo).length < JSON.stringify(serverInfo.result.structuredContent).length * 0.6,
  "stdio compact server_info retained cold-path diagnostics or failed to compact materially");

  send({ jsonrpc: "2.0", id: 602, method: "tools/call", params: { name: "diagnose_runtime", arguments: {} } });
  const diagnostics = await responseFor(602, 10_000);
  assert(diagnostics.result?.structuredContent?.request_reached_local_runtime === true, "runtime diagnostic did not prove daemon reachability");
  assert(diagnostics.result?.structuredContent?.runtime?.processes?.active_processes >= 0
    && diagnostics.result?.structuredContent?.runtime?.execution_guardrails?.tool_calls?.reserved_control_capacity === 2
    && typeof diagnostics.result?.structuredContent?.runtime?.security_audit?.worker_ready === "boolean"
    && diagnostics.result?.structuredContent?.observability?.in_flight_calls?.reserved_capacity === 2,
  "runtime diagnostic omitted wired control-plane state");
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
  const privateSnapshot = readBoundedRegularFileWithInfoSync(generatedKeyPath, 1024 * 1024, "generated SSH private key");
  const publicSnapshot = readBoundedRegularFileWithInfoSync(`${generatedKeyPath}.pub`, 64 * 1024, "generated SSH public key");
  assert(privateSnapshot.info.isFile() && publicSnapshot.info.isFile(), "generate_ssh_key_resource did not create a key pair");
  if (process.platform !== "win32") assert((privateSnapshot.info.mode & 0o777) === 0o600, "generated MCP private key mode is not 0600");
  const privateBytes = privateSnapshot.buffer;
  assert(!JSON.stringify(generatedKey.result).includes(privateBytes.toString("base64")), "generate_ssh_key_resource returned encoded private key bytes");
  send({ jsonrpc: "2.0", id: 605, method: "tools/call", params: { name: "list_local_resources", arguments: {} } });
  const resourcesAfterGeneration = await responseFor(605);
  assert(resourcesAfterGeneration.result?.structuredContent?.resources?.some((resource) => resource.name === "stdio-key" && resource.available), "generated SSH resource was not immediately visible");

  send({ jsonrpc: "2.0", id: 606, method: "tools/call", params: { name: "generate_ssh_key_resource", arguments: { name: "stdio-key", path: generatedKeyPath, comment: "stdio-integration", expose_paths: true } } });
  const generatedWithPaths = await responseFor(606, 30_000);
  const generatedWithPathsContent = generatedWithPaths.result?.structuredContent;
  assert(generatedWithPathsContent?.paths_exposed === true && generatedWithPathsContent?.private_key_path === generatedKeyPath && generatedWithPathsContent?.public_key_path === `${generatedKeyPath}.pub`, "generate_ssh_key_resource did not honor explicit expose_paths");

  send({ jsonrpc: "2.0", id: 601, method: "tools/call", params: { name: "exec_command", arguments: { command: "printf shell-ok", timeout_seconds: 5 } } });
  const shellResult = await responseFor(601, PROCESS_TOOL_RESPONSE_WAIT_MS);
  assert(shellResult.result?.structuredContent?.stdout === "shell-ok", "default full profile shell execution failed");

  const sessionScript = "process.stdin.setEncoding('utf8'); console.log('ready'); process.stdin.on('data', d => { console.log('echo:' + d.trim()); if (d.includes('quit')) process.exit(0); });";
  send({ jsonrpc: "2.0", id: 61, method: "tools/call", params: { name: "start_process", arguments: { argv: [process.execPath, "-e", sessionScript] } } });
  const startedSession = await responseFor(61, PROCESS_TOOL_RESPONSE_WAIT_MS);
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

  const resistantScript = "process.on('SIGTERM',()=>{}); console.log('resistant-ready'); setInterval(()=>{},1000);";
  send({ jsonrpc: "2.0", id: 68, method: "tools/call", params: { name: "start_process", arguments: { argv: [process.execPath, "-e", resistantScript] } } });
  const resistantSession = await responseFor(68, PROCESS_TOOL_RESPONSE_WAIT_MS);
  const resistantSessionId = resistantSession.result?.structuredContent?.session_id;
  assert(typeof resistantSessionId === "string", "resistant process session did not start");
  send({ jsonrpc: "2.0", id: 69, method: "tools/call", params: { name: "read_process", arguments: { session_id: resistantSessionId, wait_ms: 5000 } } });
  const resistantReady = await responseFor(69, 10_000);
  assert(resistantReady.result?.structuredContent?.stdout?.data.includes("resistant-ready"), "resistant process session was not ready before termination");
  send({ jsonrpc: "2.0", id: 70, method: "tools/call", params: { name: "kill_process", arguments: { session_id: resistantSessionId } } });
  const resistantKill = await responseFor(70);
  assert(resistantKill.result?.structuredContent?.termination_requested === true
    && resistantKill.result?.structuredContent?.force_after_ms === 2000,
  "graceful process-session termination did not advertise forced escalation");
  send({ jsonrpc: "2.0", id: 71, method: "tools/call", params: { name: "read_process", arguments: { session_id: resistantSessionId, wait_ms: 5000, wait_for_exit: true } } });
  const resistantExited = await responseFor(71, 10_000);
  assert(resistantExited.result?.structuredContent?.running === false, "resistant process session survived forced tree termination");

  send({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "run_process", arguments: { argv: [process.execPath, "-e", "setTimeout(() => {}, 30000)"], timeout_seconds: 60 } } });
  await new Promise((resolvePromise) => { setTimeout(resolvePromise, 100); });
  send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7, reason: "test" } });
  const cancelled = await responseFor(7, 10_000);
  assert(cancelled.result?.isError === true, "cancelled process did not return a tool error");
  assert(JSON.stringify(cancelled.result).includes("cancelled"), "cancelled process returned the wrong error");

  send({ jsonrpc: "2.0", id: 8, method: "server/discover", params: {} });
  const discoveryAfterCancellation = await responseFor(8);
  assert(JSON.stringify(discoveryAfterCancellation.result?.supportedVersions) === JSON.stringify(["2026-07-28"]), "stdio server did not remain responsive after cancellation");

  const stagedMarker = join(workspace, "staged-job-must-not-run.txt");
  send({ jsonrpc: "2.0", id: 690, method: "tools/call", params: { name: "stage_job", arguments: {
    name: "stdio review-only staged draft",
    steps: [{ argv: [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1],'unexpected')", stagedMarker], timeout_seconds: 10 }],
  } } });
  const stagedAccepted = await responseFor(690);
  const stagedJobId = stagedAccepted.result?.structuredContent?.job_id;
  assert(stagedAccepted.result?.structuredContent?.status === "staged" && stagedAccepted.result?.structuredContent?.execution_started === false, "stage_job did not remain non-executing");
  await new Promise((resolvePromise) => { setTimeout(resolvePromise, 300); });
  try { await readFile(stagedMarker); throw new Error("review-only staged job executed"); } catch (error) {
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
  await waitForFile(detachedMarker, MANAGED_JOB_SETTLEMENT_WAIT_MS);
  await waitForFile(detachedCleanup, MANAGED_JOB_SETTLEMENT_WAIT_MS);
  assert(await readFile(detachedMarker, "utf8") === "detached-complete", "managed job did not survive stdio disconnect");
  assert(await readFile(detachedCleanup, "utf8") === "cleanup-complete", "managed job finally step did not survive stdio disconnect");
  const state = loadState(canonicalWorkspace, { stateDir });
  const jobRoot = await realpath(join(state.paths.profileDir, "jobs"));
  const resultFile = join(jobRoot, detachedJobId, "result.json");
  try {
    await waitForFile(resultFile, MANAGED_JOB_SETTLEMENT_WAIT_MS);
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
  if (value && typeof value === "object" && typeof value.method === "string") {
    if (value.params === undefined) {
      sendRaw({ ...value, params: { _meta: currentMeta } });
      return;
    }
    if (value.params && typeof value.params === "object" && !Array.isArray(value.params) && !Object.hasOwn(value.params, "_meta")) {
      sendRaw({ ...value, params: { ...value.params, _meta: currentMeta } });
      return;
    }
  }
  sendRaw(value);
}

function sendRaw(value) {
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
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 50); });
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
