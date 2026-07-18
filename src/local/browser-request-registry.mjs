import { randomBytes } from "node:crypto";
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
        sendCancelQuietly(transport, id);
        rejectPromise(new Error(`browser request timed out after ${timeoutSeconds}s`));
      }, timeoutMs);
      timeout.unref?.();
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timeout, callId });
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
    if (message.ok === false) pending.reject(new Error(String(message.error || "browser operation failed").slice(0, 2000)));
    else pending.resolve(message.result);
    return true;
  }

  cancelCall(callId, transport) {
    if (!callId) return;
    for (const [id, pending] of this.pending) {
      if (pending.callId !== callId) continue;
      clearTimeout(pending.timeout);
      this.pending.delete(id);
      sendCancelQuietly(transport, id);
      pending.reject(new Error("browser request cancelled; a user-visible action may already have completed"));
    }
  }

  rejectAll(message) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }
}

function sendCancelQuietly(transport, id) {
  try { transport?.send(JSON.stringify({ type: "cancel", id })); } catch {}
}
