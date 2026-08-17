(() => {
  if (globalThis.__machineBridgeDevtoolsSession) return;
  const ATTACH_TIMEOUT_MS = 5_000;
  const COMMAND_TIMEOUT_MS = 5_000;
  const DETACH_TIMEOUT_MS = 1_500;
  const tabQueues = new Map();
  async function run(tabId, operation, options = {}) {
    if (!Number.isInteger(tabId) || tabId < 1) throw new Error("DevTools session requires a valid tab");
    if (typeof operation !== "function") throw new Error("DevTools session requires an operation");
    const previous = tabQueues.get(tabId) || Promise.resolve();
    const current = previous.catch(() => { /* A prior tab operation must not poison the serialized queue. */ }).then(() => {
      options.beforeAttach?.();
      return withDebugger(tabId, operation);
    });
    tabQueues.set(tabId, current);
    try { return await current; } finally { if (tabQueues.get(tabId) === current) tabQueues.delete(tabId); }
  }
  async function withDebugger(tabId, operation) {
    const target = { tabId };
    let attached = false;
    const attach = Promise.resolve().then(() => chrome.debugger.attach(target, "1.3"));
    try {
      try { await deadline(attach, ATTACH_TIMEOUT_MS, "DevTools attach"); attached = true; }
      catch (error) { if (error?.machineBridgeDevtoolsTimeout === true) attach.then(() => detachQuietly(target), () => {}); throw error; }
      const send = (method, params = {}) => deadline(
        Promise.resolve().then(() => chrome.debugger.sendCommand(target, method, params)), COMMAND_TIMEOUT_MS, `DevTools command ${method}`,
      );
      return await operation(Object.freeze({ tabId, target, send }));
    } finally { if (attached) await detachQuietly(target); }
  }
  async function detachQuietly(target) {
    try { await deadline(Promise.resolve().then(() => chrome.debugger.detach(target)), DETACH_TIMEOUT_MS, "DevTools detach"); }
    catch { /* Session ownership is already ending; detach is bounded best-effort cleanup. */ }
  }
  async function deadline(operation, timeoutMs, label) {
    if (typeof globalThis.setTimeout !== "function") return operation;
    let timer;
    const timeout = new Promise((_, reject) => { timer = globalThis.setTimeout(() => reject(timeoutError(label)), timeoutMs); });
    try { return await Promise.race([operation, timeout]); }
    finally { if (timer !== undefined && typeof globalThis.clearTimeout === "function") globalThis.clearTimeout(timer); }
  }
  function timeoutError(label) {
    const error = new Error(`${label} timed out`);
    Object.defineProperty(error, "machineBridgeDevtoolsTimeout", { value: true });
    return error;
  }
  Object.defineProperty(globalThis, "__machineBridgeDevtoolsSession", { value: Object.freeze({ run }), configurable: false });
})();
