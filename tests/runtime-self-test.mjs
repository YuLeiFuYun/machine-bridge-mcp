import { link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { LocalRuntime, MAX_COMMAND_BYTES, MAX_WRITE_BYTES, sha256 } from "../src/local/runtime.mjs";
import { policyProfile } from "../src/local/policy.mjs";
import { delegatedProcessIsolationStatus } from "../src/local/delegated-process-sandbox.mjs";
import { DEFAULT_PROCESS_OWNERSHIP_CHECK_BUDGET_MS, DEFAULT_PROCESS_TERMINATION_GRACE_MS } from "../src/local/process-tree.mjs";
import { createDeviceIdentity } from "../src/local/device-identity.mjs";

const SUCCESS_PROCESS_TIMEOUT_SECONDS = 30;
const SELF_TEST_RESOURCE_WAIT_MS = 5 * 60_000;
const RUNTIME_GIT_FIXTURE_TIMEOUT_MS = 30_000;
// Detached runner startup is OS-scheduled and can exceed ten seconds on loaded shared CI hosts.
// This is a harness settlement budget, not a production execution or acceptance SLA.
const DURABLE_JOB_SETTLEMENT_TEST_TIMEOUT_MS = 60_000;
const PROCESS_TREE_ESCALATION_WAIT_MS = DEFAULT_PROCESS_TERMINATION_GRACE_MS
  + 2 * DEFAULT_PROCESS_OWNERSHIP_CHECK_BUDGET_MS
  + 2000;

export async function runtimeSelfTest() {
  const workspace = await mkdtemp(join(tmpdir(), "mbm-daemon-workspace-"));
  const outside = await mkdtemp(join(tmpdir(), "mbm-daemon-outside-"));
  const jobState = await mkdtemp(join(tmpdir(), "mbm-daemon-jobs-"));
  const resourceCoordinatorRoot = join(jobState, "resource-coordinator");
  const protectedResource = join(jobState, "owner-resource.txt");
  await writeFile(protectedResource, "owner-only-resource\n", { mode: 0o600 });
  const deviceIdentity = createDeviceIdentity();
  const logEvents = [];
  const logger = {
    info(message, fields) { logEvents.push({ level: "info", message, fields }); },
    warn(message, fields) { logEvents.push({ level: "warn", message, fields }); },
    error(message, fields) { logEvents.push({ level: "error", message, fields }); },
    debug(message, fields) { logEvents.push({ level: "debug", message, fields }); },
    event(level, name, fields) { logEvents.push({ level, message: name, event: name, fields }); },
  };
  const restricted = new LocalRuntime({
    workerUrl: "https://example.invalid",
    deviceIdentity,
    expectedRelayVersion: "3.0.0",
    secret: "test-secret-value-123456",
    workspace,
    policy: { allowWrite: true, allowExec: true },
    logger,
    processResourceWaitMs: SELF_TEST_RESOURCE_WAIT_MS,
    resourceCoordinatorRoot,
    jobRoot: join(jobState, "restricted"),
    securityStateRoot: join(jobState, "security-state"),
  });
  const unrestricted = new LocalRuntime({
    workerUrl: "https://example.invalid",
    deviceIdentity,
    expectedRelayVersion: "3.0.0",
    secret: "test-secret-value-123456",
    workspace,
    policy: { allowWrite: true, allowExec: true, unrestrictedPaths: true, exposeAbsolutePaths: false },
    logger,
    processResourceWaitMs: SELF_TEST_RESOURCE_WAIT_MS,
    resourceCoordinatorRoot,
    jobRoot: join(jobState, "unrestricted"),
  });
  const unrestrictedVisible = new LocalRuntime({
    workerUrl: "https://example.invalid",
    deviceIdentity,
    expectedRelayVersion: "3.0.0",
    secret: "test-secret-value-123456",
    workspace,
    policy: { allowWrite: true, allowExec: true, unrestrictedPaths: true, exposeAbsolutePaths: true },
    logger,
    processResourceWaitMs: SELF_TEST_RESOURCE_WAIT_MS,
    resourceCoordinatorRoot,
    jobRoot: join(jobState, "unrestricted-visible"),
  });
  const fullAuthority = new LocalRuntime({
    workerUrl: "https://example.invalid",
    deviceIdentity,
    expectedRelayVersion: "3.0.0",
    workspace,
    policy: policyProfile("full"),
    logger,
    processResourceWaitMs: SELF_TEST_RESOURCE_WAIT_MS,
    resourceCoordinatorRoot,
    jobRoot: join(jobState, "full-authority"),
    resources: { "owner-secret": { kind: "file", path: protectedResource } },
    securityStateRoot: join(jobState, "full-authority-control"),
  });
  for (const runtime of [restricted, unrestricted, unrestrictedVisible, fullAuthority]) {
    if (runtime.processExecutionService.resourceWaitMs !== SELF_TEST_RESOURCE_WAIT_MS
        || runtime.processSessionManager.resourceWaitMs !== SELF_TEST_RESOURCE_WAIT_MS) {
      throw new Error("runtime self-test resource wait override did not reach both process boundaries");
    }
  }
  const previousSecret = process.env.MBM_DAEMON_SELFTEST_SECRET;
  process.env.MBM_DAEMON_SELFTEST_SECRET = "should-not-leak";
  try {
    const ownerAuthorization = { account_id: "acct_testowner_12345678901234567890", account_version: 1, client_id: `mcp_client_${"c".repeat(43)}`, family_id: `mcp_family_${"c".repeat(43)}`, role: "owner" };
    const relayMessages = [];
    const originalSend = restricted.relay.send.bind(restricted.relay);
    const originalRecoverable = restricted.relayCallRecovery.isRecoverable;
    restricted.relay.send = (value) => {
      relayMessages.push(value);
      return true;
    };
    restricted.relayCallRecovery.isRecoverable = () => true;
    await restricted.handleMessage(JSON.stringify({
      type: "tool_call",
      id: "call_durable_missing_recovery_key",
      tool: "run_process",
      arguments: { argv: [process.execPath, "-e", "process.stdout.write('must-not-run')"], timeout_seconds: 10 },
      timeout_ms: 10000,
      authorization: ownerAuthorization,
    }), { sessionId: 1, authenticated: true, ready: true });
    const missingRecoveryKey = relayMessages.find((value) => value.type === "tool_result" && value.id === "call_durable_missing_recovery_key");
    if (missingRecoveryKey?.ok !== false || missingRecoveryKey.error?.code !== "invalid_request"
        || missingRecoveryKey.error?.details?.side_effects_started !== false
        || missingRecoveryKey.error?.details?.recovery_credential_required !== "idempotency_key") {
      throw new Error(`relay durable process started without a caller-held recovery credential: ${JSON.stringify(missingRecoveryKey)}`);
    }
    relayMessages.length = 0;
    await restricted.handleMessage(JSON.stringify({
      type: "tool_call",
      id: "call_deadline_12345678",
      tool: "run_process",
      arguments: {
        argv: [process.execPath, "-e", "setTimeout(() => process.stdout.write('durable-ok'), 50)"],
        timeout_seconds: 10,
        idempotency_key: "runtime-self-test-durable-deadline",
      },
      timeout_ms: 10000,
      authorization: ownerAuthorization,
    }), { sessionId: 1, authenticated: true, ready: true });
    const deadlineResult = relayMessages.find((value) => value.type === "tool_result" && value.id === "call_deadline_12345678");
    if (deadlineResult?.ok !== true || deadlineResult.result?.execution_mode !== "durable_job"
        || typeof deadlineResult.result?.job_id !== "string" || deadlineResult.result?.recovery?.tool !== "read_job"
        || deadlineResult.result?.idempotency_key_accepted !== true) {
      throw new Error(`remote process did not settle as a recoverable durable acceptance: ${JSON.stringify(deadlineResult)}`);
    }
    if (restricted.callRegistry.cancel("call_deadline_12345678", "deadline exceeded", "timeout") !== false) {
      throw new Error("durable process acceptance remained owned by the completed MCP call lifecycle");
    }
    const durableDeadlineJob = await waitForManagedJob(restricted.managedJobManager, deadlineResult.result.job_id);
    if (durableDeadlineJob.status !== "succeeded" || durableDeadlineJob.result?.steps?.[0]?.stdout !== "durable-ok") {
      throw new Error("durable process result was not recoverable after MCP call settlement");
    }
    relayMessages.length = 0;
    await restricted.handleMessage(JSON.stringify({
      type: "tool_call",
      id: "call_durable_long_timeout",
      tool: "run_process",
      arguments: {
        argv: [process.execPath, "-e", "process.stdout.write('durable-long-timeout-ok')"],
        timeout_seconds: 600,
        idempotency_key: "runtime-self-test-durable-long-timeout",
      },
      timeout_ms: 10000,
      authorization: ownerAuthorization,
    }), { sessionId: 1, authenticated: true, ready: true });
    const longTimeoutResult = relayMessages.find((value) => value.type === "tool_result" && value.id === "call_durable_long_timeout");
    if (longTimeoutResult?.ok !== true || longTimeoutResult.result?.execution_timeout_seconds !== 600
        || typeof longTimeoutResult.result?.job_id !== "string") {
      throw new Error(`relay durable-process validation rejected the Worker-advertised 600 second execution budget: ${JSON.stringify(longTimeoutResult)}`);
    }
    const durableLongTimeoutJob = await waitForManagedJob(restricted.managedJobManager, longTimeoutResult.result.job_id);
    if (durableLongTimeoutJob.status !== "succeeded" || durableLongTimeoutJob.result?.steps?.[0]?.stdout !== "durable-long-timeout-ok") {
      throw new Error("600 second durable-process contract did not survive daemon validation and execute normally");
    }
    relayMessages.length = 0;
    await restricted.handleMessage(JSON.stringify({ type: "tool_call", id: "call_invalid_args_12345678", tool: "read_file", arguments: [], timeout_ms: 5000, authorization: ownerAuthorization }), { sessionId: 1, authenticated: true, ready: true });
    const invalidEnvelope = relayMessages.find((value) => value.type === "tool_result" && value.id === "call_invalid_args_12345678");
    if (invalidEnvelope?.ok !== false || invalidEnvelope.error?.code !== "invalid_request" || !String(invalidEnvelope.error?.message || "").includes("invalid tool_call envelope")) throw new Error("invalid relay arguments were accepted");
    await writeFile(join(workspace, ".env"), "SECRET=visible", "utf8");
    await writeFile(join(workspace, "visible.txt"), "needle", "utf8");
    await writeFile(join(outside, "outside.txt"), "outside-needle", "utf8");
    await writeFile(join(outside, "passwords.txt"), "password-file-visible", "utf8");
    await writeFile(join(outside, ".env"), "OUTSIDE_SECRET=visible", "utf8");

    const reviewerAuthorization = { account_id: `acct_${"r".repeat(32)}`, account_version: 1, client_id: `mcp_client_${"r".repeat(43)}`, family_id: `mcp_family_${"r".repeat(43)}`, role: "reviewer" };
    const editorAuthorization = { account_id: `acct_${"e".repeat(32)}`, account_version: 1, client_id: `mcp_client_${"e".repeat(43)}`, family_id: `mcp_family_${"e".repeat(43)}`, role: "editor" };
    const operatorAuthorization = { account_id: `acct_${"o".repeat(32)}`, account_version: 1, client_id: `mcp_client_${"o".repeat(43)}`, family_id: `mcp_family_${"o".repeat(43)}`, role: "operator" };
    const otherOperatorAuthorization = { account_id: `acct_${"p".repeat(32)}`, account_version: 1, client_id: `mcp_client_${"p".repeat(43)}`, family_id: `mcp_family_${"p".repeat(43)}`, role: "operator" };
    const otherReviewerAuthorization = { account_id: `acct_${"q".repeat(32)}`, account_version: 1, client_id: `mcp_client_${"q".repeat(43)}`, family_id: `mcp_family_${"q".repeat(43)}`, role: "reviewer" };
    const relayContext = (authorization) => ({ origin: "relay", authorization });
    await fullAuthority.executeTool("stage_job", {
      name: "owner diagnostic isolation",
      steps: [{ argv: [process.execPath, "-e", ""] }],
    }, relayContext(ownerAuthorization));

    const editorOverview = await fullAuthority.executeTool("project_overview", {}, relayContext(editorAuthorization));
    if (editorOverview.policy?.allowExec !== false || editorOverview.policy?.unrestrictedPaths !== false) {
      throw new Error("project_overview did not expose the editor-effective policy");
    }
    if (editorOverview.daemonPolicy?.profile !== "full" || editorOverview.daemonPolicy?.execMode !== "shell") {
      throw new Error("project_overview lost the full daemon capability ceiling");
    }
    if (editorOverview.tools?.includes("exec_command") || editorOverview.tools?.includes("browser_action") || editorOverview.tools?.includes("stage_job")) {
      throw new Error("project_overview exposed daemon-only or owner-only tools in the editor-effective tool list");
    }
    if (!editorOverview.daemonTools?.includes("exec_command") || !editorOverview.daemonTools?.includes("browser_action")) {
      throw new Error("project_overview omitted daemon-advertised tools from its explicit ceiling fields");
    }
    if (editorOverview.capabilityRouting?.activity_hidden_by_authority !== true) {
      throw new Error("project_overview leaked cross-principal capability-routing activity to the editor account");
    }
    const editorServerInfo = await fullAuthority.executeTool("server_info", { detail: "full" }, relayContext(editorAuthorization));
    if (editorServerInfo.tools?.includes("stage_job") || editorServerInfo.tools?.includes("exec_command")
        || editorServerInfo.tools?.includes("browser_action") || editorServerInfo.tools?.includes("list_local_resources")) {
      throw new Error("server_info exposed tools outside the editor account authority");
    }
    if (editorServerInfo.runtime?.local_resources?.count !== null
        || editorServerInfo.runtime?.local_resources?.names?.length !== 0
        || editorServerInfo.runtime?.local_resources?.inventory_hidden_by_authority !== true) {
      throw new Error("server_info leaked protected local resource inventory to a non-owner account");
    }
    if (editorServerInfo.runtime?.managed_jobs?.retained !== 0 || editorServerInfo.runtime?.managed_jobs?.staged !== 0) {
      throw new Error("server_info leaked another principal's managed-job activity to the editor account");
    }
    if (editorServerInfo.observability?.capability_routing?.activity_hidden_by_authority !== true
        || editorServerInfo.observability?.tool_calls?.activity_hidden_by_authority !== true
        || editorServerInfo.observability?.in_flight_calls?.activity_hidden_by_authority !== true
        || "active" in (editorServerInfo.observability?.in_flight_calls || {})
        || editorServerInfo.runtime?.processes?.activity_hidden_by_authority !== true) {
      throw new Error("server_info leaked cross-principal task/tool/call/process activity to the editor account");
    }
    if (editorServerInfo.security_audit?.activity_hidden_by_authority !== true
        || "last_event_at" in (editorServerInfo.security_audit || {})
        || "retained" in (editorServerInfo.security_audit || {})) {
      throw new Error("server_info leaked cross-principal security-audit activity to the editor account");
    }
    const ownerServerInfo = await fullAuthority.executeTool("server_info", { detail: "full" }, relayContext(ownerAuthorization));
    if (!ownerServerInfo.runtime?.local_resources?.names?.includes("owner-secret") || ownerServerInfo.runtime?.managed_jobs?.staged !== 1) {
      throw new Error("owner server_info lost its authorized resource inventory or managed-job aggregate");
    }
    if (editorServerInfo.tool_delivery?.effective_tool_count !== editorServerInfo.tools?.length
        || editorServerInfo.tool_delivery?.daemon_advertised_tool_count !== editorOverview.daemonTools?.length
        || editorServerInfo.tool_delivery?.daemon_advertised_tool_count <= editorServerInfo.tool_delivery?.effective_tool_count) {
      throw new Error("server_info did not distinguish effective account tools from the daemon capability ceiling");
    }
    const operatorDurableRouting = await fullAuthority.executeTool("resolve_task_capabilities", {
      path: ".",
      task: "Run a long background multi-step migration that must survive disconnects and always clean up",
    }, relayContext(operatorAuthorization));
    if (operatorDurableRouting.recommended_tools?.includes("start_job")
        || operatorDurableRouting.recommended_tools?.includes("stage_job")
        || operatorDurableRouting.execution_routing?.routes?.some((route) => route.id === "managed-job")) {
      throw new Error("task routing exposed an unsatisfiable owner-only managed-job creation route to the operator account");
    }
    if (!operatorDurableRouting.routing_observability?.includes("effective authority")
        || operatorDurableRouting.routing_observability?.includes("effective policy")) {
      throw new Error("task routing observability mislabeled account-attenuated authority as policy-only availability");
    }
    if (operatorDurableRouting.application_discovery?.reason
        || !Number.isInteger(operatorDurableRouting.application_discovery?.warning_count)) {
      throw new Error("read-only application discovery remained authority-disabled for the operator account");
    }
    const compactEditorOverview = await fullAuthority.executeTool("project_overview", { detail: "summary" }, relayContext(editorAuthorization));
    const compactEditorOverviewJson = JSON.stringify(compactEditorOverview);
    if (compactEditorOverview.detail !== "summary"
        || compactEditorOverview.policy?.profile !== editorOverview.policy?.profile
        || compactEditorOverview.effectiveToolCount !== editorOverview.tools.length
        || compactEditorOverview.daemonToolCount !== editorOverview.daemonTools.length
        || compactEditorOverview.capabilityRouting?.activity_hidden_by_authority !== true
        || "tools" in compactEditorOverview || "daemonTools" in compactEditorOverview
        || compactEditorOverview.topLevel?.some((entry) => "path" in entry || "size" in entry)) {
      throw new Error("compact local project_overview leaked cold-path arrays/paths or lost authority counts");
    }
    if (compactEditorOverviewJson.length > 5000) {
      throw new Error(`compact local project_overview exceeded its hot-path output budget: ${compactEditorOverviewJson.length} chars`);
    }
    const reviewerGitStatus = await fullAuthority.executeTool("git_status", {}, relayContext(reviewerAuthorization));
    if (!Number.isInteger(reviewerGitStatus.code)) {
      throw new Error("reviewer Git metadata did not use the fixed internal process boundary");
    }

    await expectReject(
      () => fullAuthority.executeTool("read_file", { path: join(outside, "outside.txt") }, relayContext(reviewerAuthorization)),
      "outside the configured workspace",
    );
    await expectReject(
      () => fullAuthority.executeTool("write_file", { path: join(outside, "editor-escape.txt"), content: "blocked" }, relayContext(editorAuthorization)),
      "outside the configured workspace",
    );
    if (delegatedProcessIsolationStatus().available) {
      const operatorAcceptance = await fullAuthority.executeTool("run_process", {
        argv: [process.execPath, "-e", "process.stdout.write(process.env.MBM_DAEMON_SELFTEST_SECRET || \"unset\")"],
        timeout_seconds: SUCCESS_PROCESS_TIMEOUT_SECONDS,
        idempotency_key: "operator-durable-environment",
      }, relayContext(operatorAuthorization));
      if (operatorAcceptance.execution_mode !== "durable_job" || typeof operatorAcceptance.job_id !== "string") {
        throw new Error("operator run_process did not receive a durable execution handle");
      }
      const operatorEnvironment = await waitForManagedJob(fullAuthority.managedJobManager, operatorAcceptance.job_id, relayContext(operatorAuthorization));
      if (operatorEnvironment.result?.steps?.[0]?.stdout !== "unset") throw new Error("operator inherited the full daemon parent environment");
      await expectReject(
        () => fullAuthority.executeTool("start_job", { steps: [{ argv: [process.execPath, "-e", ""] }] }, relayContext(operatorAuthorization)),
        "not allowed",
      );
    } else {
      await expectReject(
        () => fullAuthority.executeTool("run_process", {
          argv: [process.execPath, "-e", "process.exit(0)"],
          idempotency_key: "operator-durable-sandbox-unavailable",
        }, relayContext(operatorAuthorization)),
        "requires a behavior-verified OS workspace sandbox",
      );
    }

    const ownedProcess = await fullAuthority.executeTool("start_process", {
      argv: [process.execPath, "-e", "setTimeout(() => {}, 30000)"],
    }, relayContext(ownerAuthorization));
    await expectReject(
      () => fullAuthority.executeTool("read_process", { session_id: ownedProcess.session_id }, relayContext(otherOperatorAuthorization)),
      "belongs to another account",
    );
    await fullAuthority.executeTool("kill_process", { session_id: ownedProcess.session_id, force: true }, relayContext(ownerAuthorization));

    const ownedJob = await fullAuthority.executeTool("stage_job", {
      name: "account-owned-job",
      steps: [{ argv: [process.execPath, "-e", "process.exit(0)"] }],
    }, relayContext(ownerAuthorization));
    const otherJobs = await fullAuthority.executeTool("list_jobs", {}, relayContext(otherReviewerAuthorization));
    if (otherJobs.jobs.some((job) => job.job_id === ownedJob.job_id)) throw new Error("managed job leaked across account ownership");
    await expectReject(
      () => fullAuthority.executeTool("read_job", { job_id: ownedJob.job_id }, relayContext(otherReviewerAuthorization)),
      "belongs to another account",
    );

    const largeProcess = await restricted.executeTool("run_process", {
      argv: [process.execPath, "-e", "process.stdout.write('R'.repeat(100000) + 'RUNTIME-TAIL')"],
      timeout_seconds: SUCCESS_PROCESS_TIMEOUT_SECONDS,
    });
    if (typeof largeProcess.output_session_id !== "string" || largeProcess.stdout_truncated_bytes <= 0) {
      throw new Error("runtime one-shot process did not retain truncated output for continuation");
    }
    const largeProcessPage = await restricted.executeTool("read_process", {
      session_id: largeProcess.output_session_id,
      stdout_offset: 0,
      stderr_offset: 0,
      max_bytes: 256 * 1024,
    });
    if (!largeProcessPage.stdout.data.endsWith("RUNTIME-TAIL")) {
      throw new Error("runtime process continuation lost the retained output tail");
    }

    const envFile = await restricted.readFile(".env", 1024);
    if (!envFile.content.includes("SECRET=visible")) throw new Error("workspace .env should remain readable");

    logEvents.length = 0;
    await restricted.handleMessage(JSON.stringify({ type: "welcome", server: "machine-bridge-mcp", version: "0.8.1" }));
    if (logEvents.some(event => event.level === "warn" && event.message === "unknown websocket message")) {
      throw new Error("valid relay welcome message was treated as an unknown warning");
    }

    const relayProtocolErrors = [];
    const originalHandleServerError = restricted.relay.handleServerError.bind(restricted.relay);
    restricted.relay.handleServerError = (message) => { relayProtocolErrors.push(message.error); return true; };
    await restricted.handleMessage(JSON.stringify({ type: "error", error: "daemon_hello_timeout" }));
    await restricted.handleMessage("null");
    await restricted.handleMessage("{");
    await restricted.handleMessage(JSON.stringify({ type: "future_server_message" }));
    const originalSendForSession = restricted.relay.sendForSession.bind(restricted.relay);
    for (const reason of ["send_failed", "transport_unavailable", "session_ended"]) {
      restricted.relay.sendForSession = () => ({ ok: false, reason });
      restricted.handleRelayProbe({ type: "relay_probe", id: "probe_transport-race" }, { sessionId: 1 });
    }
    restricted.relay.sendForSession = originalSendForSession;
    restricted.relay.handleServerError = originalHandleServerError;
    if (JSON.stringify(relayProtocolErrors) !== JSON.stringify([
      "daemon_hello_timeout",
      "invalid_server_message",
      "invalid_server_json",
      "unexpected_server_message_type",
    ])) throw new Error(`relay protocol errors were not normalized consistently: ${JSON.stringify(relayProtocolErrors)}`);
    if (logEvents.some(event => event.message === "unknown websocket message")) {
      throw new Error("structured relay error was still reported as an unknown websocket message");
    }

    logEvents.length = 0;
    await restricted.handleMessage(JSON.stringify({ type: "tool_call", id: "call_fast_success_12345678", tool: "read_file", arguments: { path: "visible.txt" }, timeout_ms: 5000, authorization: ownerAuthorization }), { sessionId: 1, authenticated: true, ready: true });
    if (logEvents.some(event => event.level === "info" && event.event === "tool.call.completed")) {
      throw new Error("remote daemon emitted routine success at info level");
    }
    if (!logEvents.some(event => event.level === "debug" && event.event === "tool.call.completed")) {
      throw new Error("remote daemon omitted debug success correlation");
    }

    logEvents.length = 0;
    relayMessages.length = 0;
    restricted.relay.send = (value) => {
      relayMessages.push(value);
      return true;
    };
    await restricted.handleMessage(JSON.stringify({ type: "tool_call", id: "call_failed_12345678", tool: "read_file", arguments: { path: "missing-file.txt" }, timeout_ms: 5000, authorization: ownerAuthorization }), { sessionId: 1, authenticated: true, ready: true });
    restricted.relay.send = originalSend;
    restricted.relayCallRecovery.isRecoverable = originalRecoverable;
    const failedResult = relayMessages.find((value) => value.type === "tool_result" && value.id === "call_failed_12345678");
    if (failedResult?.ok !== false) throw new Error("failed tool call did not return an error result");
    if (logEvents.some(event => event.level === "warn" && event.event === "tool.call.failed")) {
      throw new Error("remote daemon emitted per-tool failure noise at warn level");
    }
    if (!logEvents.some(event => event.level === "debug" && event.event === "tool.call.failed" && event.fields?.tool === "read_file")) {
      throw new Error("remote daemon omitted debug-only failure telemetry");
    }

    await expectReject(() => restricted.readFile(join(outside, "outside.txt"), 1024), "outside the configured workspace", "path_boundary", "outside_workspace");
    await expectReject(() => restricted.readFile(path.relative(workspace, join(outside, "outside.txt")), 1024), "outside the configured workspace", "path_boundary", "outside_workspace");

    const outsideFile = await unrestricted.readFile(join(outside, "outside.txt"), 1024);
    if (!outsideFile.content.includes("outside-needle")) throw new Error("unrestricted absolute read failed");
    const passwordFile = await unrestricted.readFile(join(outside, "passwords.txt"), 1024);
    const outsideEnv = await unrestricted.readFile(join(outside, ".env"), 1024);
    if (!passwordFile.content.includes("password-file-visible") || !outsideEnv.content.includes("OUTSIDE_SECRET=visible")) {
      throw new Error("unrestricted policy applied a sensitive-filename block");
    }

    const linkPath = join(workspace, "outside-link");
    try {
      await symlink(outside, linkPath, "dir");
      await expectReject(() => restricted.readFile(join(linkPath, "outside.txt"), 1024), "outside the configured workspace");
      await expectReject(() => restricted.writeFile({ path: linkPath, content: "replace" }), "symbolic link", "conflict", "symbolic_link");
      const canonicalUnrestrictedTarget = await unrestricted.resolveWritePath(join(linkPath, "new-through-link.txt"));
      if (canonicalUnrestrictedTarget !== join(await realpath(outside), "new-through-link.txt")) {
        throw new Error(`unrestricted write path did not canonicalize a symbolic-link ancestor: ${canonicalUnrestrictedTarget}`);
      }
      await expectReject(() => unrestricted.resolveWritePath(linkPath), "symbolic link");
    } catch (error) {
      if (error?.code !== "EPERM" && error?.code !== "EACCES") throw error;
    }

    const hardLinkPath = join(workspace, "outside-hardlink.txt");
    try {
      const outsideHardLinkContent = await readFile(join(outside, "outside.txt"), "utf8");
      await link(join(outside, "outside.txt"), hardLinkPath);
      await expectReject(() => restricted.readFile(hardLinkPath, 1024), "multiple hard links", "permission_denied", "multiple_hard_links");
      await expectReject(() => restricted.editFile({ path: hardLinkPath, old_text: "outside", new_text: "changed" }), "multiple hard links", "permission_denied", "multiple_hard_links");
      const hardLinkSearch = await restricted.searchText({ path: hardLinkPath, query: "outside-needle" });
      if (hardLinkSearch.matches.length !== 0) throw new Error("search_text disclosed content through a hard link");
      await restricted.writeFile({ path: hardLinkPath, content: "detached-from-hardlink" });
      if ((await readFile(join(outside, "outside.txt"), "utf8")) !== outsideHardLinkContent) throw new Error("atomic write mutated an external hard-link inode");
      if ((await restricted.readFile(hardLinkPath, 1024)).content !== "detached-from-hardlink") throw new Error("atomic write did not replace the hard-link directory entry");
    } catch (error) {
      if (!["EPERM", "EACCES", "EXDEV", "ENOTSUP"].includes(error?.code)) throw error;
    }

    const written = await restricted.writeFile({ path: "nested/written.txt", content: "written", create_only: true });
    if (written.bytes !== 7) throw new Error("write_file byte count is incorrect");
    await expectReject(() => restricted.writeFile({ path: "nested/written.txt", content: "again", create_only: true }), "file exists", "conflict", "already_exists");
    await expectReject(() => restricted.writeFile({ path: "nested/written.txt", content: "again", expected_sha256: "bad" }), "expected_sha256 mismatch", "conflict", "hash_mismatch");
    await expectReject(() => restricted.writeFile({ path: "nested/missing.txt", content: "again", expected_sha256: sha256("missing") }), "requires an existing file", "conflict", "precondition_target_missing");
    await restricted.writeFile({ path: "nested/written.txt", content: "updated\nsecond\nthird\n", expected_sha256: sha256("written") });
    const slice = await restricted.readFile({ path: "nested/written.txt", start_line: 2, end_line: 3, max_bytes: 1024 });
    if (slice.content !== "second\nthird\n" || slice.start_line !== 2 || slice.total_lines !== 3) throw new Error("read_file line range failed");
    const crlfText = "first\r\nsecond\r\n";
    await restricted.writeFile({ path: "nested/crlf.txt", content: crlfText, create_only: true });
    const crlfWhole = await restricted.readFile({ path: "nested/crlf.txt", max_bytes: 1024 });
    const crlfSlice = await restricted.readFile({ path: "nested/crlf.txt", start_line: 2, end_line: 2, max_bytes: 1024 });
    if (crlfWhole.content !== crlfText || crlfWhole.sha256 !== sha256(crlfWhole.content) || crlfSlice.content !== "second\r\n") {
      throw new Error("read_file normalized CRLF content or returned a hash for different text");
    }
    await expectReject(() => restricted.editFile({ path: "nested/written.txt", old_text: "missing", new_text: "replacement" }), "old_text was not found", "not_found", "text_not_found");
    await restricted.writeFile({ path: "nested/ambiguous.txt", content: "same\nsame\n", create_only: true });
    await expectReject(() => restricted.editFile({ path: "nested/ambiguous.txt", old_text: "same", new_text: "changed" }), "occurs 2 times", "conflict", "text_ambiguous");
    const edited = await restricted.editFile({ path: "nested/written.txt", old_text: "second", new_text: "SECOND", expected_sha256: slice.sha256 });
    if (edited.replacements !== 1 || !(await readFile(join(workspace, "nested/written.txt"), "utf8")).includes("SECOND")) throw new Error("edit_file failed");
    await restricted.writeFile({ path: "nested/concurrent-edit.txt", content: "alpha\nbeta\ngamma\n", create_only: true });
    await Promise.all([
      restricted.editFile({ path: "nested/concurrent-edit.txt", old_text: "alpha", new_text: "ALPHA" }),
      restricted.editFile({ path: "nested/concurrent-edit.txt", old_text: "beta", new_text: "BETA" }),
    ]);
    if (await readFile(join(workspace, "nested/concurrent-edit.txt"), "utf8") !== "ALPHA\nBETA\ngamma\n") {
      throw new Error("same-path concurrent edits did not serialize against fresh file state");
    }
    const patch = await restricted.applyPatch({ patch: `*** Begin Patch
*** Update File: nested/written.txt
@@
 updated
-SECOND
+second-again
 third
*** Add File: nested/added.txt
+added
*** End Patch` });
    if (!patch.ok || await readFile(join(workspace, "nested/added.txt"), "utf8") !== "added\n") throw new Error("apply_patch add/update failed");
    if (!(await readFile(join(workspace, "nested/written.txt"), "utf8")).includes("second-again")) throw new Error("apply_patch update failed");
    const beforeFailedPatch = await readFile(join(workspace, "nested/written.txt"), "utf8");
    await expectReject(() => restricted.applyPatch({ patch: "not a patch" }), "must start", "invalid_request", "missing_begin_marker");
    await expectReject(() => restricted.applyPatch({ patch: `*** Begin Patch
*** Update File: nested/written.txt
@@
 updated
-second-again
+should-not-commit
*** Update File: nested/added.txt
@@
 missing-context
*** End Patch` }), "did not match", "conflict", "context_not_found");
    if (await readFile(join(workspace, "nested/written.txt"), "utf8") !== beforeFailedPatch) throw new Error("failed patch partially committed");
    await expectReject(() => restricted.applyPatch({ patch: `*** Begin Patch
*** Add File: nested/collision.txt
+one
*** Add File: nested/../nested/collision.txt
+two
*** End Patch` }), "same path", "conflict", "resolved_path_collision");
    if (await lstat(join(workspace, "nested/collision.txt")).catch(() => null)) throw new Error("canonical patch collision created a file");
    const moved = await restricted.applyPatch({ patch: `*** Begin Patch
*** Update File: nested/added.txt
*** Move to: nested/moved.txt
@@
 added
*** End Patch` });
    if (!moved.ok || await readFile(join(workspace, "nested/moved.txt"), "utf8") !== "added\n") throw new Error("apply_patch move failed");
    if (await lstat(join(workspace, "nested/added.txt")).catch(() => null)) throw new Error("apply_patch move left the source file");
    await restricted.applyPatch({ patch: `*** Begin Patch
*** Delete File: nested/moved.txt
*** End Patch` });
    if (await lstat(join(workspace, "nested/moved.txt")).catch(() => null)) throw new Error("apply_patch delete failed");
    await expectReject(() => restricted.writeFile({ path: "too-large.txt", content: "x".repeat(MAX_WRITE_BYTES + 1) }), "maximum write size", "limit_exceeded", "write_limit");

    await writeFile(join(workspace, "invalid.bin"), Buffer.from([0xff, 0xfe]));
    await expectReject(() => restricted.readFile("invalid.bin", 1024), "not valid UTF-8", "invalid_request", "invalid_utf8");
    const binarySearch = await restricted.searchText({ path: workspace, query: "needle", max_files: 100, max_matches: 10 });
    if (!binarySearch.matches.some(match => match.path.endsWith("visible.txt"))) throw new Error("search_text missed UTF-8 file");

    const cappedSearch = await restricted.searchText({ path: workspace, query: "definitely-not-present", max_files: 1, max_matches: 10 });
    if (cappedSearch.visited_files !== 1 || cappedSearch.truncated !== true) throw new Error("search_text max_files cap did not apply");

    const repo = join(workspace, "nested-repo");
    await mkdir(repo);
    await restricted.runProcess("git", ["init", "-q", repo], RUNTIME_GIT_FIXTURE_TIMEOUT_MS);
    await writeFile(join(repo, "tracked.txt"), "one\n", "utf8");
    await restricted.runProcess("git", ["-C", repo, "add", "tracked.txt"], RUNTIME_GIT_FIXTURE_TIMEOUT_MS);
    await restricted.runProcess("git", ["-C", repo, "config", "user.name", "Machine Bridge Test"], RUNTIME_GIT_FIXTURE_TIMEOUT_MS);
    await restricted.runProcess("git", ["-C", repo, "config", "user.email", "private-test@example.invalid"], RUNTIME_GIT_FIXTURE_TIMEOUT_MS);
    await restricted.runProcess("git", ["-C", repo, "commit", "-qm", "initial"], RUNTIME_GIT_FIXTURE_TIMEOUT_MS);
    const logWithoutEmail = await restricted.gitLog({ path: "nested-repo", max_count: 5 });
    if (logWithoutEmail.commits.length !== 1 || "author_email" in logWithoutEmail.commits[0]) throw new Error("git_log leaked author email by default");
    const logWithEmail = await restricted.gitLog({ path: "nested-repo", max_count: 5, include_author_email: true });
    if (logWithEmail.commits[0]?.author_email !== "private-test@example.invalid") throw new Error("git_log explicit email option failed");
    const shown = await restricted.gitShow({ path: "nested-repo", revision: "HEAD", max_bytes: 1024 * 1024 });
    if (shown.code !== 0 || !shown.stdout.includes("initial")) throw new Error("git_show failed");
    await expectReject(() => restricted.gitShow({ path: "nested-repo", revision: "--help" }), "invalid Git revision");
    await restricted.runProcess("git", ["-C", repo, "config", "diff.external", "definitely-not-a-real-diff-command"], RUNTIME_GIT_FIXTURE_TIMEOUT_MS);
    await restricted.runProcess("git", ["-C", repo, "config", "core.fsmonitor", "definitely-not-a-real-fsmonitor-command"], RUNTIME_GIT_FIXTURE_TIMEOUT_MS);
    await writeFile(join(repo, "tracked.txt"), "two\n", "utf8");
    const diff = await restricted.gitDiff({ path: "nested-repo" });
    if (diff.code !== 0 || !diff.stdout.includes("tracked.txt") || diff.gitRoot !== "nested-repo") throw new Error("nested git diff detection failed");
    const status = await restricted.gitStatus({ path: "nested-repo" });
    if (status.code !== 0 || !status.stdout.includes("tracked.txt")) throw new Error("nested git status detection failed");

    const command = await restricted.execCommand("node -e \"process.stdout.write(process.env.MBM_DAEMON_SELFTEST_SECRET || 'unset')\"", SUCCESS_PROCESS_TIMEOUT_SECONDS);
    if (command.stdout !== "unset") throw new Error("exec_command inherited unallowlisted environment variables");
    const fullServerInfo = restricted.serverInfo({ detail: "full" });
    const compactServerInfo = restricted.serverInfo({ detail: "summary" });
    if (compactServerInfo.detail !== "summary"
      || JSON.stringify(compactServerInfo.policy) !== JSON.stringify(fullServerInfo.policy)
      || compactServerInfo.tool_delivery?.daemon_advertised_tool_count !== fullServerInfo.tool_delivery?.daemon_advertised_tool_count
      || "tools" in compactServerInfo || "observability" in compactServerInfo || "security_audit" in compactServerInfo || "trust" in compactServerInfo) {
      throw new Error("compact local server_info changed effective policy, lost core state, or retained cold-path diagnostics");
    }
    const compactServerInfoJson = JSON.stringify(compactServerInfo);
    if (compactServerInfoJson.length >= JSON.stringify(fullServerInfo).length * 0.6) {
      throw new Error("compact local server_info did not materially reduce the payload");
    }
    if (compactServerInfoJson.length > 2200) {
      throw new Error(`compact local server_info exceeded its hot-path output budget: ${compactServerInfoJson.length} chars`);
    }
    const beforeBootstrap = restricted.runtimeInfo().observability.capability_routing;
    if (beforeBootstrap.bootstrap_observed || beforeBootstrap.task_resolution_observed) throw new Error("capability routing telemetry was pre-populated");
    await restricted.sessionBootstrap({ path: "." });
    await restricted.resolveTaskCapabilities({ path: ".", task: "inspect the repository files" });
    const routing = restricted.runtimeInfo().observability.capability_routing;
    if (!routing.bootstrap_observed || !routing.task_resolution_observed || routing.bootstrap_count !== 1 || routing.task_resolution_count !== 1) {
      throw new Error("capability routing telemetry did not record bootstrap and task resolution");
    }
    if (!/^[a-f0-9]{64}$/.test(routing.last_task_resolution?.task_fingerprint || "") || "task" in (routing.last_task_resolution || {}) || "task_sha256" in (routing.last_task_resolution || {})) {
      throw new Error("capability routing telemetry exposed raw task content or omitted its runtime-keyed fingerprint");
    }
    if (!routing.last_task_resolution?.primary_route || !["low", "medium", "high"].includes(routing.last_task_resolution?.routing_ambiguity)) {
      throw new Error("capability routing telemetry omitted the privacy-safe primary route or ambiguity class");
    }
    const diagnostics = await restricted.diagnoseRuntime();
    if (!diagnostics.request_reached_local_runtime || !diagnostics.checks.some(check => check.layer === "local-process-spawn" && check.ok)) {
      throw new Error("runtime diagnostics did not prove local process execution");
    }
    if (!diagnostics.checks.some(check => check.layer === "managed-job-storage" && check.ok)) {
      throw new Error("runtime diagnostics did not validate managed-job storage");
    }
    const isolatedHome = await restricted.runDirectProcess({ argv: [process.execPath, "-e", "process.stdout.write(process.env.HOME || '')"], timeout_seconds: SUCCESS_PROCESS_TIMEOUT_SECONDS });
    if (!isolatedHome.stdout.includes("machine-bridge-mcp-") || isolatedHome.stdout === process.env.HOME) throw new Error("minimal command environment did not isolate HOME");
    await expectReject(() => restricted.execCommand(`printf '${"x".repeat(MAX_COMMAND_BYTES)}'`, 5), "maximum size");
    await expectReject(() => restricted.execCommand("printf 'x\0y'", 5), "NUL byte");
    if (process.platform !== "win32") {
      await expectReject(() => restricted.execCommand("sleep 5", 1), "command timed out");
      await waitForProcessTrackerIdle(restricted, PROCESS_TREE_ESCALATION_WAIT_MS);
      const trackedBeforeInterruption = restricted.processTracker.snapshot().active_processes;
      const interrupted = restricted.runProcess("sleep", ["30"], 60_000)
        .then((value) => ({ value, error: null }), (error) => ({ value: null, error }));
      await waitForTrackedProcessIncrease(restricted, trackedBeforeInterruption, 5_000);
      restricted.terminateActiveProcesses("SIGTERM");
      const interruption = await interrupted;
      if (!String(interruption.error?.message || "").includes("exited")) throw new Error("terminated process did not reject with an exit failure");
      if (restricted.processTracker.snapshot().active_processes !== 0) throw new Error("terminated process remained tracked");

      const descendantPidFile = join(workspace, "timeout-descendant.pid");
      const descendantCommand = `(trap '' TERM; sleep 30) & echo $! > ${shellQuote(descendantPidFile)}; wait`;
      await expectReject(() => restricted.execCommand(descendantCommand, 1), "command timed out");
      const descendantPid = Number((await readFile(descendantPidFile, "utf8")).trim());
      if (!await waitForProcessExit(descendantPid, PROCESS_TREE_ESCALATION_WAIT_MS)) {
        try { process.kill(descendantPid, "SIGKILL"); } catch {}
        throw new Error("timeout escalation left a SIGTERM-ignoring descendant running");
      }

      const detachedDescendantPidFile = join(workspace, "detached-timeout-descendant.pid");
      const detachedParent = `const { spawn } = require('node:child_process'); const { writeFileSync } = require('node:fs'); const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], { stdio: 'ignore' }); writeFileSync(process.argv[1], String(child.pid)); setInterval(()=>{},1000);`;
      // Coverage instrumentation can delay a fresh Node process enough that a 200 ms
      // deadline expires before the fixture writes its descendant PID. Keep the
      // deadline bounded, but long enough to exercise post-start tree cleanup.
      await expectReject(() => restricted.runProcess(process.execPath, ["-e", detachedParent, detachedDescendantPidFile], 2000), "command timed out");
      const detachedDescendantPid = Number((await waitForFileText(detachedDescendantPidFile, 5000)).trim());
      // Capture/refresh and the final current-ownership check have separate bounded
      // budgets around the graceful-termination window. Poll the real descendant until
      // that complete production bound settles instead of sampling at one wall-clock instant.
      if (!await waitForProcessExit(detachedDescendantPid, PROCESS_TREE_ESCALATION_WAIT_MS)) {
        try { process.kill(detachedDescendantPid, "SIGKILL"); } catch {}
        throw new Error("one-shot process timeout cancelled forced escalation after the direct child exited");
      }
    }

    const redactedPathError = restricted.safeErrorMessage(new Error(`failure at ${join(workspace, "secret.txt")} and ${restricted.runtimeDir}`));
    if (redactedPathError.includes(workspace) || redactedPathError.includes(restricted.runtimeDir)) throw new Error("tool error path redaction failed");
    const externalMissing = join(outside, "private-missing-file.txt");
    let externalError;
    try { await unrestricted.readFile({ path: externalMissing }); } catch (error) { externalError = error; }
    const redactedExternalError = unrestricted.safeErrorMessage(externalError, { path: externalMissing });
    if (redactedExternalError.includes(externalMissing) || !redactedExternalError.includes("<external-path:")) {
      throw new Error("tool error leaked an explicitly requested external path while absolute-path display was disabled");
    }

    const restrictedRoots = restricted.listRoots();
    if (restrictedRoots.roots.length !== 1 || restrictedRoots.roots[0].path !== ".") throw new Error("restricted roots did not preserve relative-path privacy");
    const unrestrictedRoots = unrestricted.listRoots();
    if (unrestrictedRoots.roots.some(root => root.path.includes(workspace) || root.path === path.parse(workspace).root)) {
      throw new Error("unrestricted access leaked absolute paths while path exposure was disabled");
    }
    if (!unrestrictedRoots.roots.some(root => /^<external-path:[a-f0-9]{12}>$/.test(root.path))) {
      throw new Error("unrestricted hidden roots did not use opaque external-path identifiers");
    }
    if (unrestricted.runtimeInfo().workspace_name !== "workspace") throw new Error("hidden runtime info exposed workspace basename");
    const visibleRoots = unrestrictedVisible.listRoots();
    if (!visibleRoots.roots.some(root => root.path === path.parse(workspace).root)) throw new Error("explicit absolute-path mode omitted filesystem root");
    if (unrestrictedVisible.runtimeInfo().workspace_name !== path.basename(workspace)) throw new Error("explicit absolute-path mode omitted workspace basename");
  } finally {
    restricted.stop();
    unrestricted.stop();
    unrestrictedVisible.stop();
    fullAuthority.stop();
    if (previousSecret === undefined) delete process.env.MBM_DAEMON_SELFTEST_SECRET;
    else process.env.MBM_DAEMON_SELFTEST_SECRET = previousSecret;
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
    await rm(outside, { recursive: true, force: true }).catch(() => {});
    await rm(jobState, { recursive: true, force: true }).catch(() => {});
  }
  return true;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

async function waitForFileText(file, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  let lastError = null;
  while (performance.now() < deadline) {
    try { return await readFile(file, "utf8"); }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
      lastError = error;
      await new Promise(resolvePromise => { setTimeout(resolvePromise, 20); });
    }
  }
  throw lastError || new Error(`timed out waiting for file: ${file}`);
}

async function waitForManagedJob(manager, jobId, context = {}, timeoutMs = DURABLE_JOB_SETTLEMENT_TEST_TIMEOUT_MS) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const job = manager.read({ job_id: jobId }, context);
    if (["succeeded", "failed", "cancelled", "recovery_failed"].includes(job.status)) return job;
    await new Promise(resolvePromise => { setTimeout(resolvePromise, 20); });
  }
  throw new Error(`timed out waiting for managed job settlement: ${jobId}`);
}

