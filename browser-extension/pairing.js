(() => {
  let parsed;
  try { parsed = new URL(location.href); } catch { return; }
  const pagePort = Number(parsed.port);
  const fragment = parsed.hash.startsWith("#") ? new URLSearchParams(parsed.hash.slice(1)) : null;
  const brokerPort = Number(fragment?.get("broker_port"));
  const grant = String(fragment?.get("grant") || "");
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || parsed.pathname !== "/pair"
      || parsed.username || parsed.password || parsed.search || fragment?.size !== 2
      || !Number.isInteger(pagePort) || pagePort < 1024 || pagePort > 65535
      || !Number.isInteger(brokerPort) || brokerPort < 1024 || brokerPort > 65535
      || !/^\d{13}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/.test(grant)) return;
  try { history.replaceState(null, "", parsed.pathname); } catch { return; }
  if (location.hash) return;

  const updateStatus = (text) => {
    const apply = () => { const status = document.getElementById("status"); if (status) status.textContent = text; };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", apply, { once: true });
    else apply();
  };
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "machine_bridge_pairing_material") { sendResponse({ port: brokerPort, grant }); return false; }
    if (message?.type === "machine_bridge_pairing_status") { updateStatus(String(message.text || "")); return false; }
    return false;
  });
  chrome.runtime.sendMessage({ type: "pair_bootstrap", port: brokerPort, grant }, (response) => {
    if (chrome.runtime.lastError || response?.ok !== true) {
      updateStatus(response?.requires_manual_repair
        ? "This extension is already paired to different local state. Click the Machine Bridge extension icon while this page is active to confirm re-pairing."
        : "Pairing failed. Run pair_browser_extension with opening enabled again.");
      return;
    }
    updateStatus("Paired. You may close this tab.");
  });
})();
