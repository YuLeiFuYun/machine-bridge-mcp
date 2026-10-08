import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../browser-extension/pairing.js", import.meta.url), "utf8");
const grant = `${"1".repeat(13)}.${"n".repeat(22)}.${"p".repeat(43)}`;

const valid = runPairing(`http://127.0.0.1:45555/pair#broker_port=39393&grant=${grant}`);
assert.deepEqual(valid.events.slice(0, 2), ["strip", "send"], "pairing content script disclosed the fragment before removing it from the page URL");
assert.deepEqual(valid.sent, { type: "pair_bootstrap", port: 39393, grant });
assert.equal(valid.location.hash, "");
assert(!valid.replacement.includes("grant") && !valid.replacement.includes("#"), "pairing history replacement retained the bootstrap secret");
const material = valid.onMessage({ type: "machine_bridge_pairing_material" });
assert.equal(material, undefined, "successful pairing retained bootstrap material in the content-script message boundary");
valid.onMessage({ type: "machine_bridge_pairing_status", text: "updated" });
assert.equal(valid.status.textContent, "updated");

const repair = runPairing(`http://127.0.0.1:45555/pair#broker_port=39393&grant=${grant}`, {
  bootstrapResponse: { ok: false, requires_manual_repair: true },
});
assert.deepEqual(repair.onMessage({ type: "machine_bridge_pairing_material" }), { port: 39393, grant },
  "manual repair did not retain the short-lived bootstrap material");

const ordinaryFailure = runPairing(`http://127.0.0.1:45555/pair#broker_port=39393&grant=${grant}`, {
  bootstrapResponse: { ok: false },
});
assert.equal(ordinaryFailure.onMessage({ type: "machine_bridge_pairing_material" }), undefined,
  "ordinary pairing failure retained bootstrap material despite requiring a fresh pairing launch");

const missing = runPairing("http://127.0.0.1:39393/pair");
assert.equal(missing.sent, null, "public token-free pairing page triggered a pairing bootstrap");
const decorated = runPairing(`http://127.0.0.1:45555/pair?leak=1#broker_port=39393&grant=${grant}`);
assert.equal(decorated.sent, null, "decorated pairing URL triggered a pairing bootstrap");
const unsafeHistory = runPairing(`http://127.0.0.1:45555/pair#broker_port=39393&grant=${grant}`, { failHistory: true });
assert.equal(unsafeHistory.sent, null, "pairing proceeded when the bootstrap fragment could not be removed before page scripts");
assert.equal(unsafeHistory.replacedLocation, "/pair", "pairing did not replace a fragment-bearing URL after history cleanup failed");
assert.equal(unsafeHistory.location.hash, "", "pairing grant remained visible after fallback URL replacement");
console.log("browser pairing content bootstrap test ok");

function runPairing(href, options = {}) {
  const parsed = new URL(href);
  const location = { href, hash: parsed.hash };
  const status = { textContent: "" };
  const events = [];
  let sent = null;
  let listener = null;
  let replacement = "";
  let replacedLocation = "";
  location.replace = (value) => {
    replacedLocation = String(value);
    location.hash = "";
  };
  const context = vm.createContext({
    URL,
    URLSearchParams,
    location,
    history: {
      replaceState(_state, _title, value) {
        events.push("strip");
        if (options.failHistory) throw new Error("synthetic history failure");
        replacement = String(value);
        location.hash = "";
      },
    },
    document: {
      readyState: "complete",
      getElementById(id) { return id === "status" ? status : null; },
      addEventListener() {},
    },
    chrome: {
      runtime: {
        lastError: null,
        sendMessage(message, callback) {
          events.push("send");
          sent = structuredClone(message);
          callback?.(options.bootstrapResponse || { ok: true });
        },
        onMessage: { addListener(value) { listener = value; } },
      },
    },
  });
  vm.runInContext(source, context, { filename: "pairing.js" });
  return {
    events, sent, location, replacement, replacedLocation, status,
    onMessage(message) {
      let result;
      listener?.(message, {}, (value) => { result = structuredClone(value); });
      return result;
    },
  };
}
