import { parseStructuredGitLog } from "../src/local/git-log-parser.mjs";

const hash40 = "a".repeat(40);
const hash64 = "b".repeat(64);
const row40 = [hash40, "a1b2c3d", "2026-08-13T12:34:56+00:00", "A", "", "subject"].join("\x1f");
const row64 = [hash64, "b1c2d3e", "2026-08-13T12:34:56Z", "B", "", "subject64"].join("\x1f");

assert(parseStructuredGitLog("").length === 0, "empty framed log was not empty");
assert(parseStructuredGitLog("\n\x1e\r\n\x1e").length === 0, "newline-only framed records were not ignored");
const parsed = parseStructuredGitLog(`\r\n${row40}\x1e\n${row64}\x1e`, true);
assert(parsed.length === 2 && parsed[0].author_email === "" && parsed[1].hash === hash64,
  "framed log lost CRLF, optional field, or long-hash behavior");
for (const value of [
  `${hash40}\x1fshort\x1f2026-08-13T12:34:56Z\x1fA\x1f\x1fS\x1e`,
  `${hash40}\x1fabcdef0\x1fnot-a-date\x1fA\x1f\x1fS\x1e`,
  `${hash40}\x1fabcdef0\x1f2026-08-13T12:34:56Z\x1fA\x1f\x1e`,
]) assertRejected(value);
console.log("structured Git log format test ok");

function assertRejected(value) {
  let error;
  try { parseStructuredGitLog(value); } catch (caught) { error = caught; }
  assert(error?.code === "execution_failed" && error?.details?.reason === "git_log_parse_failed",
    "invalid framed log was not rejected");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
