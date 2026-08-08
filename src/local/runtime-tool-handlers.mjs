import { clampInteger } from "./numbers.mjs";

const RUNTIME_TOOL_HANDLERS = Object.freeze({
  server_info: (runtime, args, context) => runtime.serverInfo(args, context),
  project_overview: (runtime, args, context) => runtime.projectOverview(args, context),
  session_bootstrap: (runtime, args, context) => runtime.sessionBootstrap(args, context),
  agent_context: (runtime, args, context) => runtime.agentContextManager.agentContext(args, context),
  resolve_task_capabilities: (runtime, args, context) => runtime.resolveTaskCapabilities(args, context),
  list_local_skills: (runtime, args, context) => runtime.agentContextManager.listLocalSkills(args, context),
  load_local_skill: (runtime, args, context) => runtime.agentContextManager.loadLocalSkill(args, context),
  list_local_commands: (runtime, args, context) => runtime.agentContextManager.listLocalCommands(args, context),
  run_local_command: (runtime, args, context) => runtime.runLocalCommand(args, context),
  list_local_applications: (runtime, args, context) => runtime.appAutomationManager.listApplications(args, context),
  open_local_application: (runtime, args, context) => runtime.appAutomationManager.openApplication(args, context),
  inspect_local_application: (runtime, args, context) => runtime.appAutomationManager.inspectApplication(args, context),
  operate_local_application: (runtime, args, context) => runtime.appAutomationManager.operateApplication(args, context),
  browser_status: (runtime, _args, context) => runtime.browserBridgeManager.status(context),
  pair_browser_extension: (runtime, args, context) => runtime.browserBridgeManager.pair(args, context),
  browser_list_tabs: (runtime, args, context) => runtime.browserBridgeManager.listTabs(args, context),
  browser_manage_tabs: (runtime, args, context) => runtime.browserBridgeManager.manageTabs(args, context),
  browser_wait: (runtime, args, context) => runtime.browserBridgeManager.wait(args, context),
  browser_get_source: (runtime, args, context) => runtime.browserBridgeManager.getSource(args, context),
  browser_inspect_page: (runtime, args, context) => runtime.browserBridgeManager.inspectPage(args, context),
  browser_action: (runtime, args, context) => runtime.browserBridgeManager.act(args, context),
  browser_fill_form: (runtime, args, context) => runtime.browserBridgeManager.fillForm(args, context),
  browser_screenshot: (runtime, args, context) => runtime.browserBridgeManager.screenshot(args, context),
  browser_upload_files: (runtime, args, context) => runtime.browserBridgeManager.uploadFiles(args, context),
  list_roots: (runtime, _args, context) => runtime.listRoots(context),
  list_dir: (runtime, args, context) => runtime.listDir(args.path || ".", context),
  list_files: (runtime, args, context) => runtime.listFiles(args.path || ".", clampInteger(args.max_files, 1000, 1, 10000), context),
  read_file: (runtime, args, context) => runtime.readFile(args, context),
  view_image: (runtime, args, context) => runtime.viewImage(args, context),
  write_file: (runtime, args, context) => runtime.writeFile(args, context),
  edit_file: (runtime, args, context) => runtime.editFile(args, context),
  apply_patch: (runtime, args, context) => runtime.applyPatch(args, context),
  search_text: (runtime, args, context) => runtime.searchText(args, context),
  git_status: (runtime, args, context) => runtime.gitStatus(args, context),
  git_diff: (runtime, args, context) => runtime.gitDiff(args, context),
  git_log: (runtime, args, context) => runtime.gitLog(args, context),
  git_show: (runtime, args, context) => runtime.gitShow(args, context),
  diagnose_runtime: (runtime, _args, context) => runtime.diagnoseRuntime(context),
  list_local_resources: (runtime, _args, context) => runtime.managedJobManager.listResources(context),
  generate_ssh_key_resource: (runtime, args, context) => runtime.generateSshKeyResource(args, context),
  stage_job: (runtime, args, context) => runtime.managedJobManager.stage(args, context),
  start_job: (runtime, args, context) => runtime.managedJobManager.start(args, context),
  list_jobs: (runtime, args, context) => runtime.managedJobManager.list(args, context),
  read_job: (runtime, args, context) => runtime.managedJobManager.read(args, context),
  cancel_job: (runtime, args, context) => runtime.managedJobManager.cancel(args, context),
  run_process: (runtime, args, context) => runtime.runDirectProcess(args, context),
  start_process: (runtime, args, context) => runtime.processSessionManager.start(args, context),
  read_process: (runtime, args, context) => runtime.processSessionManager.read(args, context),
  write_process: (runtime, args, context) => runtime.processSessionManager.write(args, context),
  kill_process: (runtime, args, context) => runtime.processSessionManager.kill(args, context),
  exec_command: (runtime, args, context) => runtime.execCommand(args.command, args.timeout_seconds, context),
});

export function runtimeToolHandlerNames() {
  return Object.keys(RUNTIME_TOOL_HANDLERS);
}

export function bindRuntimeToolHandlers(runtime) {
  return Object.fromEntries(Object.entries(RUNTIME_TOOL_HANDLERS).map(([name, handler]) => [
    name,
    (args, context) => handler(runtime, args, context),
  ]));
}
