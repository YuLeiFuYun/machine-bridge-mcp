(() => {
  if (globalThis.__machineBridgeDevtoolsInput) return;

  const MODIFIERS = Object.freeze({ Alt: 1, Control: 2, Meta: 4, Shift: 8 });
  const tabQueues = new Map();
  const KEY_DATA = Object.freeze({
    Enter: { code: "Enter", virtualKeyCode: 13 },
    Tab: { code: "Tab", virtualKeyCode: 9 },
    Escape: { code: "Escape", virtualKeyCode: 27 },
    Backspace: { code: "Backspace", virtualKeyCode: 8 },
    Delete: { code: "Delete", virtualKeyCode: 46 },
    ArrowLeft: { code: "ArrowLeft", virtualKeyCode: 37 },
    ArrowUp: { code: "ArrowUp", virtualKeyCode: 38 },
    ArrowRight: { code: "ArrowRight", virtualKeyCode: 39 },
    ArrowDown: { code: "ArrowDown", virtualKeyCode: 40 },
    Home: { code: "Home", virtualKeyCode: 36 },
    End: { code: "End", virtualKeyCode: 35 },
    PageUp: { code: "PageUp", virtualKeyCode: 33 },
    PageDown: { code: "PageDown", virtualKeyCode: 34 },
    Space: { code: "Space", virtualKeyCode: 32, key: " " },
  });

  async function perform(tabId, action, details = {}) {
    if (!Number.isInteger(tabId) || tabId < 1) throw new Error("trusted input requires a valid tab");
    const previous = tabQueues.get(tabId) || Promise.resolve();
    const current = previous.catch(() => {}).then(() => withDebugger(tabId, async (send) => {
      if (action === "click") return mouseClick(send, details.point, 1);
      if (action === "double_click") return mouseClick(send, details.point, 2);
      if (action === "hover") return mouseMove(send, details.point);
      if (action === "press") return pressKey(send, details.key || "Enter");
      if (action === "type_text") return send("Input.insertText", { text: String(details.text ?? "") });
      throw new Error(`trusted input does not support '${action}'`);
    }));
    tabQueues.set(tabId, current);
    try { return await current; }
    finally { if (tabQueues.get(tabId) === current) tabQueues.delete(tabId); }
  }

  async function withDebugger(tabId, operation) {
    const target = { tabId };
    let attached = false;
    let dispatchStarted = false;
    try {
      await chrome.debugger.attach(target, "1.3");
      attached = true;
      const send = (method, params = {}) => {
        dispatchStarted = true;
        return chrome.debugger.sendCommand(target, method, params);
      };
      return await operation(send);
    } catch (error) {
      if (error?.machineBridgeTrustedInput === true) throw error;
      throw trustedInputError(error, { safeToFallback: !dispatchStarted, dispatchStarted });
    } finally {
      if (attached) {
        try { await chrome.debugger.detach(target); } catch {}
      }
    }
  }

  async function mouseMove(send, point) {
    const { x, y } = normalizePoint(point);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  }

  async function mouseClick(send, point, clickCount) {
    const { x, y } = normalizePoint(point);
    await mouseMove(send, { x, y });
    for (let count = 1; count <= clickCount; count += 1) {
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: count });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: count });
    }
  }

  async function pressKey(send, shortcut) {
    const parsed = parseShortcut(shortcut);
    const down = {
      type: parsed.text ? "keyDown" : "rawKeyDown",
      key: parsed.key,
      code: parsed.code,
      modifiers: parsed.modifiers,
      windowsVirtualKeyCode: parsed.virtualKeyCode,
      nativeVirtualKeyCode: parsed.virtualKeyCode,
      ...(parsed.text ? { text: parsed.text, unmodifiedText: parsed.text } : {}),
    };
    await send("Input.dispatchKeyEvent", down);
    await send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: parsed.key,
      code: parsed.code,
      modifiers: parsed.modifiers,
      windowsVirtualKeyCode: parsed.virtualKeyCode,
      nativeVirtualKeyCode: parsed.virtualKeyCode,
    });
  }

  function parseShortcut(value) {
    const parts = String(value || "Enter").split("+").map((part) => part.trim()).filter(Boolean);
    const keyName = parts.pop() || "Enter";
    let modifiers = 0;
    for (const raw of parts) {
      const name = raw === "Ctrl" ? "Control" : raw === "Cmd" || raw === "Command" ? "Meta" : raw;
      if (!(name in MODIFIERS)) throw new Error(`unsupported key modifier: ${raw}`);
      modifiers |= MODIFIERS[name];
    }
    const known = KEY_DATA[keyName];
    if (known) return {
      key: known.key || keyName,
      code: known.code,
      virtualKeyCode: known.virtualKeyCode,
      modifiers,
      text: "",
    };
    if ([...keyName].length !== 1) throw new Error(`unsupported key: ${keyName}`);
    const character = keyName;
    const upper = character.toUpperCase();
    return {
      key: character,
      code: /[A-Za-z]/.test(character) ? `Key${upper}` : "",
      virtualKeyCode: upper.codePointAt(0),
      modifiers,
      text: modifiers & (MODIFIERS.Control | MODIFIERS.Meta | MODIFIERS.Alt) ? "" : character,
    };
  }

  function normalizePoint(point) {
    const x = Number(point?.x);
    const y = Number(point?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) throw new Error("trusted input target has no usable viewport point");
    return { x, y };
  }

  function trustedInputError(error, { safeToFallback, dispatchStarted }) {
    const wrapped = new Error(`trusted browser input unavailable: ${cleanError(error)}`);
    Object.defineProperties(wrapped, {
      machineBridgeTrustedInput: { value: true },
      safeToFallback: { value: safeToFallback === true },
      dispatchStarted: { value: dispatchStarted === true },
    });
    return wrapped;
  }

  function cleanError(error) {
    return String(error?.message || error || "unknown error").replace(/\s+/g, " ").slice(0, 500);
  }

  Object.defineProperty(globalThis, "__machineBridgeDevtoolsInput", {
    value: Object.freeze({ perform }),
    configurable: false,
  });
})();
