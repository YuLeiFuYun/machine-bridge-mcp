import assert from "node:assert/strict";
import { dispatchWorkerPromptOperation } from "../src/worker/mcp-prompts.ts";
import { McpController } from "../src/worker/mcp-controller.ts";

const dummyToken = {
  accountId: "acc-1",
  accountVersion: 1,
  clientId: "client-1",
  role: "admin",
  familyId: "fam-1",
};

const calls = [];
const mockInvoker = async ({ name, args }) => {
  calls.push({ name, args });
  if (name === "agent_context") {
    return { instructions: "Follow strict coding guidelines." };
  }
  if (name === "git_diff") {
    return { diff: "+ new code\n- old code" };
  }
  if (name === "load_local_skill") {
    assert.equal(args.skill, "test_skill");
    return { content: "# My Skill\nRun tests carefully." };
  }
  throw new Error(`unexpected tool: ${name}`);
};

// 1. prompts/list
{
  const req = { jsonrpc: "2.0", id: "p-1", method: "prompts/list", params: {} };
  const outcome = await dispatchWorkerPromptOperation(req, mockInvoker, "http://localhost", dummyToken, new AbortController().signal);
  assert.equal(outcome.status, 200);
  assert(Array.isArray(outcome.message.result?.prompts));
  assert.equal(outcome.message.result.prompts.length, 3);
  assert(outcome.message.result.prompts.some((p) => p.name === "agent_instructions"));
  assert(outcome.message.result.prompts.some((p) => p.name === "code_review"));
  assert(outcome.message.result.prompts.some((p) => p.name === "run_skill"));
}

// 2. prompts/get for agent_instructions
{
  const req = { jsonrpc: "2.0", id: "p-2", method: "prompts/get", params: { name: "agent_instructions" } };
  const outcome = await dispatchWorkerPromptOperation(req, mockInvoker, "http://localhost", dummyToken, new AbortController().signal);
  assert.equal(outcome.status, 200);
  assert.equal(outcome.message.result?.messages?.[0]?.content?.text, "Follow strict coding guidelines.");
}

// 3. prompts/get for code_review
{
  const req = { jsonrpc: "2.0", id: "p-3", method: "prompts/get", params: { name: "code_review", arguments: { staged: true } } };
  const outcome = await dispatchWorkerPromptOperation(req, mockInvoker, "http://localhost", dummyToken, new AbortController().signal);
  assert.equal(outcome.status, 200);
  assert(outcome.message.result?.messages?.[0]?.content?.text.includes("+ new code"));
}

// 4. prompts/get for run_skill
{
  const req = { jsonrpc: "2.0", id: "p-4", method: "prompts/get", params: { name: "run_skill", arguments: { skill: "test_skill" } } };
  const outcome = await dispatchWorkerPromptOperation(req, mockInvoker, "http://localhost", dummyToken, new AbortController().signal);
  assert.equal(outcome.status, 200);
  assert(outcome.message.result?.messages?.[0]?.content?.text.includes("# My Skill"));
}

// 5. prompts/get missing name
{
  const req = { jsonrpc: "2.0", id: "p-5", method: "prompts/get", params: {} };
  const outcome = await dispatchWorkerPromptOperation(req, mockInvoker, "http://localhost", dummyToken, new AbortController().signal);
  assert.equal(outcome.status, 200);
  assert.equal(outcome.message.error?.code, -32602);
}

// 6. prompts/get unknown prompt
{
  const req = { jsonrpc: "2.0", id: "p-6", method: "prompts/get", params: { name: "non_existent" } };
  const outcome = await dispatchWorkerPromptOperation(req, mockInvoker, "http://localhost", dummyToken, new AbortController().signal);
  assert.equal(outcome.status, 200);
  assert.equal(outcome.message.error?.code, -32602);
}

// 7. non-prompt method returns null
{
  const req = { jsonrpc: "2.0", id: "p-7", method: "tools/call", params: {} };
  const outcome = await dispatchWorkerPromptOperation(req, mockInvoker, "http://localhost", dummyToken, new AbortController().signal);
  assert.equal(outcome, null);
}

// 8. McpController dispatches prompts/list via handleRequest
{
  const controller = new McpController({
    capabilities: {},
    serverInfo: { name: "test", version: "1" },
    instructions: "test",
    supportedVersions: ["2026-07-28"],
    discoveryTtlMs: 1000,
    toolListTtlMs: 1000,
    tools: () => [],
    recordError: () => {},
    cancelClientRequest: async () => {},
    callTool: mockInvoker,
  });

  const request = new Request("http://localhost/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  const response = await controller.handleRequest({
    request,
    body: { jsonrpc: "2.0", id: "p-c1", method: "prompts/list", params: {} },
    base: "http://localhost",
    authorized: dummyToken,
    proxyMode: "buffered",
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.result?.prompts?.length, 3);
}

console.log("Worker prompts test ok");
