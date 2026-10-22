import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { AgentContextManager } from "../../../src/local/agent-context.mjs";
import { readPersistentMemory } from "../../../src/local/agent-memory.mjs";
import { extractSymbolOutline, extractWorkspaceOutline } from "../../../src/local/symbol-outline.mjs";
import { applyUpdateHunks } from "../../../src/local/patch.mjs";
import { BridgeError } from "../../../src/local/errors.mjs";

const root = await realpath(await mkdtemp(join(tmpdir(), "mbm-agent-audit-")));
const failures = [];
async function check(name, fn) {
  try { await fn(); console.log(`ok ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`); }
}
try {
  const workspace = join(root, "workspace");
  const nested = join(workspace, "nested");
  const home = join(root, "home");
  const codexHome = join(home, ".codex");
  await mkdir(join(workspace, ".git"), { recursive: true });
  await mkdir(nested, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await writeFile(join(codexHome, "AGENTS.md"), "global ".repeat(2000));
  await writeFile(join(workspace, "AGENTS.md"), "project ".repeat(3500));
  await writeFile(join(nested, "AGENTS.md"), "nearest mandatory rule");
  const manager = new AgentContextManager({ workspace, home, codexHome, policy: { unrestrictedPaths: true },
    displayPath: (path) => relative(workspace, path), resolveExistingPath: async (path) => join(workspace, path) });
  await check("nearest instruction survives budget", async () => {
    const result = await manager.agentContext({ path: "nested" });
    assert(result.effective_instructions.includes("nearest mandatory rule"));
    assert(result.effective_instructions.includes("project project"));
    assert(!result.effective_instructions.includes("global global"));
    assert(result.instruction_warnings.length > 0);
    assert(result.instruction_files.reduce((n, x) => n + x.bytes, 0) <= 32768);
  });
  const memoryDir = join(workspace, ".project-local");
  const memoryPath = join(memoryDir, "agent-memory.json");
  await mkdir(memoryDir);
  await check("oversized memory is rejected without body", async () => {
    await writeFile(memoryPath, JSON.stringify({ version: 1, notes: ["x".repeat(200000)] }));
    const result = await readPersistentMemory(workspace);
    assert.equal(result.status, "too_large");
    assert(JSON.stringify(result).length < 1024);
  });
  await check("memory rejects parent symlink escape", async () => {
    await rm(memoryDir, { recursive: true });
    const outside = join(root, "outside"); await mkdir(outside);
    await writeFile(join(outside, "agent-memory.json"), JSON.stringify({ version: 1, notes: ["private sentinel"] }));
    await symlink(outside, memoryDir, "dir");
    try {
      const result = await manager.agentContext();
      assert.equal(result.persistent_memory.status, "unavailable");
      assert(!JSON.stringify(result).includes("private sentinel"));
    } finally { await rm(memoryDir); await mkdir(memoryDir); }
  });
  await check("memory rejects hard links", async () => {
    const original = join(root, "memory-source.json");
    await writeFile(original, JSON.stringify({ version: 1, notes: ["linked sentinel"] }));
    await rm(memoryPath, { force: true });
    await link(original, memoryPath);
    const result = await readPersistentMemory(workspace);
    assert.equal(result.status, "unavailable");
    assert(!JSON.stringify(result).includes("linked sentinel"));
    await rm(memoryPath);
  });
  await check("memory validates finite timestamp", async () => {
    await writeFile(memoryPath, JSON.stringify({ version: 1, notes: [{ text: "invalid", timestamp: 1e300 }] }));
    assert.equal((await readPersistentMemory(workspace)).status, "invalid");
  });
  await check("memory output is canonical and bounded", async () => {
    const notes = Array.from({ length: 20 }, (_, i) => ({ text: `${i}: ${"x".repeat(1900)}`, importance: 5 }));
    await writeFile(memoryPath, JSON.stringify({ version: 1, notes }));
    const result = await readPersistentMemory(workspace);
    assert.equal(result.status, "ok"); assert(result.truncated);
    assert.equal(result.scored_memories, undefined);
    assert(JSON.stringify(result).length < 18000);
    assert.equal(result.notes[0].updated_at, undefined);
  });
  await check("cancellation is not swallowed", async () => {
    let cancelled = false;
    await assert.rejects(readPersistentMemory(workspace, () => { if (cancelled) throw new BridgeError("cancelled", "cancelled"); }, async () => { cancelled = true; }), { code: "cancelled" });
  });
  const symbols = join(workspace, "symbols"); await mkdir(symbols);
  const source = Array.from({ length: 100 }, (_, i) => `export function f${i}(secret = "literal sentinel") {}`).join("\n");
  const file = join(symbols, "a.js"); await writeFile(file, source);
  await writeFile(join(symbols, "b.js"), "export function other() {}\n");
  await check("single file respects total line budget and redacts defaults", async () => {
    const text = await extractSymbolOutline(file, { maxLines: 10, displayPath: () => "a.js" });
    assert(text.split("\n").length <= 10);
    assert(!text.includes(root)); assert(!text.includes("literal sentinel"));
  });
  await check("directory reports file truncation", async () => {
    const result = await extractWorkspaceOutline(symbols, { maxFiles: 1, maxLines: 10 });
    assert(result.truncated); assert(result.outline.split("\n").length <= 10);
  });
  await check("directory traversal is bounded", async () => {
    for (let i = 0; i < 20; i++) await mkdir(join(symbols, `dir${i}`));
    const result = await extractWorkspaceOutline(symbols, { maxEntries: 5 });
    assert(result.visitedEntries <= 5); assert(result.truncated);
  });
  await check("outline honors per-file policy and hard-link guard", async () => {
    await link(file, join(symbols, "linked.js"));
    const result = await extractWorkspaceOutline(symbols, { assertPath: (path) => { if (path.endsWith("a.js")) throw new Error("denied"); } });
    assert(!result.outline.includes("f99")); assert(result.truncated);
  });
  await check("patch refuses semantic indentation mismatch", async () => {
    const original = "if condition:\n    if nested:\n        work()\n";
    assert.throws(() => applyUpdateHunks(original, [{ lines: [{ type: "-", text: "if condition:" }, { type: "-", text: "if nested:" }, { type: "-", text: "work()" }, { type: "+", text: "replacement()" }] }]), { code: "conflict" });
    assert.equal(original, "if condition:\n    if nested:\n        work()\n");
  });
} finally { await rm(root, { recursive: true, force: true }); }
if (failures.length) throw new Error(`${failures.length} agent audit regressions failed: ${failures.join(", ")}`);
