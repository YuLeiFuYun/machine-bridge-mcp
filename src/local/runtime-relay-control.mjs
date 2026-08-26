import { isRelayReadyContext } from "./relay-connection-classification.mjs";
import { handleRuntimeRelayAcknowledgement } from "./runtime-relay-acknowledgements.mjs";
import { normalizeRelayResumeCalls } from "./runtime-relay.mjs";
import { normalizeAuthorityRevocation } from "../shared/authority-revocation.mjs";

export async function handleRuntimeRelayControlMessage(runtime, message, relayContext = {}) {
  if (message.type === "welcome") {
    runtime.relay?.observeWelcome(message, relayContext);
    return true;
  }
  if (message.type === "hello_ack") {
    runtime.relayResumeSessionId = 0;
    runtime.relayResumeMissingIds = [];
    runtime.relay?.acknowledge(message, relayContext);
    return true;
  }
  if (message.type === "resume_calls") return handleResumeCalls(runtime, message, relayContext);
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
    if (!runtime.relay?.confirmReady(message, relayContext)) {
      runtime.relay?.interrupt?.("relay_transport_error");
      return true;
    }
    const acknowledgement = runtime.relay?.sendForSession?.({
      type: "resume_calls_ack",
      missing_ids: Array.isArray(runtime.relayResumeMissingIds) ? runtime.relayResumeMissingIds : [],
    }, sessionId);
    if (!acknowledgement?.ok) {
      runtime.relay?.interrupt?.("relay_transport_error");
      return true;
    }
    runtime.relayResumeSessionId = 0;
    runtime.relayResumeMissingIds = [];
    return true;
  }
  if (message.type === "pong") return handlePong(runtime, relayContext);
  if (message.type === "tool_result_ack" || message.type === "daemon_draining_ack") {
    return handleRuntimeRelayAcknowledgement(runtime, message, relayContext);
  }
  if (message.type === "error") {
    runtime.relay?.handleServerError(message, relayContext);
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

function handleResumeCalls(runtime, message, relayContext) {
  const sessionId = Number(relayContext.sessionId) || 0;
  const resume = normalizeRelayResumeCalls(message);
  if (!resume.ok || !sessionId || relayContext.authenticated !== true || relayContext.ready === true) {
    runtime.handleRelayProtocolViolation("invalid_resume_calls");
    return true;
  }
  const missingIds = runtime.reconcileRelayCalls(resume.ids);
  runtime.relayResumeSessionId = sessionId;
  runtime.relayResumeMissingIds = Array.isArray(missingIds) ? missingIds : [];
  return true;
}

function handlePong(runtime, relayContext) {
  runtime.relay?.observeApplicationPong?.(relayContext);
  runtime.relayCallRecovery.pulse();
  return true;
}
