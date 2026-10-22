import { runManagedJobPolicyScenarios } from "./fixtures/managed-jobs/policy-scenarios.mjs";
import { runManagedJobExecutionScenarios } from "./fixtures/managed-jobs/execution-scenarios.mjs";

await runManagedJobPolicyScenarios();
await runManagedJobExecutionScenarios();

console.log("managed jobs/resources integration test ok");
