export const JSON_SCHEMA_2020_12: "https://json-schema.org/draft/2020-12/schema";
export type ToolValidationIssue = Readonly<{ instancePath: string; keyword: string; message: string }>;
export class ToolSchemaContractError extends Error {}
export class ToolArgumentValidationError extends Error {
  code: "invalid_request";
  retryable: false;
  details: Readonly<{ tool: string; validation_issues: readonly ToolValidationIssue[] }>;
}
export function compileToolArgumentValidators(
  tools: readonly Array<{ name: string; inputSchema?: unknown }>,
  options?: { maximumDepth?: number; maximumNodes?: number; maximumIssues?: number; maximumPatternLength?: number; maximumValidationSteps?: number },
): Readonly<{
  names: readonly string[];
  has(tool: unknown): boolean;
  validate(tool: unknown, value: unknown): Readonly<{ known: boolean; valid: boolean; issues: readonly ToolValidationIssue[] }>;
  assert<T>(tool: unknown, value: T): T;
}>;
