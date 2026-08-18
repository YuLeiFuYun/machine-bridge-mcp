import { BridgeError } from "./errors.mjs";

const TRUSTED_PAGE_ACTIONS = new Set(["click", "double_click", "hover", "press", "type_text"]);
const AMBIGUOUS_TRUSTED_INPUT = "trusted browser input may have been partially dispatched";
export const TRUSTED_INPUT_QUARANTINE_REASON = "browser_trusted_input_quarantined";
export const TRUSTED_INPUT_QUARANTINE_FALLBACK = "trusted_input_quarantined_after_ambiguous_failure";

export class BrowserTrustedInputHealth {
  constructor({ logger = null } = {}) {
    this.logger = logger || { event() {} };
    this.quarantinedGeneration = 0;
  }

  status(bridge = {}) {
    const connected = bridge.extensionConnected === true;
    const generation = extensionGeneration(bridge);
    const supported = bridge.extensionInfo?.capabilities?.includes("trusted_input") === true;
    const quarantined = connected && generation > 0 && this.quarantinedGeneration === generation;
    return Object.freeze({ connected, generation, supported, quarantined, available: connected && supported && !quarantined });
  }

  pageInputMode({ inputMode, action, bridge }) {
    const health = this.status(bridge);
    if (!health.quarantined || inputMode === "dom" || !TRUSTED_PAGE_ACTIONS.has(action)) {
      return Object.freeze({ inputMode, fallback: false });
    }
    if (inputMode === "trusted") throw quarantinedError();
    return Object.freeze({ inputMode: "dom", fallback: true });
  }

  assertTrustedAvailable(bridge) {
    if (this.status(bridge).quarantined) throw quarantinedError();
  }

  noteAmbiguousFailure(error, bridge = {}) {
    const message = String(error?.message || error || "");
    if (!message.startsWith(AMBIGUOUS_TRUSTED_INPUT)) return false;
    const health = this.status(bridge);
    if (!health.connected || health.generation < 1) return false;
    if (this.quarantinedGeneration !== health.generation) {
      this.quarantinedGeneration = health.generation;
      this.logger.event?.("warn", "browser.trusted_input.quarantined", {
        reason: "ambiguous_input_settlement",
      }, "trusted browser input quarantined for the current extension connection");
    }
    return true;
  }
}

function extensionGeneration(bridge) {
  const value = bridge.extensionGeneration;
  if (Number.isSafeInteger(value) && value > 0) return value;
  return bridge.extensionConnected === true ? 1 : 0;
}

function quarantinedError() {
  return new BridgeError("unavailable",
    "trusted browser input is quarantined for the current extension connection after an ambiguous dispatch",
    {
      retryable: false,
      details: { reason: TRUSTED_INPUT_QUARANTINE_REASON, side_effects_started: false },
    });
}
