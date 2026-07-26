(() => {
  const SAFE_EXACT = new Set([
    "unsupported browser tab action",
    "no active browser tab",
    "navigate requires url",
    "trusted input is unavailable for this action",
    "trusted input currently requires the top frame; use input_mode=dom for a subframe",
    "this page cannot be scripted by a browser extension",
    "page automation module is unavailable",
    "browser request cancelled",
    "tab closed during navigation wait",
    "element reference is stale; inspect the page again",
    "element did not become geometrically stable before timeout",
    "matched element is not a file input",
    "no form or submit control found",
    "matched element is not associated with a form",
    "select option was not found",
    "trusted input requires a valid tab",
    "trusted input target has no usable viewport point",
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
