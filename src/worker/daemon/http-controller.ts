import relayContract from "../../shared/relay-contract.json" with { type: "json" };
import { authorityRevocations, queueDaemonHttpRevocations } from "../oauth/authority-revocations.ts";
import type { DaemonChannel } from "./channel.ts";
import type { DaemonHttpChannel } from "./http-channel.ts";
import type { DaemonRegistry } from "./registry.ts";
import { handleReadyDaemonMessage, beginDaemonResumeReconciliation } from "./ready-messages.ts";
import { notifyReadyDaemon } from "./ready-waiters.ts";
import { HttpError, json, readBoundedBytes } from "../room/http.ts";
import type { WorkerObservability } from "../room/observability.ts";
import type { PendingCallRegistry } from "../room/pending-calls.ts";
import { sanitizeDaemonPolicy, sanitizeDaemonTools } from "../room/policy.ts";
import { sanitizeDaemonRelayDiagnostics } from "./relay-diagnostics.ts";
import { randomToken, safeEqual } from "../oauth/state.ts";
import { sanitizeConnectionId, sanitizeDaemonInstanceId } from "./channel.ts";
import { DAEMON_HTTP_RELAY_SCHEME, DAEMON_HTTP_RELAY_TTL_SECONDS, daemonHttpRelayTranscript } from "../../shared/daemon-auth.mjs";
import { consumeBoundedNonce } from "../oauth/dpop.ts";
import { decodeBase64Url, verifyDeviceSessionCertificate, verifyP256Signature } from "../oauth/device-session-verifier.ts";

const handshakes = new WeakMap<DaemonHttpChannel, { ids: readonly string[]; offered: boolean }>();

async function advanceHandshake(channel: DaemonHttpChannel, storage: DurableObjectStorage, server: string, version: string): Promise<void> {
  const records = await authorityRevocations(storage);
  const handshake = handshakes.get(channel);
  if (handshake && !handshake.offered && channel.queuedMessageCount === 0
      && records.length <= relayContract.httpFallbackMaximumQueuedMessages - 2) {
    beginDaemonResumeReconciliation(channel, handshake.ids);
    channel.send(JSON.stringify({ type: "resume_calls", ids: handshake.ids }));
    queueDaemonHttpRevocations(channel, records);
    channel.send(JSON.stringify({ type: "ready_ack", server, version }));
    handshake.offered = true;
    return;
  }
  queueDaemonHttpRevocations(channel, records);
}

