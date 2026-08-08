import { join } from "node:path";
import { createMonotonicDeadline } from "./monotonic-deadline.mjs";
import { createExclusiveFileSync, replaceFileAtomicallySync } from "./exclusive-file.mjs";
import { ownerOnlyFile } from "./secure-file.mjs";
import { inspectPathIfPresentSync } from "./secure-file.mjs";
import { readBoundedFile } from "./managed-job-storage.mjs";

const RUNNER_CLAIM_BYTES = 1024;
const RUNNER_CLAIM_WAIT_MS = 30_000;

export function publishProvisionalRunnerClaim(dir, pid, launchToken) {
  const file = join(dir, "runner.pid");
  const claim = { pid, startedAt: new Date().toISOString(), launchToken };
  try {
    createExclusiveFileSync(file, `${JSON.stringify(claim)}\n`, { mode: 0o600 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = readRunnerClaim(file, "managed job runner claim already exists but is unreadable");
    if (Number(existing?.pid) !== pid) throw new Error("managed job runner claim is owned by another process");
  }
  ownerOnlyFile(file);
}

export async function confirmRunnerClaim({ file, pid, processStartedAt, launchToken, inspectPath = inspectPathIfPresentSync }) {
  const exact = { pid, startedAt: new Date().toISOString(), processStartedAt };
  if (!launchToken) {
    createExclusiveFileSync(file, `${JSON.stringify(exact)}\n`, { mode: 0o600 });
    return;
  }
  if (!/^[a-f0-9]{32}$/.test(launchToken)) throw new Error("runner launch token is invalid");
  const deadline = createMonotonicDeadline(RUNNER_CLAIM_WAIT_MS);
  while (!deadline.expired()) {
    if (!inspectPath(file, "managed job runner claim")) {
      await new Promise((resolvePromise) => { setTimeout(resolvePromise, 10); });
      continue;
    }
    const provisional = readRunnerClaim(file, "runner ownership claim is unreadable");
    if (Number(provisional?.pid) !== pid || provisional?.launchToken !== launchToken) {
      throw new Error("runner ownership claim does not match the spawned process");
    }
    exact.startedAt = typeof provisional.startedAt === "string" && provisional.startedAt
      ? provisional.startedAt
      : exact.startedAt;
    replaceFileAtomicallySync(file, `${JSON.stringify(exact)}\n`, { mode: 0o600 });
    return;
  }
  throw new Error("runner ownership claim was not published before startup deadline");
}

function readRunnerClaim(file, message) {
  try { return JSON.parse(readBoundedFile(file, RUNNER_CLAIM_BYTES).toString("utf8")); }
  catch (error) { throw new Error(message, { cause: error }); }
}
