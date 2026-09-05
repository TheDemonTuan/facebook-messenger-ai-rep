import type {
  Database,
  ConversationRepository,
  OutboundRepository,
  EventRepository,
  SettingsRepository,
  IncidentRepository,
  JobExecutionContext,
  Sql,
} from "@messenger/db";
import { channelAccounts, JobRepository, JobRunner } from "@messenger/db";
import { eq } from "drizzle-orm";
import type { ChannelAdapter, PreSendMarker } from "@messenger/channel";
import type { OutboundJobPayload } from "@messenger/contracts";

export interface ActiveTypingEntry {
  abortController: AbortController;
  inboundVersion: number;
  actionId: string;
  cancelAck?: () => void;
}

export class SenderWorkerService {
  private jobRunner: JobRunner | null = null;
  private jobRepo: JobRepository;
  private sql: Sql | null = null;
  private activeTypings = new Map<string, ActiveTypingEntry>();
  private cancelAckCallbacks = new Map<string, Array<() => void>>();

  constructor(
    private db: Database,
    _redisOrUnused: unknown,
    private adapter: ChannelAdapter,
    _leaseOrUnused: unknown,
    private convRepo: ConversationRepository,
    _queueRepoOrUnused: unknown,
    private outboundRepo: OutboundRepository,
    private eventRepo: EventRepository,
    private settingsRepo: SettingsRepository,
    private incidentRepo: IncidentRepository,
    customJobRepo?: JobRepository,
    customSql?: Sql
  ) {
    this.jobRepo = customJobRepo || new JobRepository(db);
    this.sql = customSql || null;
  }

  setSql(sql: Sql): void {
    this.sql = sql;
  }

  /**
   * Register a cancellation listener/acknowledgement callback for an actionId.
   */
  exposeCancelAck(actionId: string, callback: () => void): void {
    const list = this.cancelAckCallbacks.get(actionId) || [];
    list.push(callback);
    this.cancelAckCallbacks.set(actionId, list);
  }

  private triggerCancelAck(actionId: string): void {
    const list = this.cancelAckCallbacks.get(actionId);
    if (list) {
      for (const cb of list) {
        try {
          cb();
        } catch {
          // Cancellation acknowledgments are best-effort callbacks.
        }
      }
      this.cancelAckCallbacks.delete(actionId);
    }
  }

  /**
   * Cancels active typing for a conversation if the incoming inboundVersion is strictly newer.
   */
  cancelActiveTyping(conversationId: string, newerInboundVersion: number): boolean {
    const active = this.activeTypings.get(conversationId);
    if (active && newerInboundVersion > active.inboundVersion) {
      console.log(`[Sender Worker] Aborting active typing for conv ${conversationId} (current ver: ${active.inboundVersion}, new: ${newerInboundVersion})`);
      active.abortController.abort();
      active.cancelAck?.();
      this.triggerCancelAck(active.actionId);
      this.activeTypings.delete(conversationId);
      return true;
    }
    return false;
  }

  start(): void {
    console.log("[Sender Worker] Starting PostgreSQL foundation sender worker with concurrency 1...");

    this.jobRunner = new JobRunner({
      jobRepo: this.jobRepo,
      queues: ["browser", "browser-actions"],
      concurrency: 1, // Single sender execution per channel
      pollIntervalMs: 250,
      leaseDurationSeconds: 60,
      heartbeatIntervalMs: 15000,
    });

    const handler = async (ctx: JobExecutionContext) => {
      const payload = ctx.job.payload as unknown as OutboundJobPayload;
      await this.processAction(payload, ctx);
    };

    this.jobRunner.registerHandler("BROWSER_SEND", handler);
    this.jobRunner.registerHandler("send-action", handler);

    this.jobRunner.start();

    // Listen on PostgreSQL NOTIFY for cancel typing across processes
    if (this.sql && typeof this.sql.listen === "function") {
      this.sql.listen("browser_cancel_typing", (payloadStr: string) => {
        try {
          const data = JSON.parse(payloadStr);
          if (data?.conversationId && typeof data?.inboundVersion === "number") {
            this.cancelActiveTyping(data.conversationId, data.inboundVersion);
          }
        } catch (err) {
          console.warn("[Sender Worker] Failed to parse browser_cancel_typing notification:", err);
        }
      }).catch((err: unknown) => {
        console.warn("[Sender Worker] Error subscribing to browser_cancel_typing:", err);
      });
    }
  }

