// @ts-check

import relayContract from "../shared/relay-contract.json" with { type: "json" };
import { isRemoteDurableProcessTool, remoteDurableProcessTimeoutSeconds } from "../shared/foreground-timeout.mjs";

export function validRelayToolSchemaExtension(operation, issues) {
  return validRelayDurableProcessSchemaExtension(operation, issues)
    || validRelayManagedJobReadSchemaExtension(operation, issues);
}

function validRelayDurableProcessSchemaExtension(operation, issues) {
  if (operation.context.origin !== "relay" || !isRemoteDurableProcessTool(operation.tool) || !Array.isArray(issues) || !issues.length) {
    return false;
  }
  if (issues.some((issue) => issue?.instancePath !== "/timeout_seconds" || issue?.keyword !== "maximum")) return false;
  try {
    remoteDurableProcessTimeoutSeconds(operation.args?.timeout_seconds);
    return true;
  } catch {
    return false;
  }
}

function validRelayManagedJobReadSchemaExtension(operation, issues) {
  if (operation.context.origin !== "relay" || operation.tool !== "read_job" || !Array.isArray(issues) || !issues.length) {
    return false;
  }
  if (issues.some((issue) => issue?.instancePath !== "/wait_ms" || issue?.keyword !== "maximum")) return false;
  const waitMs = operation.args?.wait_ms;
  return Number.isInteger(waitMs) && waitMs >= 0 && waitMs <= relayContract.maximumManagedJobReadWaitMs;
}
