// Regenerate every tool `outputSchema` from the observed output contract.
//
// The contract (tests/fixtures/tool-output-contract.json) records the top-level fields each
// tool actually returned in a real invocation. `outputSchema` is a projection of that
// evidence, so a tool can never advertise a field it does not return. Tools that the
// offline harness cannot execute keep an empty property set instead of an invented one.
//
// Usage:
//   node scripts/generate-tool-output-schemas.mjs            # rewrite the catalog
//   node scripts/generate-tool-output-schemas.mjs --check    # fail when the catalog drifts
//   node scripts/generate-tool-output-schemas.mjs --observe  # re-observe the contract first

import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));
const catalogPath = join(root, "src/shared/tool-catalog.json");
const metadataPath = join(root, "src/shared/server-metadata.json");
const contractPath = join(root, "tests/fixtures/tool-output-contract.json");
const args = new Set(process.argv.slice(2));

let observedContract = null;
if (args.has("--observe")) {
  const { contract, verified, total } = await observeContract();
  observedContract = contract;
  console.log(`tool output contract observed: ${verified}/${total} tools returned a verified object`);
}

const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
const contract = observedContract ?? JSON.parse(readFileSync(contractPath, "utf8"));
const missing = [];
const drifted = [];
for (const tool of catalog) {
  const entry = contract.tools?.[tool.name];
  if (!entry) {
    missing.push(tool.name);
    continue;
  }
  const expected = outputSchemaFor(tool.name, entry);
  if (JSON.stringify(tool.outputSchema) !== JSON.stringify(expected)) {
    drifted.push(tool.name);
    tool.outputSchema = expected;
  }
}

const digest = createHash("sha256").update(JSON.stringify(catalog)).digest("hex");
const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));

if (args.has("--check")) {
  const problems = [
    missing.length ? `contract is missing tools: ${missing.join(", ")}` : null,
    drifted.length ? `outputSchema drifted from the observed contract: ${drifted.join(", ")}` : null,
    metadata.toolCatalogSha256 === digest ? null : "server-metadata catalog fingerprint is stale",
  ].filter(Boolean);
  if (problems.length) {
    console.error(`tool output schema check failed: ${problems.join("; ")}`);
    process.exitCode = 1;
  } else {
    console.log(`tool output schema check ok (${catalog.length} tools, ${contract.verified} verified, generation ${metadata.toolSchemaGeneration})`);
  }
} else {
  if (observedContract) writeFileSync(contractPath, `${JSON.stringify(observedContract, null, 2)}\n`);
  writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  if (metadata.toolCatalogSha256 !== digest) {
    metadata.toolCatalogSha256 = digest;
    metadata.toolSchemaGeneration = Number(metadata.toolSchemaGeneration) + 1;
    writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  }
  console.log(`tool output schemas regenerated: ${drifted.length} updated, ${catalog.length} tools, schema generation ${metadata.toolSchemaGeneration}`);
}

function outputSchemaFor(toolName, entry) {
  const properties = {};
  const injected = new Set(Array.isArray(entry.stdio_injected) ? entry.stdio_injected : []);
  for (const [name, type] of Object.entries(entry.properties || {})) {
    if (injected.has(name)) continue;
    properties[name] = schemaForObservedType(type);
  }
  const conditional = new Set(Array.isArray(entry.conditional) ? entry.conditional : []);
  const declaredRequired = Array.isArray(entry.required) ? entry.required : [];
  for (const name of declaredRequired) {
    if (!Object.hasOwn(properties, name)) throw new Error(`${toolName}: required output field ${name} was not observed`);
    if (injected.has(name)) throw new Error(`${toolName}: required output field ${name} is stdio-injected`);
    if (conditional.has(name)) throw new Error(`${toolName}: required output field ${name} is also conditional`);
  }
  for (const name of conditional) {
    if (!Object.hasOwn(properties, name)) throw new Error(`${toolName}: conditional output field ${name} was not observed`);
    if (injected.has(name)) throw new Error(`${toolName}: conditional output field ${name} is stdio-injected`);
  }
  return {
    type: "object",
    additionalProperties: true,
    properties,
    ...(declaredRequired.length ? { required: declaredRequired } : {}),
  };
}

