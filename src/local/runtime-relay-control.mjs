import { isRelayReadyContext } from "./relay-connection-classification.mjs";
import { normalizeRelayResumeCalls } from "./runtime-relay.mjs";
import { normalizeAuthorityRevocation } from "../shared/authority-revocation.mjs";

export async function handleRuntimeRelayControlMessage(runtime, message, relayContext = {}) {
  if (message.type === "welcome") {
    runtime.relay?.observeWelcome(message);
    return true;
  }
  if (message.type === "hello_ack") {
    runtime.relayResumeSessionId = 0;
    runtime.relay?.acknowledge(message);
    return true;
  }
  if (message.type === "resume_calls") {
    const sessionId = Number(relayContext.sessionId) || 0;
    const resume = normalizeRelayResumeCalls(message);
    if (!resume.ok || !sessionId || relayContext.authenticated !== true || relayContext.ready === true) {
      runtime.handleRelayProtocolViolation("invalid_resume_calls");
      return true;
    }
    runtime.reconcileRelayCalls(resume.ids);
    runtime.relayResumeSessionId = sessionId;
    return true;
  }
  if (message.type === "authority_revoke") {
    const sessionId = Number(relayContext.sessionId) || 0;
    const revocationId = String(message.revocation_id || "");
    const revocation = normalizeAuthorityRevocation(message);
    if (!sessionId || relayContext.authenticated !== true || !/^revoke_[A-Za-z0-9_-]{43}$/.test(revocationId) || !revocation) {
      runtime.handleRelayProtocolViolation("invalid_authority_revoke");
      return true;
    }
    try {
      await runtime.applyAuthorityRevocation(revocation);
    } catch (error) {
      runtime.relay?.interrupt?.("local_authority_revocation_retry");
      throw error;
    }
    runtime.relay?.sendForSession?.({ type: "authority_revoke_ack", revocation_id: revocationId }, sessionId);
    return true;
  }
  if (message.type === "ready_ack") {
    const sessionId = Number(relayContext.sessionId) || 0;
    if (!sessionId || sessionId !== runtime.relayResumeSessionId) {
      runtime.handleRelayProtocolViolation("resume_calls_required");
      return true;
    }
    runtime.relay?.confirmReady(message);
    runtime.relayResumeSessionId = 0;
    return true;
  }
  if (message.type === "pong") {
    runtime.relayCallRecovery.pulse();
    return true;
  }
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
  if (message.type === "error") {
    runtime.relay?.handleServerError(message);
    return true;
  }
  if (message.type === "cancel_call") {
    if (!isRelayReadyContext(relayContext, runtime.relay)
        || typeof message.id !== "string"
        || !/^call_[A-Za-z0-9_-]{8,240}$/.test(message.id)) {
      runtime.handleRelayProtocolViolation("invalid_cancel_call");
      return true;
    }
    runtime.cancelRelayCall(message.id, "caller_cancelled");
    return true;
  }
  return false;
}
