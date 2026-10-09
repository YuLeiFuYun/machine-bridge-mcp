import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalAdminCommands } from "../src/local/cli-local-admin.mjs";
import { loadOrCreatePairing, readBrowserPairing, savePairing } from "../src/local/browser-pairing-store.mjs";
import { loadState } from "../src/local/state.mjs";

const stateRoot = await mkdtemp(join(tmpdir(), "mbm-browser-cli-state-"));
const workspace = await mkdtemp(join(tmpdir(), "mbm-browser-cli-workspace-"));
const brokerPort = 39393;
const health = {
  ok: true,
  broker: "machine-bridge-browser",
  connected: false,
  expected_extension_version: "test",
  controls_existing_profile: true,
  controls_extension_profile: true,
};

try {
  const state = loadState(workspace, { stateDir: stateRoot });
  const initialPairing = await loadOrCreatePairing(state.paths.stateRoot);
  await savePairing(state.paths.stateRoot, { ...initialPairing, port: brokerPort });

  const healthUrls = [];
  const launches = [];
  let openedUrl = "";
  const commands = createLocalAdminCommands({
    chooseWorkspace: async () => workspace,
    confirm: async () => true,
    readBrowserHealth: async (healthUrl) => { healthUrls.push(String(healthUrl)); return health; },
    startBrowserPairingLaunch: async (options) => {
      launches.push(options);
      return syntheticLaunch(brokerPort);
    },
    openExternal: async (target) => { openedUrl = String(target); },
  });

  const statusOutput = await captureConsole(() => commands.browserCommand({ _: ["status"], stateDir: stateRoot, json: true }));
  const status = JSON.parse(statusOutput);
  assert.equal(status.running, true, "CLI browser status lost injected health state");
  assert.equal(healthUrls.at(-1), `http://127.0.0.1:${brokerPort}/healthz`, "CLI browser status queried the wrong health target");

  const output = await captureConsole(() => commands.browserCommand({ _: ["setup"], stateDir: stateRoot, json: true }));
  const result = JSON.parse(output);
  assert.equal(result.pairing_page_opened, true);
  assert.equal(result.pairing_url, `http://127.0.0.1:${brokerPort}/pair`, "CLI result stopped returning the sanitized broker pairing URL");
  assert.equal(launches.length, 1, "CLI setup did not create exactly one pairing launch");
  assert.equal(launches[0].brokerPort, brokerPort, "CLI pairing launch lost the target broker port");
  assert.equal(launches[0].extensionToken, initialPairing.extensionToken, "CLI pairing launch lost the persisted extension credential");
  assert(!output.includes("grant=") && !output.includes(initialPairing.extensionToken), "CLI setup output disclosed bootstrap or long-lived pairing material");
  assert(openedUrl.includes("#broker_port="), "CLI setup did not open the injected pairing launch URL");
  assert(!openedUrl.includes(initialPairing.extensionToken), "CLI setup exposed the long-lived extension token to the opener target");

  let failedCloseCalls = 0;
  let failedUrl = "";
  const failingCommands = createLocalAdminCommands({
    chooseWorkspace: async () => workspace,
    confirm: async () => true,
    readBrowserHealth: async () => health,
    startBrowserPairingLaunch: async () => syntheticLaunch(brokerPort, () => { failedCloseCalls += 1; }),
    openExternal: async (target) => { failedUrl = String(target); throw new Error("synthetic browser opener failure"); },
  });
  await assert.rejects(
    () => failingCommands.browserCommand({ _: ["setup"], stateDir: stateRoot, json: true }),
    /synthetic browser opener failure/,
  );
  assert(failedUrl.includes("#broker_port="), "CLI opener failure did not receive the pairing launch URL");
  assert.equal(failedCloseCalls, 1, "CLI opener failure did not close the pairing launch exactly once");

  let changedStateLaunchCalls = 0;
  let changedStateOpenCalls = 0;
  const changedStateCommands = createLocalAdminCommands({
    chooseWorkspace: async () => workspace,
    confirm: async () => true,
    readBrowserHealth: async () => {
      await savePairing(state.paths.stateRoot, { ...initialPairing, port: brokerPort + 1 });
      return health;
    },
    startBrowserPairingLaunch: async () => { changedStateLaunchCalls += 1; return syntheticLaunch(brokerPort); },
    openExternal: async () => { changedStateOpenCalls += 1; },
  });
  await assert.rejects(changedStateCommands.browserCommand({ _: ["setup"], stateDir: stateRoot, json: true }),
    /browser pairing state changed/, "pairing must reject state changed during health lookup");
  assert.equal(changedStateLaunchCalls, 0, "changed pairing state created a grant for the wrong broker");
  assert.equal(changedStateOpenCalls, 0, "changed pairing state opened the browser");

  await savePairing(state.paths.stateRoot, { ...initialPairing, port: brokerPort });
  const beforeReset = readBrowserPairing(state.paths.stateRoot);
  await assert.rejects(
    () => commands.browserCommand({ _: ["reset"], stateDir: stateRoot, json: true }),
    /requires Machine Bridge runtimes to be stopped/,
    "browser reset rotated credentials while the broker was still reported running",
  );
  assert.deepEqual(readBrowserPairing(state.paths.stateRoot), beforeReset,
    "rejected online browser reset changed persisted credentials");

  const offlineCommands = createLocalAdminCommands({
    chooseWorkspace: async () => workspace,
    confirm: async () => true,
    readBrowserHealth: async () => ({ ok: false }),
  });
  const resetOutput = await captureConsole(() => offlineCommands.browserCommand({ _: ["reset"], stateDir: stateRoot, json: true }));
  const resetResult = JSON.parse(resetOutput);
  const afterReset = readBrowserPairing(state.paths.stateRoot);
  assert.equal(resetResult.reset, true);
  assert.equal(resetResult.port, brokerPort);
  assert.equal(resetResult.repair_required, true);
  assert.equal(afterReset.port, beforeReset.port, "browser reset changed the broker port");
  assert.notEqual(afterReset.extensionToken, beforeReset.extensionToken, "browser reset did not revoke the extension credential");
  assert.notEqual(afterReset.runtimeToken, beforeReset.runtimeToken, "browser reset did not revoke the runtime credential");
  assert(!resetOutput.includes(beforeReset.extensionToken) && !resetOutput.includes(beforeReset.runtimeToken)
    && !resetOutput.includes(afterReset.extensionToken) && !resetOutput.includes(afterReset.runtimeToken),
  "browser reset output disclosed old or replacement broker credentials");

} finally {
  await rm(stateRoot, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
}
console.log("browser CLI ephemeral pairing test ok");

function syntheticLaunch(port, onClose = () => {}) {
  let closed = false;
  const grant = `${Date.now()}.${"n".repeat(22)}.${"s".repeat(43)}`;
  return {
    url: `http://127.0.0.1:49152/pair#broker_port=${port}&grant=${grant}`,
    close() {
      if (closed) return;
      closed = true;
      onClose();
    },
    closed: Promise.resolve(),
  };
}

async function captureConsole(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => { lines.push(args.map(String).join(" ")); };
  try { await fn(); } finally { console.log = original; }
  return lines.join("\n");
}
