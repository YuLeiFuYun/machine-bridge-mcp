import { authorityRevocationWireMessage, authorityRevocations } from "./authority-revocations.ts";
import { consumeDaemonPreflightNonce, createDaemonChallenge, verifyDaemonAuthentication, verifyDaemonPreflight } from "./daemon-auth.ts";
import type { DaemonChannel } from "./daemon-channel.ts";
import { isFreshDaemonCandidate } from "./daemon-liveness.ts";
import { notifyReadyDaemon } from "./daemon-ready-waiters.ts";
import { sanitizeDaemonRelayDiagnostics } from "./daemon-relay-diagnostics.ts";
import { DaemonRegistry } from "./daemon-registry.ts";
import { beginDaemonResumeReconciliation } from "./daemon-resume-reconciliation.ts";
import { sanitizeDaemonInstanceId, type DaemonAttachment } from "./daemon-socket-attachment.ts";
import { WorkerObservability } from "./observability.ts";
import { PendingCallRegistry } from "./pending-calls.ts";
import { sanitizeDaemonPolicy, sanitizeDaemonTools } from "./policy.ts";
import { randomToken } from "./oauth-state.ts";
import type { WorkerSocketDisconnectInput } from "./worker-socket-disconnect-evidence.ts";
import { workerErrorClass } from "./http.ts";
import { closeWebSocketQuietly, daemonErrorCloseCode, isObjectRecord, rejectDaemonMessage, sendWebSocketQuietly, trySendWebSocket } from "./websocket-protocol.ts";
const MAX_DAEMON_MESSAGE_BYTES = 8 * 1024 * 1024;
type DaemonSocketControllerOptions = {
  storage: DurableObjectStorage; registry: DaemonRegistry; pending: PendingCallRegistry; observability: WorkerObservability;
  server: string; version: string; publicKey: () => string | undefined; acceptWebSocket: (socket: WebSocket) => void;
  expireOverdueCalls: () => Promise<void>; scheduleAlarm: () => Promise<void>;
  detachSocketCalls: (socket: WebSocket, message: string, attachment?: DaemonAttachment) => Promise<number>;
  detachChannelCalls: (channel: DaemonChannel, message: string) => Promise<number>;
  handleReadyMessage: typeof import("./daemon-ready-messages.ts").handleReadyDaemonMessage;
  recordSocketDisconnect: (cleanup: { first: boolean }, input: WorkerSocketDisconnectInput) => Promise<void>;
};
export class DaemonWebSocketController {
  constructor(private readonly options: DaemonSocketControllerOptions) {}
  async acceptDaemonWebSocket(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }
    const publicKeyJson = this.options.publicKey();
    if (!publicKeyJson) return new Response("Daemon device identity is not configured", { status: 503 });
    const workerOrigin = new URL(request.url).origin;
    const preflight = await verifyDaemonPreflight({
      publicKeyJson,
      headers: request.headers,
      workerOrigin,
      server: this.options.server,
      version: this.options.version,
    });
    if (!preflight || !(await consumeDaemonPreflightNonce(this.options.storage, preflight))) {
      return new Response("Unauthorized daemon device", { status: 401 });
    }
    const challenge = createDaemonChallenge(workerOrigin);
    for (const socket of this.options.registry.nonReadySockets()) {
      closeWebSocketQuietly(socket, 1012, "replaced by newer daemon candidate");
    }
    const connectionId = randomToken("connection");
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.options.acceptWebSocket(server);
    this.options.observability.socketCandidate();
    this.options.registry.beginCandidate(server, challenge, preflight, connectionId);
    await this.options.scheduleAlarm();
    const welcomed = trySendWebSocket(server, {
      type: "welcome",
      server: this.options.server,
      version: this.options.version,
      connection_id: connectionId,
      worker_origin: workerOrigin,
      authentication: {
        scheme: challenge.scheme,
        challenge: challenge.challenge,
        issued_at: challenge.issuedAt,
        expires_at: challenge.expiresAt,
      },
    });
    if (!welcomed) {
      await this.invalidateDaemonSocket(server, "daemon welcome failed", "daemon welcome failed", "daemon_transport_error");
    }
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.options.expireOverdueCalls();
    const size = typeof message === "string" ? new TextEncoder().encode(message).byteLength : message.byteLength;
    if (size > MAX_DAEMON_MESSAGE_BYTES) {
      closeWebSocketQuietly(ws, 1009, "message too large");
      return;
    }
    let text: string;
    try {
      text = typeof message === "string" ? message : new TextDecoder("utf-8", { fatal: true }).decode(message);
    } catch {
      closeWebSocketQuietly(ws, 1007, "invalid UTF-8");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      rejectDaemonMessage(ws, "invalid_json", 1007, "invalid JSON");
      return;
    }
    if (!isObjectRecord(parsed)) {
      rejectDaemonMessage(ws, "invalid_message", 1002, "daemon message must be an object");
      return;
    }
    const body = parsed;
    const socketAttachment = this.options.registry.attachment(ws);
    if (!socketAttachment) {
      closeWebSocketQuietly(ws, 1008, "missing daemon attachment");
      return;
    }
    if (socketAttachment.role === "expired") {
      closeWebSocketQuietly(ws, 1008, "expired daemon candidate");
      return;
    }
    if (body.type === "hello") {
      await this.handleHello(ws, body, socketAttachment);
      return;
    }
    if (socketAttachment.role === "candidate") {
      closeWebSocketQuietly(ws, 1008, "daemon hello required");
      return;
    }
    if (body.type === "heartbeat" || body.type === "ping") {
      if (!this.touchDaemonSocket(ws)) return;
      if (!trySendWebSocket(ws, { type: "pong", ts: body.ts ?? Date.now() })) {
        await this.invalidateDaemonSocket(ws, "failed to acknowledge daemon heartbeat", "daemon pong failed", "daemon_transport_error");
        return;
      }
      await this.options.scheduleAlarm();
      return;
    }
    if (socketAttachment.role === "probing") {
      await this.handleProbeResult(ws, body, socketAttachment);
      return;
    }
    if (socketAttachment.role !== "daemon") {
      closeWebSocketQuietly(ws, 1008, "daemon readiness required");
      return;
    }
    if (!this.touchDaemonSocket(ws)) return;
    const handled = await this.options.handleReadyMessage({
      channel: ws,
      body,
      pending: this.options.pending,
      storage: this.options.storage,
      observability: this.options.observability,
      beginDrain: (channel) => this.options.registry.beginDrain(channel),
    });
    if (!handled.ok) {
      this.options.observability.socketProtocolError(handled.errorCode ?? "unknown_message_type");
      rejectDaemonMessage(ws, handled.errorCode ?? "unknown_message_type", 1002,
        handled.errorMessage ?? "invalid daemon message");
      return;
    }
    await this.options.scheduleAlarm();
  }
  async webSocketClose(ws: WebSocket, code: number, _reason: string, wasClean: boolean): Promise<void> {
    const attachment = this.options.registry.attachment(ws);
    const planned = this.options.registry.isDraining(ws);
    const cleanup = this.cleanupDaemonSocket(ws, "daemon disconnected");
    if (cleanup?.first) {
      this.options.observability.event("info", "daemon.websocket.closed", {
        close_code: Number.isInteger(code) && code >= 1000 && code <= 4999 ? code : 0, was_clean: wasClean === true,
      });
    }
    if (!cleanup) return;
    await cleanup.task;
    await this.options.recordSocketDisconnect(cleanup, {
      planned, kind: "close", closeCode: code, wasClean, role: attachment?.role, connectedAt: attachment?.connectedAt,
    });
    await this.options.scheduleAlarm();
  }
  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    const attachment = this.options.registry.attachment(ws);
    const planned = this.options.registry.isDraining(ws);
    const cleanup = this.cleanupDaemonSocket(ws, "daemon transport error");
    if (!cleanup) return;
    if (cleanup.first) {
      this.options.observability.event("warn", "daemon.websocket.error", { error_class: workerErrorClass(error) });
    }
    await cleanup.task;
    await this.options.recordSocketDisconnect(cleanup, {
      planned, kind: "error", role: attachment?.role, connectedAt: attachment?.connectedAt,
    });
    await this.options.scheduleAlarm();
  }
  cleanupDaemonSocket(ws: WebSocket, message: string) {
    const cleanup = this.options.registry.beginCleanup(
      ws, (attachment) => this.options.detachSocketCalls(ws, message, attachment));
    if (cleanup?.first) this.options.observability.socketDisconnected();
    return cleanup;
  }
  async invalidateDaemonSocket(
    ws: WebSocket, message: string, closeReason: string, errorCode = "daemon_liveness_timeout", scheduleAlarm = true,
  ): Promise<void> {
    const cleanup = this.cleanupDaemonSocket(ws, message);
    sendWebSocketQuietly(ws, { type: "error", error: errorCode });
    closeWebSocketQuietly(ws, daemonErrorCloseCode(errorCode), closeReason);
    if (cleanup) {
      await cleanup.task;
      if (scheduleAlarm) await this.options.scheduleAlarm();
    }
  }
  private async handleHello(ws: WebSocket, body: Record<string, unknown>, socketAttachment: DaemonAttachment): Promise<void> {
    if (socketAttachment.role !== "candidate") {
      rejectDaemonMessage(ws, "duplicate_hello", 1002, "duplicate daemon hello");
      return;
    }
    if (!isFreshDaemonCandidate(socketAttachment.connectedAt)) {
      closeWebSocketQuietly(ws, 1008, "stale daemon candidate");
      await this.options.scheduleAlarm();
      return;
    }
    const instanceId = sanitizeDaemonInstanceId(body.instance_id) ?? "";
    if (!instanceId) {
      rejectDaemonMessage(ws, "invalid_daemon_instance", 1002, "daemon instance id required");
      return;
    }
    if (
      !socketAttachment.authChallenge
      || !socketAttachment.authIssuedAt
      || !socketAttachment.authExpiresAt
      || !socketAttachment.workerOrigin
      || !socketAttachment.authSessionPublicKeyJson
      || !socketAttachment.authSessionKeyId
      || !socketAttachment.authCertificateExpiresAt
    ) {
      rejectDaemonMessage(ws, "missing_daemon_challenge", 1008, "daemon challenge missing");
      return;
    }
    const authenticated = await verifyDaemonAuthentication({
      publicKeyJson: socketAttachment.authSessionPublicKeyJson,
      authentication: body.authentication,
      challenge: {
        scheme: "device-signature-v1",
        challenge: socketAttachment.authChallenge,
        issuedAt: socketAttachment.authIssuedAt,
        expiresAt: socketAttachment.authExpiresAt,
        workerOrigin: socketAttachment.workerOrigin,
      },
      server: this.options.server,
      version: this.options.version,
      instanceId,
      certificateExpiresAt: socketAttachment.authCertificateExpiresAt,
    });
    if (!authenticated) {
      rejectDaemonMessage(ws, "daemon_authentication_failed", 1008, "daemon authentication failed");
      return;
    }
    const daemonPolicy = sanitizeDaemonPolicy(body.policy);
    const authenticatedAt = new Date().toISOString();
    const probeId = randomToken("probe");
    const connectionId = socketAttachment.connectionId ?? "";
    if (!connectionId) {
      rejectDaemonMessage(ws, "missing_daemon_connection_identity", 1008, "daemon connection identity missing");
      return;
    }
    this.options.registry.beginProbe(ws, {
      connectedAt: authenticatedAt,
      probeId,
      instanceId,
      connectionId,
      policy: daemonPolicy,
      tools: sanitizeDaemonTools(body.tools, daemonPolicy),
      relayDiagnostics: sanitizeDaemonRelayDiagnostics(body.relay_diagnostics),
    });
    this.options.observability.socketAuthenticated();
    try {
      ws.send(JSON.stringify({ type: "hello_ack", server: this.options.server, version: this.options.version }));
      ws.send(JSON.stringify({ type: "relay_probe", id: probeId }));
    } catch {
      await this.invalidateDaemonSocket(
        ws, "daemon readiness probe failed", "daemon readiness probe failed", "daemon_transport_error");
      return;
    }
    await this.options.scheduleAlarm();
  }
  private async handleProbeResult(ws: WebSocket, body: Record<string, unknown>, socketAttachment: DaemonAttachment): Promise<void> {
    if (body.type !== "relay_probe_result" || typeof body.id !== "string" || body.id !== socketAttachment.probeId) {
      rejectDaemonMessage(ws, "invalid_relay_probe_result", 1002, "invalid daemon readiness result");
      return;
    }
    const queuedRevocations = await authorityRevocations(this.options.storage);
    const readyAt = new Date().toISOString();
    const readyAttachment = this.options.registry.promote(ws, readyAt);
    if (!readyAttachment) {
      rejectDaemonMessage(ws, "invalid_relay_readiness_state", 1002, "invalid daemon readiness state");
      return;
    }
    const daemonInstanceId = readyAttachment.instanceId ?? "";
    const connectionId = readyAttachment.connectionId ?? "";
    if (!daemonInstanceId || !connectionId) {
      await this.invalidateDaemonSocket(
        ws, "daemon readiness identity is incomplete", "daemon ready timeout", "daemon_ready_timeout");
      return;
    }
    const previousSockets = this.options.registry.readyRoleSockets().filter((socket) => socket !== ws);
    const previousHttpChannels = this.options.registry.httpReadyChannels();
    const fallbackSocket = previousSockets.find((socket) => this.options.registry.readyAttachment(socket)?.instanceId === daemonInstanceId);
    const fallbackHttp = previousHttpChannels.find((channel) => this.options.registry.readyAttachment(channel)?.instanceId === daemonInstanceId);
    const reboundCallIds = this.options.pending.rebindInstance(daemonInstanceId, ws);
    beginDaemonResumeReconciliation(ws, reboundCallIds);
    if (reboundCallIds.length > 0) {
      this.options.observability.event("info", "daemon.calls.rebound", { rebound_calls: reboundCallIds.length });
    }
    try {
      ws.send(JSON.stringify({ type: "resume_calls", ids: reboundCallIds }));
      for (const revocation of queuedRevocations) {
        ws.send(JSON.stringify(authorityRevocationWireMessage(revocation)));
      }
      ws.send(JSON.stringify({ type: "ready_ack", server: this.options.server, version: this.options.version }));
    } catch {
      await this.invalidateDaemonSocket(
        ws, "daemon readiness acknowledgement failed", "daemon ready timeout", "daemon_ready_timeout");
      if (fallbackSocket?.readyState === WebSocket.OPEN) {
        this.options.pending.rebindInstance(daemonInstanceId, fallbackSocket);
      } else if (fallbackHttp?.readyState === 1) {
        this.options.pending.rebindInstance(daemonInstanceId, fallbackHttp);
      }
      await this.options.scheduleAlarm();
      return;
    }
    this.options.observability.socketReady();
    for (const previous of previousSockets) {
      const cleanup = this.cleanupDaemonSocket(previous, "daemon connection replaced after verified handover");
      closeWebSocketQuietly(previous, 1012, "replaced by verified daemon");
      if (cleanup) await cleanup.task;
    }
    for (const previous of previousHttpChannels) {
      await this.options.detachChannelCalls(previous, "HTTPS fallback replaced by verified WebSocket");
      this.options.registry.http.close(previous);
    }
    await this.options.scheduleAlarm();
    notifyReadyDaemon(this.options.registry);
  }
  private touchDaemonSocket(ws: WebSocket): boolean {
    return Boolean(this.options.registry.touch(ws));
  }
}
