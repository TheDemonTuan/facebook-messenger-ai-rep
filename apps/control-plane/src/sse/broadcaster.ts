import type { FastifyReply } from "fastify";
import type { SseEventEnvelope } from "@messenger/contracts";

export class SseBroadcaster {
  private clients: Set<FastifyReply> = new Set();
  private eventHistory: SseEventEnvelope[] = [];
  private maxHistory: number = 100;
  private nextEventId: number = 1;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.startHeartbeat();
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      for (const client of this.clients) {
        try {
          client.raw.write(": keep-alive\n\n");
        } catch {
          this.clients.delete(client);
        }
      }
    }, 15000);
  }

  addClient(reply: FastifyReply, lastEventId?: string): void {
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.flushHeaders();

    this.clients.add(reply);

    reply.raw.on("close", () => {
      this.clients.delete(reply);
    });

    // Replay missed events if client reconnected with Last-Event-ID
    if (lastEventId) {
      const lastId = parseInt(lastEventId, 10);
      if (!isNaN(lastId)) {
        const missed = this.eventHistory.filter((e) => parseInt(e.id, 10) > lastId);
        for (const ev of missed) {
          reply.raw.write(`id: ${ev.id}\nevent: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
        }
      }
    }
  }

  broadcast(event: string, data: Record<string, unknown>): void {
    const id = (this.nextEventId++).toString();
    const envelope: SseEventEnvelope = {
      id,
      event,
      data,
      timestamp: Date.now(),
    };

    this.eventHistory.push(envelope);
    if (this.eventHistory.length > this.maxHistory) {
      this.eventHistory.shift();
    }

    const payload = `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

    for (const client of this.clients) {
      try {
        client.raw.write(payload);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  close(): void {
    clearInterval(this.heartbeatTimer as NodeJS.Timeout);
    for (const client of this.clients) {
      try {
        client.raw.end();
      } catch {
        // Ignore
      }
    }
    this.clients.clear();
  }
}
