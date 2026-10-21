import { runRuntimeInfrastructureScenarios } from "./fixtures/runtime-infrastructure/runtime-scenarios.mjs";
import { runRelayInfrastructureTests } from "./fixtures/runtime-infrastructure/relay-scenarios.mjs";
import { runProcessInfrastructureTests } from "./fixtures/runtime-infrastructure/process-scenarios.mjs";

await runRuntimeInfrastructureScenarios();
await runRelayInfrastructureTests();
await runProcessInfrastructureTests();

console.log("runtime infrastructure test ok");
