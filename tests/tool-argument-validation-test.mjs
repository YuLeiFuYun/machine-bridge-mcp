import catalog from "../src/shared/tool-catalog.json" with { type: "json" };
import {
  JSON_SCHEMA_2020_12,
  ToolArgumentValidationError,
  ToolSchemaContractError,
  compileToolArgumentValidators,
} from "../src/shared/tool-argument-validation.mjs";

const validators = compileToolArgumentValidators(catalog);
assert(validators.names.length === catalog.length, "not every tool schema was compiled");
assert(validators.validate("list_dir", { path: "." }).valid, "valid list_dir arguments were rejected");
assertIssue(validators.validate("list_dir", { path: ".", unexpected: true }), "/unexpected", "additionalProperties");
assertIssue(validators.validate("read_file", { path: "x", start_line: 0 }), "/start_line", "minimum");
assertIssue(validators.validate("list_files", { max_files: "10" }), "/max_files", "type");
assertIssue(validators.validate("write_file", { path: "x", content: "y", expected_sha256: "secret-value" }), "/expected_sha256", "pattern");
const sensitive = validators.validate("write_file", { path: "x", content: "private-content", unexpected: "secret-value" });
assert(!JSON.stringify(sensitive).includes("private-content") && !JSON.stringify(sensitive).includes("secret-value"),
  "validation issues exposed argument values");

const largeUnboundedContent = "x".repeat(8 * 1024 * 1024);
assert(validators.validate("write_file", { path: "x", content: largeUnboundedContent }).valid,
  "large schema-unbounded content was rejected or could not be validated within bounded memory");

const budgeted = compileToolArgumentValidators([{
  name: "budgeted",
  inputSchema: {
    type: "object", additionalProperties: false,
    properties: { values: { type: "array", items: { type: "string" } } },
  },
}], { maximumValidationSteps: 3 });
assertIssue(budgeted.validate("budgeted", { values: ["a", "b", "c", "d"] }), "", "validationBudget");
const objectBudgeted = compileToolArgumentValidators([{
  name: "object_budgeted",
  inputSchema: { type: "object" },
}], { maximumValidationSteps: 4 });
assertIssue(objectBudgeted.validate("object_budgeted", { a: 1, b: 2, c: 3, d: 4 }), "", "validationBudget");

let validationError;
try { validators.assert("list_dir", { path: ".", unexpected: true }); }
catch (error) { validationError = error; }
assert(validationError instanceof ToolArgumentValidationError && validationError.code === "invalid_request"
  && validationError.details.validation_issues[0].instancePath === "/unexpected",
"assert did not return a typed, bounded validation error");

const advanced = compileToolArgumentValidators([{
  name: "advanced",
  inputSchema: {
    $schema: JSON_SCHEMA_2020_12,
    type: "object",
    additionalProperties: false,
    properties: {
      mode: { enum: ["read", "write"] },
      count: { type: "integer", minimum: 1, maximum: 4 },
      labels: { type: "array", minItems: 1, maxItems: 2, items: { type: "string", minLength: 1, maxLength: 2 } },
      choice: { oneOf: [{ type: "string", pattern: "^x" }, { type: "integer" }] },
    },
    required: ["mode", "choice"],
    if: { properties: { mode: { const: "write" } }, required: ["mode"] },
    then: { required: ["count"] },
  },
}]);
assert(advanced.validate("advanced", { mode: "read", choice: "x1" }).valid, "composition-valid input was rejected");
assertIssue(advanced.validate("advanced", { mode: "write", choice: 2 }), "", "required");
assertIssue(advanced.validate("advanced", { mode: "read", choice: false }), "/choice", "oneOf");
assertIssue(advanced.validate("advanced", { mode: "read", choice: "x", labels: ["ok", "太长了"] }), "/labels/1", "maxLength");
assertIssue(advanced.validate("advanced", { mode: "read", choice: "x", labels: [] }), "/labels", "minItems");
assertIssue(advanced.validate("advanced", { mode: "read", choice: "x", labels: ["a", "b", "c"] }), "/labels", "maxItems");
assertIssue(advanced.validate("advanced", { mode: "read", choice: "x", count: 0 }), "/count", "minimum");
assertIssue(advanced.validate("advanced", { mode: "read", choice: "x", count: 5 }), "/count", "maximum");

