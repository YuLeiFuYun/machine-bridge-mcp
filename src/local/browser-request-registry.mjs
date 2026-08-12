import { randomBytes } from "node:crypto";
import { browserMethodMayMutate } from "./browser-command.mjs";
import { BridgeError } from "./errors.mjs";
import { MAX_BROWSER_MESSAGE_BYTES } from "./browser-extension-protocol.mjs";
export class BrowserRequestRegistry {
  constructor({ maximum = 32 } = {}) {
    this.maximum = maximum;
    this.pending = new Map();
  }
  request({ transport, method, params, timeoutSeconds, callId = "" }) {
    if (this.pending.size >= this.maximum) throw new Error("too many concurrent browser requests");
    const id = `browser_${randomBytes(18).toString("base64url")}`;
    return new Promise((resolvePromise, rejectPromise) => {
      const timeoutMs = timeoutSeconds * 1000;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        const terminationRequested = sendCancelQuietly(transport, id);
        rejectPromise(browserTransportError("timeout", `browser request timed out after ${timeoutSeconds}s`, method, terminationRequested));
      }, timeoutMs);
      timeout.unref?.();
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timeout, callId, method });
      try {
        const message = JSON.stringify({ type: "request", id, method, params, timeout_ms: timeoutMs });
        if (Buffer.byteLength(message) > MAX_BROWSER_MESSAGE_BYTES) throw new Error("browser request exceeds maximum message size");
        transport.send(message);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        rejectPromise(error);
      }
    });
  }
  settle(message) {
    if (message?.type !== "response" || typeof message.id !== "string") return false;
    const pending = this.pending.get(message.id);
    if (!pending) return false;
    clearTimeout(pending.timeout);
    this.pending.delete(message.id);
    if (message.ok === false) pending.reject(browserResponseError(String(message.error || "browser operation failed").slice(0, 2000), pending.method));
    else pending.resolve(message.result);
    return true;
  }

  cancelCall(callId, transport, reason = null) {
    if (!callId) return;
    for (const [id, pending] of this.pending) {
      if (pending.callId !== callId) continue;
      clearTimeout(pending.timeout);
      this.pending.delete(id);
      const terminationRequested = sendCancelQuietly(transport, id);
      const code = reason instanceof BridgeError && reason.code === "timeout" ? "timeout" : "cancelled";
      pending.reject(browserTransportError(code, code === "timeout" ? "browser request timed out" : "browser request cancelled", pending.method, terminationRequested));
    }
  }

  rejectAll(message) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      const publicMessage = browserMethodMayMutate(pending.method)
        ? "browser connection changed after request dispatch; outcome is unknown; inspect browser state before retrying"
        : message;
      pending.reject(browserTransportError("unavailable", publicMessage, pending.method, false));
    }
    this.pending.clear();
  }
}

function browserResponseError(message, method) {
  const mutation = browserMethodMayMutate(method);
  if (message.startsWith("browser broker request timed out")) {
    return browserTransportError("timeout", message, method, mutation && message.includes("cancellation requested"));
  }
  if (message === "browser broker is busy") return new BridgeError("limit_exceeded", message, { retryable: true });
  if (["browser extension is not connected", "browser extension send failed"].includes(message)) {
    return new BridgeError("unavailable", message, { retryable: true });
  }
  if (message.startsWith("browser connection changed after request dispatch")) {
    return browserTransportError("unavailable", message, method, false);
  }
  const partial = mutation && (
    message.startsWith("trusted browser input may have been partially dispatched")
    || message.startsWith("form submission failed after partial changes")
  );
  return partial
    ? new BridgeError("execution_failed", message, { retryable: false, details: { side_effects_started: true, termination_requested: false, effect_settlement: "unknown" } })
    : new Error(message);
}

function browserTransportError(code, message, method, terminationRequested) {
  const mutation = browserMethodMayMutate(method);
  return new BridgeError(code, message, {
    retryable: !mutation && code !== "cancelled",
    ...(mutation ? { details: { request_delivery: "sent", side_effects_started: "unknown", termination_requested: terminationRequested, effect_settlement: terminationRequested ? "pending" : "unknown" } } : {}),
  });
}

function sendCancelQuietly(transport, id) {
  try { transport?.send(JSON.stringify({ type: "cancel", id })); return true; } catch { return false; }
}
