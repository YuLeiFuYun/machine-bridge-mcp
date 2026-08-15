import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { BridgeError } from "../src/local/errors.mjs";
import { ProcessExecutionService } from "../src/local/process-execution.mjs";
import {
  processCancellationFailure,
  processChildErrorFailure,
  processPostSpawnFailure,
  processPreSpawnFailure,
  processTimeoutFailure,
} from "../src/local/process-nonreplayable-settlement.mjs";
import { ProcessTracker } from "../src/local/process-tracker.mjs";

class FixtureChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = new PassThrough();
    this.exitCode = null;
    this.signalCode = null;
  }
}

let spawnMode = "normal";
let spawnCalls = 0;
let terminated = 0;
const children = [];
const tracker = new ProcessTracker();
const service = new ProcessExecutionService({
  workspace: process.cwd(),
  policy: { minimalEnv: false },
  policyGate: { assert() {} },
  runtimeDir: process.cwd(),
  processTracker: tracker,
  resolveExistingPath: async (value) => value,
  resolveLocalCommand: async () => ({}),
  displayPath: (value) => value,
  throwIfCancelled(context) { if (context.signal?.aborted) throw context.signal.reason; },
  spawnProcess: () => {
    if (spawnMode === "policy") throw new BridgeError("policy_denied", "blocked before spawn");
    if (spawnMode === "sync-raw") throw new Error("sync spawn failed");
    spawnCalls += 1;
    const pid = spawnMode === "async-pre" ? undefined : 7000 + spawnCalls;
    const child = new FixtureChild(pid);
    children.push(child);
    if (spawnMode === "async-pre") queueMicrotask(() => {
      child.emit("error", new Error("spawn failed before start"));
      child.emit("close", null, null);
    });
    if (spawnMode === "async-post") queueMicrotask(() => {
      child.emit("error", new Error("process failed after start"));
      child.emit("close", null, null);
    });
    return child;
  },
  terminateProcess: () => { terminated += 1; return null; },
  childSettlementOptions: { fallbackMs: 5 },
});

const preCancelled = new AbortController();
preCancelled.abort(new BridgeError("cancelled", "cancelled before spawn"));
await assert.rejects(
  service.run("never", [], 1000, true, 1024, { callId: "pre-cancel", signal: preCancelled.signal }, process.cwd(), null, { nonReplayableMutation: true }),
  (error) => error instanceof BridgeError && error.code === "cancelled" && error.message === "cancelled before spawn",
);
assert.equal(spawnCalls, 0);

spawnMode = "policy";
await assert.rejects(
  service.run("never", [], 1000, true, 1024, { callId: "policy" }, process.cwd(), null, { nonReplayableMutation: true }),
  (error) => error instanceof BridgeError && error.code === "policy_denied" && error.message === "blocked before spawn",
);
assert.equal(spawnCalls, 0);

spawnMode = "sync-raw";
await assert.rejects(
  service.run("never", [], 1000, true, 1024, { callId: "sync-raw" }, process.cwd(), null, { nonReplayableMutation: true }),
  (error) => error instanceof BridgeError && error.details?.reason === "process_failed_before_spawn",
);
assert.equal(spawnCalls, 0);

spawnMode = "async-pre";
await assert.rejects(
  service.run("never", [], 1000, true, 1024, { callId: "async-pre" }, process.cwd(), null, { nonReplayableMutation: true }),
  (error) => error instanceof BridgeError && error.details?.reason === "process_failed_before_spawn",
);
assert.equal(spawnCalls, 1);

spawnMode = "async-post";
await assert.rejects(
  service.run("never", [], 1000, true, 1024, { callId: "async-post" }, process.cwd(), null, { nonReplayableMutation: true }),
  (error) => error instanceof BridgeError
    && error.retryable === false
    && error.details?.reason === "process_outcome_unknown_after_spawn"
    && error.details?.trigger === "process_error",
);
assert.equal(spawnCalls, 2);

spawnMode = "normal";
const controller = new AbortController();
const cancelled = service.run("never", [], 60_000, true, 1024, {
  callId: "post-cancel", signal: controller.signal,
}, process.cwd(), null, { nonReplayableMutation: true });
assert.equal(spawnCalls, 3);
controller.abort(new BridgeError("cancelled", "cancelled after spawn"));
await assert.rejects(cancelled, (error) => error instanceof BridgeError
  && error.details?.reason === "process_outcome_unknown_after_spawn"
  && error.details?.trigger === "cancelled"
  && error.details?.termination_requested === true
  && error.details?.effect_settlement === "pending");
