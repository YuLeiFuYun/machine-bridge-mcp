// @ts-check
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertSemanticBoundary,
  findSemanticCalls,
  getSemanticExports,
  getSemanticImports,
  hasSemanticImport,
  measureSemanticComplexity,
} from "./semantic-analyzer.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

// 1. Verify semantic import extraction vs mechanical text search
const sampleCode = `
// import "./comment-fake.mjs";
const stringOnly = "import './string-fake.mjs'";
import { BridgeError, errorCode } from "./errors.mjs";
import defaultHelper from "./helper.mjs";
import * as shared from "../shared/protocol.mjs";
export { reExported } from "./re-export.mjs";

/*
  import "./block-comment-fake.mjs";
*/
export function doWork() {
  const ts = performance.now();
  // Date.now();
  return ts;
}
`;

const imports = getSemanticImports(sampleCode, "sample.mjs");
const specifiers = imports.map((i) => i.specifier);
assert.deepEqual(specifiers, ["./errors.mjs", "./helper.mjs", "../shared/protocol.mjs", "./re-export.mjs"]);
assert(!specifiers.includes("./comment-fake.mjs"), "semantic analyzer captured comment as import");
assert(!specifiers.includes("./string-fake.mjs"), "semantic analyzer captured string literal as import");
assert(!specifiers.includes("./block-comment-fake.mjs"), "semantic analyzer captured block comment as import");

assert(hasSemanticImport(sampleCode, "./errors.mjs", { requiredSymbols: ["BridgeError"] }));
assert(!hasSemanticImport(sampleCode, "./errors.mjs", { requiredSymbols: ["NonExistent"] }));
assert(!hasSemanticImport(sampleCode, "./comment-fake.mjs"));

// 2. Verify semantic call expression detection vs comment/string false positives
const perfCalls = findSemanticCalls(sampleCode, { memberObject: "performance", memberProperty: "now" });
assert.equal(perfCalls.length, 1, "did not find real performance.now() call");
assert.equal(perfCalls[0].line, 13, "call line mismatch");

const dateCalls = findSemanticCalls(sampleCode, { memberObject: "Date", memberProperty: "now" });
assert.equal(dateCalls.length, 0, "commented-out Date.now() was falsely detected as a call expression");

// 3. Verify semantic exports
const exports = getSemanticExports(sampleCode, "sample.mjs");
const exportNames = exports.map((e) => e.name);
assert(exportNames.includes("doWork"), "did not capture doWork export");
assert(exportNames.includes("reExported"), "did not capture reExported export");

// 4. Verify semantic complexity: comments vs real code lines
const complexity = measureSemanticComplexity(sampleCode, "sample.mjs");
assert(complexity.totalLines >= 16);
assert(complexity.codeLines < complexity.totalLines, "codeLines should exclude blank and comment-only lines");
assert(complexity.commentLines >= 4, "commentLines count mismatch");
assert(complexity.statementCount >= 4, "statementCount mismatch");

// 5. Verify assertSemanticBoundary
assert.doesNotThrow(() => {
  assertSemanticBoundary(sampleCode, {
    maxCodeLines: 50,
    requiredImports: ["./errors.mjs"],
    forbiddenImports: ["./forbidden.mjs"],
    forbiddenCalls: [{ memberObject: "Date", memberProperty: "now" }],
  }, "sample");
});

assert.throws(() => {
  assertSemanticBoundary(sampleCode, {
    forbiddenImports: ["./errors.mjs"],
  }, "sample");
}, /contains forbidden semantic import/);

assert.throws(() => {
  assertSemanticBoundary(sampleCode, {
    forbiddenCalls: [{ memberObject: "performance", memberProperty: "now" }],
  }, "sample");
}, /calls forbidden operation: performance\.now/);

// 6. Test on real production codebase files
const errorsMjsSource = readFileSync(join(root, "src", "local", "errors.mjs"), "utf8");
const errorsExports = getSemanticExports(errorsMjsSource, "errors.mjs");
assert(errorsExports.some((e) => e.name === "BridgeError" && e.kind === "class"));
assert(errorsExports.some((e) => e.name === "actionableGuidance" && e.kind === "function"));
assert(errorsExports.some((e) => e.name === "publicError" && e.kind === "function"));

const computerUseSource = readFileSync(join(root, "src", "local", "computer-use.mjs"), "utf8");
assert(hasSemanticImport(computerUseSource, "./computer-use-deadline.mjs"));
assert(hasSemanticImport(computerUseSource, "./computer-use-snapshot-store.mjs"));

// 7. Verify modern modular architecture boundaries via AST
const workspacePathsSource = readFileSync(join(root, "src", "local", "workspace-paths.mjs"), "utf8");
const workspacePathsExports = getSemanticExports(workspacePathsSource, "workspace-paths.mjs");
for (const expected of ["expandHome", "resolveWorkspace", "defaultFirstRunWorkspace", "ensureWorkspaceDirectory", "defaultStateRoot", "assertStateRootSeparatedFromWorkspace"]) {
  assert(workspacePathsExports.some((e) => e.name === expected), `workspace-paths.mjs missing expected semantic export: ${expected}`);
}

const stdioSource = readFileSync(join(root, "src", "local", "stdio.mjs"), "utf8");
assert(hasSemanticImport(stdioSource, "../shared/help-resources.mjs", { requiredSymbols: ["HELP_RESOURCES", "readHelpResource"] }),
  "stdio.mjs does not semantically import help resources");
assert(hasSemanticImport(stdioSource, "../shared/mcp-task-contract.mjs", { requiredSymbols: ["MCP_TASK_EXTENSION_ID", "supportsMcpTasks"] }),
  "stdio.mjs does not semantically import MCP task contracts");

const helpResourcesSource = readFileSync(join(root, "src", "shared", "help-resources.mjs"), "utf8");
const helpResourcesExports = getSemanticExports(helpResourcesSource, "help-resources.mjs");
assert(helpResourcesExports.some((e) => e.name === "HELP_RESOURCES"), "help-resources.mjs missing HELP_RESOURCES export");
assert(helpResourcesExports.some((e) => e.name === "readHelpResource"), "help-resources.mjs missing readHelpResource export");

console.log("semantic architecture test ok");
