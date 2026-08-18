export const REMOTE_FOREGROUND_TIMEOUT_SECONDS: number;
export const REMOTE_DURABLE_PROCESS_DEFAULT_TIMEOUT_SECONDS: number;
export const REMOTE_DURABLE_PROCESS_MAXIMUM_TIMEOUT_SECONDS: number;
export function isConfigurableForegroundTool(name: string): boolean;
export function isRemoteDurableProcessTool(name: string): boolean;
export function remoteDurableProcessTimeoutSeconds(value: unknown): number;
export function remoteForegroundDefaultSeconds(name: string): number;
export function remoteForegroundMaximumSeconds(name: string): number;
export function effectiveForegroundTimeoutSeconds(input: Readonly<{
  tool: string;
  value: unknown;
  remote: boolean;
  localDefault: number;
  localMaximum: number;
}>): number;
