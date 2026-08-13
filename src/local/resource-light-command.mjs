const TRUSTED_LIGHT_EXECUTABLES = new Set([
  "/bin/echo", "/bin/false", "/bin/ps", "/bin/pwd", "/bin/sleep", "/bin/true", "/bin/uptime",
  "/usr/bin/echo", "/usr/bin/false", "/usr/bin/ps", "/usr/bin/pwd", "/usr/bin/sleep", "/usr/bin/true", "/usr/bin/uptime",
]);

export function isTrustedLightExecutable(command) { return TRUSTED_LIGHT_EXECUTABLES.has(String(command || "")); }
