import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createLogger } from "../src/local/log.mjs";
import { installFatalProcessHandlers } from "../src/local/process-fatal.mjs";

const events = new EventEmitter();
const output = new PassThrough();
let text = "";
output.on("data", (chunk) => { text += chunk.toString("utf8"); });
const exits = [];
const logger = createLogger({ component: "fatal-test", level: "error", format: "json", stderrOnly: true, stderr: output });
const uninstall = installFatalProcessHandlers({ logger, terminate: (code) => exits.push(code) }, events);
try {
  const token = `ghp_${"A".repeat(36)}`;
  events.emit("unhandledRejection", new Error(`synthetic fatal failure ${token}`));
  events.emit("uncaughtException", new Error("secondary fatal event must not be logged twice"));
  assert.deepEqual(exits, [1], "fatal process handler did not terminate exactly once with a fixed non-zero exit code");
  assert.equal((text.match(/fatal process failure; terminating/g) || []).length, 1,
    "fatal process handler logged more than one terminal event");
  assert(text.includes('"fatal_event":"unhandled_rejection"'), "fatal process handler omitted the failure category");
  assert(!text.includes(token), "fatal process handler logged a credential-shaped value");
  assert(!text.includes("synthetic fatal failure"), "fatal process handler logged arbitrary rejection content");
  assert.equal(events.listenerCount("uncaughtException"), 1, "fatal process handler did not register the uncaught exception boundary");
} finally {
  uninstall();
  output.end();
}
for (const reason of [
  Object.create(null),
  { [Symbol.toPrimitive]() { throw new Error("coercion must not execute"); } },
  new Proxy({}, { getPrototypeOf() { throw new Error("prototype inspection failed"); } }),
  { get code() { assert.fail("fatal handling inspected arbitrary rejection properties"); } },
]) {
  const hostileEvents = new EventEmitter();
  const hostileExits = [];
  const dispose = installFatalProcessHandlers({ logger: { error() {} }, terminate: (code) => hostileExits.push(code) }, hostileEvents);
  try {
    assert.doesNotThrow(() => hostileEvents.emit("unhandledRejection", reason));
    assert.deepEqual(hostileExits, [1], "hostile rejection bypassed fatal termination");
  } finally { dispose(); }
}
const brokenEvents = new EventEmitter();
const brokenExits = [];
const disposeBroken = installFatalProcessHandlers({
  logger: { error() { throw new Error("synthetic logger failure"); } },
  terminate: (code) => brokenExits.push(code),
}, brokenEvents);
try {
  brokenEvents.emit("uncaughtException", new Error("synthetic failure"));
  assert.deepEqual(brokenExits, [1], "logger failure bypassed fatal termination");
} finally { disposeBroken(); }
console.log("process fatal handler test ok");
