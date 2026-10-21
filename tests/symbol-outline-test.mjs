// @ts-check
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractFileSymbols,
  extractSymbolOutline,
  extractWorkspaceOutline,
  renderSymbolOutline,
  sanitizeSource,
} from "../src/local/symbol-outline.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

// 1. Test sanitizeSource: preserves newline structure while removing comments/strings
const rawSnippet = `// Leading comment
const greeting = "Hello, world!";
/*
  Multiline comment
*/
export function calculate(a, b) {
  // Nested comment
  const msg = \`value: \${a + b}\`;
  return a + b;
}`;

const sanitized = sanitizeSource(rawSnippet);
assert.equal(sanitized.split("\n").length, rawSnippet.split("\n").length, "newline count must match 100%");
assert(!sanitized.includes("Leading comment"), "line comments must be stripped");
assert(!sanitized.includes("Multiline comment"), "block comments must be stripped");
assert(!sanitized.includes("Hello, world!"), "string literals must be stripped");

// 2. Test extractFileSymbols with various JS/TS declarations
const complexModule = `
// Fake comment: class CommentFake {}
const stringFake = "class StringFake {}";

export class DataStore extends BaseStore {
  constructor(options = {}) {
    super(options);
  }

  async loadItem(id) {
    return null;
  }

  static configure(settings) {
    return true;
  }

  get isReady() {
    return true;
  }
}

export async function processData(
  input,
  retries = 3,
  debug = false
) {
  function innerHelper() { return 1; }
  return input;
}

export const computeScore = (score, multiplier = 1.5) => {
  return score * multiplier;
};

export interface DataConfig {
  id: string;
}

export type OperationType = "read" | "write";

export enum TaskState {
  PENDING,
  DONE
}

export const MAX_RETRY_COUNT = 10;
`;

const extracted = extractFileSymbols(complexModule, "test-module.ts", { includeInternal: true });
const symbolNames = extracted.symbols.map((s) => s.name);

// Verify extracted top-level symbols
assert(symbolNames.includes("DataStore"), "class DataStore not found");
assert(symbolNames.includes("processData"), "function processData not found");
assert(symbolNames.includes("computeScore"), "arrow function computeScore not found");
assert(symbolNames.includes("DataConfig"), "interface DataConfig not found");
assert(symbolNames.includes("OperationType"), "type OperationType not found");
assert(symbolNames.includes("TaskState"), "enum TaskState not found");
assert(symbolNames.includes("MAX_RETRY_COUNT"), "const MAX_RETRY_COUNT not found");

// Verify no comment or string fakes were captured
assert(!symbolNames.includes("CommentFake"), "comment fake captured as class");
assert(!symbolNames.includes("StringFake"), "string fake captured as class");

// Verify inner helper function was excluded
assert(!symbolNames.includes("innerHelper"), "inner helper was captured as top-level symbol");

// Verify class methods
const classSymbol = extracted.symbols.find((s) => s.name === "DataStore");
assert(classSymbol, "DataStore class symbol missing");
assert.equal(classSymbol.superClass, "BaseStore");
const methodNames = classSymbol.methods.map((m) => m.name);
assert(methodNames.includes("constructor"), "constructor missing");
assert(methodNames.includes("loadItem"), "loadItem missing");
assert(methodNames.includes("configure"), "static configure missing");
assert(methodNames.includes("isReady"), "getter isReady missing");

const staticMethod = classSymbol.methods.find((m) => m.name === "configure");
assert(staticMethod?.static, "configure should be marked static");

const asyncMethod = classSymbol.methods.find((m) => m.name === "loadItem");
assert(asyncMethod?.async, "loadItem should be marked async");

// Verify multiline parameter extraction
const processDataFn = extracted.symbols.find((s) => s.name === "processData");
assert(processDataFn, "processData symbol missing");
assert(processDataFn.params.includes("input"), "params should include input");
assert(processDataFn.params.includes("retries = 3"), "params should include default value");
assert(processDataFn.params.includes("debug = false"), "params should include multiline param");

// 3. Test renderSymbolOutline formatting
const rendered = renderSymbolOutline(extracted);
assert(rendered.includes("test-module.ts ("), "header missing");
assert(rendered.includes("export class DataStore extends BaseStore"), "class outline line missing");
assert(rendered.includes("constructor(...)"), "constructor outline missing");
assert(rendered.includes("export async function processData("), "function outline line missing");
assert(rendered.includes("export interface DataConfig"), "interface outline line missing");

