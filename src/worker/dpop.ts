import { boundedNoncePresent, consumeBoundedNonce } from "./nonce-store.ts";
import { JWK_THUMBPRINT_PATTERN } from "./oauth-record-contract.ts";

const DPOP_WINDOW_SECONDS = 5 * 60;
const MAX_DPOP_JTIS = 4096;
const INTERNAL_RETRY_ID_PATTERN = /^retry_[A-Za-z0-9_-]{43}$/;
const DPOP_RETRY_BINDINGS_KEY = "dpop-internal-retry-bindings";
const MAX_DPOP_INTERNAL_RETRY_USES = 4;

export interface VerifiedDpopProof {
  jkt: string;
  jti: string;
  issuedAt: number;
  replayKey: string;
  expiresAt: number;
}

export async function verifyDpopProof(input: {
  request: Request;
  expectedMethod?: string;
  expectedUrl?: string;
  accessToken?: string;
  expectedJkt?: string;
  now?: number;
}): Promise<VerifiedDpopProof | null> {
  const encoded = input.request.headers.get("DPoP") || "";
  if (!encoded) return null;
  const parts = encoded.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return null;
  const header = decodeJson(parts[0]);
  const payload = decodeJson(parts[1]);
  const signature = decodeBase64Url(parts[2], 64);
  if (!header || !payload || !signature) return null;
  if (header.typ !== "dpop+jwt" || header.alg !== "ES256" || !plainRecord(header.jwk)) return null;
  if (header.crit !== undefined || header.b64 !== undefined) return null;
  const publicJwk = publicP256Jwk(header.jwk);
  if (!publicJwk) return null;
  const now = Number.isSafeInteger(input.now) ? Number(input.now) : Math.floor(Date.now() / 1000);
  const issuedAt = Number(payload.iat);
  const jti = String(payload.jti || "");
  if (!Number.isSafeInteger(issuedAt) || Math.abs(now - issuedAt) > DPOP_WINDOW_SECONDS) return null;
  if (!/^[A-Za-z0-9._~-]{16,200}$/.test(jti)) return null;
  const expectedMethod = String(input.expectedMethod || input.request.method).toUpperCase();
  const expectedUrl = normalizedHtu(input.expectedUrl || input.request.url);
  if (String(payload.htm || "").toUpperCase() !== expectedMethod || normalizedHtu(String(payload.htu || "")) !== expectedUrl) return null;
  const jkt = await jwkThumbprint(publicJwk);
  if (input.expectedJkt && (!JWK_THUMBPRINT_PATTERN.test(input.expectedJkt) || input.expectedJkt !== jkt)) return null;
  if (input.accessToken) {
    const ath = String(payload.ath || "");
    if (ath !== await sha256Base64Url(input.accessToken)) return null;
  } else if (payload.ath !== undefined) {
    return null;
  }
  try {
    const key = await crypto.subtle.importKey("jwk", publicJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const verified = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      signature as unknown as BufferSource,
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    if (!verified) return null;
  } catch {
    return null;
  }
  const replayKey = await sha256Base64Url(`${jkt}\0${jti}`);
  return {
    jkt,
    jti,
    issuedAt,
    replayKey,
    expiresAt: Math.max(now + 1, issuedAt + DPOP_WINDOW_SECONDS),
  };
}

export async function consumeDpopProof(
  storage: DurableObjectStorage | DpopNonceStorage,
  proof: VerifiedDpopProof,
  now = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!proof || !JWK_THUMBPRINT_PATTERN.test(proof.replayKey) || !Number.isSafeInteger(proof.expiresAt) || proof.expiresAt <= now) return false;
  return consumeBoundedNonce(storage, {
    key: "dpop-proof-jtis",
    nonce: proof.replayKey,
    expiresAt: proof.expiresAt,
    now,
    noncePattern: JWK_THUMBPRINT_PATTERN,
    maximum: MAX_DPOP_JTIS,
  });
}

