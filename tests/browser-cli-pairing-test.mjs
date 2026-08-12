import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalAdminCommands } from "../src/local/cli-local-admin.mjs";
import { loadOrCreatePairing, savePairing } from "../src/local/browser-pairing-store.mjs";
import { loadState } from "../src/local/state.mjs";

const stateRoot = await mkdtemp(join(tmpdir(), "mbm-browser-cli-state-"));
const workspace = await mkdtemp(join(tmpdir(), "mbm-browser-cli-workspace-"));
const broker = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify({
    ok: true,
    broker: "machine-bridge-browser",
    connected: false,
    expected_extension_version: "test",
    controls_existing_profile: true,
    controls_extension_profile: true,
  }));
});

try {
  await listenRandom(broker);
  const brokerPort = broker.address().port;
  const state = loadState(workspace, { stateDir: stateRoot });
  const initialPairing = await loadOrCreatePairing(state.paths.stateRoot);
  await savePairing(state.paths.stateRoot, { ...initialPairing, port: brokerPort });

  let openedUrl = "";
  const commands = createLocalAdminCommands({
    chooseWorkspace: async () => workspace,
    confirm: async () => true,
    openExternal: async (target) => {
      openedUrl = String(target);
      const launchUrl = new URL(openedUrl);
      const fragment = new URLSearchParams(launchUrl.hash.slice(1));
      assert.notEqual(Number(launchUrl.port), brokerPort, "CLI browser setup opened the long-lived broker port directly");
      assert.equal(Number(fragment.get("broker_port")), brokerPort, "CLI pairing launch lost the target broker port");
      assert.match(String(fragment.get("grant") || ""), /^\d{13}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/, "CLI pairing launch omitted its short-lived fragment grant");
      assert(!openedUrl.includes(initialPairing.extensionToken), "CLI pairing launch exposed the long-lived extension token");
      launchUrl.hash = "";
      const response = await fetch(launchUrl);
      const html = await response.text();
      assert.equal(response.status, 200);
      assert(!html.includes(initialPairing.extensionToken) && !html.includes(String(fragment.get("grant"))), "CLI pairing document exposed pairing secret material");
    },
  });
  const output = await captureConsole(() => commands.browserCommand({ _: ["setup"], stateDir: stateRoot, json: true }));
  const result = JSON.parse(output);
  assert.equal(result.pairing_page_opened, true);
  assert.equal(result.pairing_url, `http://127.0.0.1:${brokerPort}/pair`, "CLI result stopped returning the sanitized broker pairing URL");
  assert(!output.includes("grant=") && !output.includes(initialPairing.extensionToken), "CLI setup output disclosed bootstrap or long-lived pairing material");
  assert(openedUrl.includes("#broker_port="), "CLI setup did not open an ephemeral pairing launch URL");

  let failedUrl = "";
  const failingCommands = createLocalAdminCommands({
    chooseWorkspace: async () => workspace,
    confirm: async () => true,
    openExternal: async (target) => { failedUrl = String(target); throw new Error("synthetic browser opener failure"); },
  });
  await assert.rejects(
    () => failingCommands.browserCommand({ _: ["setup"], stateDir: stateRoot, json: true }),
    /synthetic browser opener failure/,
  );
  const failedPage = new URL(failedUrl); failedPage.hash = "";
  await new Promise((resolvePromise) => { setTimeout(resolvePromise, 10); });
  await assert.rejects(() => fetch(failedPage), /fetch failed|ECONNREFUSED|other side closed/i, "CLI opener failure left the ephemeral pairing listener reachable");
} finally {
  await closeServer(broker);
  await rm(stateRoot, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
}
console.log("browser CLI ephemeral pairing test ok");

async function captureConsole(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => { lines.push(args.map(String).join(" ")); };
  try { await fn(); } finally { console.log = original; }
  return lines.join("\n");
}
function listenRandom(server) {
  return new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
}
function closeServer(server) {
  return new Promise((resolvePromise) => { server.close(resolvePromise); });
}
