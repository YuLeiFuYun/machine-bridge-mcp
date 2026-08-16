export const REMOTE_FOREGROUND_TIMEOUT_SECONDS: number;
export const REMOTE_PROCESS_FOREGROUND_TIMEOUT_SECONDS: number;
export function isConfigurableForegroundTool(name: string): boolean;
export function remoteForegroundDefaultSeconds(name: string): number;
export function remoteForegroundMaximumSeconds(name: string): number;
export function effectiveForegroundTimeoutSeconds(input: Readonly<{
  tool: string;
  value: unknown;
  remote: boolean;
  localDefault: number;
  localMaximum: number;
}>): number;
