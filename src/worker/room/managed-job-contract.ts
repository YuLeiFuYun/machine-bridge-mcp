import type { AuthorizedToken } from "../oauth/authority.ts";
import relayContract from "../../shared/relay-contract.json" with { type: "json" };

const DOMAIN = "machine-bridge-mcp/managed-job-capability/v1";

const PREFIX = Object.freeze({ read: "mcp_jr_", control: "mcp_jc_" });

type CapabilityPurpose = keyof typeof PREFIX;

export async function issueManagedJobCapability(
  keyMaterial: string,
  authorized: AuthorizedToken,
  jobId: string,
  purpose: CapabilityPurpose,
): Promise<string> {
  const key = await capabilityKey(keyMaterial);
  const digest = await crypto.subtle.sign("HMAC", key, capabilityMessage(authorized, jobId, purpose));
  return `${PREFIX[purpose]}${base64Url(new Uint8Array(digest))}`;
}

export async function verifyManagedJobCapability(
  keyMaterial: string,
  authorized: AuthorizedToken,
  jobId: string,
  purpose: CapabilityPurpose,
  capability: unknown,
): Promise<boolean> {
  const value = typeof capability === "string" ? capability : "";
  const prefix = PREFIX[purpose];
  if (!value.startsWith(prefix) || !new RegExp(`^${prefix}[A-Za-z0-9_-]{43}$`).test(value)) return false;
  const signature = decodeBase64Url(value.slice(prefix.length));
  if (!signature) return false;
  const key = await capabilityKey(keyMaterial);
  return crypto.subtle.verify("HMAC", key, signature, capabilityMessage(authorized, jobId, purpose));
}

async function capabilityKey(keyMaterial: string): Promise<CryptoKey> {
  if (!keyMaterial) throw new Error("managed-job capability key is not configured");
  return crypto.subtle.importKey("raw", new TextEncoder().encode(keyMaterial), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function capabilityMessage(authorized: AuthorizedToken, jobId: string, purpose: CapabilityPurpose): ArrayBuffer {
  const source = [DOMAIN, purpose, jobId, authorized.accountId, authorized.accountVersion, authorized.clientId, authorized.familyId, authorized.role].join("\0");
  const encoded = new TextEncoder().encode(source);
  const buffer = new ArrayBuffer(encoded.byteLength);
  new Uint8Array(buffer).set(encoded);
  return buffer;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): ArrayBuffer | null {
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
    const binary = atob(padded);
    const buffer = new ArrayBuffer(binary.length); const bytes = new Uint8Array(buffer);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return buffer;
  } catch { return null; }
}
export function managedJobReadTimeoutBudget(args: Record<string, unknown>): Readonly<{
  executionTimeoutMs: number;
  settlementTimeoutMs: number;
}> {
  const requestedWaitMs = typeof args.wait_ms === "number" && Number.isSafeInteger(args.wait_ms)
    ? args.wait_ms
    : relayContract.defaultManagedJobReadWaitMs;
  const waitMs = Math.max(0, Math.min(requestedWaitMs, relayContract.maximumManagedJobReadWaitMs));
  const executionTimeoutMs = waitMs + relayContract.managedJobReadExecutionHeadroomMs;
  const settlementTimeoutMs = Math.min(
    executionTimeoutMs + relayContract.workerSettlementOverheadMs,
    relayContract.maximumRelayToolTimeoutMs,
  );
  return Object.freeze({ executionTimeoutMs, settlementTimeoutMs });
}

export function managedJobReadArgumentsWithinExecutionBudget(
  args: Record<string, unknown>,
  executionTimeoutMs: number,
): Record<string, unknown> {
  const requestedWaitMs = typeof args.wait_ms === "number" && Number.isSafeInteger(args.wait_ms)
    ? Math.max(0, Math.min(args.wait_ms, relayContract.maximumManagedJobReadWaitMs))
    : relayContract.defaultManagedJobReadWaitMs;
  const executionMs = Number.isSafeInteger(executionTimeoutMs) ? Math.max(0, executionTimeoutMs) : 0;
  const availableWaitMs = Math.max(0, Math.min(
    relayContract.maximumManagedJobReadWaitMs,
    executionMs - relayContract.managedJobReadExecutionHeadroomMs,
  ));
  return requestedWaitMs <= availableWaitMs ? args : { ...args, wait_ms: availableWaitMs };
}

export function managedJobReadExecutionBudgetHasHeadroom(executionTimeoutMs: number): boolean {
  return Number.isSafeInteger(executionTimeoutMs)
    && executionTimeoutMs >= relayContract.managedJobReadExecutionHeadroomMs;
}
