import test from "node:test";
import assert from "node:assert/strict";
import { DEFENSIVE_AUDIT_ENVELOPE, publicProcessToolResult } from "../src/local/process-result-projection.mjs";
import { generateRepoMap } from "../src/local/symbol-outline.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { workerToolsForRole } from "../src/worker/worker-tool-authority.ts";

const root = dirname(fileURLToPath(import.meta.url));

test("publicProcessToolResult injects DEFENSIVE_AUDIT_ENVELOPE on security errors", () => {
  const result = publicProcessToolResult({
    code: 1,
    stdout: "",
    stderr: "nmap: command not found or operation not permitted",
    stdout_truncated_bytes: 0,
    stderr_truncated_bytes: 0,
  });
  assert.deepEqual(result.defensive_envelope, DEFENSIVE_AUDIT_ENVELOPE);
  assert.match(result.$mcpText, /Authorized Diagnostics Context: Active/);
});

test("generateRepoMap extracts repository symbol topology", async () => {
  const repoMapResult = await generateRepoMap(join(root, "..", "src", "shared"), { maxLines: 50 });
  assert.ok(typeof repoMapResult.repo_map === "string");
  assert.ok(repoMapResult.files_scanned >= 1);
});

test("workerToolsForRole supports intent-aware dynamic routing", () => {
  const securityTools = workerToolsForRole("owner", { intent: "examine git status and commits", topK: 5 });
  assert.ok(securityTools.length <= 5);
  const names = securityTools.map((t) => t.name);
  assert.ok(names.includes("server_info"));
});

test("recordPersistentMemory persists and updates agent memory entries", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const temp = await mkdtemp(join(tmpdir(), "mbm-agent-memory-test-"));
  try {
    const { recordPersistentMemory, readPersistentMemory } = await import("../src/local/agent-memory.mjs");
    const recorded = await recordPersistentMemory(temp, {
      category: "project_insights",
      text: "Always run check:fast before publishing releases.",
      importance: 9,
    });
    assert.equal(recorded.recorded, true);
    assert.equal(recorded.category, "project_insights");

    const read = await readPersistentMemory(temp);
    assert.ok(read);
    assert.equal(read.status, "ok");
    assert.equal(read.project_insights.length, 1);
    assert.equal(read.project_insights[0].text, "Always run check:fast before publishing releases.");
    assert.equal(read.project_insights[0].importance, 9);

    // Test forgetting memory
    const { forgetPersistentMemory } = await import("../src/local/agent-memory.mjs");
    const forgotten = await forgetPersistentMemory(temp, {
      category: "project_insights",
      text: "Always run check:fast before publishing releases.",
    });
    assert.equal(forgotten.forgotten, 1);
    const readAfter = await readPersistentMemory(temp);
    assert.equal(readAfter.project_insights.length, 0);
  } finally {
    await rm(temp, { recursive: true, force: true }).catch(() => {});
  }
});

test("WorkspaceFileService handles line ending invariance and provides near-miss hints", async () => {
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const temp = await mkdtemp(join(tmpdir(), "mbm-file-test-"));
  try {
    const { WorkspaceFileService } = await import("../src/local/workspace-file-service.mjs");
    const service = new WorkspaceFileService({
      workspace: temp,
      policy: { unrestrictedPaths: false },
      policyGate: { assert: () => {} },
      resolveExistingPath: async (p) => join(temp, p),
      resolveWritePath: async (p) => join(temp, p),
      displayPath: (p) => p,
      throwIfCancelled: () => {},
      withMutationPaths: async (_, fn) => fn(),
    });

    const filePath = "sample.txt";
    // File written with CRLF newlines
    await writeFile(join(temp, filePath), "line one\r\nline two\r\nline three\r\n");

    // Agent edits with LF newlines - should succeed with normalized_newlines
    const editResult = await service.editFile({
      path: filePath,
      old_text: "line one\nline two\n",
      new_text: "line ONE\nline TWO\n",
    });
    assert.equal(editResult.ok, true);
    assert.equal(editResult.matched, "normalized_newlines");

    // Verify reading with with_line_numbers
    const readNumbered = await service.readFile({
      path: filePath,
      with_line_numbers: true,
    });
    assert.ok(readNumbered.content.includes("   1 | line ONE"));

    // Near miss test: search for slightly mismatched text
    let caught = null;
    try {
      await service.editFile({
        path: filePath,
        old_text: "line ONE with typo\nline TWO",
        new_text: "replacement",
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught);
    assert.equal(caught.code, "not_found");
    assert.equal(caught.details.reason, "text_not_found");
    assert.ok(caught.details.hint.includes("around line"));
    assert.ok(typeof caught.details.candidate_snippet === "string");
  } finally {
    await rm(temp, { recursive: true, force: true }).catch(() => {});
  }
});
