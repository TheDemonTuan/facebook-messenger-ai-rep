import type { Redis } from "ioredis";
import type { AppQueues, DebounceJobData } from "./queues.js";

export interface DebounceOptions {
  debounceMs?: number;
}

export class DebounceManager {
  constructor(
    private redis: Redis,
    private queues: AppQueues
  ) {}

  /**
   * Registers an inbound message for debounce.
   * Resets any existing debounce timer for this conversation.
   */
  async registerInbound(
    channelAccountId: string,
    conversationId: string,
    inboundVersion: number,
    debounceMs = 3000
  ): Promise<void> {
    const key = `debounce:${channelAccountId}:${conversationId}`;
    
    // Store latest version and set expiration
    await this.redis.set(key, inboundVersion.toString(), "PX", debounceMs);

    // Schedule delayed job to fire after debounceMs
    const jobId = `debounce_${channelAccountId}_${conversationId}_${inboundVersion}`;
    
    // Remove previous delayed job for this conversation if any
    try {
      const existingJob = await this.queues.inboundDebounce.getJob(jobId);
      if (existingJob) {
        await existingJob.remove();
      }
    } catch {
      // Ignore if job was already active or gone
    }

    await this.queues.inboundDebounce.add(
      "check-debounce",
      {
        channelAccountId,
        conversationId,
        inboundVersion,
      },
      {
        jobId,
        delay: debounceMs,
        removeOnComplete: true,
        removeOnFail: true,
      }
    );
  }

  /**
   * Checks if the debounce window has genuinely elapsed for this version without subsequent inbounds.
   */
  async isDebounceExpired(data: DebounceJobData): Promise<boolean> {
    const key = `debounce:${data.channelAccountId}:${data.conversationId}`;
    const currentVal = await this.redis.get(key);

    // If key is gone, it has expired naturally.
    // If key still exists, check if version matches and TTL is 0 or key expired.
    if (!currentVal) {
      return true;
    }

    const currentVersion = parseInt(currentVal, 10);
    if (currentVersion > data.inboundVersion) {
      // Newer inbound message arrived; this job is stale
      return false;
    }

    const ttl = await this.redis.pttl(key);
    // If TTL > 50ms, a timer reset occurred
    return ttl <= 50;
  }
}
