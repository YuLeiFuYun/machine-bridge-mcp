import {
  prepareDurableDirectProcess,
  prepareDurableRegisteredProcess,
  prepareDurableShellProcess,
} from "./durable-process-spec.mjs";
import { settleDurableProcessAcceptance } from "./durable-process-initial-settlement.mjs";
import { BridgeError } from "./errors.mjs";

function usesDurableProcessDelivery(args, context = {}) {
  return context.origin === "relay" || args?.idempotency_key !== undefined;
}

export async function runRuntimeDirectProcess(runtime, args, context = {}) {
  runtime.processExecutionService.policyGate.assert("run_process");
  const managedCommand = await runtime.agentContextManager.managedJobCommandForDirectInvocation(args, context);
  if (managedCommand) throw managedJobOnlyCarrierError(managedCommand);
  if (!usesDurableProcessDelivery(args, context)) {
    return runtime.processExecutionService.runDirect(args, context);
  }
  const prepared = await prepareDurableDirectProcess(runtime.processExecutionService, args, context);
  const accepted = runtime.managedJobManager.startDurableProcess(prepared, context);
  return settleDurableProcessAcceptance(runtime.managedJobManager, accepted, context);
}

export async function runRuntimeLocalCommand(runtime, args, context = {}) {
  runtime.processExecutionService.policyGate.assert("run_local_command");
  const managedCommand = await runtime.agentContextManager.managedJobCommandForLocalInvocation(args, context);
  if (managedCommand) throw managedJobOnlyCarrierError(managedCommand);
  if (!usesDurableProcessDelivery(args, context)) {
    return runtime.processExecutionService.runRegistered(args, context);
  }
  const prepared = await prepareDurableRegisteredProcess(runtime.processExecutionService, args, context);
  const accepted = runtime.managedJobManager.startDurableProcess(prepared, context);
  return settleDurableProcessAcceptance(runtime.managedJobManager, accepted, context);
}

export async function runRuntimeExecCommand(runtime, args, context = {}) {
  if (usesDurableProcessDelivery(args, context)) {
    const prepared = prepareDurableShellProcess(runtime.processExecutionService, args, context);
    const accepted = runtime.managedJobManager.startDurableProcess(prepared, context);
    return settleDurableProcessAcceptance(runtime.managedJobManager, accepted, context);
  }
  return runtime.processExecutionService.runShell(args.command, args.timeout_seconds, context);
}

function managedJobOnlyCarrierError(command) {
  return new BridgeError("invalid_request", `registered command '${command.name}' requires start_job; run_process and run_local_command intentionally refuse execution_mode=managed_job commands`, {
    retryable: false,
    details: { side_effects_started: false, required_tool: "start_job", registered_command: command.name, managed_job_timeout_seconds: command.managedJobTimeoutSeconds },
  });
}
