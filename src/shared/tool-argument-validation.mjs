export const JSON_SCHEMA_2020_12 = "https://json-schema.org/draft/2020-12/schema";

const SUPPORTED_TYPES = new Set(["null", "boolean", "object", "array", "number", "integer", "string"]);
const SUPPORTED_KEYWORDS = new Set([
  "$schema", "type", "enum", "const", "default", "title", "description",
  "properties", "required", "additionalProperties", "items",
  "minItems", "maxItems", "minLength", "maxLength", "pattern",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "minProperties", "maxProperties", "allOf", "anyOf", "oneOf", "not",
  "if", "then", "else", "x-mcp-header",
]);
const DEFAULT_LIMITS = Object.freeze({
  maximumDepth: 32, maximumNodes: 4096, maximumIssues: 16, maximumPatternLength: 2048, maximumValidationSteps: 65_536,
});

export class ToolSchemaContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "ToolSchemaContractError";
  }
}

export class ToolArgumentValidationError extends Error {
  constructor(tool, issues) {
    super(`tool arguments do not match the input schema: ${tool}`);
    this.name = "ToolArgumentValidationError";
    this.code = "invalid_request";
    this.retryable = false;
    this.details = Object.freeze({
      tool: String(tool),
      validation_issues: Object.freeze(issues.map((issue) => Object.freeze({ ...issue }))),
    });
  }
}

export function compileToolArgumentValidators(tools, options = {}) {
  if (!Array.isArray(tools)) throw new ToolSchemaContractError("tool catalog must be an array");
  const limits = normalizeLimits(options);
  const state = { nodes: 0, limits };
  const validators = new Map();
  for (const tool of tools) {
    if (!isRecord(tool) || typeof tool.name !== "string" || !tool.name) {
      throw new ToolSchemaContractError("tool catalog contains an invalid tool definition");
    }
    if (validators.has(tool.name)) throw new ToolSchemaContractError(`duplicate tool schema: ${tool.name}`);
    const schema = tool.inputSchema ?? { type: "object" };
    const compiled = compileSchema(schema, `tool ${tool.name}.inputSchema`, 0, state);
    if (!compiled.types?.includes("object")) {
      throw new ToolSchemaContractError(`tool ${tool.name} input schema must declare type object`);
    }
    validators.set(tool.name, compiled);
  }
  return Object.freeze({
    names: Object.freeze([...validators.keys()]),
    has(tool) { return validators.has(String(tool)); },
    validate(tool, value) {
      const name = String(tool || "");
      const schema = validators.get(name);
      if (!schema) return Object.freeze({ known: false, valid: false, issues: Object.freeze([]) });
      const issues = [];
      const budget = { remaining: limits.maximumValidationSteps };
      try { validateNode(schema, value, "", issues, limits.maximumIssues, budget); }
      catch (error) {
        if (error !== VALIDATION_BUDGET_EXCEEDED) throw error;
        pushIssue(issues, "", "validationBudget", "validation exceeded the bounded work budget", limits.maximumIssues);
      }
      return Object.freeze({ known: true, valid: issues.length === 0, issues: Object.freeze(issues) });
    },
    assert(tool, value) {
      const result = this.validate(tool, value);
      if (!result.known) throw new ToolSchemaContractError("unknown tool schema");
      if (!result.valid) throw new ToolArgumentValidationError(tool, result.issues);
      return value;
    },
  });
}