const exhaustive = compileToolArgumentValidators([{
  name: "exhaustive",
  inputSchema: {
    type: "object", minProperties: 2, maxProperties: 4, required: ["name", "number"],
    properties: {
      name: { type: "string", minLength: 2, maxLength: 3, pattern: "^a" },
      number: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 10, multipleOf: 0.5 },
      value: {
        allOf: [{ type: "number" }, { minimum: 0 }],
        anyOf: [{ const: 2 }, { const: 4 }],
        oneOf: [{ multipleOf: 2 }, { multipleOf: 3 }],
        not: { const: 6 },
        if: { minimum: 3 }, then: { maximum: 4 }, else: { maximum: 2 },
      },
      flag: true,
      forbidden: false,
      exact: { const: { nested: [1, 2] } },
      variant: { type: ["null", "boolean"] },
    },
    additionalProperties: { type: "boolean" },
  },
}]);
assert(exhaustive.has("exhaustive") && !exhaustive.has("missing"), "validator name lookup drifted");
assert(exhaustive.validate("exhaustive", { name: "ab", number: 1.5, value: 2 }).valid, "exhaustive valid input was rejected");
assertIssue(exhaustive.validate("exhaustive", { name: "a", number: 1 }), "/name", "minLength");
assertIssue(exhaustive.validate("exhaustive", { name: "abcd", number: 1 }), "/name", "maxLength");
assertIssue(exhaustive.validate("exhaustive", { name: "zz", number: 1 }), "/name", "pattern");
assertIssue(exhaustive.validate("exhaustive", { name: "ab", number: 0 }), "/number", "exclusiveMinimum");
assertIssue(exhaustive.validate("exhaustive", { name: "ab", number: 10 }), "/number", "exclusiveMaximum");
assertIssue(exhaustive.validate("exhaustive", { name: "ab", number: 1.2 }), "/number", "multipleOf");
assertIssue(exhaustive.validate("exhaustive", { name: "ab", number: 1, value: -1 }), "/value", "minimum");
assertIssue(exhaustive.validate("exhaustive", { name: "ab", number: 1, value: 5 }), "/value", "anyOf");
assertIssue(exhaustive.validate("exhaustive", { name: "ab", number: 1, value: 6 }), "/value", "oneOf");
assertIssue(exhaustive.validate("exhaustive", { name: "ab", number: 1, value: 6 }), "/value", "not");
assertIssue(exhaustive.validate("exhaustive", { name: "ab", number: 1, value: 8 }), "/value", "maximum");
assertIssue(exhaustive.validate("exhaustive", { name: "ab", number: 1, forbidden: "x" }), "/forbidden", "falseSchema");
assertIssue(exhaustive.validate("exhaustive", { name: "ab", number: 1, exact: { nested: [1, 3] } }), "/exact", "const");
assertIssue(exhaustive.validate("exhaustive", { name: "ab", number: 1, custom: "no" }), "/custom", "type");
assertIssue(exhaustive.validate("exhaustive", { name: "ab" }), "", "required");
assertIssue(exhaustive.validate("exhaustive", { name: "ab", number: 1, flag: true, variant: null, custom: true }), "", "maxProperties");
assertIssue(exhaustive.validate("exhaustive", { name: "ab", number: Number.POSITIVE_INFINITY }), "/number", "type");

expectSchemaFailure({ type: "object", $schema: "http://json-schema.org/draft-07/schema#" }, "unsupported JSON Schema dialect");
expectSchemaFailure({ type: "object", $ref: "https://example.com/schema.json" }, "unsupported JSON Schema keyword: $ref");
expectSchemaFailure({ type: "object", pattern: "[" }, "valid ECMAScript regular expression");
expectSchemaFailure({ type: "object", mysteryKeyword: true }, "unsupported JSON Schema keyword");
expectSchemaFailure({ type: "object", required: ["x", "x"] }, "required contains duplicates");
expectSchemaFailure({ type: "object", enum: [1, 1] }, "enum contains duplicate values");
expectSchemaFailure({ type: "object", multipleOf: 0 }, "multipleOf must be greater than zero");
expectSchemaFailure({ type: [] }, "type is invalid");
expectSchemaFailure({ type: ["object", "object"] }, "type contains duplicates");
expectSchemaFailure({ type: "object", minItems: -1 }, "must be a non-negative integer");
expectSchemaFailure({ type: "object", minimum: Number.POSITIVE_INFINITY }, "must be a finite number");
expectSchemaFailure({ type: "object", anyOf: [] }, "must be a non-empty array");
expectSchemaFailure({ type: "object", properties: { nested: { type: "object", properties: { leaf: { type: "string" } } } } }, "maximum schema depth", { maximumDepth: 1 });
expectSchemaFailure({ type: "object", properties: { a: { type: "string" }, b: { type: "string" } } }, "maximum schema node count", { maximumNodes: 2 });

console.log("tool argument validation test ok");

function expectSchemaFailure(inputSchema, message, options) {
  let error;
  try { compileToolArgumentValidators([{ name: "invalid", inputSchema }], options); }
  catch (caught) { error = caught; }
  assert(error instanceof ToolSchemaContractError && error.message.includes(message), `expected schema failure containing: ${message}`);
}

function assertIssue(result, instancePath, keyword) {
  assert(result.known && !result.valid, `expected invalid result for ${instancePath} ${keyword}`);
  assert(result.issues.some((issue) => issue.instancePath === instancePath && issue.keyword === keyword),
    `missing validation issue ${instancePath} ${keyword}: ${JSON.stringify(result.issues)}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
