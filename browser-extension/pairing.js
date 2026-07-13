(() => {
  const marker = document.querySelector('meta[name="machine-bridge-browser-pair"]');
  const portMeta = document.querySelector('meta[name="machine-bridge-browser-port"]');
  const tokenMeta = document.querySelector('meta[name="machine-bridge-browser-token"]');
  if (marker?.content !== "1" || !portMeta || !tokenMeta) return;
  const token = tokenMeta.content;
  const port = Number(portMeta.content);
  if (!/^[A-Za-z0-9_-]{32,100}$/.test(token) || !Number.isInteger(port) || port < 1024 || port > 65535) return;
  chrome.runtime.sendMessage({ type: "pair", endpoint: `ws://127.0.0.1:${port}/extension`, token }, (response) => {
    const status = document.getElementById("status");
    if (chrome.runtime.lastError || response?.ok !== true) {
      if (status) status.textContent = response?.requires_manual_repair
        ? "This extension is already paired to different local state. Click the Machine Bridge extension icon while this page is active to confirm re-pairing."
        : "Pairing failed. Confirm the local Machine Bridge runtime is running, then reload this page.";
      return;
    }
    if (status) status.textContent = "Paired. You may close this tab.";
  });
})();
