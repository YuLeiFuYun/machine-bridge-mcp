import { AppAutomationManager } from "./app-automation.mjs";
import { projectApplicationCapabilities } from "./application-capability-projection.mjs";
import { applicationBackgroundInputConfiguration } from "./macos-background-input.mjs";

export function createRuntimeAppAutomationManager(runtime, applicationAutomation, runProcess, readResourceText) {
  const { backgroundVisualBackend, backgroundInputService } = applicationBackgroundInputConfiguration(
    applicationAutomation, runProcess, runtime.runtimeDir,
  );
  return new AppAutomationManager({
    ...applicationAutomation,
    backgroundVisualBackend,
    backgroundInputService,
    policy: runtime.policy,
    authorizeTool: (tool) => runtime.policyGate.assert(tool),
    displayPath: (value, context) => runtime.displayPath(value, context),
    projectCapabilities: (capabilities, context) => projectRuntimeApplicationCapabilities(runtime, capabilities, context),
    runProcess,
    readResourceText,
    throwIfCancelled: (context) => runtime.throwIfCancelled(context),
  });
}

function projectRuntimeApplicationCapabilities(runtime, capabilities, context) {
  const available = new Set(runtime.effectiveToolNames(context));
  return projectApplicationCapabilities(capabilities, (tool) => available.has(tool));
}
