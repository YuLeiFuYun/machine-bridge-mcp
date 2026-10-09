import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXPECTED_EXTENSION_ID,
  EXPECTED_EXTENSION_PUBLIC_KEY,
  extensionIdFromPublicKey,
  normalizeExtensionId,
} from "../src/local/browser-extension-identity.mjs";
import {
  BROWSER_EXTENSION_PROTOCOL,
  EXPECTED_EXTENSION_VERSION,
  normalizeCompatibleExtensionInfo,
  parseExtensionHello,
} from "../src/local/browser-extension-protocol.mjs";
import { isAllowedExtensionOrigin } from "../src/local/browser-pairing-http.mjs";
import { loadOrCreatePairing, savePairing } from "../src/local/browser-pairing-store.mjs";

const manifest = JSON.parse(readFileSync(new URL("../browser-extension/manifest.json", import.meta.url), "utf8"));
assert.equal(manifest.key, EXPECTED_EXTENSION_PUBLIC_KEY);
assert.equal(EXPECTED_EXTENSION_ID, "jciakkdfpdmdpbfegbjiddknpiepambo");
assert.equal(extensionIdFromPublicKey(manifest.key), EXPECTED_EXTENSION_ID);
assert.equal(normalizeExtensionId(EXPECTED_EXTENSION_ID.toUpperCase()), EXPECTED_EXTENSION_ID);
assert.equal(normalizeExtensionId("a".repeat(31)), "");
assert.equal(normalizeExtensionId([EXPECTED_EXTENSION_ID]), "");
assert.throws(() => extensionIdFromPublicKey("not-base64"), /bounded base64 public key/);
assert.throws(() => extensionIdFromPublicKey("QQ=="), /bounded base64 public key/);
assert.throws(() => extensionIdFromPublicKey([manifest.key]), /must be a string/);
assert.throws(() => extensionIdFromPublicKey(`${manifest.key}=`), /canonical DER base64|bounded base64/);

