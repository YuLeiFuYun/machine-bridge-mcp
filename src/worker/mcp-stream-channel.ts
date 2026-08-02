import { json } from "./http.ts";
import type { JsonRpcMessage, McpResumptionStore } from "./mcp-resumption.ts";
import { isStreamId } from "./mcp-resumption-records.ts";
import { closeWebSocketQuietly, trySendWebSocket } from "./websocket-protocol.ts";

const SUBSCRIBER_ROLE = "mcp_stream_subscriber";
const SUBSCRIBER_TAG_PREFIX = "mcp-stream:";
const MAX_SUBSCRIBERS_PER_STREAM = 4;

type StreamChannelContext = Pick<DurableObjectState, "acceptWebSocket" | "getWebSockets">;
type StreamChannelObservability = {
  streamSubscriberOpened(existing: number): void;
  streamSubscriberRejected(): void;
  streamTerminalDelivered(recipients: number): void;
  streamSubscriberProtocolError(): void;
};
type WebSocketPairFactory = () => [WebSocket, WebSocket];
type UpgradeResponseFactory = (client: WebSocket) => Response;
type StreamSubscriberAttachment = { role: typeof SUBSCRIBER_ROLE; streamId: string };

export class McpStreamChannel {
  private readonly context: StreamChannelContext;
  private readonly observability: StreamChannelObservability;
  private readonly createPair: WebSocketPairFactory;
  private readonly createUpgradeResponse: UpgradeResponseFactory;
  private subscriberAdmission: Promise<void> = Promise.resolve();

  constructor(
    context: StreamChannelContext,
    observability: StreamChannelObservability,
    createPair: WebSocketPairFactory = defaultWebSocketPair,
    createUpgradeResponse: UpgradeResponseFactory = defaultUpgradeResponse,
  ) {
    this.context = context;
    this.observability = observability;
    this.createPair = createPair;
    this.createUpgradeResponse = createUpgradeResponse;
  }

  async subscribe(request: Request, streamId: string, resumption: McpResumptionStore): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }

    const initial = await resumption.pollMessage(streamId);
    if (initial.kind === "message") return json(initial.message);
    if (initial.kind === "not_found") return json({ error: "stream_not_found" }, 404);

    return await this.withSubscriberAdmission(async () => {
      const tag = streamTag(streamId);
      const existing = this.context.getWebSockets(tag).filter((socket) => socket.readyState === WebSocket.OPEN).length;
      if (existing >= MAX_SUBSCRIBERS_PER_STREAM) {
        this.observability.streamSubscriberRejected();
        return json({ error: "stream_subscriber_limit" }, 429, { "retry-after": "1" });
      }

      const [client, server] = this.createPair();
      this.context.acceptWebSocket(server, [tag]);
      server.serializeAttachment({ role: SUBSCRIBER_ROLE, streamId } satisfies StreamSubscriberAttachment);
      this.observability.streamSubscriberOpened(existing);

      try {
        // Recheck after registration. Completion may race between the first storage
        // read and acceptWebSocket(); either publish() or this read delivers it.
        const current = await resumption.pollMessage(streamId);
        if (current.kind === "message") this.sendTerminal(server, current.message);
        else if (current.kind === "not_found") closeWebSocketQuietly(server, 1008, "stream unavailable");
      } catch (error) {
        closeWebSocketQuietly(server, 1011, "stream lookup failed");
        throw error;
      }

      return this.createUpgradeResponse(client);
    });
  }

  publish(streamId: string, message: JsonRpcMessage): void {
    if (!isStreamId(streamId)) return;
    const sockets = this.context.getWebSockets(streamTag(streamId));
    let delivered = 0;
    for (const socket of sockets) {
      if (this.sendTerminal(socket, message)) delivered += 1;
    }
    this.observability.streamTerminalDelivered(delivered);
  }

  isSubscriber(socket: WebSocket): boolean {
    const attachment = subscriberAttachment(socket);
    return Boolean(attachment);
  }

  rejectSubscriberMessage(socket: WebSocket): void {
    this.observability.streamSubscriberProtocolError();
    closeWebSocketQuietly(socket, 1008, "stream subscribers are receive-only");
  }

  private async withSubscriberAdmission<T>(operation: () => Promise<T>): Promise<T> {
    let release: () => void = () => {};
    const predecessor = this.subscriberAdmission;
    this.subscriberAdmission = new Promise<void>((resolve) => { release = resolve; });
    await predecessor;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private sendTerminal(socket: WebSocket, message: JsonRpcMessage): boolean {
    if (socket.readyState !== WebSocket.OPEN) return false;
    const sent = trySendWebSocket(socket, message);
    closeWebSocketQuietly(socket, sent ? 1000 : 1011, sent ? "stream complete" : "stream delivery failed");
    return sent;
  }

}

function subscriberAttachment(socket: WebSocket): StreamSubscriberAttachment | null {
  const raw = socket.deserializeAttachment();
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Partial<StreamSubscriberAttachment>;
  const streamId = candidate.streamId;
  if (candidate.role !== SUBSCRIBER_ROLE || typeof streamId !== "string" || !isStreamId(streamId)) return null;
  return { role: SUBSCRIBER_ROLE, streamId };
}

function streamTag(streamId: string): string {
  if (!isStreamId(streamId)) throw new Error("invalid MCP stream id");
  return `${SUBSCRIBER_TAG_PREFIX}${streamId}`;
}

function defaultUpgradeResponse(client: WebSocket): Response {
  return new Response(null, { status: 101, webSocket: client });
}

function defaultWebSocketPair(): [WebSocket, WebSocket] {
  const pair = new WebSocketPair();
  return Object.values(pair) as [WebSocket, WebSocket];
}
