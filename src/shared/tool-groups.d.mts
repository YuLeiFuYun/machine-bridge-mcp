export const CORE_CORNERSTONE_TOOL_NAMES: ReadonlySet<string>;
export const PROGRESSIVE_TOOL_GROUPS: Readonly<{
  browser: readonly string[];
  app: readonly string[];
  jobs: readonly string[];
  git: readonly string[];
  process: readonly string[];
  diagnostics: readonly string[];
  skills: readonly string[];
  files: readonly string[];
}>;
export function findToolGroup(toolName: unknown): string | null;
export function projectToolTypeScriptDeclarations(
  tools: ReadonlyArray<{ name?: string; description?: string; inputSchema?: Record<string, unknown> }>,
  options?: { toolNames?: Iterable<string>; namespace?: string },
): string;