export async function consumeDpopProofForInternalRetry(
  storage: DurableObjectStorage | DpopNonceStorage,
  proof: VerifiedDpopProof,
  retryId: string,
  now = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!INTERNAL_RETRY_ID_PATTERN.test(retryId)
      || !proof || !JWK_THUMBPRINT_PATTERN.test(proof.replayKey)
      || !Number.isSafeInteger(proof.expiresAt) || proof.expiresAt <= now) return false;
  const consume = async (target: DpopNonceStorage): Promise<boolean> => {
    const raw = await target.get<unknown>(DPOP_RETRY_BINDINGS_KEY);
    if (raw !== undefined && !validRetryBindings(raw)) return false;
    const bindings: DpopRetryBindings = raw ? structuredClone(raw as DpopRetryBindings) : {};
    for (const [key, binding] of Object.entries(bindings)) {
      if (binding.expires_at <= now) delete bindings[key];
    }
    const existing = bindings[proof.replayKey];
    if (existing) {
      if (existing.retry_id !== retryId || existing.uses >= MAX_DPOP_INTERNAL_RETRY_USES
          || !(await boundedNoncePresent(target, {
            key: "dpop-proof-jtis",
            nonce: proof.replayKey,
            now,
            noncePattern: JWK_THUMBPRINT_PATTERN,
          }))) return false;
      bindings[proof.replayKey] = { ...existing, uses: existing.uses + 1 };
      await target.put(DPOP_RETRY_BINDINGS_KEY, bindings);
      return true;
    }
    if (Object.keys(bindings).length >= MAX_DPOP_JTIS) return false;
    const consumed = await consumeDpopProof(target, proof, now);
    if (!consumed) return false;
    bindings[proof.replayKey] = { retry_id: retryId, expires_at: proof.expiresAt, uses: 1 };
    await target.put(DPOP_RETRY_BINDINGS_KEY, bindings);
    return true;
  };
  return hasDpopTransactions(storage) ? storage.transaction(consume) : consume(storage);
}

type DpopNonceStorage = {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
};

type DpopTransactionalStorage = DpopNonceStorage & {
  transaction<T>(callback: (transaction: DpopNonceStorage) => Promise<T>): Promise<T>;
};

type DpopRetryBindings = Record<string, { retry_id: string; expires_at: number; uses: number }>;

function validRetryBindings(value: unknown): value is DpopRetryBindings {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.entries(value as Record<string, unknown>).every(([key, raw]) => (
      JWK_THUMBPRINT_PATTERN.test(key)
      && Boolean(raw) && typeof raw === "object" && !Array.isArray(raw)
      && INTERNAL_RETRY_ID_PATTERN.test(String((raw as { retry_id?: unknown }).retry_id ?? ""))
      && Number.isSafeInteger((raw as { expires_at?: unknown }).expires_at)
      && Number((raw as { expires_at?: unknown }).expires_at) > 0
      && Number.isSafeInteger((raw as { uses?: unknown }).uses)
      && Number((raw as { uses?: unknown }).uses) >= 1
      && Number((raw as { uses?: unknown }).uses) <= MAX_DPOP_INTERNAL_RETRY_USES
    ));
}

function hasDpopTransactions(storage: DurableObjectStorage | DpopNonceStorage): storage is DpopTransactionalStorage {
  return typeof (storage as Partial<DpopTransactionalStorage>).transaction === "function";
}

export async function jwkThumbprint(jwk: JsonWebKey): Promise<string> {
  const publicJwk = publicP256Jwk(jwk);
  if (!publicJwk) throw new Error("DPoP public key is invalid");
  const canonical = JSON.stringify({ crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x, y: publicJwk.y });
  return sha256Base64Url(canonical);
}

export function normalizedHtu(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) {
    throw new Error("DPoP target URI is invalid");
  }
  if (url.username || url.password || url.hash) throw new Error("DPoP target URI is invalid");
  return `${url.origin}${url.pathname}`;
}

function publicP256Jwk(value: unknown): JsonWebKey | null {
  if (!plainRecord(value) || value.kty !== "EC" || value.crv !== "P-256" || value.d !== undefined) return null;
  if (typeof value.x !== "string" || typeof value.y !== "string") return null;
  if (!/^[A-Za-z0-9_-]{42,44}$/.test(value.x) || !/^[A-Za-z0-9_-]{42,44}$/.test(value.y)) return null;
  return { kty: "EC", crv: "P-256", x: value.x, y: value.y, ext: true, key_ops: ["verify"] };
}

function decodeJson(value: string): Record<string, unknown> | null {
  const bytes = decodeBase64Url(value);
  if (!bytes || bytes.byteLength > 16 * 1024) return null;
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return plainRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function decodeBase64Url(value: string, expectedBytes?: number): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  try {
    const binary = atob(padded);
    if (expectedBytes !== undefined && binary.length !== expectedBytes) return null;
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64Url(new Uint8Array(digest));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function plainRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
