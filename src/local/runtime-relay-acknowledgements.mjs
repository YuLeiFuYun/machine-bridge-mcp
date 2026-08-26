import { isRelayReadyContext } from "./relay-connection-classification.mjs";
import { handleRuntimeRelayShutdownAck } from "./runtime-relay-shutdown-drain.mjs";

export function handleRuntimeRelayAcknowledgement(runtime, message, relayContext = {}) {
  if (message.type === "tool_result_ack") {
    if (!isRelayReadyContext(relayContext, runtime.relay)
        || typeof message.id !== "string"
        || !/^call_[A-Za-z0-9_-]{8,240}$/.test(message.id)) {
      runtime.handleRelayProtocolViolation("invalid_tool_result_ack");
      return true;
    }
    runtime.relayCallRecovery.acknowledge(message.id);
    return true;
  }
  if (message.type !== "daemon_draining_ack") return false;
  return handleRuntimeRelayShutdownAck(runtime, message, isRelayReadyContext(relayContext, runtime.relay));
}
