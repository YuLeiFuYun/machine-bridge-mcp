import relayContract from "../shared/relay-contract.json" with { type: "json" };
import { authorityRevocations, authorityRevocationWireMessage } from "./authority-revocations.ts";
import type { DaemonChannel } from "./daemon-channel.ts";
import { verifyDaemonHttpRelayRequest } from "./daemon-http-auth.ts";
import type { DaemonHttpChannel } from "./daemon-http-channel.ts";
import { normalizeDaemonHttpExchange } from "./daemon-http-protocol.ts";
import type { DaemonRegistry } from "./daemon-registry.ts";
import { handleReadyDaemonMessage } from "./daemon-ready-messages.ts";
import { notifyReadyDaemon } from "./daemon-ready-waiters.ts";
import { HttpError, json, readBoundedBytes } from "./http.ts";
import type { WorkerObservability } from "./observability.ts";
import type { PendingCallRegistry } from "./pending-calls.ts";
import { sanitizeDaemonPolicy, sanitizeDaemonTools } from "./policy.ts";
import { sanitizeDaemonRelayDiagnostics } from "./daemon-relay-diagnostics.ts";
import { randomToken } from "./oauth-state.ts";

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
    const queuedRevocations = await authorityRevocations(input.storage);
    input.registry.http.activate(exchange.sessionId, channel.activationToken, now);
    const rebound = input.pending.rebindInstance(exchange.instanceId, channel);
    channel.send(JSON.stringify({ type: "resume_calls", ids: rebound }));
    for (const revocation of queuedRevocations) channel.send(JSON.stringify(authorityRevocationWireMessage(revocation)));
    channel.send(JSON.stringify({ type: "ready_ack", server: input.server, version: input.version }));
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
        if (channel.outboundMessages().length > 0) {
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
      });
      if (!handled.ok) return invalidate(channel, input, handled.errorCode ?? "invalid_daemon_http_message");
      channel.commitDaemonSequence(message.seq);
    }
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
    });
    if (!handled.ok) return invalidate(channel, input, handled.errorCode ?? "invalid_daemon_http_message");
    channel.commitDaemonSequence(message.seq);
  }
  await input.scheduleAlarm();
  return relayResponse("ready", channel.activationToken, channel.daemonSequence, channel.outboundMessages());
}

async function invalidate(channel: DaemonHttpChannel, input: Parameters<typeof handleDaemonHttpRelay>[0], code: string): Promise<Response> {
  await input.detachChannel(channel, `HTTPS fallback protocol failure: ${code}`);
  input.registry.http.close(channel);
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
