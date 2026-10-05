import { BridgeError } from "./errors.mjs";

export const MAX_COMMAND_BYTES = 64 * 1024;
export const MAX_ARGV_ITEMS = 256;

export function validateArgv(value) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_ARGV_ITEMS) {
    throw new Error(`argv must contain 1-${MAX_ARGV_ITEMS} strings`);
  }
  const argv = value.map((item) => {
    if (typeof item !== "string" || item.includes("\0")) {
      throw new Error("argv entries must be strings without NUL bytes");
    }
    return item;
  });
  if (!argv[0]) throw new Error("argv[0] must not be empty");
  if (Buffer.byteLength(JSON.stringify(argv)) > MAX_COMMAND_BYTES) {
    throw new Error(`argv exceeds maximum size (${MAX_COMMAND_BYTES} bytes)`);
  }
  return argv;
}

export function validateShellCommand(command) {
  if (!command || typeof command !== "string") throw new BridgeError("invalid_request", "command is required");
  if (command.includes("\0")) throw new BridgeError("invalid_request", "command contains a NUL byte");
  if (Buffer.byteLength(command) > MAX_COMMAND_BYTES) throw new BridgeError("limit_exceeded", `command exceeds maximum size (${MAX_COMMAND_BYTES} bytes)`);
  return command;
}
