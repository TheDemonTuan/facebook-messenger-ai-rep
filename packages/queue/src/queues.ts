import { Queue, type QueueOptions } from "bullmq";
import type { Redis } from "ioredis";
import type { OutboundJobPayload } from "@messenger/contracts";

export const QUEUE_NAMES = {
  AI_JOBS: "ai-jobs",
  BROWSER_ACTIONS: "browser-actions",
  INBOUND_DEBOUNCE: "inbound-debounce",
} as const;

export interface AiJobData {
  channelAccountId: string;
  conversationId: string;
  inboundVersion: number;
  claimToken: string;
  fencingToken: number;
}

export interface DebounceJobData {
  channelAccountId: string;
  conversationId: string;
  inboundVersion: number;
}

export class AppQueues {
  public readonly aiJobs: Queue<AiJobData>;
  public readonly browserActions: Queue<OutboundJobPayload>;
  public readonly inboundDebounce: Queue<DebounceJobData>;

  constructor(redis: Redis) {
    const queueOptions: QueueOptions = {
      connection: redis,
      defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    };

    this.aiJobs = new Queue<AiJobData>(QUEUE_NAMES.AI_JOBS, queueOptions);
    this.browserActions = new Queue<OutboundJobPayload>(QUEUE_NAMES.BROWSER_ACTIONS, queueOptions);
    this.inboundDebounce = new Queue<DebounceJobData>(QUEUE_NAMES.INBOUND_DEBOUNCE, queueOptions);
  }

  async close(): Promise<void> {
    await Promise.all([
      this.aiJobs.close(),
      this.browserActions.close(),
      this.inboundDebounce.close(),
    ]);
  }
}
