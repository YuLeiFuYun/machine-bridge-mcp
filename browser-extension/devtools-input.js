(() => {
  if (globalThis.__machineBridgeDevtoolsInput) return;

  const MODIFIERS = Object.freeze({ Alt: 1, Control: 2, Meta: 4, Shift: 8 });
  const DRAG_MOVE_STEPS = 8;
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
    if (!Number.isSafeInteger(tabId) || tabId < 1) throw new Error("trusted input requires a valid tab");
    let prepared;
    try { prepared = validateTrustedInput(action, details); }
    catch (error) { throw trustedInputError(error, { safeToFallback: true, dispatchStarted: false }); }
    const session = globalThis.__machineBridgeDevtoolsSession;
    if (!session?.run) throw trustedInputError(new Error("DevTools session module is unavailable"), { safeToFallback: true, dispatchStarted: false });
    try {
      return await session.run(tabId, ({ send }) => performWithSend(send, action, details), { beforeAttach: prepared.beforeDispatch });
    } catch (error) {
      if (error?.machineBridgeTrustedInput === true || error?.machineBridgeBeforeDispatchAbort === true) throw error;
      throw trustedInputError(error, { safeToFallback: true, dispatchStarted: false });
    }
  }

  async function performWithSend(send, action, details = {}) {
    if (typeof send !== "function") throw trustedInputError(new Error("DevTools command sender is unavailable"), { safeToFallback: true, dispatchStarted: false });
    let prepared;
    try { prepared = validateTrustedInput(action, details); }
    catch (error) { throw trustedInputError(error, { safeToFallback: true, dispatchStarted: false }); }
    if (typeof prepared.beforeDispatch === "function") prepared.beforeDispatch();
    if (prepared.expectedScreenshotSha256) {
      try { await verifyVisualSnapshot(send, prepared); }
      catch (error) {
        if (error?.machineBridgeTrustedInput === true) throw error;
        throw trustedInputError(error, { safeToFallback: true, dispatchStarted: false });
      }
    }
    if (typeof prepared.beforeDispatch === "function") prepared.beforeDispatch();
    let dispatchStarted = false;
    try {
      const dispatch = (method, params = {}) => {
        dispatchStarted = true;
        return send(method, params);
      };
      if (prepared.action === "click") return await mouseClick(dispatch, prepared.point, 1);
      if (prepared.action === "double_click") return await mouseClick(dispatch, prepared.point, 2);
      if (prepared.action === "hover") return await mouseMove(dispatch, prepared.point);
      if (prepared.action === "drag") return await mouseDrag(dispatch, prepared.point, prepared.destinationPoint);
      if (prepared.action === "scroll") return await mouseScroll(dispatch, prepared.point, prepared.deltaX, prepared.deltaY);
      if (prepared.action === "press") return await pressKey(dispatch, prepared.key);
      if (prepared.action === "type_text") return await dispatch("Input.insertText", { text: prepared.text });
      if (prepared.action === "fill_text") {
        await pressKey(dispatch, prepared.selectAllKey);
        await pressKey(dispatch, "Backspace");
        return await dispatch("Input.insertText", { text: prepared.text });
      }
      throw new Error(`trusted input does not support '${prepared.action}'`);
    } catch (error) {
      if (error?.machineBridgeTrustedInput === true) throw error;
      throw trustedInputError(error, { safeToFallback: !dispatchStarted, dispatchStarted });
    }
  }

  function validateTrustedInput(action, details) {
    if (!details || typeof details !== "object" || Array.isArray(details)) throw new Error("trusted input details are invalid before dispatch");
    if (typeof action !== "string" || !["click", "double_click", "hover", "drag", "scroll", "press", "type_text", "fill_text"].includes(action)) {
      throw new Error(`trusted input does not support '${typeof action === "string" ? action : "invalid"}'`);
    }
    const common = new Set(["beforeDispatch", "expectedScreenshotSha256", "screenshotFormat", "screenshotQuality"]);
    const actionFields = {
      click: ["point"], double_click: ["point"], hover: ["point"], drag: ["point", "destinationPoint"],
      scroll: ["point", "deltaX", "deltaY"], press: ["key"], type_text: ["text"], fill_text: ["text", "selectAllKey"],
    };
    const allowed = new Set([...common, ...actionFields[action]]);
    for (const key of Object.keys(details)) if (!allowed.has(key)) throw new Error(`unknown trusted input detail '${key}' before dispatch`);
    const prepared = { action, beforeDispatch: details.beforeDispatch };
    if (details.beforeDispatch !== undefined && typeof details.beforeDispatch !== "function") throw new Error("trusted input beforeDispatch hook is invalid before dispatch");
    if (["click", "double_click", "hover", "drag", "scroll"].includes(action)) prepared.point = normalizePoint(details.point);
    if (action === "drag") prepared.destinationPoint = normalizePoint(details.destinationPoint);
    if (action === "scroll") {
      prepared.deltaX = normalizeScrollDelta(details.deltaX, "deltaX");
      prepared.deltaY = normalizeScrollDelta(details.deltaY, "deltaY");
      if (prepared.deltaX === 0 && prepared.deltaY === 0) throw new Error("trusted scroll requires a non-zero delta");
    }
    if (action === "press") {
      if (details.text !== undefined || details.selectAllKey !== undefined) throw new Error("trusted press details are invalid before dispatch");
      prepared.key = details.key === undefined || details.key === "" ? "Enter" : requiredInputText(details.key, "key", 100);
      parseShortcut(prepared.key);
    }
    if (action === "type_text" || action === "fill_text") {
      prepared.text = requiredInputText(details.text, "text", 131072);
      if (details.key !== undefined) throw new Error("trusted text input key is invalid before dispatch");
      if (action === "fill_text") {
        if (details.selectAllKey !== "Meta+A" && details.selectAllKey !== "Control+A") throw new Error("trusted fill select-all key is invalid before dispatch");
        prepared.selectAllKey = details.selectAllKey;
      } else if (details.selectAllKey !== undefined) throw new Error("trusted type_text select-all key is invalid before dispatch");
    }
    const hasVisual = details.expectedScreenshotSha256 !== undefined && details.expectedScreenshotSha256 !== "";
    if (hasVisual) {
      prepared.expectedScreenshotSha256 = exactVisualDigest(details.expectedScreenshotSha256);
      prepared.screenshotFormat = exactScreenshotFormat(details.screenshotFormat);
      prepared.screenshotQuality = exactScreenshotQuality(details.screenshotQuality);
    } else {
      for (const key of ["screenshotFormat", "screenshotQuality"]) if (details[key] !== undefined) throw new Error("visual snapshot metadata is invalid without a digest before dispatch");
      prepared.expectedScreenshotSha256 = "";
    }
    return prepared;
  }

  function requiredInputText(value, label, maxLength) {
    if (typeof value !== "string" || value.includes("\0") || value.length > maxLength) throw new Error(`${label} is invalid before dispatch`);
    return value;
  }

  function exactVisualDigest(value) {
    if (typeof value !== "string" || !/^[A-Fa-f0-9]{64}$/.test(value)) throw new Error("visual_snapshot_digest_invalid_before_dispatch");
    return value.toLowerCase();
  }

  function exactScreenshotFormat(value) {
    if (typeof value !== "string" || !["png", "jpeg"].includes(value)) throw new Error("visual_snapshot_format_invalid_before_dispatch");
    return value;
  }

  function exactScreenshotQuality(value) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw new Error("visual_snapshot_quality_invalid_before_dispatch");
    return value;
  }

  async function verifyVisualSnapshot(send, details) {
    const expected = details.expectedScreenshotSha256;
    const format = details.screenshotFormat;
    const quality = details.screenshotQuality;
    await send("Page.enable");
    const capture = await send("Page.captureScreenshot", {
      format,
      ...(format === "jpeg" ? { quality } : {}),
      fromSurface: true,
      captureBeyondViewport: false,
      optimizeForSpeed: true,
    });
    const actual = await sha256Base64(capture?.data);
    if (actual !== expected) throw new Error("visual_snapshot_changed_before_dispatch");
  }

  async function sha256Base64(value) {
    if (typeof value !== "string" || !value) throw new Error("visual_snapshot_capture_invalid_before_dispatch");
    const base64 = value;
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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

  async function mouseDrag(send, sourcePoint, destinationPoint) {
    const source = normalizePoint(sourcePoint);
    const destination = normalizePoint(destinationPoint);
    await mouseMove(send, source);
    let lastPoint = source;
    try {
      await send("Input.dispatchMouseEvent", {
        type: "mousePressed", x: source.x, y: source.y, button: "left", buttons: 1, clickCount: 1,
      });
      for (let step = 1; step <= DRAG_MOVE_STEPS; step += 1) {
        const ratio = step / DRAG_MOVE_STEPS;
        lastPoint = {
          x: source.x + (destination.x - source.x) * ratio,
          y: source.y + (destination.y - source.y) * ratio,
        };
        await send("Input.dispatchMouseEvent", {
          type: "mouseMoved", x: lastPoint.x, y: lastPoint.y, button: "left", buttons: 1,
        });
      }
      await send("Input.dispatchMouseEvent", {
        type: "mouseReleased", x: destination.x, y: destination.y, button: "left", buttons: 0, clickCount: 1,
      });
    } catch (error) {
      try {
        await send("Input.dispatchMouseEvent", {
          type: "mouseReleased", x: lastPoint.x, y: lastPoint.y, button: "left", buttons: 0, clickCount: 1,
        });
      } catch {}
      throw error;
    }
  }

  async function mouseScroll(send, point, deltaX, deltaY) {
    const { x, y } = normalizePoint(point);
    const xDelta = normalizeScrollDelta(deltaX, "deltaX");
    const yDelta = normalizeScrollDelta(deltaY, "deltaY");
    if (xDelta === 0 && yDelta === 0) throw new Error("trusted scroll requires a non-zero delta");
    await send("Input.dispatchMouseEvent", {
      type: "mouseWheel", x, y, deltaX: xDelta, deltaY: yDelta,
    });
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
    const text = value === undefined || value === "" ? "Enter" : requiredInputText(value, "key", 100);
    const parts = text.split("+").map((part) => part.trim()).filter(Boolean);
    const keyName = parts.pop() || "Enter";
    let modifiers = 0;
    for (const raw of parts) {
      const name = raw === "Ctrl" ? "Control" : raw === "Cmd" || raw === "Command" ? "Meta" : raw;
      if (!Object.hasOwn(MODIFIERS, name)) throw new Error(`unsupported key modifier: ${raw}`);
      modifiers |= MODIFIERS[name];
    }
    const known = Object.hasOwn(KEY_DATA, keyName) ? KEY_DATA[keyName] : null;
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
    if (!point || typeof point !== "object" || Array.isArray(point)) throw new Error("trusted input target has no usable viewport point");
    const x = point.x;
    const y = point.y;
    if (typeof x !== "number" || !Number.isFinite(x) || x < 0 || typeof y !== "number" || !Number.isFinite(y) || y < 0) {
      throw new Error("trusted input target has no usable viewport point");
    }
    return { x: Object.is(x, -0) ? 0 : x, y: Object.is(y, -0) ? 0 : y };
  }

  function normalizeScrollDelta(value, label) {
    if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 10_000) {
      throw new Error(`${label} must be a finite number from -10000 to 10000`);
    }
    return Object.is(value, -0) ? 0 : value;
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
    value: Object.freeze({ perform, performWithSend }),
    configurable: false,
  });
})();
