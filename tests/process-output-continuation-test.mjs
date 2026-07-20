import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeError, publicError } from "../src/local/errors.mjs";
import { ProcessExecutionService } from "../src/local/process-execution.mjs";
import { ProcessOutputStream } from "../src/local/process-output-stream.mjs";
import { ProcessSessionManager } from "../src/local/process-sessions.mjs";
import { ProcessTracker } from "../src/local/process-tracker.mjs";
import { toolResult } from "../src/local/tools.mjs";
import { textToolResult } from "../src/worker/mcp-jsonrpc.ts";

const root = await mkdtemp(join(tmpdir(), "mbm-process-output-test-"));
const tracker = new ProcessTracker();
const policy = {
  profile: "full",
  origin: "explicit",
  revision: 5,
  allowWrite: true,
  allowExec: true,
  execMode: "shell",
  unrestrictedPaths: true,
  minimalEnv: false,
  exposeAbsolutePaths: true,
};
const sessions = new ProcessSessionManager({
  workspace: root,
  policy,
  authorizeTool() {},
  runtimeDir: root,
  processTracker: tracker,
  resolveCwd: async () => root,
  displayPath: (value) => value,
  throwIfCancelled() {},
});
const service = new ProcessExecutionService({
  workspace: root,
  policy,
  policyGate: { assert() {} },
  runtimeDir: root,
  processTracker: tracker,
  resolveExistingPath: async () => root,
  resolveLocalCommand: async () => ({}),
  displayPath: (value) => value,
  throwIfCancelled() {},
  retainCompletedOutput: (value) => sessions.retainCompletedOutput(value),
});

try {
  testOutputStreamOffsets();
  testCompactProjection();
  await testSuccessfulContinuation();
  await testFailureContinuation();
  assert.equal(tracker.snapshot().active_processes, 0, "one-shot process tracking leaked after continuation tests");
  console.log("process output continuation test ok");
} finally {
  sessions.clear();
  await rm(root, { recursive: true, force: true });
}

function testOutputStreamOffsets() {
  const stream = new ProcessOutputStream(8);
  stream.append("012345");
  stream.append("6789");
  const first = stream.read(0, 4);
  assert.equal(first.start_offset, 2, "aged-out stream did not clamp to the retained start");
  assert.equal(first.data, "2345", "retained stream returned the wrong first page");
  assert.equal(first.truncated_before, true, "aged-out bytes were not disclosed");
  const second = stream.read(first.next_offset, 8);
  assert.equal(second.data, "6789", "retained stream continuation returned the wrong tail");
  assert.equal(second.truncated_after, false, "complete stream tail was reported as truncated");
}

function testCompactProjection() {
  const payload = { marker: "kept", ["line\nbreak".repeat(100)]: true, content: "x".repeat(64 * 1024) };
  for (const result of [toolResult(payload), textToolResult(payload)]) {
    assert.equal(result.structuredContent?.marker, "kept", "large structured content was not preserved");
    assert.match(result.content?.[0]?.text || "", /available in structuredContent/, "large result duplicated full JSON into MCP text content");
    assert(Buffer.byteLength(result.content[0].text) < 1024, "large result summary remained too large");
    assert(!result.content[0].text.includes("\n"), "large result summary preserved control characters from object keys");
  }
}

async function testSuccessfulContinuation() {
  const bodyBytes = 100_000;
  const raw = await service.runDirect({
    argv: [process.execPath, "-e", `process.stdout.write("A".repeat(${bodyBytes}) + "END-SUCCESS")`],
    timeout_seconds: 10,
  });
  const result = toolResult(raw);
  const structured = result.structuredContent;
  assert.equal(result.isError, false, "successful process result was marked as an error");
  assert.match(result.content[0].text, /Continue with read_process session/, "truncated process result omitted continuation guidance");
  assert(Buffer.byteLength(result.content[0].text) < 512, "process result text mirror remained verbose");
  assert(structured.stdout_truncated_bytes > 0, "large process output was not bounded inline");
  assert.equal(typeof structured.output_session_id, "string", "large process output did not create a continuation session");

  const page = await sessions.read({
    session_id: structured.output_session_id,
    stdout_offset: 0,
    stderr_offset: 0,
    max_bytes: 256 * 1024,
  });
  assert.equal(page.stdout.data.length, bodyBytes + "END-SUCCESS".length, "continuation did not retain the complete bounded output");
  assert(page.stdout.data.endsWith("END-SUCCESS"), "continuation lost the output tail");
  assert.equal(page.stdout.truncated_before, false, "sub-megabyte output incorrectly reported aged-out bytes");
}

async function testFailureContinuation() {
  const bodyBytes = 100_000;
  let failure;
  try {
    await service.runDirect({
      argv: [process.execPath, "-e", `process.stderr.write("E".repeat(${bodyBytes}) + "END-FAILURE"); process.exitCode = 7`],
      timeout_seconds: 10,
    });
  } catch (error) {
    failure = error;
  }
  assert(failure instanceof BridgeError && failure.code === "execution_failed", "nonzero process did not return a typed execution failure");
  assert(Buffer.byteLength(failure.message) <= 2300, "nonzero process expanded its stderr into an unbounded error message");
  const publicFailure = publicError(failure);
  const processDetails = publicFailure.details?.process;
  assert.equal(typeof processDetails?.output_session_id, "string", "failure details omitted the continuation session");
  assert(processDetails.stderr_truncated_bytes > 0, "failure details did not disclose inline truncation");

  const page = await sessions.read({
    session_id: processDetails.output_session_id,
    stdout_offset: 0,
    stderr_offset: 0,
    max_bytes: 256 * 1024,
  });
  assert(page.stderr.data.endsWith("END-FAILURE"), "failure continuation lost the stderr tail");
  assert.equal(page.exit_code, 7, "failure continuation lost the process exit code");
}