assert.equal(isAllowedExtensionOrigin(`chrome-extension://${EXPECTED_EXTENSION_ID}`), true);
assert.equal(isAllowedExtensionOrigin(`chrome-extension://${EXPECTED_EXTENSION_ID}/`), true);
assert.equal(isAllowedExtensionOrigin("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), false);
assert.equal(isAllowedExtensionOrigin(`chrome-extension://${EXPECTED_EXTENSION_ID}/unexpected`), false);
assert.equal(isAllowedExtensionOrigin(`chrome-extension://${EXPECTED_EXTENSION_ID}?query=1`), false);
assert.equal(isAllowedExtensionOrigin("https://example.test"), false);
assert.equal(isAllowedExtensionOrigin("not a URL"), false);
assert.equal(isAllowedExtensionOrigin([`chrome-extension://${EXPECTED_EXTENSION_ID}`]), false);
assert.equal(isAllowedExtensionOrigin(`chrome-extension://${EXPECTED_EXTENSION_ID}`, "invalid"), false);

const hello = {
  type: "hello",
  role: "extension",
  protocol: BROWSER_EXTENSION_PROTOCOL,
  version: EXPECTED_EXTENSION_VERSION,
  extension_id: EXPECTED_EXTENSION_ID,
  capabilities: ["semantic_snapshot_refs", "actionability_waits", "trusted_input", "tab_management", "explicit_waits", "computer_observation_v1"],
};
const parsed = parseExtensionHello(hello);
assert.equal(parsed.extension_id, EXPECTED_EXTENSION_ID);
assert.equal(normalizeCompatibleExtensionInfo(hello)?.extension_id, EXPECTED_EXTENSION_ID);
assert.equal(normalizeCompatibleExtensionInfo({ ...hello, extension_id: "a".repeat(32) }), null);
assert.equal(normalizeCompatibleExtensionInfo({ ...hello, extension_id: [EXPECTED_EXTENSION_ID] }), null);
assert.equal(normalizeCompatibleExtensionInfo({ ...hello, extension_id: undefined }), null);
assert.throws(() => parseExtensionHello({ ...hello, extension_id: "a".repeat(32) }), /identity mismatch/);
assert.throws(() => parseExtensionHello({ ...hello, extension_id: [EXPECTED_EXTENSION_ID] }), /invalid extension hello/);
assert.throws(() => parseExtensionHello({ ...hello, extension_id: undefined }), /invalid extension hello/);
assert.throws(() => parseExtensionHello({ ...hello, role: "runtime" }), /protocol mismatch/);
const missingObservationCapability = { ...hello, capabilities: hello.capabilities.filter((capability) => capability !== "computer_observation_v1") };
assert.equal(normalizeCompatibleExtensionInfo(missingObservationCapability), null);
assert.throws(() => parseExtensionHello(missingObservationCapability), /capability mismatch.*computer_observation_v1/);

await testCurrentPairingState();
console.log("browser extension identity test ok");

async function testCurrentPairingState() {
  const root = await mkdtemp(join(tmpdir(), "mbm-browser-pairing-current-"));
  const extensionToken = "e".repeat(43);
  const runtimeToken = "r".repeat(43);
  try {
    if (process.platform !== "win32") await chmod(root, 0o700);
    const [first, second] = await Promise.all([loadOrCreatePairing(root), loadOrCreatePairing(root)]);
    assert.equal(first.schemaVersion, 3);
    assert.equal(first.pairingAuthVersion, 2);
    assert.equal(Object.hasOwn(first, "migrationPending"), false);
    assert.equal(first.extensionToken, second.extensionToken, "concurrent pairing creation produced divergent extension credentials");
    assert.equal(first.runtimeToken, second.runtimeToken, "concurrent pairing creation produced divergent runtime credentials");
    const persisted = JSON.parse(await readFile(join(root, "browser-bridge.json"), "utf8"));
    assert.equal(persisted.schemaVersion, 3);
    assert.equal(persisted.pairingAuthVersion, 2);
    assert.equal(Object.hasOwn(persisted, "migrationPending"), false);
    assert.equal(persisted.extensionToken, first.extensionToken);
    assert.equal(persisted.runtimeToken, first.runtimeToken);
    assert.equal(Object.hasOwn(persisted, "token"), false);
    await assert.rejects(() => loadOrCreatePairing(root, {
      inspectPathIfPresentSync() {
        throw Object.assign(new Error("synthetic pairing storage failure"), { code: "EIO" });
      },
    }), /synthetic pairing storage failure/);
    await assert.rejects(() => savePairing(root, { schemaVersion: 3, pairingAuthVersion: 2, extensionToken, runtimeToken: extensionToken, port: 39393 }), /invalid/);
    await assert.rejects(() => savePairing(root, { schemaVersion: 3, pairingAuthVersion: 2, extensionToken, runtimeToken, port: 80 }), /invalid/);
    await assert.rejects(() => savePairing(root, { schemaVersion: 3, pairingAuthVersion: 2, extensionToken, runtimeToken, port: 39393, migrationPending: false }), /invalid/);
    await assert.rejects(() => savePairing(root, { schemaVersion: 3, pairingAuthVersion: 2, extensionToken: [extensionToken], runtimeToken, port: 39393 }), /invalid/);
    await assert.rejects(() => savePairing(root, { schemaVersion: 3, pairingAuthVersion: 2, extensionToken, runtimeToken, port: "39393" }), /invalid/);

    const previousPort = 39394;
    await writeFile(join(root, "browser-bridge.json"), `${JSON.stringify({
      schemaVersion: 2,
      pairingAuthVersion: 2,
      extensionToken,
      runtimeToken,
      port: previousPort,
      migrationPending: false,
    })}\n`, { mode: 0o600 });
    const [migratedFirst, migratedSecond] = await Promise.all([loadOrCreatePairing(root), loadOrCreatePairing(root)]);
    for (const migrated of [migratedFirst, migratedSecond]) {
      assert.deepEqual(migrated, {
        schemaVersion: 3,
        pairingAuthVersion: 2,
        extensionToken,
        runtimeToken,
        port: previousPort,
      }, "beta.198 stable pairing migration changed credentials or port");
    }
    const migratedPersisted = JSON.parse(await readFile(join(root, "browser-bridge.json"), "utf8"));
    assert.deepEqual(migratedPersisted, migratedFirst, "beta.198 stable pairing migration did not persist the exact current envelope");

    for (const obsolete of [
      { token: extensionToken, port: 39393 },
      { schemaVersion: 2, extensionToken, runtimeToken, port: 39393 },
      { schemaVersion: 2, pairingAuthVersion: 2, extensionToken, runtimeToken, port: "39393", migrationPending: false },
    ]) {
      await writeFile(join(root, "browser-bridge.json"), `${JSON.stringify(obsolete)}\n`, { mode: 0o600 });
      await assert.rejects(() => loadOrCreatePairing(root), /browser pairing state is invalid/,
        "retired browser pairing state was interpreted by the current runtime");
    }
    await writeFile(join(root, "browser-bridge.json"), `${JSON.stringify({
      schemaVersion: 2,
      pairingAuthVersion: 2,
      extensionToken,
      runtimeToken,
      port: 39393,
      migrationPending: true,
    })}\n`, { mode: 0o600 });
    await assert.rejects(() => loadOrCreatePairing(root), /complete beta\.198 browser pairing migration before upgrading/,
      "beta.198 pending migration was incorrectly collapsed into current state");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
