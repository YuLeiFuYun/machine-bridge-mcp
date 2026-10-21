import assert from "node:assert/strict";
import { PROGRESS_BACKOFF_MS, createProgressReporter, formatElapsed } from "../src/shared/progress-reporter.mjs";
import { progressNotification } from "../src/shared/mcp-protocol.mjs";

let clock = 0;
let scheduled = [];
const emitted = [];
const schedule = (callback, delay) => {
  scheduled.push({ callback, delay });
  return { unref() {} };
};
const cancel = (handle) => { scheduled = scheduled.filter((entry) => entry !== handle); };
const tick = () => {
  const next = scheduled.shift();
  assert(next, "progress reporter did not schedule the next report");
  next.callback();
  return next.delay;
};

const stop = createProgressReporter({
  progressToken: "tok-1",
  emit: (notification) => emitted.push(notification),
  now: () => clock,
  schedule,
  cancel,
  label: "read_job",
});

assert.equal(scheduled.length, 1, "progress reporter must schedule exactly one pending report");
assert.equal(scheduled[0].delay, PROGRESS_BACKOFF_MS[0], "first progress report must use the shortest delay");
assert.equal(emitted.length, 0, "progress must not fire before the first delay elapses");

clock = 1000;
tick();
assert.equal(emitted.length, 1, "progress was not reported after the first delay");
assert.equal(emitted[0].progressToken, "tok-1", "progress report lost the client token");
assert.equal(emitted[0].progress, 1000, "progress must report elapsed milliseconds");
assert.match(emitted[0].message, /read_job still running \(1s\)/, "progress message did not describe the elapsed time");
assert.equal(scheduled[0].delay, PROGRESS_BACKOFF_MS[1], "progress backoff did not widen after the first report");

clock = 3000;
tick();
assert.equal(emitted[1].progress, 3000, "progress did not advance monotonically");

clock = 7000;
tick();
clock = 15000;
tick();
clock = 31000;
tick();
clock = 61000;
tick();
assert.equal(scheduled[0].delay, PROGRESS_BACKOFF_MS.at(-1), "progress backoff did not cap at the longest delay");
assert.equal(emitted.at(-1).progress, 61000, "progress stopped advancing under the capped backoff");
assert.match(emitted.at(-1).message, /1m1s/, "long-running progress message did not switch to minute formatting");

stop();
stop();
const emittedBeforeStop = emitted.length;
scheduled = [];
assert.equal(emitted.length, emittedBeforeStop, "stopping the reporter emitted another report");

const stoppedReports = [];
const stoppedTimers = [];
const stopWithPending = createProgressReporter({
  progressToken: 7,
  emit: (notification) => stoppedReports.push(notification),
  now: () => clock,
  schedule: (callback, delay) => { stoppedTimers.push({ callback, delay }); return { unref() {} }; },
  cancel: () => {},
});
stopWithPending();
clock = 999_000;
stoppedTimers[0].callback();
assert.equal(stoppedReports.length, 0, "a stopped reporter still emitted progress for an already-scheduled report");

const inert = createProgressReporter({ progressToken: undefined, emit: () => { throw new Error("must not be called"); } });
inert();
const inertNull = createProgressReporter({ progressToken: null, emit: () => { throw new Error("must not be called"); } });
inertNull();

const rollbackReports = [];
const rollbackTimers = [];
let rollbackClock = 5000;
const stopRollback = createProgressReporter({
  progressToken: "wall-clock-rollback",
  emit: (notification) => rollbackReports.push(notification),
  now: () => rollbackClock,
  schedule: (callback) => { rollbackTimers.push(callback); return { unref() {} }; },
  cancel: () => {},
});
rollbackClock = 6000;
rollbackTimers.shift()();
rollbackClock = 5500;
rollbackTimers.shift()();
assert.deepEqual(rollbackReports.map((notification) => notification.progress), [1000, 1001],
  "progress values must remain monotonic if the injected clock moves backwards");
stopRollback();

const tolerantTimers = [];
const tolerant = createProgressReporter({
  progressToken: "tok-2",
  emit: () => { throw new Error("client went away"); },
  now: () => 0,
  schedule: (callback) => { tolerantTimers.push(callback); return { unref() {} }; },
  cancel: () => {},
});
tolerant();
tolerantTimers.shift()();
tolerant();

assert.throws(() => createProgressReporter({ progressToken: "tok-3" }), TypeError,
  "progress reporter accepted a missing emit callback");

assert.deepEqual(progressNotification({ progressToken: 7, progress: 5, message: "working" }), {
  jsonrpc: "2.0",
  method: "notifications/progress",
  params: { progressToken: 7, progress: 5, message: "working" },
}, "progress notification shape is not protocol-conformant");
assert.deepEqual(progressNotification({ progressToken: "tok", progress: 0 }), {
  jsonrpc: "2.0",
  method: "notifications/progress",
  params: { progressToken: "tok", progress: 0 },
}, "progress notification added optional fields that were not supplied");
assert.equal(progressNotification({ progressToken: "tok", progress: -3 }).params.progress, 0,
  "progress notification must not report negative progress");

assert.equal(formatElapsed(0), "0s");
assert.equal(formatElapsed(500), "1s");
assert.equal(formatElapsed(59400), "59s");
assert.equal(formatElapsed(59900), "1m");
assert.equal(formatElapsed(60000), "1m");
assert.equal(formatElapsed(60100), "1m");
assert.equal(formatElapsed(61000), "1m1s");
assert.equal(formatElapsed(119900), "2m");
assert.equal(formatElapsed(121000), "2m1s");

console.log("progress reporter test ok");
