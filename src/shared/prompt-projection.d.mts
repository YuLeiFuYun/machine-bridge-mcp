export function instructionPromptText(value: unknown): string;
export function diffPromptText(value: unknown): string;
export function skillPromptText(value: unknown): string;
export const MCP_PROMPTS: ReadonlyArray<{
  readonly name: string;
  readonly description: string;
  readonly arguments: ReadonlyArray<{ readonly name: string; readonly description: string; readonly required: boolean }>;
}>;
export function resolveSharedPromptOperation(
  method: string,
  rawParams: unknown,
  invokeTool: (name: string, args: Record<string, unknown>) => Promise<unknown>,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; code: number; message: string }>;
