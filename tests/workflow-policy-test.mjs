import assert from "node:assert/strict";
import { cpSync, linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyWorkflowPolicy } from "../.github/scripts/workflow-policy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const verified = verifyWorkflowPolicy(root);
assert.deepEqual(verified.files, [
  "ci.yml",
  "codeql.yml",
  "dependency-review.yml",
  "governance.yml",
  "scorecard.yml",
  "workflow-policy.yml",
]);
assert(verified.actions >= 20, "workflow policy action inventory unexpectedly shrank");

withFixture((fixture) => {
  replace(
    fixture,
    "ci.yml",
    "      - run: npm run check:full",
    "      # run: npm run check:full\n      - run: npm run check:fast",
  );
  expectFailure(fixture, "lost required executable run command: npm run check:full");
});

withFixture((fixture) => {
  replace(
    fixture,
    "ci.yml",
    "      - run: npm run check:platform",
    "      - run: npm run check:platform -- --help",
  );
  expectFailure(fixture, "lost required executable run command: npm run check:platform");
});

withFixture((fixture) => {
  replace(
    fixture,
    "dependency-review.yml",
    "          fail-on-severity: moderate",
    "          # fail-on-severity: moderate\n          license-check: allow",
  );
  expectFailure(fixture, "action actions/dependency-review-action lost required input fail-on-severity: moderate");
});

withFixture((fixture) => {
  replace(
    fixture,
    "codeql.yml",
    "          queries: security-extended,security-and-quality",
    "          # queries: security-extended,security-and-quality\n          queries: default",
  );
  expectFailure(fixture, "action github/codeql-action/init lost required input queries: security-extended,security-and-quality");
});

withFixture((fixture) => {
  replace(
    fixture,
    "workflow-policy.yml",
    "      - name: Run workflow policy fault injection\n        run: node tests/workflow-policy-test.mjs",
    "      - name: node tests/workflow-policy-test.mjs\n        run: node --version",
  );
  expectFailure(fixture, "lost required executable run command: node tests/workflow-policy-test.mjs");
});

withFixture((fixture) => {
  replace(
    fixture,
    "workflow-policy.yml",
    "name: Workflow Policy Gate",
    "# name: Workflow Policy Gate\nname: Workflow Policy Disabled",
  );
  expectFailure(fixture, "lost required top-level name: Workflow Policy Gate");
});

withFixture((fixture) => {
  replace(fixture, "ci.yml", "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1", "actions/checkout@v7");
  expectFailure(fixture, "dynamic, malformed, or unpinned action reference");
});

withFixture((fixture) => {
  replace(fixture, "ci.yml", "  pull_request:\n", "  pull_request_target:\n");
  expectFailure(fixture, "prohibited pull_request_target");
});

withFixture((fixture) => {
  replace(fixture, "governance.yml", "          persist-credentials: false\n", "");
  expectFailure(fixture, "checkout must disable persisted credentials");
});

withFixture((fixture) => {
  replace(fixture, "workflow-policy.yml", "    timeout-minutes: 5", "    timeout-minutes: 31");
  expectFailure(fixture, "timeout from 1 to 30 minutes");
});

withFixture((fixture) => {
  replace(fixture, "governance.yml", "            node scripts/commit-message-check.mjs --title \"$PR_TITLE\"", "            node scripts/commit-message-check.mjs --title \"${{ github.event.pull_request.title }}\"");
  expectFailure(fixture, "interpolates github.event data directly");
});

withFixture((fixture) => {
  replace(fixture, "codeql.yml", "      contents: read\n      packages: read", "      contents: write\n      packages: read");
  expectFailure(fixture, "grants unreviewed contents: write");
});

withFixture((fixture) => {
  rmSync(join(fixture, ".github", "workflows", "workflow-policy.yml"));
  expectFailure(fixture, "required workflow is missing: workflow-policy.yml");
});

withFixture((fixture) => {
  replace(fixture, "workflow-policy.yml", "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020", "example/unreviewed-action@820762786026740c76f36085b0efc47a31fe5020");
  expectFailure(fixture, "uses unreviewed action example/unreviewed-action");
});

withFixture((fixture) => {
  replace(fixture, "workflow-policy.yml", "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020", "${{ matrix.action }}");
  expectFailure(fixture, "dynamic, malformed, or unpinned action reference");
});

withFixture((fixture) => {
  const path = workflowPath(fixture, "governance.yml");
  writeFileSync(path, Buffer.from([0xff, 0xfe, 0xfd]));
  expectFailure(fixture, "is not valid UTF-8");
});

withFixture((fixture) => {
  replace(fixture, "dependency-review.yml", "group: dependency-review-${{ github.workflow }}-${{ github.ref }}", "group: dependency-review-${{ github.ref }}");
  expectFailure(fixture, "must bind github.workflow and github.ref");
});

withFixture((fixture) => {
  const path = workflowPath(fixture, "governance.yml");
  const target = join(fixture, "outside.yml");
  writeFileSync(target, readFileSync(path));
  unlinkSync(path);
  try {
    symlinkSync(target, path);
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) return;
    throw error;
  }
  expectFailure(fixture, "must be a regular file and not a symbolic link");
});

withFixture((fixture) => {
  const path = workflowPath(fixture, "governance.yml");
  const target = join(fixture, "hard-linked-governance.yml");
  try {
    linkSync(path, target);
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) return;
    throw error;
  }
  expectFailure(fixture, "must not have multiple hard links");
});

console.log(`workflow policy test ok (${verified.files.length} workflows, ${verified.actions} pinned action references)`);

function withFixture(callback) {
  const fixture = mkdtempSync(join(tmpdir(), "mbm-workflow-policy-"));
  try {
    cpSync(join(root, ".github"), join(fixture, ".github"), { recursive: true });
    callback(fixture);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

function workflowPath(fixture, name) {
  return join(fixture, ".github", "workflows", name);
}

function replace(fixture, name, before, after) {
  const path = workflowPath(fixture, name);
  const source = readFileSync(path, "utf8");
  assert(source.includes(before), `fixture mutation anchor missing in ${name}: ${before}`);
  writeFileSync(path, source.replace(before, after));
}

function expectFailure(fixture, expected) {
  assert.throws(() => verifyWorkflowPolicy(fixture), error => {
    assert.match(String(error?.message || error), new RegExp(escapeRegex(expected)));
    return true;
  });
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
