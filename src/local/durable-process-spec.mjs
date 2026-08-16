import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { BridgeError } from "./errors.mjs";
import { delegatedProcessCommand } from "./delegated-process-sandbox.mjs";
import { MAX_COMMAND_BYTES, validateArgv } from "./process-contract.mjs";
import { durableProcessExecutionTimeoutSeconds, durableRegisteredCommandTimeoutSeconds } from "./process-foreground-timeout.mjs";
import { workspaceShellCommand } from "./shell.mjs";

export async function prepareDurableDirectProcess(service, args, context = {}) {
  service.policyGate.assert("run_process");
  const idempotencyKey = durableProcessIdempotencyKey(args, context);
  const argv = validateArgv(args.argv);
  const cwd = await service.resolveExistingPath(args.cwd || ".", context);
  if (!(await stat(cwd)).isDirectory()) throw new BridgeError("invalid_request", "cwd is not a directory");
  return durableSpec(service, {
    sourceTool: "run_process",
    name: `durable run_process: ${basename(argv[0])}`,
    argv,
    cwd,
    timeoutSeconds: durableProcessExecutionTimeoutSeconds(args.timeout_seconds),
    idempotencyKey,
  }, context);
}

export async function prepareDurableRegisteredProcess(service, args, context = {}) {
  service.policyGate.assert("run_local_command");
  const idempotencyKey = durableProcessIdempotencyKey(args, context);
  const command = await service.resolveLocalCommand(args, context);
  const argv = validateArgv(command.argv);
  const cwd = await service.resolveExistingPath(command.cwd, context);
  if (!(await stat(cwd)).isDirectory()) throw new BridgeError("invalid_request", "registered command cwd is not a directory");
  return durableSpec(service, {
    sourceTool: "run_local_command",
    name: `durable command: ${String(command.name || basename(argv[0])).slice(0, 96)}`,
    argv,
    cwd,
    timeoutSeconds: durableRegisteredCommandTimeoutSeconds(args, command),
    idempotencyKey,
  }, context);
}

export function prepareDurableShellProcess(service, args, context = {}) {
  service.policyGate.assert("exec_command");
  const idempotencyKey = durableProcessIdempotencyKey(args, context);
  const command = args?.command;
  if (!command || typeof command !== "string") throw new BridgeError("invalid_request", "command is required");
  if (command.includes("\0")) throw new BridgeError("invalid_request", "command contains a NUL byte");
  if (Buffer.byteLength(command) > MAX_COMMAND_BYTES) throw new BridgeError("limit_exceeded", `command exceeds maximum size (${MAX_COMMAND_BYTES} bytes)`);
  const shell = workspaceShellCommand(command);
  return durableSpec(service, {
    sourceTool: "exec_command",
    name: "durable shell command",
    argv: [shell.cmd, ...shell.args],
    cwd: service.workspace,
    timeoutSeconds: durableProcessExecutionTimeoutSeconds(args.timeout_seconds),
    idempotencyKey,
  }, context);
}

function durableSpec(service, spec, context) {
  const launch = delegatedProcessCommand({
    command: process.execPath,
    args: [],
    workspace: service.workspace,
    runtimeDir: service.runtimeDir,
    context,
  });
  return { ...spec, delegatedProcess: launch.isolation !== "owner-or-local-user" };
}

function durableProcessIdempotencyKey(args, context) {
  const key = args?.idempotency_key;
  if (context?.origin === "relay" && key === undefined) {
    throw new BridgeError("invalid_request", "remote durable process execution requires idempotency_key before dispatch so an ambiguous acceptance response can be recovered without duplicate execution", {
      retryable: false,
      details: { side_effects_started: false, recovery_credential_required: "idempotency_key" },
    });
  }
  return key;
}