export async function handleDaemonHttpRelay(input: {
  request: Request;
  storage: DurableObjectStorage;
  registry: DaemonRegistry;
  pending: PendingCallRegistry;
  observability: WorkerObservability;
  publicKeyJson: string;
  server: string;
  version: string;
  scheduleAlarm: () => Promise<void>;
  detachChannel: (channel: DaemonChannel, message: string) => Promise<void>;
  retireWebSocket: (socket: WebSocket, message: string) => Promise<void>;
}): Promise<Response> {
  const bodyBytes = await readBoundedBytes(input.request, relayContract.httpFallbackMaximumEnvelopeBytes);
  const workerOrigin = new URL(input.request.url).origin;
  if (!(await verifyDaemonHttpRelayRequest({
    storage: input.storage, publicKeyJson: input.publicKeyJson, headers: input.request.headers,
    body: bodyBytes, workerOrigin, server: input.server, version: input.version,
  }))) return json({ error: "daemon_http_unauthorized" }, 401);
  const exchange = normalizeDaemonHttpExchange(parseJson(bodyBytes));
  if (!exchange) return json({ error: "invalid_daemon_http_exchange" }, 400);

  let channel = input.registry.http.get(exchange.sessionId);
  if (!channel && (exchange.activationToken || exchange.ackWorkerSeq !== 0 || exchange.messages.length > 0)) {
    return json({ error: "unknown_daemon_http_session" }, 409);
  }
  const readyHttpChannels = input.registry.httpReadyChannels();
  if (!channel && readyHttpChannels.some((candidate) => candidate.attachment.instanceId !== exchange.instanceId)) {
    return relayResponse("standby", null, 0, []);
  }
  const readySockets = input.registry.readySockets();
  if (readySockets.length > 0) {
    const takeoverTarget = exchange.takeoverWebSocket ? readySockets.find((socket) =>
      input.registry.readyAttachment(socket)?.connectionId === exchange.takeoverWebSocketConnectionId) : undefined;
    if (channel || !takeoverTarget || readySockets.length !== 1
        || input.registry.readyAttachment(takeoverTarget)?.instanceId !== exchange.instanceId) {
      if (channel) input.registry.http.close(channel);
      return relayResponse("standby", null, 0, []);
    }
    await input.retireWebSocket(takeoverTarget, "authenticated HTTPS fallback replacing targeted WebSocket generation");
  }

  if (!channel) {
    const sameInstanceChannels = [
      ...readyHttpChannels,
      ...input.registry.httpCandidates().filter((candidate) => candidate.sessionId !== exchange.sessionId),
    ].filter((candidate) => candidate.attachment.instanceId === exchange.instanceId);
    for (const previous of sameInstanceChannels) {
      await input.detachChannel(previous, "new authenticated HTTPS fallback session replaced same-instance channel");
      input.registry.http.close(previous);
    }
    const policy = sanitizeDaemonPolicy(exchange.policy);
    const now = Date.now();
    channel = input.registry.http.beginCandidate(exchange.sessionId, {
      role: "candidate", connectedAt: new Date(now).toISOString(), lastSeenAt: new Date(now).toISOString(),
      instanceId: exchange.instanceId, connectionId: randomToken("connection"), policy,
      tools: sanitizeDaemonTools(exchange.tools, policy),
      relayDiagnostics: sanitizeDaemonRelayDiagnostics(exchange.relayDiagnostics),
    }, now);
    if (!channel) return json({ error: "daemon_http_candidate_capacity" }, 503);
    input.registry.http.activate(exchange.sessionId, channel.activationToken, now);
    const rebound = input.pending.rebindInstance(exchange.instanceId, channel);
    handshakes.set(channel, { ids: rebound, offered: false });
    await advanceHandshake(channel, input.storage, input.server, input.version);
    await input.scheduleAlarm();
    return relayResponse("probing", channel.activationToken, channel.daemonSequence, channel.outboundMessages());
  }
  if (channel.attachment.instanceId !== exchange.instanceId) return json({ error: "daemon_http_instance_mismatch" }, 409);

  if (channel.readyState !== 1) {
    if (!channel.isActivated) {
      input.registry.http.close(channel);
      return json({ error: "invalid_daemon_http_candidate_state" }, 409);
    }
    if (exchange.activationToken !== channel.activationToken || !channel.acknowledgeWorker(exchange.ackWorkerSeq)) {
      return json({ error: "invalid_daemon_http_acknowledgement" }, 409);
    }
    channel.touch();
    for (const message of exchange.messages) {
      const sequence = channel.acceptDaemonSequence(message.seq);
      if (sequence === "duplicate") continue;
      if (sequence === "gap") return invalidate(channel, input, "daemon_http_sequence_gap");
      if (message.payload.type === "https_ready") {
        if (!handshakes.get(channel)?.offered || channel.queuedMessageCount > 0) {
          return invalidate(channel, input, "daemon_http_ready_before_control_ack");
        }
        channel.verifyReady();
        input.registry.rememberReady(channel);
        channel.commitDaemonSequence(message.seq);
        const previous = input.registry.httpReadyChannels().filter((candidate) => candidate !== channel);
        for (const old of previous) {
          await input.detachChannel(old, "HTTPS fallback channel replaced after verified handover");
          input.registry.http.close(old);
        }
        input.observability.event("info", "daemon.https_fallback.ready", { daemon_owned_calls: exchange.ownedCallIds.length });
        continue;
      }
      const handled = await handleReadyDaemonMessage({
        channel, body: message.payload, pending: input.pending, storage: input.storage, observability: input.observability,
        beginDrain: (candidate) => input.registry.beginDrain(candidate),
      });
      if (!handled.ok) return invalidate(channel, input, handled.errorCode ?? "invalid_daemon_http_message");
      channel.commitDaemonSequence(message.seq);
    }
    await advanceHandshake(channel, input.storage, input.server, input.version);
    await input.scheduleAlarm();
    if (channel.readyState === 1) notifyReadyDaemon(input.registry);
    return relayResponse(channel.readyState === 1 ? "ready" : "probing", channel.activationToken, channel.daemonSequence, channel.outboundMessages());
  }

  if (exchange.activationToken !== channel.activationToken || !channel.acknowledgeWorker(exchange.ackWorkerSeq)) {
    return json({ error: "invalid_daemon_http_acknowledgement" }, 409);
  }
  channel.touch();
  for (const message of exchange.messages) {
    const sequence = channel.acceptDaemonSequence(message.seq);
    if (sequence === "duplicate") continue;
    if (sequence === "gap") return invalidate(channel, input, "daemon_http_sequence_gap");
    const handled = await handleReadyDaemonMessage({
      channel, body: message.payload, pending: input.pending, storage: input.storage, observability: input.observability,
      beginDrain: (candidate) => input.registry.beginDrain(candidate),
    });
    if (!handled.ok) return invalidate(channel, input, handled.errorCode ?? "invalid_daemon_http_message");
    channel.commitDaemonSequence(message.seq);
  }
  await advanceHandshake(channel, input.storage, input.server, input.version);
  await input.scheduleAlarm();
  return relayResponse("ready", channel.activationToken, channel.daemonSequence, channel.outboundMessages());
}

