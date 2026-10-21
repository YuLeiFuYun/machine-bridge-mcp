import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actionableGuidance, BridgeError } from "../src/local/errors.mjs";
import { normalizeToolResult } from "../src/local/tool-result-boundary.mjs";
import { atomicWriteText } from "../src/local/workspace-file-transaction.mjs";
import { BoundedOutput } from "../src/local/bounded-output.mjs";
import { toolDefinition, toolsForPolicy } from "../src/local/policy.mjs";
import { validateToolArguments } from "../src/local/tool-executor.mjs";
import { projectMcpResult } from "../src/shared/result-projection.mjs";
import { MCP_PROTOCOL_VERSION, McpProtocolError, validateRequestMetadata } from "../src/shared/mcp-protocol.mjs";
import { dispatchWorkerPromptOperation } from "../src/worker/mcp-prompts.ts";

const results = [];
function verify(name, run) {
  return Promise.resolve().then(run).then(() => {
    results.push({ name, passed: true });
    console.log("PASS " + name);
  }).catch((error) => {
    results.push({ name, passed: false });
    throw new Error("Production contract check failed: " + name, { cause: error });
  });
}

await verify("catalog exposes the real load_local_skill schema", () => {
  const definition = toolDefinition("load_local_skill");
  assert.equal(definition.name, "load_local_skill");
  assert.deepEqual(definition.inputSchema.required, ["skill"]);
  assert.equal(Object.hasOwn(definition.inputSchema.properties, "skill_name"), false);
  assert.equal(validateToolArguments("load_local_skill", { skill: "example" }).valid, true);
  assert.equal(validateToolArguments("load_local_skill", { skill_name: "example" }).valid, false);
  assert(Array.isArray(toolsForPolicy({ profile: "safe", allowWrite: false, execMode: "off" })));
});

await verify("prompt dispatch calls the real tool contract", async () => {
  const calls = [];
  const invoker = async (input) => {
    calls.push(input);
    if (input.name === "load_local_skill") return { content: "Skill instructions" };
    throw new Error("unexpected tool " + input.name);
  };
  const request = {
    jsonrpc: "2.0", id: 1, method: "prompts/get",
    params: { name: "run_skill", arguments: { skill: "example" } },
  };
  const outcome = await dispatchWorkerPromptOperation(
    request, invoker, "http://localhost",
    { accountId: "account", accountVersion: 1, clientId: "client", familyId: "family", role: "owner" },
    new AbortController().signal,
  );
  assert.equal(outcome.message.result.resultType, "complete");
  assert.match(outcome.message.result.messages[0].content.text, /Skill instructions/);
  assert.deepEqual(calls[0].args, { skill: "example" });
});

await verify("prompt schema errors do not dispatch side effects", async () => {
  let calls = 0;
  const invoker = async () => { calls += 1; return {}; };
  const outcome = await dispatchWorkerPromptOperation({
    jsonrpc: "2.0", id: 2, method: "prompts/get",
    params: { name: "run_skill", arguments: { skill_name: "example" } },
  }, invoker, "http://localhost",
  { accountId: "account", accountVersion: 1, clientId: "client", familyId: "family", role: "owner" },
  new AbortController().signal);
  assert.equal(outcome.message.error.code, -32602);
  assert.equal(calls, 0);
});

await verify("protocol metadata validates supported request-scoped version", () => {
  const value = {
    jsonrpc: "2.0", id: 3, method: "tools/list",
    params: { _meta: {
      "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
      "io.modelcontextprotocol/clientCapabilities": {},
    } },
  };
  assert.equal(validateRequestMetadata(value).version, MCP_PROTOCOL_VERSION);
  assert.throws(() => validateRequestMetadata({
    ...value,
    params: { _meta: {
      "io.modelcontextprotocol/protocolVersion": "unsupported",
      "io.modelcontextprotocol/clientCapabilities": {},
    } },
  }), (error) => error instanceof McpProtocolError && error.code === -32022);
});

await verify("public conflict guidance comes from production error handling", () => {
  const guidance = actionableGuidance(new BridgeError("conflict", "file changed"));
  assert.equal(typeof guidance, "string");
  assert(guidance.length > 0);
  const reasonGuidance = actionableGuidance(new BridgeError("conflict", "mismatch", { details: { reason: "text_not_found" } }));
  assert(reasonGuidance.includes("read_file"), "reason-specific actionable guidance omitted");
});

await verify("tool result boundary enforces a real byte limit", () => {
  assert.throws(
    () => normalizeToolResult({ payload: "x".repeat(256) }, { maximumBytes: 32 }),
    (error) => error instanceof BridgeError && error.code === "limit_exceeded",
  );
});

await verify("structured result projection removes its private marker", () => {
  const projection = projectMcpResult({ $mcpText: "short summary", detail: { count: 2 } });
  assert.equal(projection.text, "short summary");
  assert.deepEqual(projection.structuredContent, { detail: { count: 2 } });
});

await verify("bounded output keeps storage and producer buffers independent", () => {
  const output = new BoundedOutput(24, { headBytes: 8 });
  const producer = Buffer.from("abcdefghijklmnopqrstuvwxyz0123456789");
  output.append(producer);
  const snapshot = output.text();
  producer.fill(0x5a);
  assert.equal(output.fullBuffer.length, 24);
  assert.match(snapshot, /^abcdefgh/);
  assert.match(snapshot, /truncated/);
  assert.match(snapshot, /0123456789$/);
  assert.equal(output.truncated, true);
});

await verify("atomic text mutation commits through the production transaction", async () => {
  const root = await mkdtemp(join(tmpdir(), "mbm-agent-eval-"));
  try {
    const target = join(root, "result.txt");
    const settlement = await atomicWriteText(target, "committed value");
    assert.deepEqual(settlement.warnings, []);
    assert.equal(await readFile(target, "utf8"), "committed value");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const failed = results.filter((result) => !result.passed);
assert.equal(failed.length, 0);
console.log("Production-backed offline contract checks passed (" + results.length + "/" + results.length + ").");
