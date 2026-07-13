import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalRuntime, runtimeToolHandlerNames } from "../src/local/runtime.mjs";
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
  };
  runtime.processSessionManager = {
    start: route("start_process"),
    read: route("read_process"),
    write: route("write_process"),
    kill: route("kill_process"),
    notifyCancellation() {},
    clear() {},
  };

  const argumentsByTool = {
    list_files: { path: ".", max_files: 2 },
    read_file: { path: "file.txt" },
    view_image: { path: "image.png" },
    write_file: { path: "file.txt", content: "value" },
    edit_file: { path: "file.txt", old_text: "a", new_text: "b" },
    apply_patch: { patch: "*** Begin Patch\n*** End Patch" },
    search_text: { path: ".", query: "value" },
    exec_command: { command: "echo matrix", timeout_seconds: 1 },
    run_process: { argv: [process.execPath, "--version"], timeout_seconds: 1 },
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
  console.log(`runtime handler matrix test ok (${names.length} handlers)`);
} finally {
  runtime.stop();
  await rm(root, { recursive: true, force: true });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
