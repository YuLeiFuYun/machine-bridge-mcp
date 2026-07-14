import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_BROWSER_MESSAGE_BYTES,
  parseBrowserSocketMessage,
} from "../src/local/browser-extension-protocol.mjs";
import { allToolNames, normalizePolicy, toolsForPolicy } from "../src/local/policy.mjs";
import { MAX_COMMAND_BYTES, validateArgv } from "../src/local/process-sessions.mjs";
import { runExecutable } from "../src/local/shell.mjs";

const random = xorshift32(0x6d626d31);
for (let index = 0; index < 2000; index += 1) {
  const length = random() % 1024;
  const bytes = Buffer.alloc(length);
  for (let offset = 0; offset < length; offset += 1) bytes[offset] = random() & 0xff;
  const result = parseBrowserSocketMessage(bytes);
  assert(result && typeof result.ok === "boolean", "browser parser returned an invalid result shape");
  if (result.ok) assert(result.message && typeof result.message === "object" && !Array.isArray(result.message), "browser parser accepted a non-record message");
}
const oversize = parseBrowserSocketMessage(Buffer.alloc(MAX_BROWSER_MESSAGE_BYTES + 1));
assert(oversize.ok === false && oversize.code === 1009, "browser parser did not reject oversized input before decoding");

const profiles = ["review", "edit", "agent", "full", "custom", "", null, 42];
const modes = ["off", "direct", "shell", "invalid", null, 7];
const catalog = new Set(allToolNames());
for (let index = 0; index < 2000; index += 1) {
  const input = {
    profile: profiles[random() % profiles.length],
    origin: random() % 2 ? "explicit" : "untrusted-origin",
    revision: random() % 3 ? random() % 10 : -1,
    allowWrite: Boolean(random() & 1),
    allowExec: Boolean(random() & 1),
    execMode: modes[random() % modes.length],
    unrestrictedPaths: Boolean(random() & 1),
    minimalEnv: Boolean(random() & 1),
    exposeAbsolutePaths: Boolean(random() & 1),
  };
  const policy = normalizePolicy(input);
  assert(Object.isFrozen(policy), "normalized policy is mutable");
  assert(policy.allowExec === (policy.execMode !== "off"), "policy allowExec and execMode diverged");
  const names = toolsForPolicy(policy).map((tool) => tool.name);
  assert(names.length === new Set(names).size, "policy exposed duplicate tools");
  assert(names.every((name) => catalog.has(name)), "policy exposed a tool outside the catalog");
}

for (let index = 0; index < 1000; index += 1) {
  const count = 1 + random() % 16;
  const argv = Array.from({ length: count }, (_, item) => randomAscii(random, item === 0 ? 1 + random() % 32 : random() % 64));
  assert(JSON.stringify(validateArgv(argv)) === JSON.stringify(argv), "valid argv was not preserved exactly");
  const corrupted = [...argv];
  corrupted[random() % corrupted.length] += "\0suffix";
  expectThrow(() => validateArgv(corrupted), "NUL");
}
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

console.log("security property tests ok (browser protocol, policy, argv, executable boundary)");

function xorshift32(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function randomAscii(randomValue, length) {
  let value = "";
  for (let index = 0; index < length; index += 1) value += String.fromCharCode(32 + randomValue() % 95);
  return value || "x";
}

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