  async stop(): Promise<void> {
    if (this.jobRunner) {
      await this.jobRunner.stop();
      this.jobRunner = null;
    }
    for (const [, entry] of this.activeTypings) {
      entry.abortController.abort();
    }
    this.activeTypings.clear();
    console.log("[Sender Worker] Worker stopped.");
  }

  async processAction(data: OutboundJobPayload, ctx?: JobExecutionContext): Promise<void> {
    const {
      actionId,
      channelAccountId,
      conversationId,
      externalThreadRef,
      inboundVersion,
      responseIndex,
      text,
      textHash,
      actor,
    } = data;

    const ownerToken = data.ownerToken || data.claimToken || ctx?.ownerToken || "browser-sender";
    const fencingEpoch = data.fencingEpoch ?? data.fencingToken ?? ctx?.fencingEpoch ?? 0;

    console.log(`[Sender Worker] Processing outbound action ${actionId} (conv=${conversationId}, v=${inboundVersion}, actor=${actor})`);

    // 1. Channel Account check: fail-closed if suspended or degraded
    const channelRows = await this.db
      .select({
        id: channelAccounts.id,
        status: channelAccounts.status,
        isSuspended: channelAccounts.isSuspended,
        isPaused: channelAccounts.isPaused,
      })
      .from(channelAccounts)
      .where(eq(channelAccounts.id, channelAccountId))
      .limit(1);

    const channel = channelRows[0];
    if (!channel || channel.isSuspended || channel.status === "SUSPENDED" || channel.status === "DEGRADED") {
      console.warn(`[Sender Worker] Channel account ${channelAccountId} is suspended/degraded. Aborting action ${actionId}`);
      if (this.outboundRepo.transitionStatus) {
        await this.outboundRepo.transitionStatus(actionId, "PENDING", "CANCELLED", { ownerToken, fencingEpoch }).catch(() => {});
      } else {
        await this.outboundRepo.updateStatus(actionId, "ABORTED", {
          errorMessage: "Channel account is suspended or degraded",
          ownerToken,
          fencingEpoch,
        });
      }
      return;
    }

    // 2. Conversation check & Stale inbound version check
    const convData = await this.convRepo.getConversationById(conversationId);
    if (!convData) {
      console.error(`[Sender Worker] Conversation not found: ${conversationId}`);
      return;
    }

    const currentVersion = convData.conversation.inboundVersion;
    if (currentVersion > inboundVersion) {
      console.warn(`[Sender Worker] Inbound version mismatch for ${actionId}: DB has v${currentVersion}, action has v${inboundVersion}. Aborting stale action.`);
      if (this.outboundRepo.transitionStatus) {
        await this.outboundRepo.transitionStatus(actionId, "PENDING", "CANCELLED", { ownerToken, fencingEpoch }).catch(() => {});
      }
      await this.outboundRepo.updateStatus(actionId, "ABORTED", {
        errorMessage: `Stale version: DB is at ${currentVersion}, action was created for ${inboundVersion}`,
        ownerToken,
        fencingEpoch,
      });

      await this.eventRepo.recordEvent({
        channelAccountId,
        conversationId,
        type: "AI_CANCELLED_STALE",
        inboundVersion,
        actor: "BROWSER_AGENT",
        payload: { actionId, expectedVersion: inboundVersion, currentVersion },
      });
      return;
    }

    // Check manual mode takeover for AI actions
    if (actor === "AI" && convData.conversation.manualMode) {
      console.warn(`[Sender Worker] Conversation ${conversationId} is in manual mode. Aborting AI action.`);
      await this.outboundRepo.updateStatus(actionId, "ABORTED", {
        errorMessage: "Conversation is in manual mode; AI outbound action cancelled",
        ownerToken,
        fencingEpoch,
      });
      return;
    }

    // 3. Validate thread navigation in sender page
    const threadOpened = await this.adapter.openConversation(externalThreadRef);
    if (!threadOpened) {
      console.error(`[Sender Worker] Failed to open thread: ${externalThreadRef}`);
      await this.outboundRepo.updateStatus(actionId, "FAILED", {
        errorMessage: `Failed to open conversation thread: ${externalThreadRef}`,
        ownerToken,
        fencingEpoch,
      });
      return;
    }

    // 4. Capture pre-send marker to verify delivery strictly after marker
    let preSendMarker: PreSendMarker | string | undefined;
    if (typeof this.adapter.capturePreSendMarker === "function") {
      preSendMarker = await this.adapter.capturePreSendMarker(externalThreadRef);
    }

    // 5. Transition action state PENDING -> TYPING
    const typingAction = this.outboundRepo.transitionStatus
      ? await this.outboundRepo.transitionStatus(actionId, "PENDING", "TYPING", { ownerToken, fencingEpoch })
      : await this.outboundRepo.updateStatus(actionId, "TYPING", { ownerToken, fencingEpoch });

    if (!typingAction) {
      throw new Error(`Outbound action ${actionId} could not start typing because its state or ownership changed`);
    }

    await this.eventRepo.recordEvent({
      channelAccountId,
      conversationId,
      type: "TYPING_STARTED",
      inboundVersion,
      actor,
      payload: { actionId, responseIndex },
    });

    // Setup local AbortController combined with job context abort signal
    const typingAbortController = new AbortController();
    if (ctx?.signal) {
      ctx.signal.addEventListener("abort", () => typingAbortController.abort(), { once: true });
    }

    let ackCalled = false;
    const cancelAck = () => {
      if (!ackCalled) {
        ackCalled = true;
        this.triggerCancelAck(actionId);
      }
    };

    this.activeTypings.set(conversationId, {
      abortController: typingAbortController,
      inboundVersion,
      actionId,
      cancelAck,
    });

    // 6. Type draft with human-like pacing & abortable signal
    const settings = await this.settingsRepo.getSettings(channelAccountId);
    const typingResult = await this.adapter.typeDraft(text, {
      targetWpmMin: settings.settings.typingTargetWpmMin,
      targetWpmMax: settings.settings.typingTargetWpmMax,
      signal: typingAbortController.signal,
    });

    if (typingResult.aborted) {
      console.warn(`[Sender Worker] Typing was aborted for action ${actionId}`);
      await this.adapter.clearComposer();
      this.activeTypings.delete(conversationId);
      cancelAck();

      await this.outboundRepo.updateStatus(actionId, "ABORTED", {
        errorMessage: "Typing aborted due to newer inbound message or cancellation signal",
        ownerToken,
        fencingEpoch,
      });

      await this.eventRepo.recordEvent({
        channelAccountId,
        conversationId,
        type: "TYPING_ABORTED",
        inboundVersion,
        actor,
        payload: { actionId, reason: "typing_aborted_by_signal" },
      });
      return;
    }

    // 7. Verify version right before Enter to guard against late races
    const preSendCheck = await this.convRepo.getConversationById(conversationId);
    if (preSendCheck && preSendCheck.conversation.inboundVersion > inboundVersion) {
      console.warn(`[Sender Worker] Stale inbound version detected right before send: expected v${inboundVersion}, found v${preSendCheck.conversation.inboundVersion}`);
      await this.adapter.clearComposer();
      this.activeTypings.delete(conversationId);
      cancelAck();

      await this.outboundRepo.updateStatus(actionId, "ABORTED", {
        errorMessage: "New inbound received right before send",
        ownerToken,
        fencingEpoch,
      });

      await this.eventRepo.recordEvent({
        channelAccountId,
        conversationId,
        type: "TYPING_ABORTED",
        inboundVersion,
        actor,
        payload: { actionId, reason: "inbound_bumped_pre_enter" },
      });
      return;
    }

    // 8. Atomic CAS TYPING -> SEND_INTENT immediately before Enter
    let casSendIntentSuccess = true;
    if (this.outboundRepo.transitionStatus) {
      const sendIntentAction = await this.outboundRepo.transitionStatus(
        actionId,
        "TYPING",
        "SEND_INTENT",
        { ownerToken, fencingEpoch }
      );
      if (!sendIntentAction) {
        casSendIntentSuccess = false;
      }
    } else {
      await this.outboundRepo.updateStatus(actionId, "SEND_INTENT", { ownerToken, fencingEpoch });
    }

    if (!casSendIntentSuccess) {
      await this.adapter.clearComposer();
      this.activeTypings.delete(conversationId);
      cancelAck();
      throw new Error(`Outbound action ${actionId} could not enter the send state because its state or ownership changed`);
    }

    await this.eventRepo.recordEvent({
      channelAccountId,
      conversationId,
      type: "SEND_INTENT",
      inboundVersion,
      actor,
      payload: { actionId },
    });

    // 9. Press Enter
    console.log(`[Sender Worker] Pressing Enter for action ${actionId}...`);
    const sendResult = await this.adapter.sendDraft(actionId);
    this.activeTypings.delete(conversationId);

    // 10. Verification: wait for outgoing bubble appearing after preSendMarker
    const verifyTimeoutMs = 10000;
    const verifyResult = await this.adapter.verifySent(
      text,
      textHash,
      preSendMarker,
      verifyTimeoutMs
    );

    if (sendResult.sent && verifyResult.verified && verifyResult.messageRef) {
      // Send CONFIRMED!
      console.log(`[Sender Worker] Message delivery confirmed: ${verifyResult.messageRef}`);
      await this.outboundRepo.confirmSent(actionId, verifyResult.messageRef, { ownerToken, fencingEpoch });

      await this.eventRepo.recordEvent({
        channelAccountId,
        conversationId,
        type: "SEND_CONFIRMED",
        inboundVersion,
        actor,
        payload: { actionId, messageRef: verifyResult.messageRef },
      });

      await this.convRepo.updateStatus(conversationId, "WAITING_CUSTOMER");
      return;
    }

    // 11. Uncertainty after Enter => SEND_UNCERTAIN + suspend + incident, NO RETRY!
    console.error(`[Sender Worker] Outbound action ${actionId} unconfirmed after Enter was pressed! Entering SEND_UNCERTAIN fail-closed.`);

    if (this.outboundRepo.markSendUncertain) {
      await this.outboundRepo.markSendUncertain(
        actionId,
        "Message send could not be verified after Enter key was pressed",
        { ownerToken, fencingEpoch }
      );
    } else {
      await this.outboundRepo.updateStatus(actionId, "SEND_UNCERTAIN", {
        unconfirmedReason: "Message send could not be verified after Enter key was pressed",
        ownerToken,
        fencingEpoch,
      });
    }

    await this.eventRepo.recordEvent({
      channelAccountId,
      conversationId,
      type: "SEND_UNCERTAIN",
      inboundVersion,
      actor,
      payload: { actionId, reason: "verification_timeout_after_enter" },
    });

    // Suspend channel account fail-closed
    await this.db
      .update(channelAccounts)
      .set({
        isSuspended: true,
        status: "SUSPENDED",
        statusReason: `Uncertain outbound delivery for action ${actionId} - suspended pending operator check`,
        updatedAt: new Date(),
      })
      .where(eq(channelAccounts.id, channelAccountId));

    // Create incident
    await this.incidentRepo.createIncident({
      channelAccountId,
      conversationId,
      outboundActionId: actionId,
      type: "SEND_UNCERTAIN",
      title: `Action ${actionId} entered SEND_UNCERTAIN after Enter was pressed`,
      description: "Verification timed out after Enter key was pressed; fail-closed without retry",
      metadata: {
        actionId,
        textHash,
        inboundVersion,
        responseIndex,
        actor,
        error: "Verification timed out post-Enter",
      },
      autoSuspendChannel: true,
    });

    // Terminate without retry ("không retry")
  }
}
