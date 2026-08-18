import {
  effectiveForegroundTimeoutSeconds,
  remoteForegroundDefaultSeconds,
  remoteDurableProcessTimeoutSeconds,
} from "../shared/foreground-timeout.mjs";
import { MAX_PROCESS_TIMEOUT_SECONDS } from "./execution-limits.mjs";

// Relay-origin process one-shots should be routed through durable delivery before reaching this module.
// Keep a narrower defense-in-depth ceiling for any accidental direct foreground entry without advertising
// that value as a supported remote process delivery contract.
const REMOTE_PROCESS_FOREGROUND_DEFENSE_MAX_SECONDS = 30;

export function processForegroundTimeoutSeconds(tool, value, context = {}) {
  const remote = context.origin === "relay";
  const timeout = effectiveForegroundTimeoutSeconds({
    tool,
    value,
    remote,
    localDefault: 120,
    localMaximum: MAX_PROCESS_TIMEOUT_SECONDS,
  });
  if (remote && timeout > REMOTE_PROCESS_FOREGROUND_DEFENSE_MAX_SECONDS) {
    throw new RangeError(`foreground timeout must be an integer from 1 to ${REMOTE_PROCESS_FOREGROUND_DEFENSE_MAX_SECONDS}`);
  }
  return timeout;
}

export function registeredCommandTimeoutSeconds(args, command, context = {}) {
  const remote = context.origin === "relay";
  const requested = args.timeout_seconds === undefined
    ? (remote ? remoteForegroundDefaultSeconds("run_local_command") : command.timeoutSeconds)
    : processForegroundTimeoutSeconds("run_local_command", args.timeout_seconds, context);
  return Math.min(
    requested,
    command.timeoutSeconds,
    remote ? REMOTE_PROCESS_FOREGROUND_DEFENSE_MAX_SECONDS : MAX_PROCESS_TIMEOUT_SECONDS,
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
