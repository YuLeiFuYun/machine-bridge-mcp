import strictAssert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolCatalogDigest, assertToolSchemaContract, readToolSchemaBaselines } from "../scripts/tool-schema-contract.mjs";
import { CORE_CORNERSTONE_TOOL_NAMES, PROGRESSIVE_TOOL_GROUPS } from "../src/shared/tool-groups.mjs";
import { readFile, mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { allToolNames, MCP_INSTRUCTIONS, toolResult, toolsForPolicy } from "../src/local/tools.mjs";
import { runtimeToolHandlerNames } from "../src/local/runtime.mjs";
import { operationMayHaveSideEffects } from "../src/local/operation-risk.mjs";

const catalog = JSON.parse(await readFile(new URL("../src/shared/tool-catalog.json", import.meta.url), "utf8"));
const outputContract = JSON.parse(await readFile(new URL("../src/shared/tool-output-contract.json", import.meta.url), "utf8"));
const JSON_SCHEMA_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const metadata = JSON.parse(await readFile(new URL("../src/shared/server-metadata.json", import.meta.url), "utf8"));
const activationSchema = catalog.find((tool) => tool.name === "resolve_task_capabilities").inputSchema.properties.activate_tool_groups.items;
assert(JSON.stringify([...activationSchema.enum].sort()) === JSON.stringify(Object.keys(PROGRESSIVE_TOOL_GROUPS).sort()), "progressive group schema drifted from implementation");
assert(CORE_CORNERSTONE_TOOL_NAMES.has("resolve_task_capabilities"), "progressive discovery entry point is hidden");
const groupedNames = new Set([...CORE_CORNERSTONE_TOOL_NAMES, ...Object.values(PROGRESSIVE_TOOL_GROUPS).flat()]);
assert(catalog.every((tool) => groupedNames.has(tool.name)), "a tool cannot be discovered through any progressive group");
const policyContract = JSON.parse(await readFile(new URL("../src/shared/policy-contract.json", import.meta.url), "utf8"));
assert(policyContract.defaultProfile === "full", "default policy profile is an explicit full-authority product contract and must not be narrowed incidentally");
assert(metadata.name === "machine-bridge-mcp", "shared server name is invalid");
assert(metadata.protocolVersion === "2026-07-28", "shared primary protocol version is invalid");
assert(JSON.stringify(metadata.supportedProtocolVersions) === JSON.stringify(["2026-07-28"]), "supported protocol inventory is not current-only");
assert(!Object.hasOwn(metadata, "remoteHttpInitializationCompatibilityVersions"),
  "shared metadata must not advertise removed remote initialization compatibility");
assert(!Object.hasOwn(metadata, "modernProtocolVersions") && !Object.hasOwn(metadata, "legacyProtocolVersions"), "shared metadata retained protocol-era compatibility inventories");
assert(Array.isArray(metadata.instructions) && metadata.instructions.length >= 4, "shared server instructions are missing");
assert(metadata.instructions.some((line) => line.includes("never use a hosted GitHub connector or ChatGPT GitHub plugin") && line.includes("stop rather than substitute")), "shared instructions omitted the fail-closed local GitHub control-plane rule");
assert(metadata.instructions.some((line) => line.includes("Straightforward file, Git, and shell work") && line.includes("instead of adding a resolver call")), "shared instructions still require an unnecessary capability-resolution round trip for direct work");
assert(metadata.instructions.some((line) => line.includes("child exit code") && line.includes("forced-command refusal") && line.includes("downstream target evidence")), "shared instructions do not distinguish a spawned nested-command refusal from Machine Bridge policy denial");
assert(MCP_INSTRUCTIONS === metadata.instructions.join("\n"), "runtime MCP instructions differ from shared metadata");
// `instructions` is re-sent at the start of every session, so its size is a per-session context
// cost rather than a documentation detail. The ceiling keeps growth deliberate: at the time it
// was set, only ~545 of these characters also appeared in a tool description, so most of this
// text is unique operating contract that cannot be trimmed without deciding which rule to drop.
const instructionCharacters = MCP_INSTRUCTIONS.length;
assert(instructionCharacters <= 32_000,
  `shared server instructions grew to ${instructionCharacters} characters; the per-session budget is 32,000`);
const workerSource = await readFile(new URL("../src/worker/index.ts", import.meta.url), "utf8");
const workerCatalogSource = await readFile(new URL("../src/worker/tool-catalog.ts", import.meta.url), "utf8");
const workerMcpConfigSource = await readFile(new URL("../src/worker/worker-mcp-config.ts", import.meta.url), "utf8");
const workerMetadataSource = await readFile(new URL("../src/worker/worker-metadata.ts", import.meta.url), "utf8");
assert(workerSource.includes('./worker-mcp-config.ts'), "Worker entrypoint bypasses the MCP configuration boundary");
assert(workerMcpConfigSource.includes('../shared/server-metadata.json')
  && workerMetadataSource.includes('../shared/server-metadata.json'),
"Worker MCP and discovery metadata do not derive from shared server metadata");
assert(!workerSource.includes("const MCP_INSTRUCTIONS = ["), "Worker retains a second hand-maintained instruction catalog");
assert(!workerSource.includes('const MCP_PROTOCOL_VERSION = "'), "Worker retains a second hand-maintained protocol version");

const names = catalog.map((tool) => tool.name);
const unique = new Set(names);
assert(names.length === unique.size, "tool catalog contains duplicate names");
assert(names[0] === "server_info", "server_info must remain the first catalog tool");
assert(JSON.stringify(names) === JSON.stringify(allToolNames()), "runtime tool inventory differs from catalog");
assert(JSON.stringify([...runtimeToolHandlerNames()].sort()) === JSON.stringify([...names].sort()), "local runtime handler inventory differs from catalog");
assert(operationMayHaveSideEffects("__future_unreviewed_tool") === true,
  "unknown future tools must fail closed as side-effecting at the audit boundary");
const computerActionSchema = catalog.find((tool) => tool.name === "computer_act")?.inputSchema;
assert(computerActionSchema?.properties?.post_screenshot?.default === "auto"
  && !Object.hasOwn(computerActionSchema.properties, "include_post_screenshot")
  && Number.isSafeInteger(metadata.toolSchemaGeneration) && metadata.toolSchemaGeneration > 0,
"computer_act exposes retired screenshot compatibility or an outdated schema generation");

for (const tool of catalog) {
  assert(typeof tool.name === "string" && /^[a-z][a-z0-9_]*$/.test(tool.name), `invalid tool name: ${tool.name}`);
  assert(typeof tool.title === "string" && tool.title.length > 0, `${tool.name} is missing title`);
  assert(typeof tool.description === "string" && tool.description.length > 20, `${tool.name} has an insufficient description`);
  if (["run_process", "run_local_command", "exec_command"].includes(tool.name)) {
    assert(Array.isArray(tool.inputSchema?.required), `${tool.name} durable schema must declare its required fields statically`);
  }
  assert(["always", "write", "direct-exec", "write+direct-exec", "shell-exec", "full"].includes(tool.availability), `${tool.name} has invalid availability`);
  assert(tool.inputSchema?.type === "object", `${tool.name} inputSchema must be an object`);
  assert(tool.inputSchema?.additionalProperties === false, `${tool.name} inputSchema must reject unknown fields`);
  assert(tool.outputSchema?.type === "object", `${tool.name} outputSchema must be an object`);
  assert(tool.outputSchema?.properties && typeof tool.outputSchema.properties === "object", `${tool.name} outputSchema must declare properties`);
  const observed = outputContract.tools?.[tool.name];
  assert(observed, `${tool.name} has no entry in the observed output contract`);
  for (const field of Object.keys(tool.outputSchema.properties)) {
    assert(Object.hasOwn(observed.properties, field),
      `${tool.name} outputSchema declares "${field}", which no real invocation returned`);
  }
  const requiredOutput = tool.outputSchema.required;
  assert(requiredOutput === undefined
    || (Array.isArray(requiredOutput) && requiredOutput.every((field) => Object.hasOwn(tool.outputSchema.properties, field))),
  `${tool.name} outputSchema requires a field it does not declare`);
  const expectedRequired = (observed.required || []).filter((field) => Object.hasOwn(observed.properties, field)
    && !(observed.conditional || []).includes(field)
    && !(observed.stdio_injected || []).includes(field));
  assert(JSON.stringify(requiredOutput || []) === JSON.stringify(expectedRequired),
    `${tool.name} outputSchema required fields drifted from the observed contract`);
  for (const field of requiredOutput || []) {
    assert(!(observed.conditional || []).includes(field),
      `${tool.name} outputSchema marks conditional field "${field}" as required`);
  }
  for (const [field, schema] of Object.entries(tool.outputSchema.properties)) {
    assert(schema && typeof schema === "object" && !Array.isArray(schema), `${tool.name} outputSchema field "${field}" is not an object schema`);
    if (schema.type === undefined) {
      assert(Object.keys(schema).length === 0, `${tool.name} outputSchema field "${field}" has no JSON type and no unconstrained marker`);
      continue;
    }
    assert(JSON_SCHEMA_TYPES.has(schema.type), `${tool.name} outputSchema field "${field}" has no JSON type`);
    assert(schema.type !== "null", `${tool.name} outputSchema field "${field}" froze a single null observation`);
  }
  for (const field of observed.stdio_injected || []) {
    assert(!Object.hasOwn(tool.outputSchema.properties, field),
      `${tool.name} outputSchema advertises transport-injected field "${field}" as a tool output`);
  }
  for (const field of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
    assert(typeof tool.annotations?.[field] === "boolean", `${tool.name} annotation ${field} is missing`);
  }
  assert(tool.annotations.readOnlyHint === !operationMayHaveSideEffects(tool.name),
    `${tool.name} read-only annotation drifted from the local side-effect security classification`);
}

const review = new Set(toolsForPolicy({ profile: "review", allowWrite: false, execMode: "off" }).map((tool) => tool.name));
const edit = new Set(toolsForPolicy({ profile: "edit", allowWrite: true, execMode: "off" }).map((tool) => tool.name));
const agent = new Set(toolsForPolicy({ profile: "agent", allowWrite: true, execMode: "direct" }).map((tool) => tool.name));
const full = new Set(toolsForPolicy({ profile: "full", origin: "explicit", revision: 5, allowWrite: true, execMode: "shell", unrestrictedPaths: true, minimalEnv: false, exposeAbsolutePaths: true }).map((tool) => tool.name));

assert(review.has("read_file") && review.has("list_jobs") && review.has("read_job") && review.has("list_local_resources") && !review.has("write_file") && !review.has("run_process"), "review profile inventory is invalid");
assert(edit.has("apply_patch") && !edit.has("run_process"), "edit profile inventory is invalid");
assert(agent.has("run_process") && agent.has("start_job") && !agent.has("exec_command") && !agent.has("generate_ssh_key_resource"), "agent profile inventory is invalid");
assert(review.has("list_local_applications") && edit.has("list_local_applications") && agent.has("list_local_applications"),
  "read-only application discovery did not remain available across policy profiles");
for (const fullOnly of ["open_local_application", "inspect_local_application", "operate_local_application", "browser_status", "browser_manage_tabs", "browser_wait", "browser_action", "browser_fill_form", "browser_upload_files"]) {
  assert(!review.has(fullOnly) && !edit.has(fullOnly) && !agent.has(fullOnly), `${fullOnly} escaped full-only policy`);
}
assert(full.has("run_process") && full.has("exec_command") && full.has("generate_ssh_key_resource"), "full profile inventory is invalid");
assert(full.has("browser_action") && full.has("browser_manage_tabs") && full.has("browser_wait") && full.has("operate_local_application"), "full profile omitted local automation tools");
assert(full.size === catalog.length, "full profile must expose the complete catalog");
for (const processToolName of ["run_local_command", "run_process", "exec_command"]) {
  const processTool = catalog.find((tool) => tool.name === processToolName);
  const timeout = processTool?.inputSchema?.properties?.timeout_seconds;
  assert(timeout?.maximum === 60 && timeout?.default === 60,
    `${processToolName} widened the owner-local foreground schema instead of leaving durability to the remote Worker projection`);
  assert(processTool?.inputSchema?.properties?.idempotency_key?.type === "string",
    `${processToolName} omitted the explicit durable acceptance idempotency key`);
}

const result = toolResult({ ok: true, nested: { value: 1 } });
assert(result.isError === false, "successful tool result was marked as an error");
assert(result.structuredContent?.nested?.value === 1, "structuredContent was not preserved");
assert(JSON.parse(result.content[0].text).nested.value === 1, "text and structured tool content diverged");
for (const value of [[1, 2], "text", 7, false, null]) {
  const projected = toolResult(value);
  assert(Object.hasOwn(projected, "structuredContent"), `structuredContent presence was lost for ${JSON.stringify(value)}`);
  assert(JSON.stringify(projected.structuredContent) === JSON.stringify(value), `structuredContent value was lost for ${JSON.stringify(value)}`);
}
for (const value of [["array"], "text", 0, false, null]) {
  const projected = toolResult({ $mcp: { content: [{ type: "text", text: "ok" }], structuredContent: value } });
  assert(Object.hasOwn(projected, "structuredContent"), `special structuredContent presence was lost for ${JSON.stringify(value)}`);
  assert(JSON.stringify(projected.structuredContent) === JSON.stringify(value), `special structuredContent value was lost for ${JSON.stringify(value)}`);
}

assert(workerSource.includes('./tool-catalog'), "Worker entrypoint does not use the catalog boundary");
assert(workerCatalogSource.includes('../shared/tool-catalog.json'), "Worker catalog boundary does not import the shared tool catalog");
assert(!workerCatalogSource.includes('const workspaceTools = ['), "Worker contains a second hand-maintained tool catalog");


{
  const fixture = await mkdtemp(join(tmpdir(), "mbm-schema-history-"));
  const environment = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete environment[key];
  const hooks = join(fixture, "hooks");
  const git = (argv) => execFileSync("git", [
    "-c", "core.hooksPath=" + hooks, "-c", "commit.gpgSign=false",
    "-c", "user.name=Catalog Test", "-c", "user.email=catalog-test@example.invalid", ...argv,
  ], { cwd: fixture, env: environment, stdio: "pipe" });
  const oldCatalog = [{ name: "read_file" }];
  const newCatalog = [...oldCatalog, { name: "write_file" }];
  const oldMetadata = { toolSchemaGeneration: 1, toolCatalogSha256: toolCatalogDigest(oldCatalog) };
  const unchangedGeneration = { toolSchemaGeneration: 1, toolCatalogSha256: toolCatalogDigest(newCatalog) };
  const advanced = { ...unchangedGeneration, toolSchemaGeneration: 2 };
  const baseline = [{ ref: "baseline", metadata: oldMetadata, catalog: oldCatalog }];
  assertToolSchemaContract(oldMetadata, oldCatalog, baseline);
  assertToolSchemaContract(advanced, newCatalog, baseline);
  strictAssert.throws(() => assertToolSchemaContract(unchangedGeneration, newCatalog, baseline), /strictly newer/);
  strictAssert.throws(() => assertToolSchemaContract(oldMetadata, oldCatalog, [{ ref: "newer", metadata: advanced, catalog: oldCatalog }]), /must not decrease/);
  strictAssert.throws(() => assertToolSchemaContract({ ...advanced, toolCatalogSha256: "invalid" }, newCatalog, baseline), /fingerprint/);
  strictAssert.throws(() => assertToolSchemaContract(advanced, newCatalog, []), /baseline is required/);
  try {
    await mkdir(join(fixture, "src", "shared"), { recursive: true });
    await mkdir(hooks);
    const storeContract = async (value, tools) => {
      await writeFile(join(fixture, "src", "shared", "server-metadata.json"), JSON.stringify(value));
      await writeFile(join(fixture, "src", "shared", "tool-catalog.json"), JSON.stringify(tools));
    };
    git(["init", "-q"]);
    await storeContract(oldMetadata, oldCatalog);
    git(["add", "."]); git(["commit", "-qm", "baseline"]); git(["tag", "v3.0.0-beta.206"]);
    await storeContract(unchangedGeneration, newCatalog);
    git(["add", "."]); git(["commit", "-qm", "committed catalog change"]); git(["tag", "v3.0.0-beta.207"]);
    const baselines = readToolSchemaBaselines(fixture, "3.0.0-beta.207");
    assert(baselines.some((value) => value.ref === "v3.0.0-beta.206"), "candidate tag obscured the previous release");
    strictAssert.throws(() => assertToolSchemaContract(unchangedGeneration, newCatalog, baselines), /strictly newer/,
      "a committed catalog change reused the released generation");
    await storeContract(advanced, newCatalog);
    assertToolSchemaContract(advanced, newCatalog, readToolSchemaBaselines(fixture, "3.0.0-beta.207"));
    git(["tag", "-d", "v3.0.0-beta.206"]);
    strictAssert.throws(() => readToolSchemaBaselines(fixture, "3.0.0-beta.207"), /complete release tags/);
  } finally { await rm(fixture, { recursive: true, force: true }); }
}

console.log("shared tool catalog test ok");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
