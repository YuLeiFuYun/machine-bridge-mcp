(() => {
  if (globalThis.__machineBridgeDevtoolsSession) return;

  const tabQueues = new Map();

  async function run(tabId, operation, options = {}) {
    if (!Number.isInteger(tabId) || tabId < 1) throw new Error("DevTools session requires a valid tab");
    if (typeof operation !== "function") throw new Error("DevTools session requires an operation");
    const previous = tabQueues.get(tabId) || Promise.resolve();
    const current = previous.catch(() => {}).then(() => {
      if (typeof options.beforeAttach === "function") options.beforeAttach();
      return withDebugger(tabId, operation);
    });
    tabQueues.set(tabId, current);
    try { return await current; }
    finally { if (tabQueues.get(tabId) === current) tabQueues.delete(tabId); }
  }

  async function withDebugger(tabId, operation) {
    const target = { tabId };
    let attached = false;
    try {
      await chrome.debugger.attach(target, "1.3");
      attached = true;
      const send = (method, params = {}) => chrome.debugger.sendCommand(target, method, params);
      return await operation(Object.freeze({ tabId, target, send }));
    } finally {
      if (attached) {
        try { await chrome.debugger.detach(target); } catch {}
      }
    }
  }

  Object.defineProperty(globalThis, "__machineBridgeDevtoolsSession", {
    value: Object.freeze({ run }),
    configurable: false,
  });
})();