function schemaForObservedType(type) {
  // A null observation proves only that the field was null in this environment. It does not
  // prove the field is always null: agent_context.automatic_project_context, for example,
  // becomes an object when a project context file exists. Emitting `type: "null"` would make
  // valid responses fail strict client validation, so leave the value unconstrained.
  // "unknown" means two observed modes returned different JSON types; declaring either one
  // would make the other valid response fail client validation.
  if (type === "null" || type === "unknown") return {};
  return { type };
}

async function observeContract() {
  const { LocalRuntime, runtimeToolHandlerNames } = await import("../src/local/runtime.mjs");
  const { policyProfile } = await import("../src/local/tools.mjs");
  const workspace = await mkdtemp(join(tmpdir(), "mbm-output-contract-"));
  const stateRoot = await mkdtemp(join(tmpdir(), "mbm-output-contract-state-"));
  await mkdir(join(workspace, "nested"), { recursive: true });
  await mkdir(join(workspace, ".machine-bridge"), { recursive: true });
  await mkdir(join(workspace, ".codex", "skills", "contract"), { recursive: true });
  await writeFile(join(workspace, "contract.txt"), "alpha\nbeta\n");
  await writeFile(join(workspace, "nested", "deep.txt"), "deep\n");
  await writeFile(join(workspace, "pixel.png"), Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
    "base64",
  ));
  await writeFile(join(workspace, ".codex", "skills", "contract", "SKILL.md"), `---
name: contract-skill
description: Observable output-contract fixture.
---

# Contract fixture

Return deterministic skill content for the output-observation harness.
`);
  await writeFile(join(workspace, ".machine-bridge", "agent.json"), JSON.stringify({
    version: 1,
    skill_roots: [".codex/skills"],
    commands: {
      "contract-command": {
        description: "Emit a deterministic output-contract fixture.",
        argv: [process.execPath, "-e", "process.stdout.write('contract-command\\n')"],
        cwd: ".",
        timeout_seconds: 5,
      },
    },
  }, null, 2));
  try {
    execFileSync("git", ["init", "-q"], { cwd: workspace });
    execFileSync("git", ["config", "user.email", "contract@invalid"], { cwd: workspace });
    execFileSync("git", ["config", "user.name", "contract"], { cwd: workspace });
    execFileSync("git", ["add", "."], { cwd: workspace });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: workspace });
    await writeFile(join(workspace, "commit.txt"), "staged contract change\n");
    execFileSync("git", ["add", "commit.txt"], { cwd: workspace });
  } catch {
    // Git is optional: tools that need it simply stay unverified.
  }
  const previous = (() => {
    try { return JSON.parse(readFileSync(contractPath, "utf8")); } catch { return { tools: {} }; }
  })();
  const metadata = {
    generation: Number.isSafeInteger(previous.generation) ? previous.generation : 1,
    note: typeof previous.note === "string" ? previous.note
      : "Top-level output fields observed from real tool invocations. Tools marked verified=false could not be executed in the offline audit harness, so their outputSchema deliberately claims no fields. Regenerate with scripts/generate-tool-output-schemas.mjs --observe.",
  };
  const { buildServerInfoResult } = await import("../src/worker/server-info.ts");
  const { DaemonRegistry } = await import("../src/worker/daemon-registry.ts");
  const { WorkerObservability } = await import("../src/worker/observability.ts");
  const runtime = new LocalRuntime({
    workspace,
    policy: policyProfile("full", "explicit"),
    logger: { event() {}, debug() {}, info() {}, warn() {}, error() {} },
    jobRoot: join(workspace, "jobs"),
    browserStateRoot: join(workspace, "browser"),
    resourceStatePath: join(stateRoot, "profiles", "contract", "state.json"),
    recoverJobs: false,
  });
  runtime.managedJobManager.runnerSpawnProcess = () => ({ pid: process.pid, unref() {}, once() {} });
  const state = { workspace, stagedJobs: [], startedJobId: "", processSessionId: "" };
  const tools = {};
  try {
    for (const label of ["read", "cancel"]) {
      try {
        const staged = await runtime.executeTool("stage_job", {
          name: `contract-${label}-fixture`,
          steps: [{ argv: [process.execPath, "--version"] }],
        }, { callId: `contract-stage-${label}`, origin: "output-contract" });
        if (typeof staged?.job_id === "string") state.stagedJobs.push(staged.job_id);
      } catch {
        // A failed fixture setup leaves the corresponding read/cancel tool unverified.
      }
    }
    for (const [index, name] of runtimeToolHandlerNames().entries()) {
      const observations = [];
      let startProcessResult = null;
      let startJobResult = null;
      for (const [variantIndex, args] of observationArgumentVariants(name, state).entries()) {
        let result = null;
        try {
          result = await runtime.executeTool(name, args, {
            callId: `contract-${index}-${variantIndex}`,
            origin: "output-contract",
          });
        } catch {
          result = null;
        }
        if (name === "start_process" && !startProcessResult) startProcessResult = result;
        if (name === "start_job" && !startJobResult) startJobResult = result;
        observations.push(observeResult(result));
      }
      if (name === "server_info") {
        const workerInput = {
          serverName: "machine-bridge-mcp",
          serverVersion: "0.0.0-contract",
          base: "https://bridge.example.test",
          oauth: { issuer: "https://bridge.example.test" },
          authorization: {
            account: { role: "owner", version: 1 },
            summary: { role: "owner" },
            effective_policy: { profile: "full" },
            effective_tool_count: 1,
            account_role_is_owner: true,
            effective_profile_is_full: true,
            execution_model: { within_effective_authority: "direct", owner_ambient_authority: true },
          },
          daemon: { connected: true, count: 1, tool_count: 1, readiness_verified: true },
          effectiveTools: ["server_info"],
          advertisedTools: ["server_info"],
          pendingSnapshot: { active: 0, maximum: 8 },
          toolListSubscription: { activeForAccount: 0, openedForAccount: false },
          daemonRegistry: new DaemonRegistry({ getWebSockets: () => [] }),
          observability: new WorkerObservability(),
        };
        observations.push(
          observeResult(buildServerInfoResult(workerInput, "full")),
          observeResult(buildServerInfoResult(workerInput, "summary")),
        );
      }
      if (name === "start_process" && typeof startProcessResult?.session_id === "string") {
        state.processSessionId = startProcessResult.session_id;
      }
      if (name === "start_job" && typeof startJobResult?.job_id === "string") {
        state.startedJobId = startJobResult.job_id;
      }
      tools[name] = mergeObservationMetadata(mergeObservations(observations), previous.tools?.[name]);
    }
  } finally {
    await runtime.stop();
    await rm(workspace, { recursive: true, force: true });
    await rm(stateRoot, { recursive: true, force: true });
  }
  const verified = Object.values(tools).filter((entry) => entry.verified).length;
  return {
    contract: {
      generation: metadata.generation,
      note: metadata.note,
      verified,
      total: Object.keys(tools).length,
      tools: Object.fromEntries(Object.entries(tools).sort(([left], [right]) => left.localeCompare(right))),
    },
    verified,
    total: Object.keys(tools).length,
  };
}

