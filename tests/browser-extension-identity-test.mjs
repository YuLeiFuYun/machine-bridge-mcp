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
assert.throws(() => extensionIdFromPublicKey("not-base64"), /bounded base64 public key/);
assert.throws(() => extensionIdFromPublicKey("QQ=="), /bounded base64 public key/);
assert.throws(() => extensionIdFromPublicKey(`${manifest.key}=`), /canonical DER base64|bounded base64/);

assert.equal(isAllowedExtensionOrigin(`chrome-extension://${EXPECTED_EXTENSION_ID}`), true);
assert.equal(isAllowedExtensionOrigin(`chrome-extension://${EXPECTED_EXTENSION_ID}/`), true);
assert.equal(isAllowedExtensionOrigin("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), false);
assert.equal(isAllowedExtensionOrigin(`chrome-extension://${EXPECTED_EXTENSION_ID}/unexpected`), false);
assert.equal(isAllowedExtensionOrigin(`chrome-extension://${EXPECTED_EXTENSION_ID}?query=1`), false);
assert.equal(isAllowedExtensionOrigin("https://example.test"), false);
assert.equal(isAllowedExtensionOrigin("not a URL"), false);
assert.equal(isAllowedExtensionOrigin(`chrome-extension://${EXPECTED_EXTENSION_ID}`, "invalid"), false);

const hello = {
  type: "hello",
  role: "extension",
  protocol: BROWSER_EXTENSION_PROTOCOL,
  version: EXPECTED_EXTENSION_VERSION,
  extension_id: EXPECTED_EXTENSION_ID,
  capabilities: ["semantic_snapshot_refs", "actionability_waits", "trusted_input", "tab_management", "explicit_waits"],
};
const parsed = parseExtensionHello(hello);
assert.equal(parsed.extension_id, EXPECTED_EXTENSION_ID);
assert.equal(normalizeCompatibleExtensionInfo(hello)?.extension_id, EXPECTED_EXTENSION_ID);
assert.equal(normalizeCompatibleExtensionInfo({ ...hello, extension_id: "a".repeat(32) }), null);
assert.equal(normalizeCompatibleExtensionInfo({ ...hello, extension_id: undefined }), null);
assert.throws(() => parseExtensionHello({ ...hello, extension_id: "a".repeat(32) }), /identity mismatch/);
assert.throws(() => parseExtensionHello({ ...hello, extension_id: undefined }), /invalid extension hello/);
assert.throws(() => parseExtensionHello({ ...hello, role: "runtime" }), /protocol mismatch/);

await testLegacyPairingMigration();
console.log("browser extension identity test ok");

async function testLegacyPairingMigration() {
  const root = await mkdtemp(join(tmpdir(), "mbm-browser-pairing-migration-"));
  const legacyToken = "l".repeat(43);
  try {
    if (process.platform !== "win32") await chmod(root, 0o700);
    await writeFile(join(root, "browser-bridge.json"), JSON.stringify({ token: legacyToken, port: 39393 }), { mode: 0o600 });
    const [first, second] = await Promise.all([loadOrCreatePairing(root), loadOrCreatePairing(root)]);
    assert.equal(first.schemaVersion, 2);
    assert.equal(first.pairingAuthVersion, 2);
    assert.equal(first.migrationPending, true);
    assert.notEqual(first.extensionToken, legacyToken, "legacy pairing token was retained after pairing-auth privacy rotation");
    assert.notEqual(first.runtimeToken, legacyToken);
    assert.equal(first.extensionToken, second.extensionToken, "concurrent legacy migration produced divergent extension credentials");
    assert.equal(first.runtimeToken, second.runtimeToken, "concurrent legacy migration produced divergent runtime credentials");
    const persisted = JSON.parse(await readFile(join(root, "browser-bridge.json"), "utf8"));
    assert.equal(persisted.schemaVersion, 2);
    assert.equal(persisted.pairingAuthVersion, 2);
    assert.equal(persisted.migrationPending, true);
    assert.equal(persisted.extensionToken, first.extensionToken);
    assert.equal(persisted.runtimeToken, first.runtimeToken);
    assert.equal(Object.hasOwn(persisted, "token"), false);
    await assert.rejects(() => loadOrCreatePairing(root, {
      inspectPathIfPresentSync() {
        throw Object.assign(new Error("synthetic pairing storage failure"), { code: "EIO" });
      },
    }), /synthetic pairing storage failure/);
    await assert.rejects(() => savePairing(root, { schemaVersion: 2, pairingAuthVersion: 2, extensionToken: legacyToken, runtimeToken: legacyToken, port: 39393 }), /invalid/);
    await assert.rejects(() => savePairing(root, { schemaVersion: 2, pairingAuthVersion: 2, extensionToken: legacyToken, runtimeToken: "r".repeat(43), port: 80 }), /invalid/);
    await assert.rejects(() => savePairing(root, { schemaVersion: 2, pairingAuthVersion: 2, extensionToken: legacyToken, runtimeToken: "r".repeat(43), port: 39393, migrationPending: "true" }), /invalid/);
    await assert.rejects(() => savePairing(root, { schemaVersion: 2, pairingAuthVersion: 2, extensionToken: legacyToken, runtimeToken: "r".repeat(43), port: 39393 }), /invalid/);

    const priorExtension = "e".repeat(43);
    const priorRuntime = "r".repeat(43);
    await writeFile(join(root, "browser-bridge.json"), `${JSON.stringify({ schemaVersion: 2, extensionToken: priorExtension, runtimeToken: priorRuntime, port: 39394 })}\n`, { mode: 0o600 });
    const upgraded = await loadOrCreatePairing(root);
    assert.equal(upgraded.schemaVersion, 2);
    assert.equal(upgraded.pairingAuthVersion, 2);
    assert.equal(upgraded.migrationPending, true);
    assert.notEqual(upgraded.extensionToken, priorExtension, "schema-2 extension credential was not rotated");
    assert.equal(upgraded.runtimeToken, priorRuntime, "schema-2 runtime credential changed and would split mixed-version local runtimes");
    assert.equal(upgraded.port, 39394);
    assert.equal(beta55AcceptsPairingState(JSON.parse(await readFile(join(root, "browser-bridge.json"), "utf8"))), true,
      "current pairing envelope is no longer readable by the beta.55 rollback parser");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function beta55AcceptsPairingState(value) {
  const token = /^[A-Za-z0-9_-]{32,100}$/;
  const port = Number(value?.port);
  return value?.schemaVersion === 2
    && token.test(String(value?.extensionToken || ""))
    && token.test(String(value?.runtimeToken || ""))
    && value.extensionToken !== value.runtimeToken
    && Number.isInteger(port) && port >= 1024 && port <= 65535;
}
