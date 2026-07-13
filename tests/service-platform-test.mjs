import { windowsCommandLineArgument } from "../src/local/service.mjs";

assert(windowsCommandLineArgument("plain") === '"plain"', "plain Windows argument was not quoted");
assert(windowsCommandLineArgument("C:\\") === '"C:\\\\"', "trailing Windows path separator was not doubled before the closing quote");
assert(windowsCommandLineArgument('a\\"b') === '"a\\\\\\"b"', "backslashes before an embedded quote were not escaped with Windows CRT semantics");
assert(windowsCommandLineArgument("") === '""', "empty Windows argument was not preserved");
await expectReject(() => windowsCommandLineArgument("bad\0value"), "NUL byte");
console.log("service platform quoting test ok");

async function expectReject(operation, expected) {
  try { await operation(); } catch (error) {
    if (String(error?.message || error).includes(expected)) return;
    throw error;
  }
  throw new Error(`expected rejection containing ${expected}`);
}
function assert(condition, message) { if (!condition) throw new Error(message); }
