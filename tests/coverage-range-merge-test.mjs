import assert from "node:assert/strict";
import { mergeFunctionExecutions, rangeCoveredAcrossExecutions } from "../scripts/coverage-range-merge.mjs";

const inheritedCoverage = mergeFunctionExecutions([
  [{ startOffset: 0, endOffset: 10, count: 1 }, { startOffset: 2, endOffset: 4, count: 0 }],
  [{ startOffset: 0, endOffset: 10, count: 1 }],
]);
assert.equal(inheritedCoverage.functionCovered, true);
assert.equal(inheritedCoverage.blocks.get("2:4"), true, "missing child range did not inherit the covered parent count");

const neverCovered = mergeFunctionExecutions([
  [{ startOffset: 0, endOffset: 10, count: 1 }, { startOffset: 2, endOffset: 4, count: 0 }],
  [{ startOffset: 0, endOffset: 10, count: 1 }, { startOffset: 2, endOffset: 4, count: 0 }],
]);
assert.equal(neverCovered.blocks.get("2:4"), false, "never-executed child range was fabricated as covered");

const splitAcrossReports = [
  [{ startOffset: 0, endOffset: 12, count: 1 }, { startOffset: 2, endOffset: 8, count: 0 }],
  [{ startOffset: 0, endOffset: 12, count: 1 }, { startOffset: 2, endOffset: 5, count: 0 }],
];
assert.equal(rangeCoveredAcrossExecutions(splitAcrossReports, 2, 8), true, "missing exact range did not inherit its nearest enclosing execution count");
splitAcrossReports.push([{ startOffset: 0, endOffset: 12, count: 1 }]);
assert.equal(rangeCoveredAcrossExecutions(splitAcrossReports, 2, 8), true, "aggregate execution failed to cover a range inherited from the parent");
assert.equal(rangeCoveredAcrossExecutions(splitAcrossReports, 8, 8), false, "empty block range was accepted");

for (const executions of [inheritedCoverageInput(), neverCoveredInput(), splitAcrossReports]) {
  const merged = mergeFunctionExecutions(executions);
  for (const [key, covered] of merged.blocks) {
    const [startOffset, endOffset] = key.split(":").map(Number);
    const naiveCovered = executions.some((ranges) => ranges.some((range, index) => index > 0
      && range.startOffset === startOffset && range.endOffset === endOffset && range.count > 0));
    if (naiveCovered) assert.equal(covered, true, `merge regressed explicitly covered raw range ${key}`);
  }
}

function inheritedCoverageInput() {
  return [
    [{ startOffset: 0, endOffset: 10, count: 1 }, { startOffset: 2, endOffset: 4, count: 0 }],
    [{ startOffset: 0, endOffset: 10, count: 1 }],
  ];
}
function neverCoveredInput() {
  return [
    [{ startOffset: 0, endOffset: 10, count: 1 }, { startOffset: 2, endOffset: 4, count: 0 }],
    [{ startOffset: 0, endOffset: 10, count: 1 }, { startOffset: 2, endOffset: 4, count: 0 }],
  ];
}

console.log("coverage range merge test ok");