async function invalidate(channel: DaemonHttpChannel, input: Parameters<typeof handleDaemonHttpRelay>[0], code: string): Promise<Response> {
  await input.detachChannel(channel, `HTTPS fallback protocol failure: ${code}`);
  input.registry.http.close(channel);
  input.observability.socketProtocolError(code);
  input.observability.event("warn", "daemon.https_fallback.invalidated", { error_class: code });
  await input.scheduleAlarm();
  return json({ error: code }, 409);
}

function relayResponse(phase: "probing" | "ready" | "standby", activationToken: string | null, ackDaemonSeq: number, messages: unknown[]): Response {
  return json({ protocol: 1, phase, activation_token: activationToken, ack_daemon_seq: ackDaemonSeq, messages });
}

function parseJson(bytes: Uint8Array): unknown {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new HttpError(400, "invalid_encoding", "daemon HTTP relay body must be UTF-8"); }
  try { return JSON.parse(text); }
  catch { throw new HttpError(400, "invalid_json", "daemon HTTP relay body is not valid JSON"); }
}
const SESSION_ID = /^relay_http_[A-Za-z0-9_-]{43}$/;

const ACTIVATION_TOKEN = /^activate_[A-Za-z0-9_-]{43}$/;

const CALL_ID = /^call_[A-Za-z0-9_-]{8,240}$/;

export interface DaemonHttpExchange {
  sessionId: string;
  instanceId: string;
  activationToken: string;
  ackWorkerSeq: number;
  takeoverWebSocket: boolean;
  takeoverWebSocketConnectionId: string;
  ownedCallIds: string[];
  messages: Array<{ seq: number; payload: Record<string, unknown> }>;
  tools: unknown;
  policy: unknown;
  relayDiagnostics: unknown;
}

export function normalizeDaemonHttpExchange(value: unknown): DaemonHttpExchange | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (body.protocol !== 1) return null;
  const sessionId = typeof body.session_id === "string" && SESSION_ID.test(body.session_id) ? body.session_id : "";
  const instanceId = sanitizeDaemonInstanceId(body.instance_id) ?? "";
  const activationToken = body.activation_token === undefined ? ""
    : typeof body.activation_token === "string" && ACTIVATION_TOKEN.test(body.activation_token) ? body.activation_token : "invalid";
  const ackWorkerSeq = typeof body.ack_worker_seq === "number" ? body.ack_worker_seq : Number.NaN;
  const takeoverWebSocket = body.takeover_websocket === undefined ? false : body.takeover_websocket;
  const takeoverWebSocketConnectionId = body.takeover_websocket_connection_id === undefined ? ""
    : sanitizeConnectionId(body.takeover_websocket_connection_id) ?? "invalid";
  const ownedCallIds = normalizeCallIds(body.owned_call_ids);
  const messages = normalizeMessages(body.messages);
  if (!sessionId || !instanceId || activationToken === "invalid" || !Number.isSafeInteger(ackWorkerSeq) || ackWorkerSeq < 0
      || typeof takeoverWebSocket !== "boolean" || takeoverWebSocketConnectionId === "invalid"
      || (takeoverWebSocket ? !takeoverWebSocketConnectionId : Boolean(takeoverWebSocketConnectionId))
      || !ownedCallIds || !messages) return null;
  return {
    sessionId, instanceId, activationToken, ackWorkerSeq, takeoverWebSocket, takeoverWebSocketConnectionId, ownedCallIds, messages,
    tools: body.tools, policy: body.policy, relayDiagnostics: body.relay_diagnostics,
  };
}

function normalizeCallIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 32) return null;
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !CALL_ID.test(item) || seen.has(item)) return null;
    seen.add(item); result.push(item);
  }
  return result;
}

function normalizeMessages(value: unknown): Array<{ seq: number; payload: Record<string, unknown> }> | null {
  if (!Array.isArray(value) || value.length > 64) return null;
  const result = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    if (!Number.isSafeInteger(record.seq) || Number(record.seq) <= 0
        || !record.payload || typeof record.payload !== "object" || Array.isArray(record.payload)) return null;
    result.push({ seq: Number(record.seq), payload: record.payload as Record<string, unknown> });
  }
  return result;
}
const SESSION_CERTIFICATE_HEADER = "X-Bridge-Device-Certificate";

export async function verifyDaemonHttpRelayRequest(input: {
  storage: DurableObjectStorage;
  publicKeyJson: string;
  headers: Headers;
  body: Uint8Array;
  workerOrigin: string;
  server: string;
  version: string;
  now?: number;
}): Promise<boolean> {
  const now = Number.isSafeInteger(input.now) ? Number(input.now) : Math.floor(Date.now() / 1000);
  const certificate = await verifyDeviceSessionCertificate({
    encodedCertificate: input.headers.get(SESSION_CERTIFICATE_HEADER) || "",
    rootPublicKeyJson: input.publicKeyJson,
    workerOrigin: input.workerOrigin,
    server: input.server,
    version: input.version,
    now,
  });
  if (!certificate) return false;
  const scheme = input.headers.get("X-Bridge-Device-Scheme") || "";
  const keyId = input.headers.get("X-Bridge-Device-Key") || "";
  const nonce = input.headers.get("X-Bridge-Device-Nonce") || "";
  const issuedAt = Number(input.headers.get("X-Bridge-Device-Time"));
  const claimedBodyHash = input.headers.get("X-Bridge-Body-SHA256") || "";
  const signature = decodeBase64Url(input.headers.get("X-Bridge-Device-Signature") || "", 64);
  if (scheme !== DAEMON_HTTP_RELAY_SCHEME || !signature || !/^[A-Za-z0-9_-]{43}$/.test(claimedBodyHash)) return false;
  if (!Number.isSafeInteger(issuedAt) || now >= issuedAt + DAEMON_HTTP_RELAY_TTL_SECONDS || issuedAt - now > DAEMON_HTTP_RELAY_TTL_SECONDS) return false;
  if (!/^[A-Za-z0-9_-]{24,128}$/.test(nonce) || !(await safeEqual(keyId, certificate.sessionKeyId))) return false;
  const digestInput = new Uint8Array(input.body.byteLength);
  digestInput.set(input.body);
  const actualBodyHash = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", digestInput)));
  if (!(await safeEqual(claimedBodyHash, actualBodyHash))) return false;
  let transcript: string;
  try {
    transcript = daemonHttpRelayTranscript({
      workerOrigin: input.workerOrigin, server: input.server, version: input.version,
      nonce, issuedAt, bodySha256: claimedBodyHash,
    });
  } catch { return false; }
  if (!(await verifyP256Signature(certificate.sessionPublicJwk, transcript, signature))) return false;
  return consumeBoundedNonce(input.storage, {
    key: "daemon-http-relay-nonces", nonce, expiresAt: issuedAt + DAEMON_HTTP_RELAY_TTL_SECONDS, now,
    noncePattern: /^[A-Za-z0-9_-]{24,128}$/, maximum: 1024, maxFutureSeconds: DAEMON_HTTP_RELAY_TTL_SECONDS * 2,
  });
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
