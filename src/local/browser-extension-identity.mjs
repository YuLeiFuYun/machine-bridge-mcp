import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { packageRoot } from "./package-identity.mjs";

const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;
const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

const manifest = readExtensionManifest();
export const EXPECTED_EXTENSION_PUBLIC_KEY = normalizeManifestPublicKey(manifest.key);
export const EXPECTED_EXTENSION_ID = extensionIdFromPublicKey(EXPECTED_EXTENSION_PUBLIC_KEY);

export function extensionIdFromPublicKey(value) {
  const publicKey = normalizeManifestPublicKey(value);
  const bytes = Buffer.from(publicKey, "base64");
  const hexadecimal = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
  const extensionId = [...hexadecimal]
    .map((character) => String.fromCharCode(97 + Number.parseInt(character, 16)))
    .join("");
  if (!EXTENSION_ID_PATTERN.test(extensionId)) throw new Error("browser extension public key produced an invalid extension id");
  return extensionId;
}

export function normalizeExtensionId(value) {
  const extensionId = String(value || "").trim().toLowerCase();
  return EXTENSION_ID_PATTERN.test(extensionId) ? extensionId : "";
}

function normalizeManifestPublicKey(value) {
  const publicKey = String(value || "").trim();
  if (!PUBLIC_KEY_PATTERN.test(publicKey) || publicKey.length < 128 || publicKey.length > 8192) {
    throw new Error("browser extension manifest must contain a bounded base64 public key");
  }
  let bytes;
  try { bytes = Buffer.from(publicKey, "base64"); }
  catch { throw new Error("browser extension manifest public key is invalid base64"); }
  if (bytes.length < 96 || bytes.length > 6144 || bytes.toString("base64") !== publicKey) {
    throw new Error("browser extension manifest public key is not canonical DER base64");
  }
  return publicKey;
}

function readExtensionManifest() {
  const path = resolve(packageRoot, "browser-extension", "manifest.json");
  const manifestValue = JSON.parse(readFileSync(path, "utf8"));
  if (!manifestValue || typeof manifestValue !== "object" || Array.isArray(manifestValue)) {
    throw new Error("browser extension manifest is invalid");
  }
  return manifestValue;
}
