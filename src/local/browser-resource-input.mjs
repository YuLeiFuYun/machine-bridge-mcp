import { normalizeBrowserSelector, normalizeFormAction } from "./browser-command.mjs";

const MAX_FIELD_VALUE_CHARS = 128 * 1024;
const RESOURCE_NAME = /^[a-z][a-z0-9._-]{0,63}$/;

export function prepareBrowserFormField(input, index) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`fields[${index}] must be an object`);
  const allowed = new Set(["selector", "value", "value_resource", "action", "sensitive"]);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`unknown fields[${index}] property: ${key}`);
  if (input.sensitive !== undefined && typeof input.sensitive !== "boolean") throw new Error(`fields[${index}].sensitive must be boolean`);
  const action = input.action === undefined ? "fill" : normalizeFormAction(input.action);
  const selector = normalizeBrowserSelector(input.selector, action);
  const directValue = input.value === undefined ? null : boundedBrowserValue(input.value, `fields[${index}].value`);
  const resourceName = input.value_resource === undefined ? "" : validateBrowserResource(input.value_resource);
  if (directValue !== null && resourceName) throw new Error(`fields[${index}] value and value_resource are mutually exclusive`);
  const hasValue = directValue !== null || Boolean(resourceName);
  if (!hasValue && !["check", "uncheck", "click"].includes(action)) throw new Error(`fields[${index}] requires value or value_resource`);
  if (hasValue && !["fill", "select"].includes(action)) throw new Error(`fields[${index}] value is not valid for action '${action}'`);
  return { index, selector, action, sensitive: input.sensitive === true, value: directValue, resourceName };
}

export function normalizeUploadFilename(value, { derived = false } = {}) {
  if (typeof value !== "string") {
    if (derived) return "upload.bin";
    throw new Error("filenames entries must be safe single-component filenames of at most 255 characters");
  }
  let name = value;
  if (derived) name = name.replace(/[\u0000-\u001f\u007f/\\]+/g, "_").trim();
  if (!name || name === "." || name === ".." || name.length > 255 || /[\u0000-\u001f\u007f/\\]/.test(name)) {
    if (derived) return "upload.bin";
    throw new Error("filenames entries must be safe single-component filenames of at most 255 characters");
  }
  return name;
}

export function normalizeMimeType(value) {
  if (typeof value !== "string") throw new Error("mime_types entries must be valid media types");
  const mime = value.trim().toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime) || mime.length > 200) {
    throw new Error("mime_types entries must be valid media types");
  }
  return mime;
}

export function optionalStringArray(value, label, maxItems, maxLength) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${label} must be an array with at most ${maxItems} entries`);
  return value.map((item, index) => {
    if (typeof item !== "string" || item.includes("\0") || !item.length || item.length > maxLength) {
      throw new Error(`${label}[${index}] must be a non-empty string of at most ${maxLength} characters`);
    }
    return item;
  });
}

export async function resolveBrowserActionValue(args, readResourceText) {
  let value = args.value === undefined ? null : boundedBrowserValue(args.value, "value");
  if (args.value_resource !== undefined) {
    if (value !== null) throw new Error("value and value_resource are mutually exclusive");
    value = boundedBrowserValue(await readResourceText(validateBrowserResource(args.value_resource)), "value_resource");
  }
  return { value, source: args.value_resource !== undefined ? "local-resource" : value === null ? "none" : "mcp-argument" };
}

export function boundedBrowserValue(value, label) {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  if (value.includes("\0") || value.length > MAX_FIELD_VALUE_CHARS) throw new Error(`${label} exceeds the maximum length or contains a NUL byte`);
  return value;
}

export function validateBrowserResource(value) {
  if (typeof value !== "string" || !RESOURCE_NAME.test(value)) throw new Error("value_resource is invalid");
  return value;
}
