import { createLogger } from "../src/local/log.mjs";

const stdout = captureStream();
const stderr = captureStream();
const logger = createLogger({ level: "debug", format: "json", component: "test", stdout, stderr, color: false });
const syntheticHomePath = ["", "Users", "synthetic-user", "project"].join("/");
const syntheticRefreshToken = `mcp_rt_${"r".repeat(43)}`;
const syntheticAccountId = `acct_${"a".repeat(43)}`;
const syntheticClientId = `mcp_client_${"c".repeat(43)}`;
const syntheticFamilyId = `mcp_family_${"f".repeat(43)}`;

logger.event("info", "tool.call.completed", {
  call_id: "call-123",
  tool: "read_file",
  duration_ms: 12,
  password: "must-not-appear",
  apiKey: "opaque-api-value",
  proof: "opaque-proof-value",
  monkey: "safe-animal",
  account_id: syntheticAccountId,
  clientId: syntheticClientId,
  owner_family_id: syntheticFamilyId,
  workspace_path: syntheticHomePath,
  note: `Bearer abc.def.ghi refresh=${syntheticRefreshToken} account=${syntheticAccountId} client=${syntheticClientId} family=${syntheticFamilyId}`,
  timestamp: "1970-01-01T00:00:00.000Z",
  level: "debug",
  component: "caller",
  event: "caller.override",
  message: "forged message",
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
assert(completed.event === "tool.call.completed" && completed.message === "Tool call completed" && completed.timestamp !== "1970-01-01T00:00:00.000Z", "structured event fields overrode authoritative local log metadata");
assert(completed.call_id === "call-123" && completed.tool === "read_file" && completed.duration_ms === 12, "safe lifecycle fields were lost");
assert(completed.password === "<redacted>" && completed.apiKey === "<redacted>" && completed.proof === "<redacted>",
  "sensitive structured field-name variants were not redacted");
assert(completed.account_id === "<redacted>" && completed.clientId === "<redacted>" && completed.owner_family_id === "<redacted>",
  "stable authorization identity fields were not redacted");
assert(completed.monkey === "safe-animal", "sensitive-key matching over-redacted an unrelated field name");
assert(completed.workspace_path === "<local-path>", "local path field was not redacted");
assert(!stdout.lines[0].includes("must-not-appear") && !stdout.lines[0].includes(syntheticHomePath)
  && !stdout.lines[0].includes(syntheticRefreshToken) && !stdout.lines[0].includes(syntheticAccountId)
  && !stdout.lines[0].includes(syntheticClientId) && !stdout.lines[0].includes(syntheticFamilyId),
"structured log leaked sensitive values or stable authorization identity");
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
const directStdout = captureStream();
const directStderr = captureStream();
const directLogger = createLogger({ level: "debug", format: "json", component: "daemon", stdout: directStdout, stderr: directStderr, color: false });
directLogger.info("daemon started", { workspace_path: syntheticHomePath, attempts: 1, timestamp: "1970-01-01T00:00:00.000Z", level: "error", component: "caller", message: "forged message" });
directLogger.warn("relay unavailable", { attempts: 3, token: "must-not-appear" });
assert(directStdout.lines.length === 1 && directStderr.lines.length === 1, "direct JSON log methods used the wrong streams");
const directInfo = JSON.parse(directStdout.lines[0]);
const directWarning = JSON.parse(directStderr.lines[0]);
assert(Number.isFinite(Date.parse(directInfo.timestamp)) && directInfo.level === "info" && directInfo.component === "daemon", "direct info log omitted structured identity");
assert(directInfo.timestamp !== "1970-01-01T00:00:00.000Z" && directInfo.message === "daemon started", "direct JSON fields overrode authoritative local log metadata");
assert(directInfo.workspace_path === "<local-path>" && directInfo.attempts === 1, "direct info log omitted safe fields or leaked a path");
assert(directWarning.level === "warn" && directWarning.attempts === 3 && directWarning.token === "<redacted>", "direct warning log omitted fields or failed redaction");
assert(!directStderr.lines[0].includes("must-not-appear"), "direct JSON warning leaked a sensitive field");
assert(typeof directLogger.plain === "undefined" && typeof directLogger.json === "undefined",
  "logger exposed ambiguous raw-output method names that can be mistaken for redacted logging");
const rawOutput = captureStream();
const rawLogger = createLogger({ stdout: rawOutput, stderr: rawOutput, color: false });
rawLogger.rawPlain("literal raw output");
rawLogger.rawJson({ explicit_raw: "literal raw json" });
assert(rawOutput.lines[0] === "literal raw output" && rawOutput.lines[1].includes("literal raw json"),
  "explicit raw-output methods stopped preserving user-requested terminal payloads");

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
