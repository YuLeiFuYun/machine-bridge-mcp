import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import { filesystemIdentity, sameFilesystemIdentity } from "./filesystem-identity.mjs";
import { withOwnerStateLock } from "./owner-state-lock.mjs";
import { assertStateMaintenanceAvailable, expandHome, machineServiceControlRoot } from "./state.mjs";

const LOCK_PURPOSE = "toolchain-operation";

export function withToolchainOperationLock(stateRoot, callback, options = {}) {
  if (typeof callback !== "function") throw new TypeError("toolchain operation lock requires a callback");
  const root = resolve(expandHome(stateRoot));
  assertStateMaintenanceAvailable(root);
  const generation = stateGeneration(root);
  const key = process.platform === "win32" ? root.toLowerCase() : root;
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return withOwnerStateLock(machineServiceControlRoot(options), async () => {
    assertStateMaintenanceAvailable(root);
    const current = stateGeneration(root);
    if (!sameFilesystemIdentity(generation, current)) {
      throw new Error("state root changed while waiting for private-toolchain ownership; retry from current state");
    }
    return callback();
  }, {
    purpose: LOCK_PURPOSE,
    fileName: `toolchain-operation-${digest}.lock`,
    label: "private toolchain operation",
    timeoutMs: options.timeoutMs ?? 30_000,
  });
}

function stateGeneration(root) {
  let info;
  try { info = lstatSync(root, { bigint: true }); }
  catch (error) {
    if (error?.code === "ENOENT") throw new Error("state root must exist before a persistent private-toolchain operation", { cause: error });
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("state root must be a real directory before a persistent private-toolchain operation");
  return filesystemIdentity(info, "private-toolchain state root");
}
