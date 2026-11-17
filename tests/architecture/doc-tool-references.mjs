import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The comparative review maps upstream designs onto this project's tool names, and its
// Decision column records what was adopted. When a tool is renamed or a dependency is
// added, the prose keeps asserting an "adopted" design that no longer exists and the
// table silently stops being checkable evidence. This gate binds the document to the
// shared tool catalog and to package.json instead of trusting reviewer memory.
const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const REVIEW_DOCUMENT = "docs/COMPARATIVE_REVIEW.md";

// Parameter names, result keys and protocol states that legitimately appear in the table.
// Each entry must still occur in src/, so this list cannot outlive the identifiers it names.
const NON_TOOL_IDENTIFIERS = Object.freeze([
  "actionable_remedy",
  "expected_sha256",
  "input_required",
  "instruction_files",
  "snapshot_id",
  "with_line_numbers",
]);

const NUMBER_WORDS = Object.freeze({ two: 2, three: 3, four: 4, five: 5, six: 6 });

const catalog = JSON.parse(readFileSync(join(root, "src", "shared", "tool-catalog.json"), "utf8"));
const toolNames = new Set(catalog.map((tool) => tool.name));
const review = readFileSync(join(root, REVIEW_DOCUMENT), "utf8");
const quoted = [...new Set([...review.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]))];
const snakeCase = quoted.filter((token) => /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(token));

// A silently empty extraction would make every assertion below vacuous, so guard the
// extraction itself rather than only the result it produces.
assert.ok(catalog.length >= 40, `tool catalog looks truncated: ${catalog.length} tools`);
assert.ok(snakeCase.length >= 25,
  `expected at least 25 quoted snake_case identifiers in ${REVIEW_DOCUMENT}, found ${snakeCase.length}; the table format or quoting style changed`);

const declared = new Set(NON_TOOL_IDENTIFIERS);
const sourceText = walk(join(root, "src")).map((file) => readFileSync(file, "utf8")).join("\n");
for (const identifier of declared) {
  assert.ok(!toolNames.has(identifier),
    `"${identifier}" is a shipped tool name; it does not belong in NON_TOOL_IDENTIFIERS`);
  assert.ok(occursInSource(identifier),
    `declared non-tool identifier "${identifier}" no longer occurs in src/; drop it from NON_TOOL_IDENTIFIERS or restore the feature`);
}

const unknown = snakeCase.filter((token) => !toolNames.has(token) && !declared.has(token));
assert.deepEqual(unknown, [],
  `quoted identifiers in ${REVIEW_DOCUMENT} are neither shipped tool names nor declared non-tool identifiers: ${unknown.join(", ")}; rename them to the catalog spelling or declare them in NON_TOOL_IDENTIFIERS`);

const adopted = snakeCase.filter((token) => toolNames.has(token));
assert.ok(adopted.length >= 15,
  `expected ${REVIEW_DOCUMENT} to reference at least 15 shipped tools, found ${adopted.length}`);

// The dependency sentence is the other documented claim that drifted: it must match the
// exact set in package.json, not only its size.
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const runtimeDependencies = Object.keys(pkg.dependencies ?? {}).sort();
const dependencySentence = /Its (\w+) direct runtime dependencies remain purposeful: ([^.]+)\./.exec(review);
assert.ok(dependencySentence,
  `${REVIEW_DOCUMENT} no longer states its direct runtime dependency set in the reviewed form`);
assert.equal(NUMBER_WORDS[dependencySentence[1]], runtimeDependencies.length,
  `the review claims ${dependencySentence[1]} direct runtime dependencies but package.json declares ${runtimeDependencies.length}`);
assert.deepEqual(
  [...dependencySentence[2].matchAll(/`([^`]+)`/g)].map((match) => match[1]).sort(),
  runtimeDependencies,
  `the review names a different direct runtime dependency set than package.json`,
);

const footprintSentence = /\((\d+) runtime packages\)/.exec(review);
assert.ok(footprintSentence, `${REVIEW_DOCUMENT} no longer states the runtime package footprint`);
assert.equal(Number(footprintSentence[1]), runtimeDependencies.length,
  `the review states a ${footprintSentence[1]}-package footprint but package.json declares ${runtimeDependencies.length}`);

console.log(`comparative review references ok (${adopted.length} shipped tools, ${declared.size} declared non-tool identifiers, ${runtimeDependencies.length} runtime dependencies)`);

function occursInSource(identifier) {
  return new RegExp(`(?<![\\w-])${identifier}(?![\\w-])`).test(sourceText);
}

function walk(directory) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...walk(file));
    else if (/\.(?:ts|mjs|js|json)$/.test(entry.name)) result.push(file);
  }
  return result;
}
