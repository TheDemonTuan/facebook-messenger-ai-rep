import { Worker, type Job } from "bullmq";
import type {
  Database,
  ConversationRepository,
  QueueRepository,
  OutboundRepository,
  EventRepository,
  SettingsRepository,
  IncidentRepository,
} from "@messenger/db";
import { channelAccounts } from "@messenger/db";
import { eq } from "drizzle-orm";
import type { ChannelAdapter } from "@messenger/channel";
import type { OutboundJobPayload } from "@messenger/contracts";
import type { LeaseManager } from "@messenger/queue";
import { QUEUE_NAMES } from "@messenger/queue";
import type { Redis } from "ioredis";

export class SenderWorkerService {
  private worker: Worker<OutboundJobPayload> | null = null;

  constructor(
    private db: Database,
    private redis: Redis,
    private adapter: ChannelAdapter,
    private leaseManager: LeaseManager,
    private convRepo: ConversationRepository,
    private queueRepo: QueueRepository,
    private outboundRepo: OutboundRepository,
    private eventRepo: EventRepository,
    private settingsRepo: SettingsRepository,
    private incidentRepo: IncidentRepository
  ) {}

  start(): void {
    console.log("[Sender Worker] Starting sender worker with concurrency 1...");

    this.worker = new Worker<OutboundJobPayload>(
      QUEUE_NAMES.BROWSER_ACTIONS,
      async (job: Job<OutboundJobPayload>) => {
        await this.processAction(job.data);
      },
      {
        connection: this.redis,
        concurrency: 1, // Strictly single sender execution per account
      }
    );

    this.worker.on("error", (err) => {
      console.error("[Sender Worker] Worker error:", err);
    });
  }

