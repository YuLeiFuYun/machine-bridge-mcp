import {
  effectiveForegroundTimeoutSeconds,
  remoteForegroundMaximumSeconds,
  remoteForegroundDefaultSeconds,
  remoteDurableProcessTimeoutSeconds,
} from "../shared/foreground-timeout.mjs";
import { MAX_PROCESS_TIMEOUT_SECONDS } from "./execution-limits.mjs";

export function processForegroundTimeoutSeconds(tool, value, context = {}) {
  return effectiveForegroundTimeoutSeconds({
    tool,
    value,
    remote: context.origin === "relay",
    localDefault: 120,
    localMaximum: MAX_PROCESS_TIMEOUT_SECONDS,
  });
}

export function registeredCommandTimeoutSeconds(args, command, context = {}) {
  const remote = context.origin === "relay";
  const requested = args.timeout_seconds === undefined
    ? (remote ? remoteForegroundDefaultSeconds("run_local_command") : command.timeoutSeconds)
    : processForegroundTimeoutSeconds("run_local_command", args.timeout_seconds, context);
  return Math.min(
    requested,
    command.timeoutSeconds,
    remote ? remoteForegroundMaximumSeconds("run_local_command") : MAX_PROCESS_TIMEOUT_SECONDS,
  );
}

export function durableProcessExecutionTimeoutSeconds(value) {
  return remoteDurableProcessTimeoutSeconds(value);
}

export function durableRegisteredCommandTimeoutSeconds(args, command) {
  return Math.min(
    remoteDurableProcessTimeoutSeconds(args.timeout_seconds),
    command.timeoutSeconds,
    MAX_PROCESS_TIMEOUT_SECONDS,
  );
}
