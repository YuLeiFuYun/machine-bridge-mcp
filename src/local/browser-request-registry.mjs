import { randomBytes } from "node:crypto";
import { MAX_BROWSER_MESSAGE_BYTES } from "./browser-extension-protocol.mjs";
import { browserRequestResponseError, browserRequestTransportError, invalidBrowserResponseSettlement } from "./browser-request-settlement.mjs";
export class BrowserRequestRegistry {
  constructor({ maximum = 32 } = {}) {
    this.maximum = maximum;
    this.pending = new Map();
  }
  request({ transport, method, params, timeoutSeconds, callId = "" }) {
    if (this.pending.size >= this.maximum) throw new Error("too many concurrent browser requests");
    if (typeof method !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(method)) throw new Error("browser request method is invalid");
    if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 185) throw new Error("browser request timeout is invalid");
    const id = `browser_${randomBytes(18).toString("base64url")}`;
    return new Promise((resolvePromise, rejectPromise) => {
      const timeoutMs = timeoutSeconds * 1000;
      const timeout = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        const terminationRequested = sendCancelQuietly(transport, id);
        rejectPromise(browserRequestTransportError({
          pending,
          code: "timeout",
          fallback: `browser request timed out after ${timeoutSeconds}s`,
          terminationRequested,
        }));
      }, timeoutMs);
      timeout.unref?.();
      const pending = { resolve: resolvePromise, reject: rejectPromise, timeout, callId, method, dispatchAttempted: false };
      this.pending.set(id, pending);
      try {
        const message = JSON.stringify({ type: "request", id, method, params, timeout_ms: timeoutMs });
        if (Buffer.byteLength(message) > MAX_BROWSER_MESSAGE_BYTES) throw new Error("browser request exceeds maximum message size");
        pending.dispatchAttempted = true;
        transport.send(message);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        rejectPromise(pending.dispatchAttempted
          ? browserRequestTransportError({ pending, code: "unavailable", fallback: error })
          : error);
      }
    });
  }
  settle(message) {
    if (message?.type !== "response" || typeof message.id !== "string") return false;
    const pending = this.pending.get(message.id);
    if (!pending) return false;
    clearTimeout(pending.timeout);
    this.pending.delete(message.id);
    if (message.ok === false) {
      if (typeof message.error !== "string" || !message.error || message.error.includes("\0") || message.error.length > 2000) {
        pending.reject(invalidBrowserResponseSettlement(pending));
      } else {
        pending.reject(browserRequestResponseError(message.error, pending));
      }
    } else if (message.ok === true && message.result && typeof message.result === "object" && !Array.isArray(message.result)) {
      pending.resolve(message.result);
    } else {
      pending.reject(invalidBrowserResponseSettlement(pending));
    }
    return true;
  }

  cancelCall(callId, transport, reason = null) {
    if (!callId) return;
    for (const [id, pending] of this.pending) {
      if (pending.callId !== callId) continue;
      clearTimeout(pending.timeout);
      this.pending.delete(id);
      const terminationRequested = sendCancelQuietly(transport, id);
      const code = reason?.code === "timeout" ? "timeout" : "cancelled";
      pending.reject(browserRequestTransportError({
        pending,
        code,
        fallback: code === "timeout" ? "browser request timed out" : "browser request cancelled",
        terminationRequested,
      }));
    }
  }

  rejectAll(message) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(browserRequestTransportError({ pending, code: "unavailable", fallback: message }));
    }
    this.pending.clear();
  }
}

function sendCancelQuietly(transport, id) {
  try { transport?.send(JSON.stringify({ type: "cancel", id })); return true; } catch { return false; }
}
