import { spawn } from "node:child_process";
import process from "node:process";

export const VERIFICATION_IDLE_SLEEP_GUARD_ENV = "MBM_CHECK_IDLE_SLEEP_GUARD";

export async function rerunVerificationUnderIdleSleepGuard(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (platform !== "darwin" || env[VERIFICATION_IDLE_SLEEP_GUARD_ENV] === "1") return null;

  const executable = String(options.execPath || process.execPath);
  const argv = Array.isArray(options.argv) ? options.argv.map(String) : process.argv.slice(1);
  if (!executable || argv.length === 0 || !argv[0]) {
    throw new Error("verification idle-sleep guard requires the current Node executable and entrypoint");
  }
  const spawnProcess = typeof options.spawnProcess === "function" ? options.spawnProcess : spawn;
  let child;
  try {
    child = spawnProcess("/usr/bin/caffeinate", ["-i", executable, ...argv], {
      env: { ...env, [VERIFICATION_IDLE_SLEEP_GUARD_ENV]: "1" },
      stdio: "inherit",
      shell: false,
      windowsHide: true,
    });
  } catch (error) {
    throw new Error("could not start the macOS verification idle-sleep guard", { cause: error });
  }
  return await new Promise((resolvePromise, rejectPromise) => {
    child.once("error", (error) => {
      rejectPromise(new Error("could not start the macOS verification idle-sleep guard", { cause: error }));
    });
    child.once("close", (code, signal) => {
      if (Number.isInteger(code)) resolvePromise(code);
      else rejectPromise(new Error(`macOS verification idle-sleep guard ended by signal ${signal || "unknown"}`));
    });
  });
}