async function waitForProcessTrackerIdle(runtime, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while (runtime.processTracker.snapshot().active_processes > 0 && performance.now() < deadline) {
    await new Promise(resolvePromise => { setTimeout(resolvePromise, 10); });
  }
  if (runtime.processTracker.snapshot().active_processes > 0) throw new Error("timed-out process did not leave the tracker before the next lifecycle test");
}

async function waitForTrackedProcessIncrease(runtime, baseline, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while (runtime.processTracker.snapshot().active_processes <= baseline && performance.now() < deadline) {
    await new Promise(resolvePromise => { setTimeout(resolvePromise, 10); });
  }
  if (runtime.processTracker.snapshot().active_processes <= baseline) throw new Error("new process did not reach tracker before termination test");
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while (isProcessAlive(pid) && performance.now() < deadline) {
    await new Promise(resolvePromise => { setTimeout(resolvePromise, 50); });
  }
  return !isProcessAlive(pid);
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function expectReject(callback, pattern, code = "", reason = "") {
  try {
    await callback();
  } catch (error) {
    if (!String(error?.message || error).includes(pattern)) throw error;
    if (code && error?.code !== code) throw new Error(`expected error code ${code}, received ${error?.code || "untyped"}`);
    if (reason && error?.details?.reason !== reason) throw new Error(`expected error reason ${reason}, received ${error?.details?.reason || "missing"}`);
    return error;
  }
  throw new Error(`expected rejection containing: ${pattern}`);
}
