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
