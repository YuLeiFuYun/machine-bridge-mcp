import { requireSuccessfulCiRun, requireSuccessfulWorkflowRun, waitForSuccessfulWorkflowRun } from "../scripts/release-ci.mjs";

const head = "a".repeat(40);
const other = "b".repeat(40);
const success = {
  databaseId: 101,
  status: "completed",
  conclusion: "success",
  headSha: head,
  event: "push",
  createdAt: "2026-07-12T10:00:00Z",
  url: "https://example.com/actions/runs/101",
};

const selected = requireSuccessfulCiRun([
  { ...success, databaseId: 99, headSha: other },
  { ...success, databaseId: 100, event: "pull_request" },
  success,
], head);
assert(selected.databaseId === 101, "successful head push run was not selected");
assert(requireSuccessfulWorkflowRun([success], head, "CodeQL").databaseId === 101, "named release workflow was not selected");

expectThrow(() => requireSuccessfulCiRun([], head), "no push-triggered CI run exists");
expectThrow(() => requireSuccessfulWorkflowRun([], head, "OpenSSF Scorecard"), "no push-triggered OpenSSF Scorecard run exists");
expectThrow(() => requireSuccessfulCiRun([{ ...success, status: "in_progress", conclusion: "" }], head), "is in_progress");
expectThrow(() => requireSuccessfulCiRun([{ ...success, conclusion: "failure" }], head), "concluded failure");
expectThrow(() => requireSuccessfulCiRun([
  success,
  { ...success, databaseId: 102, status: "in_progress", conclusion: "", createdAt: "2026-07-12T10:01:00Z" },
], head), "is in_progress");
expectThrow(() => requireSuccessfulCiRun([success], "invalid"), "release commit SHA is invalid");

await testWaitsFromMissingAndPendingToSuccess();
await testNewestExactRunWinsWhileWaiting();
await testTerminalFailureFailsImmediately();
await testDeadlineExpiresWithoutExactRun();
await testDeadlineExpiredBeforeFirstLoad();

console.log("release CI gate test ok");

async function testWaitsFromMissingAndPendingToSuccess() {
  let now = 0;
  let index = 0;
  const states = [
    [],
    [{ ...success, databaseId: 201, status: "queued", conclusion: "", createdAt: "2026-07-12T10:02:00Z" }],
    [{ ...success, databaseId: 201, createdAt: "2026-07-12T10:02:00Z" }],
  ];
  const selectedRun = await waitForSuccessfulWorkflowRun(
    async () => states[Math.min(index++, states.length - 1)], head, "CI",
    { deadlineMs: 30, pollIntervalMs: 10, now: () => now, wait: async (ms) => { now += ms; } },
  );
  assert(selectedRun.databaseId === 201, "waiter did not continue from missing/queued state to exact-run success");
  assert(index === 3, "waiter did not use bounded polling progression");
}

async function testNewestExactRunWinsWhileWaiting() {
  let now = 0;
  let index = 0;
  const newerPending = { ...success, databaseId: 202, status: "in_progress", conclusion: "", createdAt: "2026-07-12T10:03:00Z" };
  const newerSuccess = { ...newerPending, status: "completed", conclusion: "success" };
  const selectedRun = await waitForSuccessfulWorkflowRun(
    async () => index++ === 0 ? [success, newerPending] : [success, newerSuccess], head, "CI",
    { deadlineMs: 20, pollIntervalMs: 10, now: () => now, wait: async (ms) => { now += ms; } },
  );
  assert(selectedRun.databaseId === 202, "older exact-run success masked a newer exact-run state");
}

async function testTerminalFailureFailsImmediately() {
  let waits = 0;
  await expectReject(
    () => waitForSuccessfulWorkflowRun(
      async () => [{ ...success, databaseId: 203, conclusion: "failure", createdAt: "2026-07-12T10:04:00Z" }],
      head, "CI", { deadlineMs: 100, pollIntervalMs: 10, now: () => 0, wait: async () => { waits += 1; } },
    ),
    "concluded failure",
  );
  assert(waits === 0, "terminal workflow failure was polled instead of failing closed");
}

async function testDeadlineExpiresWithoutExactRun() {
  let now = 0;
  let loads = 0;
  await expectReject(
    () => waitForSuccessfulWorkflowRun(
      async () => { loads += 1; return [{ ...success, headSha: other }]; },
      head, "CI", { deadlineMs: 20, pollIntervalMs: 10, now: () => now, wait: async (ms) => { now += ms; } },
    ),
    "before the finite CI wait deadline",
  );
  assert(loads === 2, "finite deadline allowed an extra query after expiry");
  assert(now === 20, "finite deadline accounting drifted");
}

async function testDeadlineExpiredBeforeFirstLoad() {
  let loads = 0;
  await expectReject(
    () => waitForSuccessfulWorkflowRun(
      async () => { loads += 1; return [success]; },
      head, "CI", { deadlineMs: 0, pollIntervalMs: 10, now: () => 0, wait: async () => {} },
    ),
    "before the finite CI wait deadline",
  );
  assert(loads === 0, "expired shared deadline allowed a first workflow query");
}

async function expectReject(callback, expected) {
  try { await callback(); } catch (error) {
    if (String(error?.message || error).includes(expected)) return;
    throw error;
  }
  throw new Error(`expected rejection containing: ${expected}`);
}


function expectThrow(callback, expected) {
  try { callback(); } catch (error) {
    if (String(error?.message || error).includes(expected)) return;
    throw error;
  }
  throw new Error(`expected throw containing: ${expected}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
