type ToolDefinition = Record<string, unknown> & { name: string; description: string };
type JsonSchema = Record<string, unknown> & {
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  allOf?: Record<string, unknown>[];
};

const EXPLICIT_TAB_TOOLS = new Set([
  "browser_get_source",
  "browser_inspect_page",
  "browser_wait",
  "browser_action",
  "browser_fill_form",
  "browser_screenshot",
  "browser_upload_files",
]);

export function applyHostedBrowserTargetContract(definition: ToolDefinition, schema: JsonSchema): void {
  if (EXPLICIT_TAB_TOOLS.has(definition.name)) {
    schema.required = [...new Set([...(schema.required ?? []), "tab_id"])];
    definition.description = `${definition.description} Hosted calls require an explicit tab_id obtained from browser_list_tabs; they never fall back to whichever tab happens to be active, so concurrent hosted conversations cannot retarget this operation merely by changing browser focus.`;
    return;
  }
  if (definition.name === "computer_observe") {
    schema.allOf = [...(schema.allOf ?? []), {
      if: { properties: { surface: { const: "browser" } }, required: ["surface"] },
      then: { required: ["tab_id"] },
    }];
    definition.description = `${definition.description} Hosted browser observations require an explicit tab_id; the returned snapshot then binds later computer_act operations to that observed browser target.`;
  }
}
