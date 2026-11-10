import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PERSISTENT_MEMORY_FILE, readPersistentMemory } from "../src/local/agent-memory.mjs";
import { applyUpdateHunks } from "../src/local/patch.mjs";
import { BridgeError } from "../src/local/errors.mjs";
import { publicProcessToolResult } from "../src/local/process-result-projection.mjs";
import { extractWorkspaceOutline } from "../src/local/symbol-outline.mjs";
import { inspectSyntax, inspectSyntaxWarning, WorkspaceFileService } from "../src/local/workspace-file-service.mjs";
import { buildBrowserObservation, projectSetOfMarks, renderSetOfMarksSvg } from "../src/local/computer-use-observation.mjs";
import { ToolExecutor, validateToolArguments } from "../src/local/tool-executor.mjs";
import { MCP_TEXT_PROJECTION_KEY } from "../src/shared/result-projection.mjs";
import { CODE_MODE_SDK_RESOURCE_URI, HELP_RESOURCES, helpResourceMimeType, readHelpResource } from "../src/shared/help-resources.mjs";
import { CORE_CORNERSTONE_TOOL_NAMES, projectToolTypeScriptDeclarations } from "../src/shared/tool-groups.mjs";

test("projectToolTypeScriptDeclarations projects compact TypeScript SDK signatures for Code Mode and exposes them as an MCP resource", async () => {
  const catalog = JSON.parse(await readFile(new URL("../src/shared/tool-catalog.json", import.meta.url), "utf8"));
  const declarations = projectToolTypeScriptDeclarations(catalog, {
    toolNames: CORE_CORNERSTONE_TOOL_NAMES,
    namespace: "mbm",
  });
  assert.match(declarations, /^declare namespace mbm \{/);
  assert.match(declarations, /function read_file\(args: \{ path: string;/);
  assert.match(declarations, /function server_info\(args\?: \{ detail\?: "summary" \| "full" \}\): Promise<Record<string, unknown>>;/);
  assert.doesNotMatch(declarations, /function browser_action\(/);
  assert.equal(HELP_RESOURCES.some((item) => item.uri === CODE_MODE_SDK_RESOURCE_URI), true);
  assert.equal(helpResourceMimeType(CODE_MODE_SDK_RESOURCE_URI), "application/typescript");
  const sdkResource = readHelpResource(CODE_MODE_SDK_RESOURCE_URI);
  assert.match(String(sdkResource || ""), /^declare namespace mbm \{/);
  assert.match(String(sdkResource || ""), /function browser_action\(/);
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
    assert.match(String(inspectSyntaxWarning("broken.mjs", "export function broken() {\n  return 1;\n")), /^syntax_warning: /);
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

test("projectSetOfMarks projects deterministic marks with center coordinates, labels, and SVG overlay", () => {
  const elements = [
    { targetId: "btn-submit", role: "button", name: "Submit Form", bounds: { x: 100, y: 200, width: 80, height: 30 } },
    { targetId: "txt-input", role: "textbox", name: "Search", bounds: { x: 50, y: 50, width: 200, height: 30 } },
    { targetId: "no-bounds", role: "generic" },
  ];
  const marks = projectSetOfMarks(elements);
  assert.equal(marks.length, 2);
  assert.equal(marks[0].markId, 1);
  assert.equal(marks[0].targetId, "btn-submit");
  assert.equal(marks[0].center.x, 140);
  assert.equal(marks[0].center.y, 215);
  assert.match(marks[0].label, /button "Submit Form"/);

  assert.equal(marks[1].markId, 2);
  assert.equal(marks[1].targetId, "txt-input");
  assert.equal(marks[1].center.x, 150);
  assert.equal(marks[1].center.y, 65);

  const svg = renderSetOfMarksSvg(marks, { width: 1000, height: 600 });
  assert.match(svg, /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="1000" height="600"/);
  assert.match(svg, /stroke="#ef4444"/);
  assert.match(svg, />1<\/text>/);
  assert.match(svg, />2<\/text>/);

  // Viewport projection from browser semantic observation
  const obs = buildBrowserObservation({ viewport: { width: 800, height: 600 }, semantic: {} });
  assert.equal(obs.semantic?.viewport?.width, 800);
  assert.equal(obs.semantic?.viewport?.height, 600);
  const svg800 = renderSetOfMarksSvg(marks, {
    width: obs.semantic?.viewport?.width,
    height: obs.semantic?.viewport?.height,
  });
  assert.match(svg800, /width="800" height="600" viewBox="0 0 800 600"/);

  // The renderer is exported; callers other than projectSetOfMarks must not be able to
  // inject markup through a label or geometry value.
  const injected = renderSetOfMarksSvg([{
    markId: '"><script>alert(1)</script>',
    bounds: { x: '0" onload="alert(1)', y: 10, width: 20, height: 30 },
  }], { width: 100, height: 100 });
  assert.ok(!injected.includes("<script>"), "SoM SVG allowed an unescaped script element");
  assert.ok(!injected.includes('onload="'), "SoM SVG allowed an injected attribute");
  assert.ok(injected.includes("&lt;script&gt;"), "SoM SVG did not escape the mark label");
});

test("WorkspaceFileService enforces verify_syntax pre-commit gate on file write and edit", async () => {
  // The gate is only reachable if the public schema accepts the parameter.
  const schemaCheck = validateToolArguments("write_file", { path: "a.mjs", content: "export const x = 1;\n", verify_syntax: true });
  assert.equal(schemaCheck.valid, true, "write_file schema must accept verify_syntax");

  // Valid production syntax must never be reported as a warning.
  const validSamples = {
    "decorator.ts": "@Component({selector: \"a\"}) export class A {}\n",
    "accessor.ts": "class A { accessor x = 1; }\n",
    "jsx-in-js.js": "const A = () => <div>hi</div>;\n",
    "angle-assertion.ts": "const value = <string>input;\n",
    "satisfies.ts": "export const x = { a: 1 } satisfies Record<string, number>;\n",
    "using.ts": "function f() { using handle = open(); }\n",
    "guard.cjs": "if (true) return;\n",
  };
  for (const [file, content] of Object.entries(validSamples)) {
    assert.equal(inspectSyntaxWarning(file, content), null, `${file} was reported as invalid syntax`);
  }

  const temp = await mkdtemp(join(tmpdir(), "mbm-syntax-test-"));
  try {
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

    const brokenFile = join(temp, "broken.mjs");
    await assert.rejects(
      () => service.writeFile({ path: brokenFile, content: "function broken() {\n  return 1;\n", verify_syntax: true }),
      (err) => err?.code === "invalid_request" && err?.details?.reason === "syntax_gate_failure",
    );

    const invalidEsmFile = join(temp, "invalid-esm.mjs");
    await assert.rejects(
      () => service.writeFile({ path: invalidEsmFile, content: "export const x === 1;\n", verify_syntax: true }),
      (err) => err?.code === "invalid_request" && err?.details?.reason === "syntax_gate_failure",
    );

    const invalidCjsFile = join(temp, "invalid.cjs");
    await assert.rejects(
      () => service.writeFile({ path: invalidCjsFile, content: "await Promise.resolve();\n", verify_syntax: true }),
      (err) => err?.code === "invalid_request" && err?.details?.reason === "syntax_gate_failure",
    );

    const validCjsFile = join(temp, "valid.cjs");
    const validCjsRes = await service.writeFile({ path: validCjsFile, content: "if (true) return;\n", verify_syntax: true });
    assert.equal(validCjsRes.ok, true);

    const writeRes = await service.writeFile({ path: brokenFile, content: "export function valid() {\n  return 1;\n}\n", verify_syntax: true });
    assert.equal(writeRes.ok, true);

    await assert.rejects(
      () => service.editFile({ path: brokenFile, old_text: "return 1;\n}\n", new_text: "return 1;\n", verify_syntax: true }),
      (err) => err?.code === "invalid_request" && err?.details?.reason === "syntax_gate_failure",
    );

    // Without the opt-in gate the write still lands, but the result carries the warning and
    // an explicit status instead of silently claiming the file is valid.
    const softFile = join(temp, "soft.mjs");
    const soft = await service.writeFile({ path: softFile, content: "export const y === 2;\n" });
    assert.equal(soft.ok, true);
    assert.equal(soft.syntax_check, "warning");
    assert.ok(soft.warnings?.some((warning) => warning.includes("syntax_warning")));

    // Content above the validation ceiling is reported as skipped, never as valid.
    assert.equal(inspectSyntax("huge.mjs", "x".repeat(512 * 1024 + 1)).status, "skipped_too_large");
    await assert.rejects(
      () => service.writeFile({ path: join(temp, "huge.mjs"), content: "x".repeat(512 * 1024 + 1), verify_syntax: true }),
      (err) => err?.code === "invalid_request" && err?.details?.reason === "syntax_check_skipped_too_large",
    );
  } finally {
    await rm(temp, { recursive: true, force: true }).catch(() => {});
  }
});

test("ToolExecutor stuck-loop detector flags repeated identical failing calls", async () => {
  let callIndex = 0;
  const executor = new ToolExecutor({
    handlers: {
      git_status: async () => { throw new Error("git binary not found"); },
    },
    policyGate: { assert: () => {} },
    accountAccessGate: { authority: () => ({ principal: { role: "admin" } }) },
    callRegistry: {
      open: (ctx) => ({ callId: `c-${++callIndex}`, ...ctx }),
      finish: () => {},
      bindPrincipal: () => {},
      throwIfCancelled: () => {},
    },
    observability: { start: () => {}, finish: () => {} },
    logger: { event: () => {} },
    safeMessage: (err) => err.message,
  });

  await assert.rejects(
    () => executor.execute("git_status", {}),
    (err) => err.details?.stuck_loop_warning === undefined,
  );
  await assert.rejects(
    () => executor.execute("git_status", {}),
    (err) => err.details?.stuck_loop_warning === undefined,
  );
  await assert.rejects(
    () => executor.execute("git_status", {}),
    (err) => typeof err.details?.stuck_loop_warning === "string"
      && /3 consecutive identical calls/.test(err.details.stuck_loop_warning)
      && /Reflexion: Run git_status or git_diff/.test(err.details.stuck_loop_warning),
  );
});

test("ToolExecutor does not flag deterministic policy denials as stuck loops", async () => {
  let callIndex = 0;
  const executor = new ToolExecutor({
    handlers: {},
    policyGate: {
      assert: () => { throw new BridgeError("policy_denied", "tool is disabled by the active policy"); },
    },
    accountAccessGate: { authority: () => ({ principal: { role: "reviewer" } }) },
    callRegistry: {
      open: (ctx) => ({ callId: `d-${++callIndex}`, ...ctx }),
      finish: () => {},
      bindPrincipal: () => {},
      throwIfCancelled: () => {},
    },
    observability: { start: () => {}, finish: () => {} },
    logger: { event: () => {} },
  });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(
      () => executor.execute("browser_action", { action: "click" }),
      (err) => {
        assert.equal(err.code, "policy_denied");
        // A denied tool is outside the caller's catalog: no retry advice and no tool names
        // from the unavailable catalog may be disclosed.
        assert.equal(err.details?.stuck_loop_warning, undefined);
        return true;
      },
    );
  }
});
