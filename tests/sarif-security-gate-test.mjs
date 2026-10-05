import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temp = mkdtempSync(join(tmpdir(), "mbm-sarif-gate-"));
try {
  const sarif = join(temp, "result.sarif");
  const allowlist = join(temp, "allowlist.json");
  writeFileSync(sarif, JSON.stringify(document("src/local/example.mjs")));
  const blocked = run(sarif, allowlist);
  assert(blocked.status !== 0 && blocked.stderr.includes("rejected 1 unaccepted"), "unaccepted security finding did not fail the gate");

  writeFileSync(allowlist, JSON.stringify({
    schemaVersion: 1,
    accepted: [{
      ruleId: "js/example-security-rule",
      path: "src/local/example.mjs",
      reason: "Synthetic test exception demonstrates exact rule and path matching for an intentionally reviewed security boundary.",
      expires: "2099-01-01",
    }],
  }));
  const accepted = run(sarif, allowlist);
  assert(accepted.status === 0 && accepted.stderr.includes("explicitly accepted"), "matching accepted finding did not pass the gate");

  for (const quality of [false, true]) {
    const report = document("src/local/example.mjs");
    if (quality) report.runs[0].tool.driver.rules[0].properties = { tags: ["quality"] };
    report.runs[0].results[0].ruleId = ["js/example-security-rule"];
    writeFileSync(sarif, JSON.stringify(report));
    assert(run(sarif, allowlist).status !== 0, "array rule identity acquired a quality classification or waiver");
  }
  for (const uri of [["src/local/example.mjs"], false, 7, ""]) {
    writeFileSync(sarif, JSON.stringify(document(uri)));
    assert(run(sarif, allowlist).status !== 0, "non-string or empty artifact URI acquired an exact-path waiver");
  }
  const validAllowlist = JSON.parse(readFileSync(allowlist, "utf8"));
  for (const field of ["ruleId", "path", "reason", "expires"]) {
    const malformed = structuredClone(validAllowlist);
    malformed.accepted[0][field] = [malformed.accepted[0][field]];
    writeFileSync(allowlist, JSON.stringify(malformed));
    writeFileSync(sarif, JSON.stringify(document("src/local/example.mjs")));
    assert(run(sarif, allowlist).status !== 0, "coerced waiver field was accepted: " + field);
  }
  writeFileSync(allowlist, JSON.stringify(validAllowlist));

  writeFileSync(sarif, JSON.stringify(document("src/local/example.mjs", { includeRules: false })));
  const missingMetadata = run(sarif, join(temp, "missing-allowlist.json"));
  assert(missingMetadata.status !== 0 && missingMetadata.stderr.includes("rejected 1 unaccepted"), "finding with omitted rule metadata bypassed the fail-closed gate");

  writeFileSync(sarif, JSON.stringify(document("src/local/other.mjs")));
  const wrongPath = run(sarif, allowlist);
  assert(wrongPath.status !== 0, "accepted finding incorrectly matched a different path");

  for (const properties of [undefined, {}, { tags: [] }, { tags: ["unclassified"] },
    { tags: ["quality"], "security-severity": null }, { tags: ["quality"], "security-severity": "invalid" },
    { tags: ["quality"], "security-severity": -1 }, { tags: ["quality"], "security-severity": 11 },
    { tags: ["quality"], "security-severity": "7.0" }]) {
    const report = document("src/local/example.mjs");
    report.runs[0].tool.driver.rules[0].properties = properties;
    writeFileSync(sarif, JSON.stringify(report));
    assert(run(sarif, join(temp, "missing-allowlist.json")).status !== 0,
      "incomplete, unknown, or security rule properties bypassed the gate");
  }
  for (const report of [
    { version: "2.1.0", runs: [] },
    { version: "2.0.0", runs: document("src/local/example.mjs").runs },
    { version: "2.1.0", runs: [{ tool: { driver: { name: "CodeQL" } } }] },
    { version: "2.1.0", runs: [{ tool: { driver: { name: "CodeQL" } }, results: [],
      invocations: [{ executionSuccessful: false }] }] },
    { version: "2.1.0", runs: [{ tool: { driver: { name: "CodeQL" } }, results: [],
      invocations: [{}] }] },
  ]) {
    writeFileSync(sarif, JSON.stringify(report));
    assert(run(sarif, allowlist).status !== 0, "absent or failed analysis was accepted as a clean scan");
  }
  for (const conflictingIndex of [false, true]) {
    const report = document("src/local/example.mjs");
    const security = report.runs[0].tool.driver.rules[0];
    report.runs[0].tool.driver.rules.push({ id: security.id, properties: { tags: ["quality"] } });
    report.runs[0].results[0].ruleIndex = 0;
    if (conflictingIndex) security.id = "js/another-security-rule";
    writeFileSync(sarif, JSON.stringify(report));
    assert(run(sarif, allowlist).status !== 0, "duplicate or mismatched rule metadata hid a security finding");
  }
  for (const tags of [["quality"], ["maintainability"], ["reliability"], ["quality", "security"]]) {
    const report = document("src/local/example.mjs");
    report.runs[0].tool.driver.rules[0].properties = { tags };
    writeFileSync(sarif, JSON.stringify(report));
    const control = run(sarif, join(temp, "missing-allowlist.json"));
    assert((control.status === 0) === !tags.includes("security"), "quality/security classification regressed");
  }
  for (const successfulInvocation of [undefined, [{ executionSuccessful: true }]]) {
    const report = document("src/local/example.mjs");
    report.runs[0].results = [];
    report.runs[0].invocations = successfulInvocation;
    writeFileSync(sarif, JSON.stringify(report));
    assert(run(sarif, allowlist).status === 0, "completed zero-finding scan failed the gate");
  }


  writeFileSync(sarif, JSON.stringify(document("src/local/example.mjs")));
  for (const expires of ["2099-99-99", "2099-02-29", "2099-04-31", "2000-01-01", "2096-02-29"]) {
    writeFileSync(allowlist, JSON.stringify({
      schemaVersion: 1,
      accepted: [{ ruleId: "js/example-security-rule", path: "src/local/example.mjs",
        reason: "Owned synthetic reviewed exception validates calendar expiration instead of shape-only date checking.", expires }],
    }));
    assert((run(sarif, allowlist).status === 0) === (expires === "2096-02-29"),
      "invalid, expired, or valid leap-day exception was classified incorrectly");
  }

  console.log("SARIF security gate test ok");
} finally {
  rmSync(temp, { recursive: true, force: true });
}

function run(sarif, allowlist) {
  return spawnSync(process.execPath, ["scripts/sarif-security-gate.mjs", sarif, `--allowlist=${allowlist}`], {
    cwd: root,
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 128 * 1024,
  });
}

function document(path, options = {}) {
  return {
    version: "2.1.0",
    runs: [{
      tool: { driver: { name: "CodeQL", rules: options.includeRules === false ? [] : [{
        id: "js/example-security-rule",
        properties: { tags: ["security"], "security-severity": "7.0" },
      }] } },
      results: [{
        ruleId: "js/example-security-rule",
        message: { text: "synthetic security finding" },
        locations: [{ physicalLocation: { artifactLocation: { uri: path }, region: { startLine: 7 } } }],
      }],
    }],
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