children.at(-1).emit("close", null, null);

const timed = service.run("never", [], 5, true, 1024, { callId: "post-timeout" }, process.cwd(), null, { nonReplayableMutation: true });
assert.equal(spawnCalls, 4);
const keepAlive = setTimeout(() => {}, 100);
try {
  await assert.rejects(timed, (error) => error instanceof BridgeError
    && error.details?.reason === "process_outcome_unknown_after_spawn"
    && error.details?.trigger === "timeout");
} finally {
  clearTimeout(keepAlive);
}
children.at(-1).emit("close", null, null);

const nonzero = service.run("never", [], 1000, false, 1024, { callId: "nonzero" }, process.cwd(), null, { nonReplayableMutation: true });
assert.equal(spawnCalls, 5);
children.at(-1).emit("close", 7, null);
await assert.rejects(nonzero, (error) => error instanceof BridgeError
  && error.details?.reason === "process_outcome_unknown_after_spawn"
  && error.details?.trigger === "nonzero_exit"
  && error.details?.process?.code === 7);

const explicit = service.run("never", [], 1000, true, 1024, { callId: "explicit" }, process.cwd(), null, { nonReplayableMutation: true });
assert.equal(spawnCalls, 6);
children.at(-1).emit("close", 4, null);
assert.equal((await explicit).code, 4);

spawnMode = "async-post";
const ordinary = service.run("never", [], 1000, true, 1024, { callId: "ordinary" }, process.cwd());
assert.equal((await ordinary).code, 127, "ordinary allowFailure process error changed historical settlement");

const ordinaryPreSpawn = new Error("ordinary pre-spawn");
assert.strictEqual(processPreSpawnFailure(ordinaryPreSpawn, false), ordinaryPreSpawn);
const bridgePreSpawn = new BridgeError("policy_denied", "already classified");
assert.strictEqual(processPreSpawnFailure(bridgePreSpawn, true), bridgePreSpawn);
const rawPreSpawn = processPreSpawnFailure(new Error("raw pre-spawn /private/tmp/operator-secret"), true);
assert.equal(rawPreSpawn.code, "execution_failed");
assert.equal(rawPreSpawn.message, "process failed before spawn");
assert.equal(JSON.stringify({ message: rawPreSpawn.message, details: rawPreSpawn.details }).includes("/private/tmp/operator-secret"), false,
  "non-replayable pre-spawn public error exposed lower-layer exception text");

const timeoutAbort = new AbortController();
timeoutAbort.abort(new BridgeError("timeout", "deadline reached"));
const ordinaryTimeoutCancellation = processCancellationFailure(false, timeoutAbort.signal);
assert.equal(ordinaryTimeoutCancellation.code, "timeout");
assert.equal(ordinaryTimeoutCancellation.message, "deadline reached");
assert.equal(ordinaryTimeoutCancellation.details.effect_settlement, "pending");
const rawAbort = new AbortController();
rawAbort.abort("stop");
const ordinaryCancellation = processCancellationFailure(false, rawAbort.signal);
assert.equal(ordinaryCancellation.code, "cancelled");
assert.equal(ordinaryCancellation.message, "tool call cancelled");

const ordinaryTimeout = processTimeoutFailure(false, 123);
assert.equal(ordinaryTimeout.code, "timeout");
assert.match(ordinaryTimeout.message, /123ms/);
const fallback = new Error("ordinary post-spawn failure");
assert.strictEqual(processPostSpawnFailure(false, "process_error", fallback), fallback);
assert.equal(processPostSpawnFailure(true, "process_error", fallback, { marker: true }).details.marker, true);
assert.strictEqual(processChildErrorFailure(false, fallback, true), fallback);
assert.equal(processChildErrorFailure(true, fallback, true).details.trigger, "process_error");
assert.equal(processChildErrorFailure(true, "", false).message, "process failed before spawn");
assert.equal(processChildErrorFailure(true, new Error("spawn failed at /private/tmp/operator-secret"), false).message, "process failed before spawn");

await new Promise((resolve) => { setImmediate(resolve); });
assert.equal(tracker.snapshot().active_processes, 0, "process settlement fixtures leaked tracked children");
assert(terminated >= 2, "post-spawn cancellation or timeout failed to request termination");
console.log("process non-replayable settlement test ok");
