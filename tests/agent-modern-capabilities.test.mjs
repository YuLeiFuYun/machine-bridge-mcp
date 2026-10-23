import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PERSISTENT_MEMORY_FILE, readPersistentMemory } from "../src/local/agent-memory.mjs";
import { applyUpdateHunks } from "../src/local/patch.mjs";
import { publicProcessToolResult } from "../src/local/process-result-projection.mjs";
import { extractWorkspaceOutline } from "../src/local/symbol-outline.mjs";
import { inspectSyntaxWarning, WorkspaceFileService } from "../src/local/workspace-file-service.mjs";
import { MCP_TEXT_PROJECTION_KEY } from "../src/shared/result-projection.mjs";
import { CORE_CORNERSTONE_TOOL_NAMES, projectToolTypeScriptDeclarations } from "../src/shared/tool-groups.mjs";

test("projectToolTypeScriptDeclarations projects compact TypeScript SDK signatures for Code Mode", async () => {
  const catalog = JSON.parse(await readFile(new URL("../src/shared/tool-catalog.json", import.meta.url), "utf8"));
  const declarations = projectToolTypeScriptDeclarations(catalog, {
    toolNames: CORE_CORNERSTONE_TOOL_NAMES,
    namespace: "mbm",
  });
  assert.match(declarations, /^declare namespace mbm \{/);
  assert.match(declarations, /function read_file\(args: \{ path: string;/);
  assert.match(declarations, /function server_info\(args\?: \{ detail\?: "summary" \| "full" \}\): Promise<Record<string, unknown>>;/);
  assert.doesNotMatch(declarations, /function browser_action\(/);
});

test("publicProcessToolResult provides SRE diagnostics and interactive prompt stall detection", () => {
  const res = publicProcessToolResult({
    code: 60,
    stdout: "",
    stderr: "curl: (60) SSL certificate problem: unable to get local issuer certificate",
  });
  const text = String(res[MCP_TEXT_PROJECTION_KEY] || "");
  assert.match(text, /\[SRE Advisory: Certificate verification failed/);
  assert.doesNotMatch(text, /Authorized Diagnostics Context/);

  const promptRes = publicProcessToolResult({ code: 1, stdout: "Proceed with installation? [y/N] ", stderr: "" });
  assert.match(String(promptRes[MCP_TEXT_PROJECTION_KEY] || ""), /\[SRE Advisory: Process output ended at an interactive prompt/);
});

test("extractWorkspaceOutline extracts bounded repository symbol topology", async () => {
  const temp = await mkdtemp(join(tmpdir(), "mbm-outline-test-"));
  try {
    await writeFile(join(temp, "sample.mjs"), "export function alpha() {}\nexport class Beta {\n  gamma() {}\n}\n", "utf8");
    const result = await extractWorkspaceOutline(temp, { maxFiles: 10, maxLines: 50 });
    assert.equal(result.filesScanned, 1);
    assert.match(result.outline, /function alpha/);
    assert.match(result.outline, /class Beta/);
  } finally {
    await rm(temp, { recursive: true, force: true }).catch(() => {});
  }
});

test("readPersistentMemory enforces canonical read-only projection, deduplication, expiry filtering, and symlink rejection", async () => {
  const temp = await mkdtemp(join(tmpdir(), "mbm-agent-memory-test-"));
  try {
    await mkdir(join(temp, ".project-local"), { recursive: true });
    await writeFile(join(temp, PERSISTENT_MEMORY_FILE), JSON.stringify({
      version: 1,
      updated_at: "2026-10-21T00:00:00.000Z",
      project_insights: [
        { text: "Always run architecture tests before committing.", importance: 9, source: "unit-test" },
        { text: "Always run architecture tests before committing.", importance: 5 },
        { text: "Expired insight", expires_at: "2020-01-01T00:00:00.000Z" },
      ],
    }), "utf8");

    const readBack = await readPersistentMemory(temp);
    assert.equal(readBack?.status, "ok");
    assert.equal(readBack.project_insights.length, 1);
    assert.equal(readBack.project_insights[0].text, "Always run architecture tests before committing.");
    assert.equal(readBack.project_insights[0].importance, 9);

    const symTemp = await mkdtemp(join(tmpdir(), "mbm-agent-memory-sym-"));
    try {
      await symlink(join(temp, ".project-local"), join(symTemp, ".project-local"));
      const symRead = await readPersistentMemory(symTemp);
      assert.equal(symRead?.status, "unavailable");
    } finally {
      await rm(symTemp, { recursive: true, force: true }).catch(() => {});
    }
  } finally {
    await rm(temp, { recursive: true, force: true }).catch(() => {});
  }
});

test("WorkspaceFileService and applyUpdateHunks handle line ending invariance, relative-indent patches, syntax warnings, and near-miss hints", async () => {
  const temp = await mkdtemp(join(tmpdir(), "mbm-file-test-"));
  try {
    const filePath = join(temp, "crlf.txt");
    await writeFile(filePath, "line1\r\nline2\r\nline3\r\n", "utf8");
    const service = new WorkspaceFileService({
      workspace: temp,
      policy: { allowWrites: true },
      policyGate: { assert: () => {} },
      resolveExistingPath: async (p) => p,
      resolveWritePath: async (p) => p,
      displayPath: (p) => p,
      throwIfCancelled: () => {},
      withMutationPaths: async (_paths, fn) => fn(),
    });
    const numbered = await service.readFile({ path: filePath, with_line_numbers: true });
    assert.match(numbered.content, /1\s+\|\s+line1/);
    assert.match(numbered.content, /2\s+\|\s+line2/);

    const editRes = await service.editFile({ path: filePath, old_text: "line1\nline2", new_text: "updated1\nupdated2" });
    assert.equal(editRes.replacements, 1);
    const rawAfter = await readFile(filePath, "utf8");
    assert.match(rawAfter, /updated1\r\nupdated2\r\nline3\r\n/);

    const patchedIndent = applyUpdateHunks("    if (ready) {\n      runTask();\n    }\n", [{
      lines: [
        { type: " ", text: "  if (ready) {" },
        { type: "-", text: "    runTask();" },
        { type: "+", text: "    runVerifiedTask();" },
        { type: " ", text: "  }" },
      ],
    }]);
    assert.equal(patchedIndent, "    if (ready) {\n      runVerifiedTask();\n    }\n");
    assert.match(String(inspectSyntaxWarning("broken.mjs", "export function broken() {\n  return 1;\n")), /unclosed delimiter/);
    assert.equal(inspectSyntaxWarning("valid.mjs", "export function valid() {\n  return 1;\n}\n"), null);

    await assert.rejects(
      () => service.editFile({ path: filePath, old_text: "updated1\nupdated_typo", new_text: "noop" }),
      (err) => err?.code === "not_found"
        && err?.details?.candidate_lines?.start === 1
        && /1\s+\|\s+updated1/.test(String(err?.details?.candidate_snippet || "")),
    );
  } finally {
    await rm(temp, { recursive: true, force: true }).catch(() => {});
  }
});