function compileSchema(schema, label, depth, state) {
  if (schema === true) return { boolean: true };
  if (schema === false) return { boolean: false };
  if (!isRecord(schema)) throw new ToolSchemaContractError(`${label} must be an object or boolean schema`);
  if (depth > state.limits.maximumDepth) throw new ToolSchemaContractError(`${label} exceeds maximum schema depth`);
  state.nodes += 1;
  if (state.nodes > state.limits.maximumNodes) throw new ToolSchemaContractError("tool catalog exceeds maximum schema node count");
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(key)) throw new ToolSchemaContractError(`${label} uses unsupported JSON Schema keyword: ${key}`);
  }
  validateDialect(schema.$schema, label);
  const types = compileTypes(schema.type, label);
  const node = { types };
  if (Object.hasOwn(schema, "const")) node.constValue = structuredClone(schema.const);
  if (Object.hasOwn(schema, "enum")) node.enumValues = compileEnum(schema.enum, label);
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== "string" || schema.pattern.length > state.limits.maximumPatternLength) {
      throw new ToolSchemaContractError(`${label}.pattern is invalid or too large`);
    }
    try { node.pattern = new RegExp(schema.pattern, "u"); }
    catch { throw new ToolSchemaContractError(`${label}.pattern is not a valid ECMAScript regular expression`); }
  }
  for (const key of ["minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties"]) {
    if (schema[key] !== undefined) node[key] = nonNegativeInteger(schema[key], `${label}.${key}`);
  }
  for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"]) {
    if (schema[key] !== undefined) node[key] = finiteNumber(schema[key], `${label}.${key}`);
  }
  if (schema.multipleOf !== undefined) {
    node.multipleOf = finiteNumber(schema.multipleOf, `${label}.multipleOf`);
    if (node.multipleOf <= 0) throw new ToolSchemaContractError(`${label}.multipleOf must be greater than zero`);
  }
  if (schema.properties !== undefined) {
    if (!isRecord(schema.properties)) throw new ToolSchemaContractError(`${label}.properties must be an object`);
    node.properties = new Map(Object.entries(schema.properties).map(([key, child]) => [
      key, compileSchema(child, `${label}.properties.${key}`, depth + 1, state),
    ]));
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || !schema.required.every((value) => typeof value === "string")) {
      throw new ToolSchemaContractError(`${label}.required must be an array of strings`);
    }
    if (new Set(schema.required).size !== schema.required.length) throw new ToolSchemaContractError(`${label}.required contains duplicates`);
    node.required = Object.freeze([...schema.required]);
  }
  if (schema.additionalProperties !== undefined) {
    node.additionalProperties = typeof schema.additionalProperties === "boolean"
      ? schema.additionalProperties
      : compileSchema(schema.additionalProperties, `${label}.additionalProperties`, depth + 1, state);
  }
  if (schema.items !== undefined) node.items = compileSchema(schema.items, `${label}.items`, depth + 1, state);
  for (const key of ["allOf", "anyOf", "oneOf"]) {
    if (schema[key] !== undefined) {
      if (!Array.isArray(schema[key]) || schema[key].length === 0) throw new ToolSchemaContractError(`${label}.${key} must be a non-empty array`);
      node[key] = schema[key].map((child, index) => compileSchema(child, `${label}.${key}[${index}]`, depth + 1, state));
    }
  }
  for (const key of ["not", "if", "then", "else"]) {
    if (schema[key] !== undefined) node[key] = compileSchema(schema[key], `${label}.${key}`, depth + 1, state);
  }
  return node;
}

const VALIDATION_BUDGET_EXCEEDED = Object.freeze({ code: "validation_budget_exceeded" });

function validateNode(node, value, instancePath, issues, maximumIssues, budget) {
  if (issues.length >= maximumIssues) return;
  if (budget.remaining <= 0) throw VALIDATION_BUDGET_EXCEEDED;
  budget.remaining -= 1;
  if (node.boolean === true) return;
  if (node.boolean === false) return pushIssue(issues, instancePath, "falseSchema", "value is rejected by the schema", maximumIssues);
  if (node.types && !node.types.some((type) => matchesType(type, value))) {
    pushIssue(issues, instancePath, "type", `must be ${node.types.join(" or ")}`, maximumIssues);
    return;
  }
  if (node.constValue !== undefined && !jsonEqual(value, node.constValue)) {
    pushIssue(issues, instancePath, "const", "must equal the declared constant", maximumIssues);
  }
  if (node.enumValues && !node.enumValues.some((candidate) => jsonEqual(value, candidate))) {
    pushIssue(issues, instancePath, "enum", "must equal one of the allowed values", maximumIssues);
  }
  if (typeof value === "string") validateString(node, value, instancePath, issues, maximumIssues);
  if (typeof value === "number") validateNumber(node, value, instancePath, issues, maximumIssues);
  if (Array.isArray(value)) validateArray(node, value, instancePath, issues, maximumIssues, budget);
  else if (isRecord(value)) validateObject(node, value, instancePath, issues, maximumIssues, budget);
  validateComposition(node, value, instancePath, issues, maximumIssues, budget);
}

