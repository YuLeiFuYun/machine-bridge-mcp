import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalRuntime, runtimeToolHandlerNames } from "../src/local/runtime.mjs";
import { bindRuntimeToolHandlers } from "../src/local/runtime-tool-handlers.mjs";
import { normalizeToolResult } from "../src/local/tool-result-boundary.mjs";
import { policyProfile } from "../src/local/tools.mjs";

const root = await mkdtemp(join(tmpdir(), "mbm-runtime-handler-matrix-"));
const runtime = new LocalRuntime({
  workspace: root,
  policy: policyProfile("full", "explicit"),
  logger: { event() {}, debug() {}, info() {}, warn() {}, error() {} },
  jobRoot: join(root, "jobs"),
  browserStateRoot: "",
  recoverJobs: false,
});
if (runtime.processExecutionService.resourceWaitMs !== undefined || runtime.processSessionManager.resourceWaitMs !== undefined) {
  throw new Error("runtime composition pinned the old two-second resource-admission override instead of using dynamic defaults");
}

try {
  const routed = [];
  const route = (name) => async (...args) => {
    routed.push(name);
    return { route: name, argument_count: args.length };
  };
  const routeSync = (name) => (...args) => {
    routed.push(name);
    return { route: name, argument_count: args.length };
  };

  runtime.runtimeInfo = routeSync("server_info");
  runtime.projectOverview = route("project_overview");
  runtime.sessionBootstrap = route("session_bootstrap");
  runtime.resolveTaskCapabilities = route("resolve_task_capabilities");
  runtime.runLocalCommand = route("run_local_command");
  runtime.listRoots = routeSync("list_roots");
  runtime.listDir = route("list_dir");
  runtime.listFiles = route("list_files");
  runtime.readFile = route("read_file");
  runtime.viewImage = route("view_image");
  runtime.writeFile = route("write_file");
  runtime.editFile = route("edit_file");
  runtime.applyPatch = route("apply_patch");
  runtime.searchText = route("search_text");
  runtime.gitStatus = route("git_status");
  runtime.gitDiff = route("git_diff");
  runtime.gitLog = route("git_log");
  runtime.gitShow = route("git_show");
  runtime.gitCommit = route("git_commit");
  runtime.diagnoseRuntime = route("diagnose_runtime");
  runtime.generateSshKeyResource = route("generate_ssh_key_resource");
  runtime.runDirectProcess = route("run_process");
  runtime.execCommand = route("exec_command");

  runtime.agentContextManager = {
    agentContext: route("agent_context"),
    listLocalSkills: route("list_local_skills"),
    loadLocalSkill: route("load_local_skill"),
    listLocalCommands: route("list_local_commands"),
  };
  runtime.appAutomationManager = {
    listApplications: route("list_local_applications"),
    openApplication: route("open_local_application"),
    inspectApplication: route("inspect_local_application"),
    operateApplication: route("operate_local_application"),
  };
  runtime.computerUseManager = {
    observe: route("computer_observe"),
    act: route("computer_act"),
  };
  runtime.browserBridgeManager = {
    status: route("browser_status"),
    pair: route("pair_browser_extension"),
    listTabs: route("browser_list_tabs"),
    manageTabs: route("browser_manage_tabs"),
    wait: route("browser_wait"),
    getSource: route("browser_get_source"),
    inspectPage: route("browser_inspect_page"),
    act: route("browser_action"),
    fillForm: route("browser_fill_form"),
    screenshot: route("browser_screenshot"),
    uploadFiles: route("browser_upload_files"),
    cancelCall() {},
    stop() {},
  };
  runtime.managedJobManager = {
    listResources: routeSync("list_local_resources"),
    stage: routeSync("stage_job"),
    start: routeSync("start_job"),
    list: routeSync("list_jobs"),
    read: routeSync("read_job"),
    cancel: routeSync("cancel_job"),
    stopRunnerExitRecovery() {},
  };
  runtime.processSessionManager = {
    start: route("start_process"),
    read: route("read_process"),
    write: route("write_process"),
    kill: route("kill_process"),
    notifyCancellation() {},
    async clearAndWait() {},
  };

  const argumentsByTool = {
    resolve_task_capabilities: { task: "verify runtime handler routing" },
    open_local_application: { application: "Example" },
    inspect_local_application: { application: "Example" },
    operate_local_application: { application: "Example", action: "activate" },
    computer_observe: { surface: "browser" },
    computer_act: { surface: "browser", snapshot_id: "cu_matrix00000001", action: "reload" },
    browser_manage_tabs: { action: "new" },
    browser_action: { action: "reload" },
    browser_fill_form: { fields: [{ selector: { css: "#field" }, value: "value" }] },
    browser_upload_files: { selector: { css: "#upload" }, resources: ["matrix-file"] },
    load_local_skill: { skill: "matrix-skill" },
    run_local_command: { name: "matrix-command" },
    list_files: { path: ".", max_files: 2 },
    read_file: { path: "file.txt" },
    view_image: { path: "image.png" },
    write_file: { path: "file.txt", content: "value" },
    edit_file: { path: "file.txt", old_text: "a", new_text: "b" },
    apply_patch: { patch: "*** Begin Patch\n*** End Patch" },
    search_text: { path: ".", query: "value" },
    git_commit: { path: ".", message: "matrix commit" },
    run_process: { argv: [process.execPath, "--version"], timeout_seconds: 1 },
    start_process: { argv: [process.execPath, "--version"] },
    read_process: { session_id: "matrix-session" },
    write_process: { session_id: "matrix-session", data: "value" },
    kill_process: { session_id: "matrix-session" },
    generate_ssh_key_resource: { name: "matrix-key" },
    stage_job: { steps: [{ argv: [process.execPath, "--version"] }] },
    start_job: { steps: [{ argv: [process.execPath, "--version"] }] },
    read_job: { job_id: `job_${"A".repeat(24)}` },
    cancel_job: { job_id: `job_${"B".repeat(24)}` },
    exec_command: { command: "echo matrix", timeout_seconds: 1 },
  };

  const names = runtimeToolHandlerNames();
  for (const [index, name] of names.entries()) {
    const result = await runtime.executeTool(name, argumentsByTool[name] || {}, {
      callId: `matrix-${index}`,
      origin: "runtime-handler-matrix",
    });
    assert(result?.route === name, `runtime handler routed ${name} to ${result?.route || "nothing"}`);
  }
  assert(routed.length === names.length, "runtime handler matrix did not execute every handler exactly once");
  assert(runtime.callRegistry.snapshot().active === 0, "runtime handler matrix leaked call registry state");

  const shortJobId = `job_${"C".repeat(24)}`;
  const accepted = {
    job_id: shortJobId, status: "queued", recovery: { tool: "read_job", job_id: shortJobId },
  };
  const hostedHandlers = bindRuntimeToolHandlers({
    managedJobManager: {
      start() { return accepted; },
      async readHosted() {
        return { job_id: shortJobId, status: "succeeded", current_phase: null, current_step: null, result: { ok: true } };
      },
      readProgress() { return { status: "succeeded", current_phase: null, current_step: null }; },
    },
  });
  const hostedStart = await hostedHandlers.start_job({}, { origin: "relay", authority: { origin: "relay" } });
  assert(hostedStart.status === "succeeded" && hostedStart.initial_settlement_terminal === true
    && hostedStart.follow_up_read_required === false && hostedStart.result?.ok === true
    && hostedStart.recovery === accepted.recovery,
  "hosted start_job did not coalesce a short terminal managed job into the original response");
  const normalizedHostedStart = normalizeToolResult(hostedStart).value;
  assert(normalizedHostedStart.recovery?.job_id === shortJobId && normalizedHostedStart.follow_up_read_required === false,
    "hosted start_job initial settlement leaked a non-JSON value through the real tool-result boundary");
  console.log(`runtime handler matrix test ok (${names.length} handlers)`);
} finally {
  await runtime.stop();
  await rm(root, { recursive: true, force: true });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
