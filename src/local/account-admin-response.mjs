import { BridgeError } from "./errors.mjs";

const MAX_ADMIN_RESPONSE_BYTES = 1024 * 1024;
const MAX_ADMIN_ERROR_CHARS = 2_000;

export function isReadOnlyAdminMethod(method) { return method === "GET" || method === "HEAD"; }

export async function validateAdminResponseStatus(response, method, pathname) {
  const expectedStatus = method === "DELETE" && pathname === "/admin/accounts" ? 204
    : method === "POST" && pathname === "/admin/accounts" ? 201 : 200;
  if (!response.ok || response.status === expectedStatus) return;
  await cancelResponseBody(response.body);
  throw adminResponseProtocolError(response, method, "account administration response used an unexpected success status");
}

export function boundedRemoteAdminMessage(payload, status) {
  const fallback = `account administration failed (${status})`;
  const candidate = typeof payload?.message === "string" ? payload.message : typeof payload?.error === "string" ? payload.error : fallback;
  const normalized = candidate.replace(/[\u0000-\u001f\u007f\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, " ").replace(/\s+/g, " ").trim();
  return (normalized || fallback).slice(0, MAX_ADMIN_ERROR_CHARS);
}

export async function readAdminJsonResponse(response, method) {
  const declared = Number(response.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > MAX_ADMIN_RESPONSE_BYTES) {
    await cancelResponseBody(response.body);
    throw adminResponseProtocolError(response, method, "account administration response exceeded the size limit");
  }
  if (!response.body) {
    if (response.ok) throw adminResponseProtocolError(response, method, "account administration response was empty");
    return {};
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > MAX_ADMIN_RESPONSE_BYTES) {
        await cancelReader(reader);
        throw adminResponseProtocolError(response, method, "account administration response exceeded the size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  let payload;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(concatBytes(chunks, bytes));
    payload = JSON.parse(text);
  } catch (cause) {
    if (response.ok) throw adminResponseProtocolError(response, method, "account administration response was not valid JSON", cause);
    return {};
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    if (response.ok) throw adminResponseProtocolError(response, method, "account administration response was not a JSON object");
    return {};
  }
  return payload;
}

function adminResponseProtocolError(response, method, message, cause) {
  const mutation = response.ok && !isReadOnlyAdminMethod(method);
  return new BridgeError("protocol_error", message, {
    ...(cause ? { cause } : {}),
    ...(mutation ? { retryable: false, details: { request_delivery: "sent", effect_settlement: "unknown" } } : {}),
  });
}

async function cancelResponseBody(body) {
  if (!body) return;
  const reader = body.getReader();
  try { await cancelReader(reader); } finally { reader.releaseLock(); }
}

async function cancelReader(reader) {
  try { await reader.cancel("response size limit reached"); } catch { /* cleanup only */ }
}

function concatBytes(chunks, bytes) {
  const output = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