function validateString(node, value, path, issues, maximumIssues) {
  if (node.minLength !== undefined || node.maxLength !== undefined) {
    const length = boundedCodePointLength(value, node.minLength, node.maxLength);
    if (node.minLength !== undefined && length < node.minLength) pushIssue(issues, path, "minLength", `must contain at least ${node.minLength} characters`, maximumIssues);
    if (node.maxLength !== undefined && length > node.maxLength) pushIssue(issues, path, "maxLength", `must contain at most ${node.maxLength} characters`, maximumIssues);
  }
  if (node.pattern && !node.pattern.test(value)) pushIssue(issues, path, "pattern", "must match the declared pattern", maximumIssues);
}

function boundedCodePointLength(value, minimum, maximum) {
  const stopAt = maximum !== undefined ? maximum + 1 : minimum;
  let length = 0;
  for (let offset = 0; offset < value.length && (stopAt === undefined || length < stopAt); length += 1) {
    const point = value.codePointAt(offset);
    offset += point > 0xFFFF ? 2 : 1;
  }
  return length;
}

function validateNumber(node, value, path, issues, maximumIssues) {
  if (!Number.isFinite(value)) return pushIssue(issues, path, "type", "must be a finite number", maximumIssues);
  if (node.minimum !== undefined && value < node.minimum) pushIssue(issues, path, "minimum", `must be at least ${node.minimum}`, maximumIssues);
  if (node.maximum !== undefined && value > node.maximum) pushIssue(issues, path, "maximum", `must be at most ${node.maximum}`, maximumIssues);
  if (node.exclusiveMinimum !== undefined && value <= node.exclusiveMinimum) pushIssue(issues, path, "exclusiveMinimum", `must be greater than ${node.exclusiveMinimum}`, maximumIssues);
  if (node.exclusiveMaximum !== undefined && value >= node.exclusiveMaximum) pushIssue(issues, path, "exclusiveMaximum", `must be less than ${node.exclusiveMaximum}`, maximumIssues);
  if (node.multipleOf !== undefined && !isMultipleOf(value, node.multipleOf)) pushIssue(issues, path, "multipleOf", `must be a multiple of ${node.multipleOf}`, maximumIssues);
}

function validateArray(node, value, path, issues, maximumIssues, budget) {
  if (node.minItems !== undefined && value.length < node.minItems) pushIssue(issues, path, "minItems", `must contain at least ${node.minItems} items`, maximumIssues);
  if (node.maxItems !== undefined && value.length > node.maxItems) pushIssue(issues, path, "maxItems", `must contain at most ${node.maxItems} items`, maximumIssues);
  if (node.items) value.forEach((item, index) => validateNode(node.items, item, `${path}/${index}`, issues, maximumIssues, budget));
}

function validateObject(node, value, path, issues, maximumIssues, budget) {
  for (const required of node.required ?? []) {
    if (!Object.hasOwn(value, required)) pushIssue(issues, path, "required", `missing required property ${required}`, maximumIssues);
  }
  let propertyCount = 0;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    if (budget.remaining <= 0) throw VALIDATION_BUDGET_EXCEEDED;
    budget.remaining -= 1;
    propertyCount += 1;
    const child = node.properties?.get(key);
    if (child) validateNode(child, value[key], `${path}/${escapePointer(key)}`, issues, maximumIssues, budget);
    else if (node.additionalProperties === false) pushIssue(issues, `${path}/${escapePointer(key)}`, "additionalProperties", "property is not allowed", maximumIssues);
    else if (node.additionalProperties && node.additionalProperties !== true) validateNode(node.additionalProperties, value[key], `${path}/${escapePointer(key)}`, issues, maximumIssues, budget);
  }
  if (node.minProperties !== undefined && propertyCount < node.minProperties) pushIssue(issues, path, "minProperties", `must contain at least ${node.minProperties} properties`, maximumIssues);
  if (node.maxProperties !== undefined && propertyCount > node.maxProperties) pushIssue(issues, path, "maxProperties", `must contain at most ${node.maxProperties} properties`, maximumIssues);
}

