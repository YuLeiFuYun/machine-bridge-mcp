import { runProtocolAndPolicyScenarios } from "./fixtures/worker-runtime/protocol-and-policy-scenarios.mjs";
import { runPendingCallsScenarios } from "./fixtures/worker-runtime/pending-calls-scenarios.mjs";
import { runDaemonWaitersAndRoutesScenarios } from "./fixtures/worker-runtime/daemon-waiters-and-routes-scenarios.mjs";

await runProtocolAndPolicyScenarios();
await runPendingCallsScenarios();
await runDaemonWaitersAndRoutesScenarios();

console.log("worker runtime infrastructure test ok");
