import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentContextManager, parseSkillMetadata } from "../src/local/agent-context.mjs";
import { LocalRuntime } from "../src/local/runtime.mjs";

const root = await mkdtemp(join(tmpdir(), "mbm-agent-context-"));
const workspace = join(root, "workspace");
const jobs = join(root, "jobs");
const nested = join(workspace, "packages", "example");

try {
  await mkdir(join(workspace, ".git"), { recursive: true });
  await mkdir(join(workspace, ".machine-bridge"), { recursive: true });
  await mkdir(join(nested, ".machine-bridge"), { recursive: true });
  await mkdir(join(workspace, ".codex", "skills", "sample", "scripts"), { recursive: true });
  await mkdir(join(workspace, ".codex", "skills", "invalid"), { recursive: true });
  await mkdir(jobs, { recursive: true });

  await writeFile(join(workspace, "AGENTS.md"), "root agents\n", "utf8");
  await writeFile(join(workspace, "PROJECT.md"), "root project\n", "utf8");
  await writeFile(join(nested, "LOCAL.md"), "nested local\n", "utf8");
  await writeFile(join(nested, "AGENTS.md"), "nested agents\n", "utf8");
  await writeFile(join(workspace, ".codex", "skills", "sample", "SKILL.md"), `---
name: sample-skill
description: "A sample local workflow."
---

# Sample

Follow the sample workflow.
`, "utf8");
  await writeFile(join(workspace, ".codex", "skills", "sample", "scripts", "run.mjs"), "console.log('sample');\n", "utf8");
  await writeFile(join(workspace, ".codex", "skills", "invalid", "SKILL.md"), "---\nname: invalid-skill\n---\n", "utf8");

  await writeFile(join(workspace, ".machine-bridge", "agent.json"), JSON.stringify({
    version: 1,
    instruction_files: ["PROJECT.md", "AGENTS.md"],
    skill_roots: [".codex/skills"],
    commands: {
      "echo-args": {
        description: "Echo arguments without shell parsing.",
        argv: [process.execPath, "-e", "process.stdout.write(process.cwd() + '\\n' + process.argv.slice(1).join('|'))"],
        cwd: ".",
        timeout_seconds: 10,
        allow_extra_args: true,
      },
      fixed: {
        description: "A command that accepts no caller arguments.",
        argv: [process.execPath, "-e", "process.stdout.write('fixed')"],
        cwd: ".",
        timeout_seconds: 5,
      },
    },
  }, null, 2), "utf8");

  await writeFile(join(nested, ".machine-bridge", "agent.json"), JSON.stringify({
    version: 1,
    instruction_files: ["LOCAL.md", "AGENTS.md"],
    commands: {
      "echo-args": {
        description: "Nearest-scope echo command.",
        argv: [process.execPath, "-e", "process.stdout.write(process.cwd() + '\\n' + process.argv.slice(1).join('|'))"],
        cwd: ".",
        timeout_seconds: 7,
        allow_extra_args: true,
      },
      fixed: null,
    },
  }, null, 2), "utf8");

  const runtime = new LocalRuntime({
    workspace,
    policy: { profile: "agent", origin: "explicit", revision: 3 },
    jobRoot: jobs,
    agentHome: root,
    codexHome: join(root, "empty-codex-home"),
    recoverJobs: false,
  });
  try {
    const context = await runtime.executeTool("agent_context", { path: "packages/example" });
    assert(context.scope_root === ".", `unexpected scope root: ${context.scope_root}`);
    assert(context.config_files.length === 2, "root and nested agent configs were not discovered");
    assert(context.instruction_files.length === 2, "instruction file precedence chain is incomplete");
    assert(context.instruction_files.map((item) => item.path).join(",") === "PROJECT.md,packages/example/LOCAL.md", "instruction candidate priority or root-to-leaf order is incorrect");
    assert(context.effective_instructions.indexOf("root project") < context.effective_instructions.indexOf("nested local"), "effective instructions are not root-to-leaf");
    assert(context.skills.length === 1 && context.skills[0].name === "sample-skill", "agent context did not summarize configured skills");
    assert(context.skill_warnings.length === 1 && context.skill_warnings[0].message.includes("requires non-empty name and description"), "invalid skill metadata was not reported and skipped");
    assert(context.commands.length === 1 && context.commands[0].name === "echo-args", "nearest command override/deletion failed");
    assert(context.commands[0].cwd === "packages/example", "registered command cwd was not resolved relative to its config scope");

    const skills = await runtime.executeTool("list_local_skills", { path: "packages/example", query: "sample" });
    assert(skills.skills.length === 1, "list_local_skills did not find the sample skill");
    const loaded = await runtime.executeTool("load_local_skill", { path: "packages/example", skill: skills.skills[0].id });
    assert(loaded.instructions.includes("Follow the sample workflow"), "load_local_skill omitted SKILL.md content");
    assert(loaded.files.some((item) => item.path === "scripts/run.mjs"), "load_local_skill omitted the skill file inventory");
    assert(loaded.execution_semantics.includes("does not execute"), "skill loading semantics are ambiguous");

    const resolved = await runtime.executeTool("resolve_task_capabilities", { path: "packages/example", task: "Follow the sample local workflow and run the repository command" });
    assert(resolved.selected_skill?.name === "sample-skill", "task capability resolver did not automatically select the relevant skill");
    assert(resolved.effective_instructions.includes("root project") && resolved.effective_instructions.includes("nested local"), "task capability resolver omitted effective instructions for a reused host session");
    assert(resolved.recommended_tools.includes("run_local_command"), "task capability resolver did not recommend the registered command surface");
    const previousFingerprint = resolved.refresh.fingerprint;
    await mkdir(join(workspace, ".codex", "skills", "fresh"), { recursive: true });
    await writeFile(join(workspace, ".codex", "skills", "fresh", "SKILL.md"), `---
name: fresh-skill
description: Handles freshly discovered deployment workflows.
---

Use the fresh workflow.
`, "utf8");
    const refreshed = await runtime.executeTool("resolve_task_capabilities", { path: "packages/example", task: "Use the freshly discovered deployment workflow", include_selected_skill: true });
    assert(refreshed.skill_matches.some((skill) => skill.name === "fresh-skill"), "task capability resolver did not rescan newly added skills");
    assert(refreshed.refresh.fingerprint !== previousFingerprint, "capability refresh fingerprint did not change after skill discovery changed");

    await mkdir(join(workspace, ".codex", "skills", "chinese"), { recursive: true });
    await writeFile(join(workspace, ".codex", "skills", "chinese", "SKILL.md"), `---
name: deployment-review
description: 审查部署流程并验证发布配置。
---

检查部署流程。
`, "utf8");
    const chineseRelevant = await runtime.executeTool("resolve_task_capabilities", { path: "packages/example", task: "请审查部署流程并检查配置" });
    assert(chineseRelevant.selected_skill?.name === "deployment-review", "Chinese task matching did not select the relevant skill");
    const chineseUnrelated = await runtime.executeTool("resolve_task_capabilities", { path: "packages/example", task: "在浏览器里填写新闻表单" });
    assert(chineseUnrelated.selected_skill === null, "Chinese task matching selected an unrelated skill from weak single-character overlap");

    const commands = await runtime.executeTool("list_local_commands", { path: "packages/example" });
    assert(commands.commands.length === 1 && commands.commands[0].timeout_seconds === 7, "list_local_commands did not apply nearest manifest precedence");
    const command = await runtime.executeTool("run_local_command", {
      path: "packages/example",
      name: "echo-args",
      args: ["one;two", "three"],
      timeout_seconds: 99,
    });
    assert(command.timeout_seconds === 7, "caller increased a registered command beyond its manifest timeout");
    assert(command.stdout.endsWith("\none;two|three"), "run_local_command used shell parsing or lost caller arguments");
    assert(command.cwd === "packages/example", "run_local_command used the wrong cwd");

    await expectReject(
      () => runtime.executeTool("run_local_command", { path: ".", name: "fixed", args: ["unexpected"] }),
      "does not accept extra args",
    );

    const metadata = parseSkillMetadata("---\nname: 'quoted'\ndescription: test skill\n---\n");
    assert(metadata.name === "quoted" && metadata.description === "test skill", "skill frontmatter parsing failed");
  } finally {
    runtime.stop();
  }

  const editRuntime = new LocalRuntime({
    workspace,
    policy: { profile: "edit", origin: "explicit", revision: 3 },
    jobRoot: join(root, "edit-jobs"),
    agentHome: root,
    codexHome: join(root, "empty-codex-home"),
    recoverJobs: false,
  });
  try {
    await expectReject(
      () => editRuntime.executeTool("run_local_command", { path: ".", name: "echo-args" }),
      "tool disabled or unknown",
    );
  } finally {
    editRuntime.stop();
  }

  await writeFile(join(workspace, ".machine-bridge", "agent.json"), JSON.stringify({
    version: 1,
    instruction_files: ["../outside.md"],
  }), "utf8");
  const manager = new AgentContextManager({
    workspace,
    policy: { unrestrictedPaths: false },
    displayPath: (value) => value,
    resolveExistingPath: async (value) => value === "." ? workspace : join(workspace, value),
  });
  await expectReject(() => manager.agentContext({ path: "." }), "outside the configured workspace");

  const compatWorkspace = join(root, "compat-workspace");
  const compatSubdir = join(compatWorkspace, "services", "example");
  const codexHome = join(root, "codex-home");
  await mkdir(join(root, ".config", "machine-bridge-mcp"), { recursive: true });
  await writeFile(join(root, "MODEL.md"), "global model instructions\n", "utf8");
  await writeFile(join(root, ".config", "machine-bridge-mcp", "agent.json"), JSON.stringify({ version: 1, model_instructions_file: "MODEL.md" }, null, 2), "utf8");
  await mkdir(join(compatWorkspace, ".git"), { recursive: true });
  await mkdir(join(compatSubdir, ".agents", "skills"), { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await writeFile(join(compatWorkspace, "AGENTS.md"), "ignored root base\n", "utf8");
  await writeFile(join(compatWorkspace, "AGENTS.override.md"), "root override\n", "utf8");
  await writeFile(join(compatSubdir, "AGENTS.override.md"), "", "utf8");
  await writeFile(join(compatSubdir, "AGENTS.md"), "nested base\n", "utf8");
  await writeFile(join(codexHome, "AGENTS.md"), "ignored global base\n", "utf8");
  await writeFile(join(codexHome, "AGENTS.override.md"), "global override\n", "utf8");
  const linkedSkillTarget = join(compatWorkspace, "shared-skill");
  await mkdir(linkedSkillTarget, { recursive: true });
  await writeFile(join(linkedSkillTarget, "SKILL.md"), `---
name: linked-skill
description: A skill reached through a repository symlink.
---

Use the linked workflow.
`, "utf8");
  let linkedSkillAvailable = true;
  try {
    await symlink(linkedSkillTarget, join(compatSubdir, ".agents", "skills", "linked-skill"), "dir");
  } catch (error) {
    if (error?.code !== "EPERM" && error?.code !== "EACCES") throw error;
    linkedSkillAvailable = false;
  }
  const projectCompatManager = new AgentContextManager({
    workspace: compatWorkspace,
    policy: { unrestrictedPaths: false },
    home: root,
    codexHome,
    displayPath: (value) => value,
    resolveExistingPath: async (value) => value === "." ? compatWorkspace : join(compatWorkspace, value),
  });
  const projectCompatContext = await projectCompatManager.agentContext({ path: "services/example" });
  assert(projectCompatContext.model_instructions_file?.content === "global model instructions\n", "global model_instructions_file was not loaded under a workspace-confined profile");
  assert(projectCompatContext.effective_instructions.indexOf("global model instructions") < projectCompatContext.effective_instructions.indexOf("root override"), "global model instructions did not precede project guidance");
  assert(projectCompatContext.instruction_files.length === 2, "project-only Codex instruction chain is incomplete");
  assert(projectCompatContext.instruction_files[0].content === "root override\n", "project AGENTS.override.md did not win");
  assert(projectCompatContext.instruction_files[1].content === "nested base\n", "empty nested override did not fall back to AGENTS.md");
  if (linkedSkillAvailable) assert(projectCompatContext.skills.some((skill) => skill.name === "linked-skill"), "default ancestor .agents/skills discovery did not follow a repository skill symlink");

  await mkdir(join(compatWorkspace, ".machine-bridge"), { recursive: true });
  await writeFile(join(compatWorkspace, ".machine-bridge", "agent.json"), JSON.stringify({
    version: 1,
    skill_roots: ["services/example/.agents/skills"],
  }), "utf8");
  const compatManager = new AgentContextManager({
    workspace: compatWorkspace,
    policy: { unrestrictedPaths: true },
    home: root,
    codexHome,
    displayPath: (value) => value,
    resolveExistingPath: async (value) => value === "." ? compatWorkspace : join(compatWorkspace, value),
  });
  const compatContext = await compatManager.agentContext({ path: "services/example" });
  assert(compatContext.instruction_files.length === 3, "Codex-compatible global/project instruction chain is incomplete");
  assert(compatContext.instruction_files[0].content === "global override\n", "global AGENTS.override.md did not win");
  assert(compatContext.instruction_files[1].content === "root override\n", "project AGENTS.override.md did not win");
  assert(compatContext.instruction_files[2].content === "nested base\n", "nested AGENTS.md was not loaded");
  const bootstrap = await compatManager.sessionBootstrap({ path: "services/example" });
  assert(bootstrap.instructions.includes("global model instructions") && bootstrap.model_instructions_file === join(root, "MODEL.md"), "session bootstrap omitted the configured global model instructions");
  assert(bootstrap.capability_refresh.skills_scanned === false, "session bootstrap performed an unnecessary full skill scan");


  const limitedWorkspace = join(root, "limited-workspace");
  await mkdir(join(limitedWorkspace, ".git"), { recursive: true });
  await mkdir(join(limitedWorkspace, ".machine-bridge"), { recursive: true });
  await writeFile(join(limitedWorkspace, "AGENTS.md"), "x".repeat(2048), "utf8");
  await writeFile(join(limitedWorkspace, ".machine-bridge", "agent.json"), JSON.stringify({
    version: 1,
    instruction_max_bytes: 1024,
  }), "utf8");
  const limitedManager = new AgentContextManager({
    workspace: limitedWorkspace,
    policy: { unrestrictedPaths: false },
    displayPath: (value) => value,
    resolveExistingPath: async () => limitedWorkspace,
  });
  const limitedContext = await limitedManager.agentContext({ path: "." });
  assert(limitedContext.instructions_truncated === true && limitedContext.instruction_files.length === 0, "instruction byte ceiling did not stop oversized guidance");

    const externalGuidance = join(root, "external-guidance");
  await mkdir(externalGuidance, { recursive: true });
  await writeFile(join(externalGuidance, "OUTSIDE.md"), "outside guidance\n", "utf8");
  try {
    await symlink(externalGuidance, join(workspace, "guidance-link"), "dir");
    await writeFile(join(workspace, ".machine-bridge", "agent.json"), JSON.stringify({
      version: 1,
      instruction_files: ["guidance-link/OUTSIDE.md"],
    }), "utf8");
    await expectReject(() => manager.agentContext({ path: "." }), "outside the configured workspace");
  } catch (error) {
    if (error?.code !== "EPERM" && error?.code !== "EACCES") throw error;
  }

  console.log("agent context test ok");
} finally {
  await rm(root, { recursive: true, force: true });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function expectReject(callback, expected) {
  try {
    await callback();
  } catch (error) {
    if (String(error?.message || error).includes(expected)) return;
    throw new Error(`expected error containing '${expected}', got '${error?.message || error}'`);
  }
  throw new Error(`expected rejection containing '${expected}'`);
}
