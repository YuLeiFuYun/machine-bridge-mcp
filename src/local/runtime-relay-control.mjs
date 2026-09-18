import { isRelayReadyContext } from "./relay-connection-classification.mjs";
import { handleRuntimeRelayAcknowledgement } from "./runtime-relay-acknowledgements.mjs";
import { normalizeRelayResumeCalls } from "./runtime-relay.mjs";
import { normalizeAuthorityRevocation } from "../shared/authority-revocation.mjs";

export function handleRuntimeRelayProtocolViolation(runtime, errorCode, relayContext = {}) {
  const sessionId = Number(relayContext?.sessionId) || 0;
  if (staleRelayGeneration(runtime, relayContext)) {
    runtime.logger?.event?.("debug", "relay.protocol_violation.stale_generation_discarded", {
      source_transport: relayTransport(relayContext) || "unknown",
      connection_generation: "stale",
      handshake_stage: relayHandshakeStage(relayContext),
    }, "Discarded a protocol violation from an ended relay generation");
    return;
  }
  if (runtime.relay) {
    runtime.relay.handleServerError({ type: "error", error: errorCode }, relayContext);
    return;
  }
  runtime.logger?.error?.("remote relay protocol error; upgrade and redeploy both components, then restart the daemon", {
    error_code: safeMessageType(errorCode),
    source_transport: relayTransport(relayContext) || "unknown",
    connection_generation: sessionId ? "unknown" : "unbound",
    handshake_stage: relayHandshakeStage(relayContext),
    disposition: "fatal_runtime",
  });
}

export function handleRuntimeRelayDisconnect(runtime, relayContext = {}) {
  const transport = relayTransport(relayContext);
  const states = relayResumeState(runtime);
  if (!transport) states.clear();
  else clearRelayResumeState(runtime, transport);
  runtime.relayCallRecovery.disconnected();
}

