import { withOwnerStateLock } from "./owner-state-lock.mjs";
import { assertStateMaintenanceAvailable, machineServiceControlRoot } from "./state.mjs";

const LOCK_FILE = "release-runtime.lock";
const LOCK_PURPOSE = "release-runtime";

export function withReleaseRuntimeLock(stateRoot, callback, options = {}) {
  if (typeof callback !== "function") throw new TypeError("release-runtime lock requires a callback");
  return withOwnerStateLock(machineServiceControlRoot(options), async () => {
    if (stateRoot) assertStateMaintenanceAvailable(stateRoot);
    return callback();
  }, {
    purpose: LOCK_PURPOSE,
    fileName: LOCK_FILE,
    label: "release runtime",
    timeoutMs: options.timeoutMs ?? 30_000,
  });
}
