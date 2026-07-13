import { readFile } from "node:fs/promises";
import { allToolNames, MCP_INSTRUCTIONS, toolResult, toolsForPolicy } from "../src/local/tools.mjs";
import { runtimeToolHandlerNames } from "../src/local/runtime.mjs";

const catalog = JSON.parse(await readFile(new URL("../src/shared/tool-catalog.json", import.meta.url), "utf8"));
const metadata = JSON.parse(await readFile(new URL("../src/shared/server-metadata.json", import.meta.url), "utf8"));
assert(metadata.name === "machine-bridge-mcp", "shared server name is invalid");
assert(metadata.protocolVersion === "2025-11-25", "shared protocol version is invalid");
assert(Array.isArray(metadata.supportedProtocolVersions) && metadata.supportedProtocolVersions.includes(metadata.protocolVersion), "shared supported protocol versions are invalid");
assert(Array.isArray(metadata.instructions) && metadata.instructions.length >= 4, "shared server instructions are missing");
assert(MCP_INSTRUCTIONS === metadata.instructions.join("\n"), "runtime MCP instructions differ from shared metadata");
const workerSource = await readFile(new URL("../src/worker/index.ts", import.meta.url), "utf8");
assert(workerSource.includes('server-metadata.json'), "Worker does not import shared server metadata");
assert(!workerSource.includes("const MCP_INSTRUCTIONS = ["), "Worker retains a second hand-maintained instruction catalog");
assert(!workerSource.includes('const MCP_PROTOCOL_VERSION = "'), "Worker retains a second hand-maintained protocol version");

const names = catalog.map((tool) => tool.name);
const unique = new Set(names);
assert(names.length === unique.size, "tool catalog contains duplicate names");
assert(names[0] === "server_info", "server_info must remain the first catalog tool");
assert(JSON.stringify(names) === JSON.stringify(allToolNames()), "runtime tool inventory differs from catalog");
assert(JSON.stringify([...runtimeToolHandlerNames()].sort()) === JSON.stringify([...names].sort()), "local runtime handler inventory differs from catalog");

for (const tool of catalog) {
  assert(typeof tool.name === "string" && /^[a-z][a-z0-9_]*$/.test(tool.name), `invalid tool name: ${tool.name}`);
  assert(typeof tool.title === "string" && tool.title.length > 0, `${tool.name} is missing title`);
  assert(typeof tool.description === "string" && tool.description.length > 20, `${tool.name} has an insufficient description`);
  assert(["always", "write", "direct-exec", "shell-exec", "full"].includes(tool.availability), `${tool.name} has invalid availability`);
  assert(tool.inputSchema?.type === "object", `${tool.name} inputSchema must be an object`);
  assert(tool.inputSchema?.additionalProperties === false, `${tool.name} inputSchema must reject unknown fields`);
  for (const field of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
    assert(typeof tool.annotations?.[field] === "boolean", `${tool.name} annotation ${field} is missing`);
  }
}

const review = new Set(toolsForPolicy({ profile: "review", allowWrite: false, execMode: "off" }).map((tool) => tool.name));
const edit = new Set(toolsForPolicy({ profile: "edit", allowWrite: true, execMode: "off" }).map((tool) => tool.name));
const agent = new Set(toolsForPolicy({ profile: "agent", allowWrite: true, execMode: "direct" }).map((tool) => tool.name));
const full = new Set(toolsForPolicy({ profile: "full", origin: "explicit", revision: 3, allowWrite: true, execMode: "shell", unrestrictedPaths: true, minimalEnv: false, exposeAbsolutePaths: true }).map((tool) => tool.name));

assert(review.has("read_file") && !review.has("write_file") && !review.has("run_process"), "review profile inventory is invalid");
assert(edit.has("apply_patch") && !edit.has("run_process"), "edit profile inventory is invalid");
assert(agent.has("run_process") && !agent.has("exec_command") && !agent.has("generate_ssh_key_resource"), "agent profile inventory is invalid");
for (const fullOnly of ["list_local_applications", "operate_local_application", "browser_status", "browser_manage_tabs", "browser_wait", "browser_action", "browser_fill_form", "browser_upload_files"]) {
  assert(!review.has(fullOnly) && !edit.has(fullOnly) && !agent.has(fullOnly), `${fullOnly} escaped full-only policy`);
}
assert(full.has("run_process") && full.has("exec_command") && full.has("generate_ssh_key_resource"), "full profile inventory is invalid");
assert(full.has("browser_action") && full.has("browser_manage_tabs") && full.has("browser_wait") && full.has("operate_local_application"), "full profile omitted local automation tools");
assert(full.size === catalog.length, "full profile must expose the complete catalog");

const result = toolResult({ ok: true, nested: { value: 1 } });
assert(result.isError === false, "successful tool result was marked as an error");
assert(result.structuredContent?.nested?.value === 1, "structuredContent was not preserved");
assert(JSON.parse(result.content[0].text).nested.value === 1, "text and structured tool content diverged");

assert(workerSource.includes('../shared/tool-catalog.json'), "Worker does not import the shared tool catalog");
assert(!workerSource.includes('const workspaceTools = ['), "Worker contains a second hand-maintained tool catalog");

console.log("shared tool catalog test ok");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