// 4. Test extractWorkspaceOutline
const workspaceResult = await extractWorkspaceOutline(join(root, "src", "local"), {
  maxFiles: 5,
  maxLines: 40,
});
assert(workspaceResult.filesScanned > 0, "files should be scanned");
assert(workspaceResult.totalSymbols > 0, "symbols should be found");
assert(workspaceResult.outline.length > 0, "outline text should not be empty");
assert(workspaceResult.truncated, "should be truncated with maxLines = 40");
assert(workspaceResult.outline.includes("truncated: budget reached"), "truncation notice missing");

// 5. Test on production files
const errorsCode = readFileSync(join(root, "src", "local", "errors.mjs"), "utf8");
const errorsOutline = renderSymbolOutline(extractFileSymbols(errorsCode, "errors.mjs"));
assert(errorsOutline.includes("export class BridgeError extends Error"));
assert(errorsOutline.includes("export function errorCode(...)"));

const workerCode = readFileSync(join(root, "src", "worker", "index.ts"), "utf8");
const workerOutline = renderSymbolOutline(extractFileSymbols(workerCode, "index.ts"));
assert(workerOutline.includes("export class BridgeRoom extends DurableObject<BridgeEnv>"));

// 6. Regression: Regex literals containing braces and quotes
const regexTrickyCode = `
const RE_BRACES = /\\{[^\\}]*\\}/g;
const RE_QUOTES = /[^\\s"'<>]+/gi;
const RE_SLASH = /[/]/;

export function afterRegexFunction(a, b) {
  return a + b;
}

export class AfterRegexClass {
  greet() { return "hello"; }
}
`;
const trickyExtracted = extractFileSymbols(regexTrickyCode, "tricky.js");
const trickyNames = trickyExtracted.symbols.map((s) => s.name);
assert(trickyNames.includes("afterRegexFunction"), "afterRegexFunction must be captured despite preceding regex with braces");
assert(trickyNames.includes("AfterRegexClass"), "AfterRegexClass must be captured despite preceding regex with quotes");

// 7. Regression: Production files log-redaction.mjs and mcp-http-contract.ts
const logRedactionCode = readFileSync(join(root, "src", "shared", "log-redaction.mjs"), "utf8");
const logRedactionSymbols = extractFileSymbols(logRedactionCode, "log-redaction.mjs").symbols.map((s) => s.name);
assert(logRedactionSymbols.includes("isSensitiveLogFieldName"), "isSensitiveLogFieldName must be extracted from log-redaction.mjs");
assert(logRedactionSymbols.includes("sanitizePortableLogText"), "sanitizePortableLogText must be extracted from log-redaction.mjs");

const mcpContractCode = readFileSync(join(root, "src", "worker", "mcp-http-contract.ts"), "utf8");
const mcpContractSymbols = extractFileSymbols(mcpContractCode, "mcp-http-contract.ts").symbols.map((s) => s.name);
assert(mcpContractSymbols.includes("validateHttpRequest"), "validateHttpRequest must be extracted from mcp-http-contract.ts");
assert(mcpContractSymbols.includes("httpHeaderContractError"), "httpHeaderContractError must be extracted from mcp-http-contract.ts");

// Rendered bytes, UTF-8 paths and notices share the same budget for files and directories.
{
  const temporary = mkdtempSync(join(tmpdir(), "mbm-outline-byte-budget-"));
  try {
    const large = join(temporary, "large.mjs");
    const source = "export function " + "x".repeat(20000) + "() {}";
    writeFileSync(large, source);
    const text = await extractSymbolOutline(large);
    assert(Buffer.byteLength(text) <= 16 * 1024 && text.includes("truncated"), "long identifiers bypassed the default output budget");
    const directory = await extractWorkspaceOutline(temporary, { maxOutputBytes: 128 });
    assert(directory.truncated && directory.truncationReasons.includes("output_byte_limit"));
    assert(directory.outputBytes === Buffer.byteLength(directory.outline) && directory.outputBytes <= 128);
    const unicode = join(temporary, "多字节.mjs");
    writeFileSync(unicode, source);
    const unicodeText = await extractSymbolOutline(unicode, { maxOutputBytes: 128, displayPath: () => "多字节.mjs" });
    assert(unicodeText.includes("多字节.mjs") && !unicodeText.includes("\uFFFD") && Buffer.byteLength(unicodeText) <= 128);
    const tiny = await extractSymbolOutline(unicode, { maxLines: 1, maxOutputBytes: 1 });
    assert.equal(tiny, ".", "tiny budgets must include their truncation marker");
    const small = join(temporary, "small.mjs");
    writeFileSync(small, "export function shortName() {}\n");
    const full = await extractSymbolOutline(small, { displayPath: () => "small.mjs" });
    const exact = await extractSymbolOutline(small, { maxOutputBytes: Buffer.byteLength(full), displayPath: () => "small.mjs" });
    assert.equal(exact, full, "an exactly fitting complete outline was marked incomplete");
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

console.log("symbol outline test ok");
