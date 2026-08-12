export function ninjaJobserverPlan(argv, environment = {}, _maximum = 1024, platform = process.platform) {
  if ((argv || []).slice(1).some((value) => String(value) === "-n")) return null;
  if (!Object.prototype.hasOwnProperty.call(environment || {}, "MAKEFLAGS")) return null;
  const flags = String(environment.MAKEFLAGS || "");
  return validNinjaJobserver(flags, platform) ? cooperativePlan() : null;
}

function validNinjaJobserver(flags, platform) {
  const args = String(flags).trim().split(/\s+/).filter(Boolean);
  if (args[0] && !args[0].startsWith("-") && args[0].includes("n")) return false;
  let mode = null; let resource = "";
  for (const arg of args) {
    if (arg.startsWith("--jobserver-auth=")) [mode, resource] = authMode(arg.slice("--jobserver-auth=".length));
    else if (arg.startsWith("--jobserver-fds=")) {
      const pair = descriptorPair(arg.slice("--jobserver-fds=".length)); if (pair === null) return false;
      mode = pair ? "pipe" : "none"; resource = "";
    }
  }
  return platform === "win32" ? mode === "semaphore" && resource.length > 0 : mode === "fifo" && resource.length > 0;
}
function authMode(value) {
  const pair = descriptorPair(value); if (pair !== null) return [pair ? "pipe" : "none", ""];
  return value.startsWith("fifo:") ? ["fifo", value.slice(5)] : ["semaphore", value];
}
function descriptorPair(value) {
  const match = /^(-?\d+),(-?\d+)/.exec(value); return match ? Number(match[1]) >= 0 && Number(match[2]) >= 0 : null;
}
function cooperativePlan() { return { jobs: null, elastic: false, unbounded: true, preserve: true }; }