export async function handleRuntimeRelayControlMessage(runtime, message, relayContext = {}) {
  if (message.type === "welcome") {
    runtime.relay?.observeWelcome(message, relayContext);
    return true;
  }
  if (message.type === "hello_ack") {
    clearRelayResumeState(runtime, relayTransport(relayContext) || "websocket");
    runtime.relay?.acknowledge(message, relayContext);
    return true;
  }
  if (staleRelayGeneration(runtime, relayContext)) {
    runtime.logger?.event?.("debug", "relay.control.stale_generation_discarded", {
      source_transport: relayTransport(relayContext) || "unknown",
      connection_generation: "stale",
      handshake_stage: relayHandshakeStage(relayContext),
      message_type: safeMessageType(message?.type),
    }, "Discarded a control message from an ended relay generation");
    return true;
  }
  if (message.type === "resume_calls") return handleResumeCalls(runtime, message, relayContext);
  if (message.type === "authority_revoke") {
    const sessionId = Number(relayContext.sessionId) || 0;
    const revocationId = String(message.revocation_id || "");
    const revocation = normalizeAuthorityRevocation(message);
    if (!sessionId || relayContext.authenticated !== true || !/^revoke_[A-Za-z0-9_-]{43}$/.test(revocationId) || !revocation) {
      runtime.handleRelayProtocolViolation("invalid_authority_revoke", relayContext);
      return true;
    }
    try {
      await runtime.applyAuthorityRevocation(revocation);
    } catch (error) {
      interruptRelayContext(runtime, "local_authority_revocation_retry", relayContext);
      throw error;
    }
    runtime.relay?.sendForSession?.({ type: "authority_revoke_ack", revocation_id: revocationId }, sessionId);
    return true;
  }
  if (message.type === "ready_ack") {
    const sessionId = Number(relayContext.sessionId) || 0;
    const key = relayResumeKey(relayContext);
    const resume = key ? relayResumeState(runtime).get(key) : null;
    if (!sessionId || !resume) {
      runtime.handleRelayProtocolViolation("resume_calls_required", relayContext);
      return true;
    }
    if (!runtime.relay?.confirmReady(message, relayContext)) {
      interruptRelayContext(runtime, "relay_transport_error", relayContext);
      return true;
    }
    const acknowledgement = runtime.relay?.sendForSession?.({
      type: "resume_calls_ack",
      missing_ids: Array.isArray(resume.missingIds) ? resume.missingIds : [],
    }, sessionId);
    if (!acknowledgement?.ok) {
      interruptRelayContext(runtime, "relay_transport_error", relayContext);
      return true;
    }
    relayResumeState(runtime).delete(key);
    return true;
  }
  if (message.type === "pong") return handlePong(runtime, relayContext);
  if (message.type === "tool_result_ack" || message.type === "daemon_draining_ack") {
    return handleRuntimeRelayAcknowledgement(runtimeForRelayContext(runtime, relayContext), message, relayContext);
  }
  if (message.type === "error") {
    runtime.relay?.handleServerError(message, relayContext);
    return true;
  }
  if (message.type === "cancel_call") {
    if (!isRelayReadyContext(relayContext, runtime.relay)
        || typeof message.id !== "string"
        || !/^call_[A-Za-z0-9_-]{8,240}$/.test(message.id)) {
      runtime.handleRelayProtocolViolation("invalid_cancel_call", relayContext);
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
  const key = relayResumeKey(relayContext);
  if (!resume.ok || !sessionId || !key || relayContext.authenticated !== true || relayContext.ready === true) {
    runtime.handleRelayProtocolViolation("invalid_resume_calls", relayContext);
    return true;
  }
  const states = relayResumeState(runtime);
  if (states.has(key)) {
    runtime.handleRelayProtocolViolation("invalid_resume_calls", relayContext);
    return true;
  }
  clearRelayResumeState(runtime, relayTransport(relayContext));
  const missingIds = runtime.reconcileRelayCalls(resume.ids);
  states.set(key, { missingIds: Array.isArray(missingIds) ? missingIds : [] });
  return true;
}

function handlePong(runtime, relayContext) {
  runtime.relay?.observeApplicationPong?.(relayContext);
  runtime.relayCallRecovery.pulse();
  return true;
}

function relayResumeState(runtime) {
  if (!(runtime.relayResumeStates instanceof Map)) runtime.relayResumeStates = new Map();
  return runtime.relayResumeStates;
}

function relayTransport(relayContext = {}) {
  const value = String(relayContext?.transport || "");
  return value === "websocket" || value === "https" ? value : "";
}

function relayResumeKey(relayContext = {}) {
  const transport = relayTransport(relayContext);
  const sessionId = Number(relayContext?.sessionId) || 0;
  return transport && sessionId ? transport + ":" + sessionId : "";
}

function clearRelayResumeState(runtime, transport = "") {
  const states = relayResumeState(runtime);
  if (!transport) {
    states.clear();
    return;
  }
  const prefix = transport + ":";
  for (const key of states.keys()) {
    if (key.startsWith(prefix)) states.delete(key);
  }
}

function staleRelayGeneration(runtime, relayContext = {}) {
  const sessionId = Number(relayContext?.sessionId) || 0;
  if (!sessionId || !relayTransport(relayContext) || typeof runtime.relay?.isCurrentSession !== "function") return false;
  return runtime.relay.isCurrentSession(relayContext) !== true;
}

function interruptRelayContext(runtime, category, relayContext) {
  if (typeof runtime.relay?.interruptForContext === "function") {
    return runtime.relay.interruptForContext(category, relayContext);
  }
  return runtime.relay?.interrupt?.(category);
}

function runtimeForRelayContext(runtime, relayContext) {
  return {
    relay: runtime.relay,
    relayCallRecovery: runtime.relayCallRecovery,
    relayShutdownDrain: runtime.relayShutdownDrain,
    handleRelayProtocolViolation(errorCode) {
      return runtime.handleRelayProtocolViolation(errorCode, relayContext);
    },
  };
}

function relayHandshakeStage(relayContext = {}) {
  if (relayContext?.ready === true) return "post_ready";
  if (relayContext?.authenticated === true) return "authenticated_pre_ready";
  return "pre_authentication";
}

function safeMessageType(value) {
  return String(value || "unknown").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "unknown";
}
