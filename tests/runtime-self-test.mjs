import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { LocalRuntime, MAX_COMMAND_BYTES, MAX_WRITE_BYTES, sha256 } from "../src/local/runtime.mjs";

export async function runtimeSelfTest() {
  const workspace = await mkdtemp(join(tmpdir(), "mbm-daemon-workspace-"));
  const outside = await mkdtemp(join(tmpdir(), "mbm-daemon-outside-"));
  const jobState = await mkdtemp(join(tmpdir(), "mbm-daemon-jobs-"));
  const logEvents = [];
  const logger = {
    info(message, fields) { logEvents.push({ level: "info", message, fields }); },
    warn(message, fields) { logEvents.push({ level: "warn", message, fields }); },
    error(message, fields) { logEvents.push({ level: "error", message, fields }); },
    debug(message, fields) { logEvents.push({ level: "debug", message, fields }); },
  };
  const restricted = new LocalRuntime({
    workerUrl: "https://example.invalid",
    secret: "test-secret-value-123456",
    workspace,
    policy: { allowWrite: true, allowExec: true },
    logger,
    jobRoot: join(jobState, "restricted"),
  });
  const unrestricted = new LocalRuntime({
    workerUrl: "https://example.invalid",
    secret: "test-secret-value-123456",
    workspace,
    policy: { allowWrite: true, allowExec: true, unrestrictedPaths: true, exposeAbsolutePaths: false },
    logger,
    jobRoot: join(jobState, "unrestricted"),
  });
  const unrestrictedVisible = new LocalRuntime({
    workerUrl: "https://example.invalid",
    secret: "test-secret-value-123456",
    workspace,
    policy: { allowWrite: true, allowExec: true, unrestrictedPaths: true, exposeAbsolutePaths: true },
    logger,
    jobRoot: join(jobState, "unrestricted-visible"),
  });
  const previousSecret = process.env.MBM_DAEMON_SELFTEST_SECRET;
  process.env.MBM_DAEMON_SELFTEST_SECRET = "should-not-leak";
  try {
    const relayMessages = [];
    const originalSend = restricted.send.bind(restricted);
    const originalExecuteTool = restricted.executeTool.bind(restricted);
    restricted.send = (value) => { relayMessages.push(value); return true; };
    restricted.executeTool = async (_tool, _args, context) => {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1100));
      restricted.throwIfCancelled(context);
      return { unexpected: true };
    };
    await restricted.handleMessage(JSON.stringify({ type: "tool_call", id: "deadline-call", tool: "read_file", arguments: {}, timeout_ms: 1000 }));
    const deadlineResult = relayMessages.find((value) => value.type === "tool_result" && value.id === "deadline-call");
    if (deadlineResult?.ok !== false || !String(deadlineResult.error?.message || "").includes("cancelled")) throw new Error("relay deadline did not cancel the local call");
    relayMessages.length = 0;
    await restricted.handleMessage(JSON.stringify({ type: "tool_call", id: "invalid-args", tool: "read_file", arguments: [] }));
    const invalidEnvelope = relayMessages.find((value) => value.type === "tool_result" && value.id === "invalid-args");
    if (invalidEnvelope?.ok !== false || !String(invalidEnvelope.error?.message || "").includes("invalid tool_call envelope")) throw new Error("invalid relay arguments were accepted");
    restricted.send = originalSend;
    restricted.executeTool = originalExecuteTool;

    await writeFile(join(workspace, ".env"), "SECRET=visible", "utf8");
    await writeFile(join(workspace, "visible.txt"), "needle", "utf8");
    await writeFile(join(outside, "outside.txt"), "outside-needle", "utf8");
    await writeFile(join(outside, "passwords.txt"), "password-file-visible", "utf8");
    await writeFile(join(outside, ".env"), "OUTSIDE_SECRET=visible", "utf8");

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
    await restricted.handleMessage(JSON.stringify({ type: "tool_call", id: "fast-success", tool: "read_file", arguments: { path: "visible.txt" } }));
    if (logEvents.some(event => event.level === "info" && event.message === "tool call completed")) {
      throw new Error("remote daemon emitted routine success at info level");
    }
    if (!logEvents.some(event => event.level === "debug" && event.message === "tool call completed")) {
      throw new Error("remote daemon omitted debug success correlation");
    }

    logEvents.length = 0;
    relayMessages.length = 0;
    restricted.send = (value) => { relayMessages.push(value); return true; };
    await restricted.handleMessage(JSON.stringify({ type: "tool_call", id: "failed-call", tool: "read_file", arguments: { path: "missing-file.txt" } }));
    restricted.send = originalSend;
    const failedResult = relayMessages.find((value) => value.type === "tool_result" && value.id === "failed-call");
    if (failedResult?.ok !== false) throw new Error("failed tool call did not return an error result");
    if (logEvents.some(event => event.level === "warn" && event.message === "tool call failed")) {
      throw new Error("remote daemon emitted per-tool failure noise at warn level");
    }
    if (!logEvents.some(event => event.level === "debug" && event.message === "tool call failed" && event.fields?.tool === "read_file")) {
      throw new Error("remote daemon omitted debug-only failure telemetry");
    }

    await expectReject(() => restricted.readFile(join(outside, "outside.txt"), 1024), "outside the configured workspace");
    await expectReject(() => restricted.readFile(path.relative(workspace, join(outside, "outside.txt")), 1024), "outside the configured workspace");

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
      await expectReject(() => restricted.writeFile({ path: linkPath, content: "replace" }), "outside the configured workspace");
    } catch (error) {
      if (error?.code !== "EPERM" && error?.code !== "EACCES") throw error;
    }

    const written = await restricted.writeFile({ path: "nested/written.txt", content: "written", create_only: true });
    if (written.bytes !== 7) throw new Error("write_file byte count is incorrect");
    await expectReject(() => restricted.writeFile({ path: "nested/written.txt", content: "again", create_only: true }), "file exists");
    await expectReject(() => restricted.writeFile({ path: "nested/written.txt", content: "again", expected_sha256: "bad" }), "expected_sha256 mismatch");
    await restricted.writeFile({ path: "nested/written.txt", content: "updated\nsecond\nthird\n", expected_sha256: sha256("written") });
    const slice = await restricted.readFile({ path: "nested/written.txt", start_line: 2, end_line: 3, max_bytes: 1024 });
    if (slice.content !== "second\nthird\n" || slice.start_line !== 2 || slice.total_lines !== 3) throw new Error("read_file line range failed");
    const edited = await restricted.editFile({ path: "nested/written.txt", old_text: "second", new_text: "SECOND", expected_sha256: slice.sha256 });
    if (edited.replacements !== 1 || !(await readFile(join(workspace, "nested/written.txt"), "utf8")).includes("SECOND")) throw new Error("edit_file failed");
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
    await expectReject(() => restricted.applyPatch({ patch: `*** Begin Patch
*** Update File: nested/written.txt
@@
 updated
-second-again
+should-not-commit
*** Update File: nested/added.txt
@@
 missing-context
*** End Patch` }), "context not found");
    if (await readFile(join(workspace, "nested/written.txt"), "utf8") !== beforeFailedPatch) throw new Error("failed patch partially committed");
    await expectReject(() => restricted.applyPatch({ patch: `*** Begin Patch
*** Add File: nested/collision.txt
+one
*** Add File: nested/../nested/collision.txt
+two
*** End Patch` }), "same path");
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
    await expectReject(() => restricted.writeFile({ path: "too-large.txt", content: "x".repeat(MAX_WRITE_BYTES + 1) }), "maximum write size");

    await writeFile(join(workspace, "invalid.bin"), Buffer.from([0xff, 0xfe]));
    await expectReject(() => restricted.readFile("invalid.bin", 1024), "not valid UTF-8");
    const binarySearch = await restricted.searchText({ path: workspace, query: "needle", max_files: 100, max_matches: 10 });
    if (!binarySearch.matches.some(match => match.path.endsWith("visible.txt"))) throw new Error("search_text missed UTF-8 file");

    const cappedSearch = await restricted.searchText({ path: workspace, query: "definitely-not-present", max_files: 1, max_matches: 10 });
    if (cappedSearch.visited_files !== 1 || cappedSearch.truncated !== true) throw new Error("search_text max_files cap did not apply");

    const repo = join(workspace, "nested-repo");
    await mkdir(repo);
    await restricted.runProcess("git", ["init", "-q", repo], 10_000);
    await writeFile(join(repo, "tracked.txt"), "one\n", "utf8");
    await restricted.runProcess("git", ["-C", repo, "add", "tracked.txt"], 10_000);
    await restricted.runProcess("git", ["-C", repo, "config", "user.name", "Machine Bridge Test"], 10_000);
    await restricted.runProcess("git", ["-C", repo, "config", "user.email", "private-test@example.invalid"], 10_000);
    await restricted.runProcess("git", ["-C", repo, "commit", "-qm", "initial"], 10_000);
    const logWithoutEmail = await restricted.gitLog({ path: "nested-repo", max_count: 5 });
    if (logWithoutEmail.commits.length !== 1 || "author_email" in logWithoutEmail.commits[0]) throw new Error("git_log leaked author email by default");
    const logWithEmail = await restricted.gitLog({ path: "nested-repo", max_count: 5, include_author_email: true });
    if (logWithEmail.commits[0]?.author_email !== "private-test@example.invalid") throw new Error("git_log explicit email option failed");
    const shown = await restricted.gitShow({ path: "nested-repo", revision: "HEAD", max_bytes: 1024 * 1024 });
    if (shown.code !== 0 || !shown.stdout.includes("initial")) throw new Error("git_show failed");
    await expectReject(() => restricted.gitShow({ path: "nested-repo", revision: "--help" }), "invalid Git revision");
    await restricted.runProcess("git", ["-C", repo, "config", "diff.external", "definitely-not-a-real-diff-command"], 10_000);
    await restricted.runProcess("git", ["-C", repo, "config", "core.fsmonitor", "definitely-not-a-real-fsmonitor-command"], 10_000);
    await writeFile(join(repo, "tracked.txt"), "two\n", "utf8");
    const diff = await restricted.gitDiff({ path: "nested-repo" });
    if (diff.code !== 0 || !diff.stdout.includes("tracked.txt") || diff.gitRoot !== "nested-repo") throw new Error("nested git diff detection failed");
    const status = await restricted.gitStatus({ path: "nested-repo" });
    if (status.code !== 0 || !status.stdout.includes("tracked.txt")) throw new Error("nested git status detection failed");

    const command = await restricted.execCommand("node -e \"process.stdout.write(process.env.MBM_DAEMON_SELFTEST_SECRET || 'unset')\"", 5);
    if (command.stdout !== "unset") throw new Error("exec_command inherited unallowlisted environment variables");
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
    const diagnostics = await restricted.diagnoseRuntime();
    if (!diagnostics.request_reached_local_runtime || !diagnostics.checks.some(check => check.layer === "local-process-spawn" && check.ok)) {
      throw new Error("runtime diagnostics did not prove local process execution");
    }
    if (!diagnostics.checks.some(check => check.layer === "managed-job-storage" && check.ok)) {
      throw new Error("runtime diagnostics did not validate managed-job storage");
    }
    const isolatedHome = await restricted.runDirectProcess({ argv: [process.execPath, "-e", "process.stdout.write(process.env.HOME || '')"], timeout_seconds: 5 });
    if (!isolatedHome.stdout.includes("machine-bridge-mcp-") || isolatedHome.stdout === process.env.HOME) throw new Error("minimal command environment did not isolate HOME");
    await expectReject(() => restricted.execCommand(`printf '${"x".repeat(MAX_COMMAND_BYTES)}'`, 5), "maximum size");
    await expectReject(() => restricted.execCommand("printf 'x\0y'", 5), "NUL byte");
    if (process.platform !== "win32") {
      await expectReject(() => restricted.execCommand("sleep 5", 1), "command timed out");
      const interrupted = restricted.runProcess("sleep", ["30"], 60_000);
      await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
      restricted.terminateActiveProcesses("SIGTERM");
      await expectReject(() => interrupted, "exited");
      if (restricted.activeProcesses.size !== 0) throw new Error("terminated process remained tracked");

      const descendantPidFile = join(workspace, "timeout-descendant.pid");
      const descendantCommand = `(trap '' TERM; sleep 30) & echo $! > ${shellQuote(descendantPidFile)}; wait`;
      await expectReject(() => restricted.execCommand(descendantCommand, 1), "command timed out");
      await new Promise(resolvePromise => setTimeout(resolvePromise, 2500));
      const descendantPid = Number((await readFile(descendantPidFile, "utf8")).trim());
      if (isProcessAlive(descendantPid)) {
        try { process.kill(descendantPid, "SIGKILL"); } catch {}
        throw new Error("timeout escalation left a SIGTERM-ignoring descendant running");
      }

      const detachedDescendantPidFile = join(workspace, "detached-timeout-descendant.pid");
      const detachedParent = `const { spawn } = require('node:child_process'); const { writeFileSync } = require('node:fs'); const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], { stdio: 'ignore' }); writeFileSync(process.argv[1], String(child.pid)); setInterval(()=>{},1000);`;
      await expectReject(() => restricted.runProcess(process.execPath, ["-e", detachedParent, detachedDescendantPidFile], 200), "command timed out");
      const detachedDescendantPid = Number((await readFile(detachedDescendantPidFile, "utf8")).trim());
      const detachedDeadline = Date.now() + 5000;
      while (isProcessAlive(detachedDescendantPid) && Date.now() < detachedDeadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
      }
      if (isProcessAlive(detachedDescendantPid)) {
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

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function expectReject(callback, pattern) {
  try {
    await callback();
  } catch (error) {
    if (String(error?.message || error).includes(pattern)) return;
    throw error;
  }
  throw new Error(`expected rejection containing: ${pattern}`);
}
