import { createLogger } from "../src/local/log.mjs";

const stdout = captureStream();
const stderr = captureStream();
const logger = createLogger({ level: "debug", format: "json", component: "test", stdout, stderr, color: false });
const syntheticHomePath = ["", "Users", "synthetic-user", "project"].join("/");

logger.event("info", "tool.call.completed", {
  call_id: "call-123",
  tool: "read_file",
  duration_ms: 12,
  password: "must-not-appear",
  workspace_path: syntheticHomePath,
  note: "Bearer abc.def.ghi",
});
logger.event("error", "tool.call.failed", {
  error_code: "permission_denied",
  retryable: false,
});

assert(stdout.lines.length === 1, "info event did not use stdout");
assert(stderr.lines.length === 1, "error event did not use stderr");
const completed = JSON.parse(stdout.lines[0]);
const failed = JSON.parse(stderr.lines[0]);
assert(completed.event === "tool.call.completed", "structured event name was lost");
assert(completed.component === "test" && completed.level === "info", "structured event identity is incomplete");
assert(completed.call_id === "call-123" && completed.tool === "read_file" && completed.duration_ms === 12, "safe lifecycle fields were lost");
assert(completed.password === "<redacted>", "sensitive structured field was not redacted");
assert(completed.workspace_path === "<local-path>", "local path field was not redacted");
assert(!stdout.lines[0].includes("must-not-appear") && !stdout.lines[0].includes(syntheticHomePath), "structured log leaked sensitive values");
assert(failed.event === "tool.call.failed" && failed.error_code === "permission_denied", "structured error event is incomplete");

const human = captureStream();
const humanLogger = createLogger({ level: "warn", component: "daemon", stdout: human, stderr: human, color: false });
humanLogger.event(
  "warn",
  "relay.tool_result.discarded",
  { call_id: "call-123" },
  "A completed tool result could not be delivered because the caller disconnected",
);
assert(human.lines.length === 1, "human event did not emit exactly one line");
assert(human.lines[0].includes("caller disconnected"), "human event omitted its natural-language explanation");
assert(!human.lines[0].includes("relay.tool_result.discarded"), "human event exposed the machine event name");
assert(!human.lines[0].includes('"event"'), "human event duplicated the structured event field");

const infoOnly = captureStream();
const quietDebug = createLogger({ level: "info", format: "json", stdout: infoOnly, stderr: infoOnly, color: false });
quietDebug.event("debug", "tool.call.started", { tool: "read_file" });
assert(infoOnly.lines.length === 0, "JSON logger ignored the configured level");
console.log("structured logging test ok");

function captureStream() {
  return {
    lines: [],
    write(value) {
      this.lines.push(String(value).trimEnd());
      return true;
    },
  };
}
function assert(condition, message) { if (!condition) throw new Error(message); }
