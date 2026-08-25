import { resolve } from "node:path";
import { execPath } from "node:process";
import { releaseControlEnvironmentIsTrusted } from "./resource-release-control-executable.mjs";

const TRUSTED_LIGHT_EXECUTABLES = new Set([
  "/bin/echo", "/bin/false", "/bin/ps", "/bin/pwd", "/bin/sleep", "/bin/true", "/bin/uptime",
  "/usr/bin/echo", "/usr/bin/false", "/usr/bin/ps", "/usr/bin/pwd", "/usr/bin/sleep", "/usr/bin/true", "/usr/bin/uptime",
]);

export function isTrustedLightExecutable(command) { return TRUSTED_LIGHT_EXECUTABLES.has(String(command || "")); }

export function isTrustedLightInvocation(command, args = [], environment = {}) {
  if (!releaseControlEnvironmentIsTrusted(environment)) return false;
  if (isTrustedLightExecutable(command)) return true;
  const raw = String(command || "");
  const values = args.map(String);
  return Boolean(raw) && resolve(raw) === resolve(execPath)
    && values.length === 1 && ["--version", "-v"].includes(values[0]);
}
