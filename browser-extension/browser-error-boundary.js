(() => {
  const SAFE_EXACT = new Set([
    "unsupported browser tab action",
    "no active browser tab",
    "navigate requires url",
    "trusted input is unavailable for this action",
    "trusted input currently requires the top frame; use input_mode=dom for a subframe",
    "this page cannot be scripted by a browser extension",
    "page automation module is unavailable",
    "page automation module version mismatch",
    "browser request cancelled",
    "snapshot browser tab changed before navigation dispatch; observe again",
    "snapshot browser tab could not be verified before navigation dispatch; observe again",
    "snapshot history document changed before dispatch; observe again",
    "snapshot history document could not be verified before dispatch; observe again",
    "snapshot history entry changed before dispatch; observe again",
    "snapshot history entry could not be verified before dispatch; observe again",
    "snapshot browser history has no back entry before dispatch; observe again",
    "snapshot browser history has no forward entry before dispatch; observe again",
    "snapshot history mutation API is unavailable before dispatch; observe again",
    "browser tab activation completed but its current window is unavailable before focus; inspect tabs before retrying",
    "browser tab activation completed but the target tab could not be verified before focus; inspect tabs before retrying",
    "browser tab activation completed but the target tab was no longer active before focus; inspect tabs before retrying",
    "browser tab activation and window focus completed but the target tab could not be verified; inspect tabs before retrying",
    "browser tab activation and window focus completed but the target tab moved windows; inspect tabs before retrying",
    "browser tab activation and window focus completed but the target tab was no longer active; inspect tabs before retrying",
    "tab closed during navigation wait",
    "element reference is stale; inspect the page again",
    "element did not become geometrically stable before timeout",
    "matched element is not a file input",
    "no form or submit control found",
    "matched element is not associated with a form",
    "select option was not found",
    "trusted input requires a valid tab",
    "trusted input target has no usable viewport point",
    "browser screenshot cannot safely switch tabs without a restore baseline",
    "browser screenshot could not revalidate the active tab before temporary activation",
    "browser screenshot active tab changed before temporary activation",
    "browser screenshot could not verify target tab at capture boundary",
    "browser screenshot target tab was not active at capture boundary",
    "browser screenshot could not verify the active tab after capture",
    "browser screenshot active tab changed during capture",
    "browser screenshot could not verify active-tab restoration",
    "browser screenshot could not restore the previous active tab",
    "browser tab became unavailable during computer observation",
  ]);

  function publicError(error) {
    const message = String(error?.message || error || "");
    if (message.startsWith("unknown browser method:")) return "unknown browser method";
    if (message.startsWith("invalid CSS selector:")) return "invalid CSS selector";
    if (/^selector matched \d+ elements;/.test(message)) return "selector matched multiple elements; use ref or index to disambiguate";
    if (message.startsWith("browser wait timed out")) return "browser wait timed out";
    if (message.startsWith("trusted browser input may have been partially dispatched")) {
      return "trusted browser input may have been partially dispatched; the action outcome is unknown. Inspect the page before retrying.";
    }
    if (message.startsWith("browser action may have been dispatched; the action outcome is unknown")) {
      return "browser action may have been dispatched; the action outcome is unknown. Inspect the page before retrying.";
    }
    if (message.startsWith("browser tab mutation may have been dispatched; the outcome is unknown")) {
      return "browser tab mutation may have been dispatched; the outcome is unknown. Inspect tabs before retrying.";
    }
    if (message.startsWith("browser screenshot temporary tab activation may have been dispatched; the outcome is unknown")) {
      return "browser screenshot temporary tab activation may have been dispatched; the outcome is unknown. Inspect tabs before retrying.";
    }
    if (message.startsWith("browser screenshot restoration may have been dispatched; the active-tab outcome is unknown")) {
      return "browser screenshot restoration may have been dispatched; the active-tab outcome is unknown. Inspect tabs before retrying.";
    }
    if (message.startsWith("trusted browser input unavailable: visual_snapshot_changed_before_dispatch")) {
      return "visual snapshot changed before trusted input; observe again";
    }
    if (message.startsWith("snapshot_backend_target_changed_before_dispatch")) {
      return "snapshot backend target changed before trusted input; observe again";
    }
    if (message.startsWith("snapshot_ref_identity_changed_before_dispatch")) {
      return "snapshot ref identity changed before dispatch; observe again";
    }
    if (message.startsWith("snapshot_backend_geometry_unavailable_before_dispatch")
        || message.startsWith("snapshot_backend_trusted_input_unavailable_before_dispatch")) {
      return "snapshot backend trusted input unavailable before dispatch";
    }
    if (message.startsWith("form submission failed after")) {
      return "form submission failed after partial changes; inspect the page before retrying";
    }
    if (message.startsWith("element was not actionable before timeout")) return "element was not actionable before timeout";
    if (message.startsWith("element was not clickable before timeout")) return "element was not clickable before timeout";
    if (message.startsWith("unsupported element action:")) return "unsupported element action";
    if (message.startsWith("unsupported key modifier:") || message.startsWith("unsupported key:")) return "unsupported keyboard input";
    return SAFE_EXACT.has(message) ? message : "browser operation failed";
  }

  Object.defineProperty(globalThis, "__machineBridgeBrowserErrorBoundary", {
    value: Object.freeze({ publicError }),
    configurable: false,
  });
})();
