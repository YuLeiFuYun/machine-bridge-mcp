import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  writeFileSync(sarif, JSON.stringify(document("src/local/other.mjs")));
  const wrongPath = run(sarif, allowlist);
  assert(wrongPath.status !== 0, "accepted finding incorrectly matched a different path");
  console.log("SARIF security gate test ok");
} finally {
  rmSync(temp, { recursive: true, force: true });
}

function run(sarif, allowlist) {
  return spawnSync(process.execPath, ["scripts/sarif-security-gate.mjs", sarif, `--allowlist=${allowlist}`], {
    cwd: root,
    encoding: "utf8",
  });
}

function document(path) {
  return {
    version: "2.1.0",
    runs: [{
      tool: { driver: { name: "CodeQL", rules: [{
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
