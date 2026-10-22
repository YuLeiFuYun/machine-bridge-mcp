import assert from "node:assert/strict";
import { resolve, relative } from "node:path";
import { selectAffectedChecks } from "../scripts/check-changed.mjs";
import { FAST_CHECK_TASKS } from "../scripts/check-plan.mjs";

const root = resolve("synthetic-impact-root");

const source = new Map([
  ["src/shared/value.mjs", "export const value = 1;"],
  ["src/local/use.mjs", "import { value } from '../shared/value.mjs'; export { value };"],
  ["tests/agent-evals-test.mjs", "import { value } from '../src/local/use.mjs'; if(value !== 1) throw Error();"],
  ["tests/symbol-outline-test.mjs", "export const unrelated = true;"],
]);
const options = { root, files: [...source.keys()], packageScripts: {
  "agent-evals:test": "node tests/agent-evals-test.mjs", "symbol-outline:test": "node tests/symbol-outline-test.mjs",
}, readSource: (path) => source.get(relative(root, path).replaceAll("\\", "/")) };
const transitive = selectAffectedChecks({ ...options, changedPaths: ["src/shared/value.mjs"] });
assert(transitive.selected.includes("agent-evals:test"));
assert(!transitive.selected.includes("symbol-outline:test"));
assert(transitive.advisory && transitive.not_selected.length);
assert(transitive.proof_boundary.includes("full release gates"));
const deleted = selectAffectedChecks({ ...options, files: options.files.filter((p) => !p.endsWith("value.mjs")), changedPaths: ["src/shared/value.mjs"] });
assert(deleted.selected.includes("agent-evals:test"), "deleted dependencies disappeared from impact closure");
const config = selectAffectedChecks({ ...options, changedPaths: ["package-lock.json"] });
assert.deepEqual(config.selected, FAST_CHECK_TASKS);
const docs = selectAffectedChecks({ ...options, changedPaths: ["docs/CLIENTS.md"] });
assert(docs.selected.includes("architecture:test") && docs.selected.includes("markdown:test"));
source.set("src/local/use.mjs", "export class {");
assert.deepEqual(selectAffectedChecks({ ...options, changedPaths: ["src/shared/value.mjs"] }).selected, FAST_CHECK_TASKS);
console.log("affected check selection safety ok");