function mergeObservations(observations) {
  const verified = observations.filter((entry) => entry.verified);
  if (!verified.length) return { verified: false, properties: {} };
  const properties = {};
  for (const observation of verified) {
    for (const [name, type] of Object.entries(observation.properties)) {
      if (!Object.hasOwn(properties, name)) properties[name] = type;
      else if (properties[name] !== type) properties[name] = "unknown";
    }
  }
  const alwaysPresent = new Set(
    Object.keys(properties).filter((name) => verified.every((entry) => Object.hasOwn(entry.properties, name))),
  );
  return { verified: true, properties, alwaysPresent };
}

function mergeObservationMetadata(observed, previous) {
  if (!observed.verified) return { verified: false, properties: {} };
  const { alwaysPresent = new Set(), ...rest } = observed;
  const stdioInjected = Array.isArray(previous?.stdio_injected) ? previous.stdio_injected : [];
  const injectedSet = new Set(stdioInjected);
  const conditionalSet = new Set(
    (Array.isArray(previous?.conditional) ? previous.conditional : [])
      .filter((name) => Object.hasOwn(rest.properties, name) && !injectedSet.has(name) && !alwaysPresent.has(name)),
  );
  for (const name of ["effective_instructions", "builtin_instructions", "automatic_project_context", "model_instructions_file", "instruction_files", "capacity", "recent_activity", "next_start_line"]) {
    if (Array.isArray(previous?.conditional) && previous.conditional.includes(name) && Object.hasOwn(rest.properties, name) && !injectedSet.has(name)) {
      conditionalSet.add(name);
    }
  }
  for (const name of Object.keys(rest.properties)) {
    if (!injectedSet.has(name) && !alwaysPresent.has(name)) conditionalSet.add(name);
  }
  const conditional = Object.keys(rest.properties).filter((name) => conditionalSet.has(name));
  const required = Object.keys(rest.properties).filter((name) => !conditionalSet.has(name) && !injectedSet.has(name));
  return {
    ...rest,
    conditional,
    required,
    ...(stdioInjected.length ? { stdio_injected: stdioInjected } : {}),
  };
}

function observeResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return { verified: false, properties: {} };
  const structured = result.$mcp?.structuredContent;
  const value = structured && typeof structured === "object" && !Array.isArray(structured) ? structured : result;
  if (value === result && Object.hasOwn(result, "$mcp")) return { verified: false, properties: {} };
  const properties = {};
  for (const [key, field] of Object.entries(value)) {
    if (key === "$mcpText") continue;
    properties[key] = jsonType(field);
  }
  return { verified: true, properties };
}

function jsonType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (["string", "boolean", "object"].includes(typeof value)) return typeof value;
  return "object";
}

function observationArgumentVariants(name, state) {
  const args = observationArguments(name, state);
  if (name === "server_info" || name === "project_overview") return [args, { ...args, detail: "summary" }];
  if (name === "exec_command" || name === "run_process" || name === "run_local_command") {
    return [args, { ...args, idempotency_key: `contract-${name}-durable` }];
  }
  if (name === "cancel_job") {
    return [args, args, { job_id: state.startedJobId || `job_${"C".repeat(24)}` }];
  }
  return [args];
}

function observationArguments(name, state) {
  return {
    resolve_task_capabilities: { task: "observe tool output contract" },
    load_local_skill: { skill: "contract-skill" },
    run_local_command: { name: "contract-command" },
    computer_observe: { surface: "browser" },
    browser_manage_tabs: { action: "new" },
    browser_action: { action: "reload" },
    list_files: { path: ".", max_files: 5 },
    read_file: { path: "contract.txt", max_bytes: 6 },
    view_image: { path: "pixel.png" },
    write_file: { path: "written.txt", content: "value" },
    edit_file: { path: "written.txt", old_text: "value", new_text: "value2" },
    apply_patch: { patch: "*** Begin Patch\n*** Add File: patched.txt\n+hello\n*** End Patch" },
    search_text: { path: ".", query: "alpha" },
    git_commit: { path: ".", message: "contract commit" },
    generate_ssh_key_resource: { name: "contract-key", path: join(state.workspace, "contract-key") },
    run_process: { argv: [process.execPath, "--version"], timeout_seconds: 5 },
    start_process: { argv: [process.execPath, "-e", "process.stdin.resume();setInterval(()=>{},1000);"] },
    read_process: state.processSessionId ? { session_id: state.processSessionId, wait_ms: 100 } : { session_id: "missing" },
    write_process: state.processSessionId ? { session_id: state.processSessionId, data: "ping\n" } : { session_id: "missing" },
    kill_process: state.processSessionId ? { session_id: state.processSessionId, force: true } : { session_id: "missing" },
    stage_job: { steps: [{ argv: [process.execPath, "--version"] }] },
    start_job: { steps: [{ argv: [process.execPath, "--version"] }] },
    read_job: { job_id: state.stagedJobs[0] || `job_${"A".repeat(24)}` },
    cancel_job: { job_id: state.stagedJobs[1] || `job_${"B".repeat(24)}` },
    exec_command: { command: "echo contract", timeout_seconds: 5 },
  }[name] || {};
}
