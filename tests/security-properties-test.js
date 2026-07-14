import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import {
  MAX_BROWSER_MESSAGE_BYTES,
  parseBrowserSocketMessage,
} from "../src/local/browser-extension-protocol.mjs";
import { allToolNames, normalizePolicy, toolsForPolicy } from "../src/local/policy.mjs";
import { MAX_COMMAND_BYTES, validateArgv } from "../src/local/process-sessions.mjs";
import { runExecutable } from "../src/local/shell.mjs";

fc.assert(fc.property(
  fc.uint8Array({ maxLength: 1024 }),
  (bytes) => {
    const result = parseBrowserSocketMessage(Buffer.from(bytes));
    assert(result && typeof result.ok === "boolean", "browser parser returned an invalid result shape");
    if (result.ok) assert(result.message && typeof result.message === "object" && !Array.isArray(result.message), "browser parser accepted a non-record message");
  },
), { numRuns: 2000, seed: 0x6d626d31 });
const oversize = parseBrowserSocketMessage(Buffer.alloc(MAX_BROWSER_MESSAGE_BYTES + 1));
assert(oversize.ok === false && oversize.code === 1009, "browser parser did not reject oversized input before decoding");

const profiles = ["review", "edit", "agent", "full", "custom", "", null, 42];
const modes = ["off", "direct", "shell", "invalid", null, 7];
const catalog = new Set(allToolNames());
fc.assert(fc.property(
  fc.record({
    profile: fc.constantFrom(...profiles),
    origin: fc.constantFrom("explicit", "untrusted-origin"),
    revision: fc.integer({ min: -1, max: 9 }),
    allowWrite: fc.boolean(),
    allowExec: fc.boolean(),
    execMode: fc.constantFrom(...modes),
    unrestrictedPaths: fc.boolean(),
    minimalEnv: fc.boolean(),
    exposeAbsolutePaths: fc.boolean(),
  }),
  (input) => {
    const policy = normalizePolicy(input);
    assert(Object.isFrozen(policy), "normalized policy is mutable");
    assert(policy.allowExec === (policy.execMode !== "off"), "policy allowExec and execMode diverged");
    const names = toolsForPolicy(policy).map((tool) => tool.name);
    assert(names.length === new Set(names).size, "policy exposed duplicate tools");
    assert(names.every((name) => catalog.has(name)), "policy exposed a tool outside the catalog");
  },
), { numRuns: 2000, seed: 0x6d626d32 });

const ascii = (minLength, maxLength) => fc.array(
  fc.integer({ min: 32, max: 126 }),
  { minLength, maxLength },
).map((characters) => String.fromCharCode(...characters));
const argvArbitrary = fc.tuple(
  ascii(1, 32),
  fc.array(ascii(0, 63), { maxLength: 15 }),
).map(([executable, rest]) => [executable, ...rest]);
fc.assert(fc.property(
  argvArbitrary,
  fc.nat(),
  (argv, selected) => {
    assert(JSON.stringify(validateArgv(argv)) === JSON.stringify(argv), "valid argv was not preserved exactly");
    const corrupted = [...argv];
    const index = selected % corrupted.length;
    corrupted[index] += "\0suffix";
    expectThrow(() => validateArgv(corrupted), "NUL");
  },
), { numRuns: 1000, seed: 0x6d626d33 });
expectThrow(() => validateArgv(Array.from({ length: 257 }, () => "x")), "1-256");
expectThrow(() => validateArgv(["x".repeat(MAX_COMMAND_BYTES)]), "maximum size");
expectThrow(() => runExecutable("bad\0command"), "NUL");
expectThrow(() => runExecutable(process.execPath, ["bad\0argument"]), "NUL");

const temp = mkdtempSync(join(tmpdir(), "mbm-executable-boundary-"));
try {
  const marker = join(temp, "must-not-exist");
  const payload = `$(touch ${marker}); echo injected`;
  const result = await runExecutable(process.execPath, ["-e", "process.stdout.write(process.argv[1])", payload], {
    capture: true,
    timeoutMs: 10_000,
  });
  assert(result.stdout === payload, "executable runner changed argv through shell interpretation");
  assert(!existsSync(marker), "executable runner evaluated shell syntax from an argv value");
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log("security property tests ok (fast-check browser protocol, policy, argv, executable boundary)");

function expectThrow(callback, pattern) {
  try { callback(); } catch (error) {
    if (String(error?.message || error).includes(pattern)) return;
    throw error;
  }
  throw new Error(`expected rejection containing: ${pattern}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
