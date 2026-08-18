import {
  prepareDurableDirectProcess,
  prepareDurableRegisteredProcess,
  prepareDurableShellProcess,
} from "./durable-process-spec.mjs";

function usesDurableProcessDelivery(args, context = {}) {
  return context.origin === "relay" || args?.idempotency_key !== undefined;
}

export async function runRuntimeDirectProcess(runtime, args, context = {}) {
  if (!usesDurableProcessDelivery(args, context)) {
    return runtime.processExecutionService.runDirect(args, context);
  }
  const prepared = await prepareDurableDirectProcess(runtime.processExecutionService, args, context);
  return runtime.managedJobManager.startDurableProcess(prepared, context);
}

export async function runRuntimeLocalCommand(runtime, args, context = {}) {
  if (!usesDurableProcessDelivery(args, context)) {
    return runtime.processExecutionService.runRegistered(args, context);
  }
  const prepared = await prepareDurableRegisteredProcess(runtime.processExecutionService, args, context);
  return runtime.managedJobManager.startDurableProcess(prepared, context);
}

export function runRuntimeExecCommand(runtime, args, context = {}) {
  if (usesDurableProcessDelivery(args, context)) {
    const prepared = prepareDurableShellProcess(runtime.processExecutionService, args, context);
    return runtime.managedJobManager.startDurableProcess(prepared, context);
  }
  return runtime.processExecutionService.runShell(args.command, args.timeout_seconds, context);
}