  async stop(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
      this.worker = null;
    }
    console.log("[Sender Worker] Worker stopped.");
  }

  async processAction(data: OutboundJobPayload): Promise<void> {
    const {
      actionId,
      channelAccountId,
      conversationId,
      externalThreadRef,
      inboundVersion,
      responseIndex,
      text,
      textHash,
      claimToken,
    } = data;

    // 1. Acquire sender lease with fencing token
    const senderLockKey = `sender:${channelAccountId}`;
    const lease = await this.leaseManager.acquire(senderLockKey, 45000);
    if (!lease) {
      console.warn(`[Sender Worker] Could not acquire sender lock for channel: ${channelAccountId}`);
      throw new Error("Sender lock unavailable");
    }

    const abortController = new AbortController();

    try {
      // 2. Pre-check: Channel health and active state
      const [channel] = await this.db
        .select()
        .from(channelAccounts)
        .where(eq(channelAccounts.id, channelAccountId))
        .limit(1);

      if (!channel || channel.isSuspended || channel.isPaused || channel.status !== "RUNNING") {
        console.warn(`[Sender Worker] Channel is not RUNNING (${channel?.status}). Aborting action ${actionId}`);
        await this.outboundRepo.updateStatus(actionId, "ABORTED", {
          errorMessage: `Channel status is ${channel?.status || "UNKNOWN"}`,
        });
        return;
      }

      // 3. Pre-check: Conversation inbound version
      const convData = await this.convRepo.getConversationById(conversationId);
      if (!convData || convData.conversation.inboundVersion !== inboundVersion) {
        console.warn(
          `[Sender Worker] Version mismatch for action ${actionId}: job=${inboundVersion}, conv=${convData?.conversation.inboundVersion}. Aborting.`
        );
        await this.outboundRepo.updateStatus(actionId, "ABORTED", {
          errorMessage: "New inbound received before typing",
        });
        await this.adapter.clearComposer();
        return;
      }

      // 4. Update status to TYPING and start typing
      await this.outboundRepo.updateStatus(actionId, "TYPING");
      await this.eventRepo.recordEvent({
        channelAccountId,
        conversationId,
        type: "TYPING_STARTED",
        inboundVersion,
        actor: "BROWSER_AGENT",
        payload: { actionId, responseIndex },
      });

      const opened = await this.adapter.openConversation(externalThreadRef);
      if (!opened) {
        throw new Error(`Failed to navigate to conversation: ${externalThreadRef}`);
      }

      const { settings } = await this.settingsRepo.getSettings(channelAccountId);
      // Wait for debounce to ensure no new inbound is arriving (debounceMs + safety buffer)
      await new Promise((resolve) =>
        setTimeout(resolve, settings.debounceMs + 1500)
      );

      const typingResult = await this.adapter.typeDraft(text, {
        targetWpmMin: settings.typingTargetWpmMin,
        targetWpmMax: settings.typingTargetWpmMax,
        signal: abortController.signal,
      });

      if (typingResult.aborted) {
        console.warn(`[Sender Worker] Typing was aborted for action ${actionId}`);
        await this.outboundRepo.updateStatus(actionId, "ABORTED", {
          errorMessage: "Typing aborted via signal",
        });
        await this.eventRepo.recordEvent({
          channelAccountId,
          conversationId,
          type: "TYPING_ABORTED",
          inboundVersion,
          actor: "BROWSER_AGENT",
          payload: { actionId },
        });
        await this.adapter.clearComposer();
        return;
      }

      // 5. Final check immediately before Send
      const preSendConv = await this.convRepo.getConversationById(conversationId);
      if (!preSendConv) {
        throw new Error("Conversation disappeared before send");
      }
      if (preSendConv.conversation.inboundVersion !== inboundVersion) {
        console.warn(`[Sender Worker] Aborting immediately before send: new inbound received!`);
        await this.outboundRepo.updateStatus(actionId, "ABORTED", {
          errorMessage: "New inbound received right before send",
        });
        await this.adapter.clearComposer();
        return;
      }

      // 6. Send
      await this.outboundRepo.updateStatus(actionId, "SENDING");
      await this.eventRepo.recordEvent({
        channelAccountId,
        conversationId,
        type: "SEND_STARTED",
        inboundVersion,
        actor: "BROWSER_AGENT",
        payload: { actionId },
      });

      const sendResult = await this.adapter.sendDraft(actionId);
      if (!sendResult.sent) {
        throw new Error(`Browser adapter sendDraft returned false for action ${actionId}`);
      }

      // 7. Post-send verification
      const verifyResult = await this.adapter.verifySent(text, textHash, 12000);

      if (verifyResult.verified) {
        console.log(`[Sender Worker] Outbound action ${actionId} confirmed sent successfully.`);
        await this.outboundRepo.confirmSent(actionId, verifyResult.messageRef);
        await this.eventRepo.recordEvent({
          channelAccountId,
          conversationId,
          type: "SEND_CONFIRMED",
          inboundVersion,
          actor: "BROWSER_AGENT",
          payload: { actionId, messageRef: verifyResult.messageRef },
        });

        // Release conversation back to waiting customer or queue
        await this.queueRepo.release(conversationId, claimToken, {
          nextStatus: "WAITING_CUSTOMER",
          stickyWindowMs: settings.stickyWindowMs,
          keepInQueueForReply: true,
        });

        await this.eventRepo.recordEvent({
          channelAccountId,
          conversationId,
          type: "CONVERSATION_RELEASED",
          inboundVersion,
          actor: "BROWSER_AGENT",
          payload: { nextStatus: "WAITING_CUSTOMER" },
        });
      } else {
        // UNCONFIRMED SEND -> Trigger Circuit Breaker
        console.error(`[Sender Worker] Outbound action ${actionId} UNCONFIRMED. Suspending channel.`);
        await this.outboundRepo.updateStatus(actionId, "UNCONFIRMED", {
          unconfirmedReason: "Outgoing bubble could not be verified in DOM within timeout",
        });

        await this.eventRepo.recordEvent({
          channelAccountId,
          conversationId,
          type: "SEND_UNCONFIRMED",
          inboundVersion,
          actor: "BROWSER_AGENT",
          payload: { actionId },
        });

        // Auto-suspend channel and create incident
        await this.incidentRepo.createIncident({
          channelAccountId,
          conversationId,
          outboundActionId: actionId,
          type: "UNCONFIRMED_SEND",
          title: "Unconfirmed Message Send",
          description: `Message "${text.slice(0, 40)}..." was typed and sent, but outgoing bubble confirmation failed. Channel is suspended to prevent duplicate sends.`,
          autoSuspendChannel: true,
        });
      }
    } finally {
      await this.leaseManager.release(senderLockKey, lease.token);
    }
  }
}
