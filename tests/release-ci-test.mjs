import { requireSuccessfulCiRun } from "../scripts/release-ci.mjs";

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

expectThrow(() => requireSuccessfulCiRun([], head), "no push-triggered CI run exists");
expectThrow(() => requireSuccessfulCiRun([{ ...success, status: "in_progress", conclusion: "" }], head), "is in_progress");
expectThrow(() => requireSuccessfulCiRun([{ ...success, conclusion: "failure" }], head), "concluded failure");
expectThrow(() => requireSuccessfulCiRun([
  success,
  { ...success, databaseId: 102, status: "in_progress", conclusion: "", createdAt: "2026-07-12T10:01:00Z" },
], head), "is in_progress");
expectThrow(() => requireSuccessfulCiRun([success], "invalid"), "release commit SHA is invalid");

console.log("release CI gate test ok");

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
