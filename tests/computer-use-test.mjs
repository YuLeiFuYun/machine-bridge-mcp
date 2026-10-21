import { runBrowserComputerUseTests } from "./fixtures/computer-use/browser-scenarios.mjs";
import { runApplicationComputerUseTests } from "./fixtures/computer-use/application-scenarios.mjs";

await runBrowserComputerUseTests();
await runApplicationComputerUseTests();

console.log("computer use tests passed");
