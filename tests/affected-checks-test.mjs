import assert from "node:assert/strict";
import { resolve, relative } from "node:path";
import test from "node:test";
import { selectAffectedChecks } from "../scripts/check-changed.mjs";
import { FAST_CHECK_TASKS } from "../scripts/check-plan.mjs";

test("affected check selection follows transitive source imports and docs/config fallbacks", () => {
  const root = resolve("synthetic-impact-root");

  const source = new Map([
    ["src/shared/value.mjs", "export const value = 1;"],
    ["src/local/use.mjs", "import { value } from '../shared/value.mjs'; export { value };"],
    ["tests/agent-evals-test.mjs", "import { value } from '../src/local/use.mjs'; if(value !== 1) throw Error();"],
    ["tests/symbol-outline-test.mjs", "export const unrelated = true;"],
  ]);
  const options = { root, files: [...source.keys()], packageScripts: {
    "test:agent": "node --test tests/agent-evals-test.mjs",
    "test:apps-computer": "node --test tests/symbol-outline-test.mjs",
  }, readSource: (path) => source.get(relative(root, path).replaceAll("\\", "/")) };
  const transitive = selectAffectedChecks({ ...options, changedPaths: ["src/shared/value.mjs"] });
  assert(new Set(transitive.selected).has("test:agent"));
  assert(!new Set(transitive.selected).has("test:apps-computer"));
  assert(transitive.advisory && transitive.not_selected.length);
  assert.match(transitive.proof_boundary, /full release gates/);
  const deleted = selectAffectedChecks({ ...options, files: options.files.filter((p) => !p.endsWith("value.mjs")), changedPaths: ["src/shared/value.mjs"] });
  assert(new Set(deleted.selected).has("test:agent"), "deleted dependencies disappeared from impact closure");
  const config = selectAffectedChecks({ ...options, changedPaths: ["package-lock.json"] });
  assert.deepEqual(config.selected, FAST_CHECK_TASKS);
  const docs = selectAffectedChecks({ ...options, changedPaths: ["docs/CLIENTS.md"] });
  const docSet = new Set(docs.selected);
  assert(docSet.has("architecture:test") && docSet.has("test:docs"));
  source.set("src/local/use.mjs", "export class {");
  assert.deepEqual(selectAffectedChecks({ ...options, changedPaths: ["src/shared/value.mjs"] }).selected, FAST_CHECK_TASKS);
});
