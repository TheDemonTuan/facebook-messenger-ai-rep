import type { FastifyReply } from "fastify";
import type { OutboxRepository } from "@messenger/db";
import type { SseEventEnvelope } from "@messenger/contracts";

export class OutboxBroadcaster {
  private clients = new Set<FastifyReply>();
  private inMemoryHistory: SseEventEnvelope[] = [];
  private maxHistory = 200;
  private nextEventId = 1;
  private heartbeatInterval: NodeJS.Timeout | null = null;

  constructor(private outboxRepo?: OutboxRepository) {
    this.startHeartbeat();
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      const pingComment = ": ping\n\n";
      for (const client of this.clients) {
        try {
          if (!client.raw.destroyed && client.raw.writable) {
            client.raw.write(pingComment);
          }
        } catch {
          this.clients.delete(client);
        }
      }
    }, 15000);

    if (this.heartbeatInterval.unref) {
      this.heartbeatInterval.unref();
    }
  }

  async addClient(
    reply: FastifyReply,
    options: { lastEventId?: string; channelAccountId?: string } = {}
  ): Promise<void> {
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");
    reply.raw.flushHeaders();

    this.clients.add(reply);

    reply.raw.on("close", () => {
      this.clients.delete(reply);
    });

    reply.raw.on("error", () => {
      this.clients.delete(reply);
    });

    // Replay missed events if client reconnected with lastEventId
    if (options.lastEventId) {
      await this.replayMissedEvents(reply, options.lastEventId, options.channelAccountId);
    }
  }

  private async replayMissedEvents(
    reply: FastifyReply,
    lastEventId: string,
    channelAccountId?: string
  ): Promise<void> {
    // 1. Try in-memory buffer first
    const lastNum = parseInt(lastEventId, 10);
    if (!isNaN(lastNum)) {
      const missed = this.inMemoryHistory.filter((e) => parseInt(e.id, 10) > lastNum);
      for (const ev of missed) {
        await this.writeToClient(
          reply,
          `id: ${ev.id}\nevent: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`
        );
      }
      return;
    }

    // 2. Query outbox repo if UUID cursor is provided
    if (this.outboxRepo && channelAccountId) {
      try {
        const events = await this.outboxRepo.getEventsSince(channelAccountId, lastEventId, 50);
        for (const ev of events) {
          await this.writeToClient(
            reply,
            `id: ${ev.id}\nevent: ${ev.eventType}\ndata: ${JSON.stringify(ev.payload)}\n\n`
          );
        }
      } catch (err) {
        console.warn("[OutboxBroadcaster] Failed to replay outbox events:", err);
      }
    }
  }

  private async writeToClient(client: FastifyReply, payload: string): Promise<boolean> {
    if (client.raw.destroyed || !client.raw.writable) {
      this.clients.delete(client);
      return false;
    }

    const canWrite = client.raw.write(payload);
    if (!canWrite) {
      // Handle backpressure
      await new Promise<void>((resolve) => {
        const onDrain = () => {
          client.raw.removeListener("close", onClose);
          resolve();
        };
        const onClose = () => {
          client.raw.removeListener("drain", onDrain);
          this.clients.delete(client);
          resolve();
        };
        client.raw.once("drain", onDrain);
        client.raw.once("close", onClose);
      });
    }
    return true;
  }

  async broadcast(
    event: string,
    data: Record<string, unknown>,
    eventId?: string
  ): Promise<void> {
    const id = eventId || (this.nextEventId++).toString();
    const envelope: SseEventEnvelope = {
      id,
      event,
      data,
      timestamp: Date.now(),
    };

    this.inMemoryHistory.push(envelope);
    if (this.inMemoryHistory.length > this.maxHistory) {
      this.inMemoryHistory.shift();
    }

    const payload = `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

    const promises: Promise<boolean>[] = [];
    for (const client of this.clients) {
      promises.push(this.writeToClient(client, payload));
    }
    await Promise.all(promises);
  }

  get connectedClientsCount(): number {
    return this.clients.size;
  }

  stop(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    for (const client of this.clients) {
      try {
        client.raw.end();
      } catch {
        /* ignore error during client disconnect */
      }
    }
    this.clients.clear();
  }
}
