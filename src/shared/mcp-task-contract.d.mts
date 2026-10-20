export const MCP_TASK_EXTENSION_ID: "io.modelcontextprotocol/tasks";
export const MCP_TASK_TTL_MS: number;
export const MCP_TASK_POLL_INTERVAL_MS: number;
export const MCP_TASK_JOB_ID_PATTERN: "^job_[A-Za-z0-9_-]{24,}$";
export function isMcpTaskJobId(value: unknown): value is string;
export function supportsMcpTasks(clientCapabilities: unknown): boolean;
export function isMcpTaskAugmentedTool(name: string): boolean;
export function taskClientCapabilities(request: unknown): Record<string, unknown>;
