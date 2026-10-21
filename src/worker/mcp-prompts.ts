import { instructionPromptText, diffPromptText, skillPromptText } from "../shared/prompt-projection.mjs";
import type { AuthorizedToken } from "./access.ts";
import { publicWorkerToolError } from "./errors.ts";
import { completeResult } from "../shared/mcp-protocol.mjs";
import { rpcError, rpcResult, type JsonRpcRequest } from "./mcp-jsonrpc.ts";

export type PromptToolInvoker = (input: {
  name: string;
  args: Record<string, unknown>;
  base: string;
  authorized: AuthorizedToken;
  signal: AbortSignal;
  requestKey?: string;
}) => Promise<unknown>;

const asObj = (val: unknown): Record<string, unknown> =>
  (val && typeof val === "object" && !Array.isArray(val)) ? val as Record<string, unknown> : {};

export async function dispatchWorkerPromptOperation(
  request: JsonRpcRequest,
  invoker: PromptToolInvoker,
  base: string,
  authorized: AuthorizedToken,
  signal: AbortSignal,
  requestKey?: string,
  serverInfo?: Record<string, unknown>,
): Promise<{ status: number; message: Record<string, unknown> } | null> {
  const method = request.method;
  if (method !== "prompts/list" && method !== "prompts/get") return null;
  const params = asObj(request.params);

  try {
    if (method === "prompts/list") {
      const prompts = [
        {
          name: "agent_instructions",
          description: "Project-specific developer instructions and operating constraints",
          arguments: [],
        },
        {
          name: "code_review",
          description: "Review current staged or unstaged git changes",
          arguments: [
            { name: "staged", description: "Whether to review staged changes only", required: false },
          ],
        },
        {
          name: "run_skill",
          description: "Load instructions for a discovered local agent skill; loading does not execute its files",
          arguments: [
            { name: "skill", description: "Name of the skill to load", required: true },
          ],
        },
      ];
      return { status: 200, message: rpcResult(request.id, completeResult({ prompts }, serverInfo))! };
    }
    if (method === "prompts/get") {
      const name = String(params.name || "");
      if (!name) return { status: 200, message: rpcError(request.id, -32602, "prompts/get requires a prompt name") };
      const args = asObj(params.arguments);

      if (name === "agent_instructions") {
        if (Object.keys(args).length) return { status: 200, message: rpcError(request.id, -32602, "agent_instructions does not accept arguments") };
        const raw = await invoker({ name: "agent_context", args: {}, base, authorized, signal, requestKey });
        const obj = asObj(raw);
        const text = instructionPromptText(obj);
        return {
          status: 200,
          message: rpcResult(request.id, completeResult({
            description: "Project developer instructions",
            messages: [{ role: "user", content: { type: "text", text } }],
          }, serverInfo))!,
        };
      }
      if (name === "code_review") {
        if (Object.keys(args).some((key) => key !== "staged") || (args.staged !== undefined && typeof args.staged !== "boolean")) {
          return { status: 200, message: rpcError(request.id, -32602, "code_review accepts only an optional boolean staged argument") };
        }
        const staged = args.staged === true;
        const raw = await invoker({ name: "git_diff", args: { staged }, base, authorized, signal, requestKey });
        const obj = asObj(raw);
        const diffText = diffPromptText(obj);
        return {
          status: 200,
          message: rpcResult(request.id, completeResult({
            description: `Code review prompt for ${staged ? "staged" : "unstaged"} changes`,
            messages: [{
              role: "user",
              content: {
                type: "text",
                text: `Please review the following git diff for correctness, security, and architecture:\n\n\`\`\`diff\n${diffText}\n\`\`\``,
              },
            }],
          }, serverInfo))!,
        };
      }
      if (name === "run_skill") {
        const skillName = typeof args.skill === "string" ? args.skill.trim() : "";
        if (!skillName || Object.keys(args).some((key) => key !== "skill")) {
          return { status: 200, message: rpcError(request.id, -32602, "run_skill requires only a non-empty skill argument") };
        }
        const raw = await invoker({ name: "load_local_skill", args: { skill: skillName }, base, authorized, signal, requestKey });
        const obj = asObj(raw);
        const text = skillPromptText(obj);
        return {
          status: 200,
          message: rpcResult(request.id, completeResult({
            description: `Skill: ${skillName}`,
            messages: [{ role: "user", content: { type: "text", text } }],
          }, serverInfo))!,
        };
      }
      return { status: 200, message: rpcError(request.id, -32602, `Unknown prompt: ${name}`) };
    }
  } catch (error) {
    return { status: 200, message: rpcError(request.id, -32603, "Prompt operation failed", publicWorkerToolError(error)) };
  }
  return null;
}
