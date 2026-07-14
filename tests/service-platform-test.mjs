import { runServiceCommand, windowsCommandLineArgument } from "../src/local/service.mjs";
import { waitForInactiveStatus } from "../src/local/service-convergence.mjs";

assert(windowsCommandLineArgument("plain") === '"plain"', "plain Windows argument was not quoted");
assert(windowsCommandLineArgument("C:\\") === '"C:\\\\"', "trailing Windows path separator was not doubled before the closing quote");
assert(windowsCommandLineArgument('a\\"b') === '"a\\\\\\"b"', "backslashes before an embedded quote were not escaped with Windows CRT semantics");
assert(windowsCommandLineArgument("") === '""', "empty Windows argument was not preserved");
await expectReject(() => windowsCommandLineArgument("bad\0value"), "NUL byte");

const serviceInvocation = await runServiceCommand("synthetic-service", ["status"], async (command, args, options) => ({ command, args, options }));
assert(serviceInvocation.command === "synthetic-service" && serviceInvocation.args[0] === "status", "service command adapter changed executable or argv");
assert(serviceInvocation.options.capture === true && serviceInvocation.options.allowFailure === true && serviceInvocation.options.maxOutputBytes === 64 * 1024, "service command adapter lost bounded failure-capturing options");
await delayedLaunchdStopTest();
await stuckLaunchdStopTest();
console.log("service platform quoting test ok");

async function delayedLaunchdStopTest() {
  const statuses = [{ active: true }, { active: true }, { active: false }];
  const sleeps = [];
  const result = await waitForInactiveStatus(
    async () => statuses.shift(),
    { attempts: 5, delayMs: 25, sleep: async milliseconds => sleeps.push(milliseconds) },
  );
  assert(result.active === false, "launchd stop polling did not observe delayed inactivity");
  assert(sleeps.join(",") === "25,25", "launchd stop polling used an unexpected retry schedule");
}

async function stuckLaunchdStopTest() {
  let reads = 0;
  const result = await waitForInactiveStatus(
    async () => { reads += 1; return { active: true }; },
    { attempts: 3, delayMs: 1, sleep: async () => {} },
  );
  assert(result.active === true, "launchd stop polling fabricated an inactive state");
  assert(reads === 3, "launchd stop polling exceeded its bounded attempt count");
}

async function expectReject(operation, expected) {
  try { await operation(); } catch (error) {
    if (String(error?.message || error).includes(expected)) return;
    throw error;
  }
  throw new Error(`expected rejection containing ${expected}`);
}
function assert(condition, message) { if (!condition) throw new Error(message); }
