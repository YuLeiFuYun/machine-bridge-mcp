import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertFreshFullVerificationReceipt,
  captureVerificationRunGeneration,
  captureVerifiedSourceGeneration,
  clearFullVerificationReceipt,
  fullVerificationReceiptPath,
  writeFullVerificationReceipt,
} from "../scripts/verification-state.mjs";

const root = await mkdtemp(join(tmpdir(), "mbm-full-verification-receipt-"));
const generation = "a".repeat(64);
const now = Date.parse("2026-08-16T01:00:00.000Z");
try {
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "machine-bridge-mcp", version: "3.0.0-beta.test" }), "utf8");
  await writeFile(join(root, "src", "sample.mjs"), "export const sample = true;\n", "utf8");
  const sourceGeneration = captureVerifiedSourceGeneration(root);
  const runGeneration = captureVerificationRunGeneration(root);
  assert(/^[0-9a-f]{64}$/.test(sourceGeneration) && /^[0-9a-f]{64}$/.test(runGeneration), "verification generation did not produce a SHA-256 digest");
  await mkdir(join(root, ".release-candidate"), { recursive: true });
  await writeFile(join(root, ".release-candidate", "manifest.json"), "generated candidate state\n", "utf8");
  assert(captureVerifiedSourceGeneration(root) === sourceGeneration, "generated candidate state incorrectly changed verified-source identity");
  assert(captureVerificationRunGeneration(root) !== runGeneration, "verification run generation stopped detecting concurrent candidate-state changes");

  expectThrow(() => writeFullVerificationReceipt(root, "invalid", { now }), "generation", "TypeError");
  expectThrow(() => writeFullVerificationReceipt(root, generation, { now: Number.NaN }), "timestamp", "TypeError");

  writeFullVerificationReceipt(root, generation, { now });
  const stored = JSON.parse(await readFile(fullVerificationReceiptPath(root), "utf8"));
  assert(stored.generation_sha256 === generation && stored.mode === "full", "full verification receipt did not persist exact generation evidence");
  assertFreshFullVerificationReceipt(root, { now: now + 1_000, captureGeneration: () => generation });

  expectThrow(() => assertFreshFullVerificationReceipt(root, {
    now: now + 1_000,
    captureGeneration: () => "b".repeat(64),
  }), "current source");
  expectThrow(() => assertFreshFullVerificationReceipt(root, {
    now: now + 10_001,
    maximumAgeMs: 10_000,
    captureGeneration: () => generation,
  }), "freshness window");
  expectThrow(() => assertFreshFullVerificationReceipt(root, {
    now: now - 1,
    captureGeneration: () => generation,
  }), "freshness window");

  await writeFile(fullVerificationReceiptPath(root), "{not-json", "utf8");
  expectThrow(() => assertFreshFullVerificationReceipt(root, { now, captureGeneration: () => generation }), "unreadable or invalid");
  writeFullVerificationReceipt(root, generation, { now });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "machine-bridge-mcp", version: "3.0.0-beta.changed" }), "utf8");
  expectThrow(() => assertFreshFullVerificationReceipt(root, { now, captureGeneration: () => generation }), "current source");
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "machine-bridge-mcp", version: "3.0.0-beta.test" }), "utf8");

  clearFullVerificationReceipt(root);
  expectThrow(() => assertFreshFullVerificationReceipt(root, { now, captureGeneration: () => generation }), "missing");
  console.log("full verification receipt test ok");
} finally {
  await rm(root, { recursive: true, force: true });
}

function expectThrow(callback, pattern, name = "") {
  try { callback(); } catch (error) {
    const expectedClass = name ? error?.name === name : error?.code === "MBM_FULL_VERIFICATION_REQUIRED";
    if (String(error?.message || error).includes(pattern) && expectedClass) return error;
    throw error;
  }
  throw new Error(`expected throw containing: ${pattern}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
