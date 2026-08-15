import os from "node:os";
import process from "node:process";
import { sanitizePortableLogText } from "../src/shared/log-redaction.mjs";

const EVENT_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/;

const HOME_PATHS = [...new Set([
  process.env.HOME,
  process.env.USERPROFILE,
  safeHomeDirectory(),
].filter((value) => typeof value === "string" && value.length > 1))];

export function releaseDiagnostic(value, maxChars = 1000) {
  return sanitizePortableLogText(value, { maxChars, homePaths: HOME_PATHS }).trim();
}

export function releaseDiagnosticEvent(event, value, maxChars = 1000) {
  const name = String(event || "");
  if (!EVENT_NAME_PATTERN.test(name)) throw new Error("release diagnostic event name is invalid");
  return Object.freeze({ event: name, error: releaseDiagnostic(value, maxChars) });
}

export function releaseCommandLabel(command, args = []) {
  const executable = String(command || "command").split(/[\\/]/).filter(Boolean).at(-1) || "command";
  const first = Array.isArray(args) && args.length ? String(args[0] || "") : "";
  return releaseDiagnostic(first ? `${executable} ${first}` : executable, 160);
}

export function releaseCommandFailure(command, args, result, options = {}) {
  const label = releaseCommandLabel(command, args);
  const detail = releaseDiagnostic([
    result?.stderr,
    result?.stdout,
    result?.error?.message,
  ].filter(Boolean).join("\n"), options.maxChars || 1000);
  return `${label} failed${detail ? `: ${detail}` : ""}`;
}

function safeHomeDirectory() {
  try { return os.homedir(); } catch { return ""; }
}
