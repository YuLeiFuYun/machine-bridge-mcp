import assert from "node:assert/strict";
import { BridgeError, publicError } from "../../../src/local/errors.mjs";
import { daemonToolError, publicWorkerToolError, dispatchedDaemonTimeoutError } from "../../../src/worker/errors.ts";

for (const reason of ["text_not_found", "hash_mismatch", "context_ambiguous"]) {
  const local = publicError(new BridgeError("conflict", "safe", { details: { reason } }));
  const relay = publicWorkerToolError(daemonToolError(local));
  assert.equal(relay.actionable_remedy, local.actionable_remedy);
  assert(local.actionable_remedy);
}
const timeout = publicWorkerToolError(dispatchedDaemonTimeoutError("synthetic operation", false));
assert.equal(timeout.retryable, false);
assert(timeout.actionable_remedy.includes("do not repeat"));
assert(!timeout.actionable_remedy.includes("split the task"));
const recovered = publicWorkerToolError(dispatchedDaemonTimeoutError("synthetic operation", true, { mode: "read_same_job" }));
assert(recovered.actionable_remedy.includes("read_job"));
assert(recovered.actionable_remedy.includes("original job_id"));
console.log("settlement guidance parity ok");