function validateComposition(node, value, path, issues, maximumIssues, budget) {
  if (node.allOf) for (const child of node.allOf) validateNode(child, value, path, issues, maximumIssues, budget);
  if (node.anyOf && !node.anyOf.some((child) => isValid(child, value, budget))) pushIssue(issues, path, "anyOf", "must match at least one schema", maximumIssues);
  if (node.oneOf) {
    const matches = node.oneOf.reduce((count, child) => count + Number(isValid(child, value, budget)), 0);
    if (matches !== 1) pushIssue(issues, path, "oneOf", "must match exactly one schema", maximumIssues);
  }
  if (node.not && isValid(node.not, value, budget)) pushIssue(issues, path, "not", "must not match the excluded schema", maximumIssues);
  if (node.if) {
    const branch = isValid(node.if, value, budget) ? node.then : node.else;
    if (branch) validateNode(branch, value, path, issues, maximumIssues, budget);
  }
}

function isValid(node, value, budget) {
  const issues = [];
  validateNode(node, value, "", issues, 1, budget);
  return issues.length === 0;
}

function compileTypes(value, label) {
  if (value === undefined) return undefined;
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0 || !values.every((type) => typeof type === "string" && SUPPORTED_TYPES.has(type))) {
    throw new ToolSchemaContractError(`${label}.type is invalid`);
  }
  if (new Set(values).size !== values.length) throw new ToolSchemaContractError(`${label}.type contains duplicates`);
  return Object.freeze([...values]);
}

function compileEnum(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw new ToolSchemaContractError(`${label}.enum must be a non-empty array`);
  for (let left = 0; left < value.length; left += 1) {
    for (let right = left + 1; right < value.length; right += 1) {
      if (jsonEqual(value[left], value[right])) throw new ToolSchemaContractError(`${label}.enum contains duplicate values`);
    }
  }
  return structuredClone(value);
}

function validateDialect(value, label) {
  if (value === undefined) return;
  if (value !== JSON_SCHEMA_2020_12 && value !== `${JSON_SCHEMA_2020_12}#`) {
    throw new ToolSchemaContractError(`${label} uses an unsupported JSON Schema dialect`);
  }
}

function matchesType(type, value) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isRecord(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function jsonEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => jsonEqual(value, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length && leftKeys.every((key) => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]));
  }
  return false;
}

function isMultipleOf(value, divisor) {
  const quotient = value / divisor;
  return Number.isFinite(quotient) && Math.abs(quotient - Math.round(quotient)) <= Number.EPSILON * Math.max(1, Math.abs(quotient)) * 4;
}

function pushIssue(issues, instancePath, keyword, message, maximumIssues) {
  if (issues.length >= maximumIssues) return;
  issues.push(Object.freeze({ instancePath: instancePath || "", keyword, message }));
}

function normalizeLimits(value) {
  const limits = {};
  for (const [key, fallback] of Object.entries(DEFAULT_LIMITS)) {
    const candidate = Number(value[key]);
    limits[key] = Number.isInteger(candidate) && candidate > 0 ? candidate : fallback;
  }
  return Object.freeze(limits);
}

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new ToolSchemaContractError(`${label} must be a non-negative integer`);
  return value;
}

function finiteNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ToolSchemaContractError(`${label} must be a finite number`);
  return value;
}

function escapePointer(value) {
  return String(value).replaceAll("~", "~0").replaceAll("/", "~1");
}

function isRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
