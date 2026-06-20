import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { Logger } from "pino";
import {
  classifySensitiveContent,
  createSensitiveNoticeFacts,
  type SensitiveNoticeFacts,
} from "../security/sensitive-content-policy.js";
import {
  isAllowedPrivateMessageEvent,
  isPrivateMessageEvent,
  type OneBotPrivateMessageEvent,
} from "./types.js";

export interface PrivateTextSender {
  sendPrivateText(userId: number, text: string): Promise<void>;
}

export interface OneBotEventServerOptions {
  host: string;
  port: number;
  path: string;
  accessToken: string;
  allowedUserId: number;
  logger: Logger;
  sender: PrivateTextSender;
  onTextMessage?: (event: OneBotPrivateMessageEvent, text: string) => Promise<void>;
  onSensitiveContent?: (
    event: OneBotPrivateMessageEvent,
    facts: SensitiveNoticeFacts,
  ) => Promise<void>;
}

export function extractRequestToken(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length);
  }

  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  return requestUrl.searchParams.get("access_token") ?? undefined;
}

export function tokensEqual(received: string | undefined, expected: string): boolean {
  if (!received) return false;
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return (
    receivedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(receivedBuffer, expectedBuffer)
  );
}

export async function containMessageError(
  task: Promise<void>,
  onError: (error: unknown) => void,
): Promise<void> {
  try {
    await task;
  } catch (error) {
    onError(error);
  }
}

export function extractPlainText(event: OneBotPrivateMessageEvent): string {
  if (typeof event.raw_message === "string" && event.raw_message.length > 0) {
    return event.raw_message;
  }
  if (typeof event.message === "string") return event.message;
  if (!Array.isArray(event.message)) return "";

  return event.message
    .filter(
      (segment): segment is { type: "text"; data: { text: string } } =>
        Boolean(
          segment &&
            typeof segment === "object" &&
            (segment as { type?: unknown }).type === "text" &&
            typeof (segment as { data?: { text?: unknown } }).data?.text === "string",
        ),
    )
    .map((segment) => segment.data.text)
    .join("");
}

export function hasUserText(event: OneBotPrivateMessageEvent): boolean {
  if (Array.isArray(event.message)) {
    return event.message.some(
      (segment) =>
        Boolean(
          segment &&
            typeof segment === "object" &&
            (segment as { type?: unknown }).type === "text" &&
            typeof (segment as { data?: { text?: unknown } }).data?.text ===
              "string" &&
            (segment as { data: { text: string } }).data.text.trim().length > 0,
        ),
    );
  }
  if (typeof event.message === "string") return event.message.trim().length > 0;
  return false;
}

export function isSelfAuthored(event: OneBotPrivateMessageEvent): boolean {
  const senderId = event.sender?.user_id;
  return senderId !== undefined && String(senderId) === String(event.self_id);
}

export class RecentMessageCache {
  private readonly keys = new Set<string>();
  private readonly order: string[] = [];

  constructor(private readonly capacity = 100) {}

  addIfNew(key: string): boolean {
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    this.order.push(key);
    if (this.order.length > this.capacity) {
      const oldest = this.order.shift();
      if (oldest) this.keys.delete(oldest);
    }
    return true;
  }
}

export class OneBotEventServer {
  private readonly httpServer: Server;
  private readonly webSocketServer = new WebSocketServer({ noServer: true });
  private readonly recentMessages = new RecentMessageCache(100);

  constructor(private readonly options: OneBotEventServerOptions) {
    this.httpServer = createServer();
    this.httpServer.on("upgrade", (request, socket, head) => {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      const authenticated = tokensEqual(
        extractRequestToken(request),
        this.options.accessToken,
      );

      if (pathname !== this.options.path || !authenticated) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        this.options.logger.warn(
          { expectedPath: pathname === this.options.path, authenticated },
          "Rejected OneBot WebSocket upgrade",
        );
        return;
      }

      this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        this.webSocketServer.emit("connection", webSocket, request);
      });
    });

    this.webSocketServer.on("connection", (webSocket) => {
      this.options.logger.info("NapCat reverse WebSocket connected");
      webSocket.on("message", (data, isBinary) => {
        if (isBinary) return;
        void containMessageError(this.handlePayload(data.toString()), (error) => {
          this.options.logger.error(
            { error },
            "Contained OneBot message processing error",
          );
        });
      });
      webSocket.on("close", () => {
        this.options.logger.warn("NapCat reverse WebSocket disconnected");
      });
      webSocket.on("error", (error) => {
        this.options.logger.error({ error }, "NapCat WebSocket error");
      });
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.httpServer.once("error", reject);
      this.httpServer.listen(this.options.port, this.options.host, () => {
        this.httpServer.off("error", reject);
        resolve();
      });
    });
    this.options.logger.info(
      { host: this.options.host, port: this.options.port, path: this.options.path },
      "Bridge reverse WebSocket is listening",
    );
  }

  async stop(): Promise<void> {
    for (const client of this.webSocketServer.clients) {
      if (client.readyState === WebSocket.OPEN) client.close(1001, "Bridge stopping");
    }
    await new Promise<void>((resolve, reject) => {
      this.webSocketServer.close(() => {
        this.httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    });
  }

  isNapCatConnected(): boolean {
    return Array.from(this.webSocketServer.clients).some(
      (client) => client.readyState === WebSocket.OPEN,
    );
  }

  private async handlePayload(payload: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      this.options.logger.warn("Ignored invalid OneBot JSON payload");
      return;
    }

    if (!isPrivateMessageEvent(parsed)) return;
    if (!isAllowedPrivateMessageEvent(parsed, this.options.allowedUserId)) {
      this.options.logger.warn(
        { messageId: parsed.message_id },
        "Ignored private message outside whitelist",
      );
      return;
    }

    const dedupKey = `${parsed.user_id}:${parsed.message_id}`;
    if (!this.recentMessages.addIfNew(dedupKey)) {
      this.options.logger.warn(
        { messageId: parsed.message_id },
        "Ignored duplicate private message",
      );
      return;
    }

    if (isSelfAuthored(parsed)) {
      this.options.logger.info(
        { messageId: parsed.message_id },
        "Ignored self-authored private message",
      );
      return;
    }

    if (!hasUserText(parsed)) {
      this.options.logger.info(
        { messageId: parsed.message_id },
        "Ignored non-text private message",
      );
      return;
    }

    const text = extractPlainText(parsed);
    const sensitive = classifySensitiveContent(text);
    if (sensitive.blocked && sensitive.category) {
      this.options.logger.warn(
        { category: sensitive.category, messageId: parsed.message_id },
        "Sensitive private message blocked before agent processing",
      );
      await this.options.onSensitiveContent?.(
        parsed,
        createSensitiveNoticeFacts(sensitive.category),
      );
      return;
    }

    await this.options.onTextMessage?.(parsed, text);
  }
}
