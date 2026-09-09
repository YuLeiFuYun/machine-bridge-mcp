type ToolDefinition = { name: string; description?: unknown };
type ToolSchema = { properties: Record<string, Record<string, unknown>> };
type HostedResultContract = {
  maximumHostedReadFileResultBytes: number;
  maximumHostedProcessReadBytes: number;
};

const DURABLE_PROCESS_HELPERS = new Set(["exec_command", "run_process", "run_local_command"]);

export function applyHostedResultBudgetContract(definition: ToolDefinition, schema: ToolSchema, contract: HostedResultContract) {
  if (definition.name === "read_file") {
    boundBytes(schema.properties.max_bytes, contract.maximumHostedReadFileResultBytes);
    definition.description = `${String(definition.description)} Hosted calls cap the complete serialized read_file result at ${contract.maximumHostedReadFileResultBytes} bytes. Omit end_line to permit automatic whole-line pagination; a paged result returns complete=false and next_start_line. An explicit range or individual line that cannot fit returns limit_exceeded. Local/stdio read capacity is unchanged.`;
  }
  if (definition.name === "read_process") {
    boundBytes(schema.properties.max_bytes, contract.maximumHostedProcessReadBytes);
    definition.description = `${String(definition.description)} Hosted max_bytes defaults to and is capped at ${contract.maximumHostedProcessReadBytes} bytes per read; local/stdio read capacity is unchanged.`;
  }
  if (DURABLE_PROCESS_HELPERS.has(definition.name)) {
    definition.description = `${String(definition.description)} If complete large stdout/stderr is required, redirect it to a file and consume it through bounded read_file pages rather than returning one large terminal payload.`;
  }
}

function boundBytes(property: Record<string, unknown> | undefined, maximum: number) {
  if (!property) return;
  property.maximum = maximum;
  property.default = maximum;
}
