import type {
  Database,
  ConversationRepository,
  OutboundRepository,
  EventRepository,
  SettingsRepository,
  IncidentRepository,
  JobExecutionContext,
  TurnRepository,
  Sql,
} from "@messenger/db";
import { channelAccounts, JobRepository, JobRunner, ReplyPolicyService } from "@messenger/db";
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

  private replyPolicyService: ReplyPolicyService;

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
    customSql?: Sql,
    customPolicyService?: ReplyPolicyService,
    private turnRepo?: TurnRepository
  ) {
    this.jobRepo = customJobRepo || new JobRepository(db);
    this.sql = customSql || null;
    this.replyPolicyService = customPolicyService || new ReplyPolicyService(db);
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
      retryDelaySeconds: 0, // Strictly no retries for browser sending
    });

    const handler = async (ctx: JobExecutionContext) => {
      const payload = ctx.job.payload as unknown as OutboundJobPayload;
      try {
        await this.processAction(payload, ctx);
      } catch (err: unknown) {
        const error = err as Error;
        console.error(`[Sender Worker] Error in processAction for ${payload?.actionId}:`, error?.message || err);
        try {
          if (payload?.actionId) {
            await this.outboundRepo.updateStatus(payload.actionId, "FAILED", {
              errorMessage: error?.message || "Internal sender execution error",
            });
          }
        } catch (updateErr) {
          console.error(`[Sender Worker] Failed to update action status to FAILED:`, updateErr);
        }
      } finally {
        if (typeof this.adapter.releaseSendLock === "function") {
          this.adapter.releaseSendLock();
        }
      }
    };

    this.jobRunner.registerHandler("BROWSER_SEND", handler);
    this.jobRunner.registerHandler("send-action", handler);

    this.jobRunner.registerHandler("DISCOVERY_SEARCH", async (ctx) => {
      const payload = ctx.job.payload as { query?: string };
      const query = payload?.query || "";
      const searchableAdapter = this.adapter as ChannelAdapter & {
        searchRecipients?: (query: string) => Promise<unknown[]>;
      };
      if (typeof searchableAdapter.searchRecipients === "function") {
        const candidates = await searchableAdapter.searchRecipients(query);
        return { candidates };
      }
      return { candidates: [] };
    });

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
      turnId,
    } = data;

    const ownerToken = data.ownerToken || data.claimToken || ctx?.ownerToken || "browser-sender";
    const fencingEpoch = data.fencingEpoch ?? data.fencingToken ?? ctx?.fencingEpoch ?? 0;
    const controlEpoch = data.controlEpoch ?? 0;

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
      if (turnId && this.turnRepo) {
        await this.turnRepo.cancelTurn(turnId, "Channel suspended or degraded").catch(() => {});
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
      if (turnId && this.turnRepo) {
        await this.turnRepo.cancelTurn(turnId, "Stale inbound version").catch(() => {});
      }
      return;
    }

    // Check reply-control epoch and manual takeover for AI actions
    if (
      actor === "AI" &&
      typeof convData.conversation.controlEpoch === "number" &&
      typeof convData.conversation.replyControlMode === "string" &&
      (convData.conversation.controlEpoch !== controlEpoch ||
        convData.conversation.replyControlMode !== "AUTO")
    ) {
      console.warn(`[Sender Worker] Conversation ${conversationId} lost AI reply control (expected epoch ${controlEpoch}, actual ${convData.conversation.controlEpoch}, mode ${convData.conversation.replyControlMode}).`);
      await this.outboundRepo.updateStatus(actionId, "ABORTED", {
        errorMessage: "Conversation reply control changed; AI outbound action cancelled",
        ownerToken,
        fencingEpoch,
      });
      if (turnId && this.turnRepo) {
        await this.turnRepo.cancelTurn(turnId, "Conversation reply control changed").catch(() => {});
      }
      return;
    }

    if (actor === "AI" && convData.conversation.manualMode) {
      console.warn(`[Sender Worker] Conversation ${conversationId} is in manual mode. Aborting AI action.`);
      await this.outboundRepo.updateStatus(actionId, "ABORTED", {
        errorMessage: "Conversation is in manual mode; AI outbound action cancelled",
        ownerToken,
        fencingEpoch,
      });
      if (turnId && this.turnRepo) {
        await this.turnRepo.cancelTurn(turnId, "Manual mode takeover").catch(() => {});
      }
      return;
    }

    // Re-check policy revision & eligibility before typing
    if (actor === "AI") {
      const policyResult = await this.replyPolicyService.recheckEligibility({
        channelAccountId,
        conversationId,
        inboundVersion,
        conversation: convData.conversation,
      });

      if (!policyResult.eligible) {
        console.warn(
          `[Sender Worker] Inbound v${inboundVersion} for conv ${conversationId} became ineligible before typing (${policyResult.reasonCode}): ${policyResult.reason}. Aborting action.`
        );
        if (this.outboundRepo.transitionStatus) {
          await this.outboundRepo
            .transitionStatus(actionId, "PENDING", "CANCELLED", { ownerToken, fencingEpoch })
            .catch(() => {});
        }
        await this.outboundRepo.updateStatus(actionId, "ABORTED", {
          errorMessage: `Policy ineligible: ${policyResult.reason}`,
          ownerToken,
          fencingEpoch,
        });

        await this.eventRepo.recordEvent({
          channelAccountId,
          conversationId,
          type: "AI_CANCELLED_STALE",
          inboundVersion,
          actor: "BROWSER_AGENT",
          payload: { actionId, reason: "POLICY_INELIGIBLE", reasonCode: policyResult.reasonCode },
        });
        if (turnId && this.turnRepo) {
          await this.turnRepo.cancelTurn(turnId, `Policy ineligible: ${policyResult.reason}`).catch(() => {});
        }
        return;
      }
    }

    // Align dynamic business timezone before opening thread/processing
    const settings = await this.settingsRepo.getSettings(channelAccountId);
    if (settings?.settings?.businessTimeZone && typeof this.adapter.setTimeZone === "function") {
      const needsRecreation = this.adapter.setTimeZone(settings.settings.businessTimeZone);
      if (needsRecreation && typeof this.adapter.reinitializeContext === "function") {
        console.log(`[Sender Worker] Aligning browser context timezone to ${settings.settings.businessTimeZone}...`);
        await this.adapter.reinitializeContext();
      }
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

    // 7. Verify version, external activity, and policy right before Enter to guard against late races
    const preSendCheck = await this.convRepo.getConversationById(conversationId);

    if (
      actor === "AI" &&
      typeof this.adapter.checkLastBubbleIsExternalOutbound === "function"
    ) {
      const isExternal = await this.adapter.checkLastBubbleIsExternalOutbound(externalThreadRef);
      if (isExternal) {
        console.warn(
          `[Sender Worker] External human outbound detected in active thread right before Enter! Aborting AI action.`
        );
        await this.adapter.clearComposer();
        this.activeTypings.delete(conversationId);
        cancelAck();

        await this.convRepo.setHumanHold?.(conversationId, 30 * 60 * 1000);
        await this.outboundRepo.updateStatus(actionId, "ABORTED", {
          errorMessage: "External human message appeared in thread right before Enter",
          ownerToken,
          fencingEpoch,
        });

        await this.eventRepo.recordEvent({
          channelAccountId,
          conversationId,
          type: "TYPING_ABORTED",
          inboundVersion,
          actor,
          payload: { actionId, reason: "external_outbound_pre_enter" },
        });
        return;
      }
    }

    if (
      actor === "AI" &&
      preSendCheck &&
      typeof preSendCheck.conversation.controlEpoch === "number" &&
      (preSendCheck.conversation.controlEpoch > controlEpoch ||
        (preSendCheck.conversation.replyControlMode && preSendCheck.conversation.replyControlMode !== "AUTO"))
    ) {
      console.warn(`[Sender Worker] Control epoch moved or human takeover occurred right before send for conv ${conversationId}`);
      await this.adapter.clearComposer();
      this.activeTypings.delete(conversationId);
      cancelAck();

      await this.outboundRepo.updateStatus(actionId, "ABORTED", {
        errorMessage: "Control epoch moved or human takeover pre-enter",
        ownerToken,
        fencingEpoch,
      });

      if (turnId && this.turnRepo) {
        await this.turnRepo.cancelTurn(turnId, "Control epoch moved or human takeover pre-enter").catch(() => {});
      }

      await this.eventRepo.recordEvent({
        channelAccountId,
        conversationId,
        type: "TYPING_ABORTED",
        inboundVersion,
        actor,
        payload: { actionId, reason: "control_epoch_moved_pre_enter" },
      });
      return;
    }

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

      if (turnId && this.turnRepo) {
        await this.turnRepo.cancelTurn(turnId, "New inbound received right before send").catch(() => {});
      }

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

    if (actor === "AI") {
      const preSendPolicy = await this.replyPolicyService.recheckEligibility({
        channelAccountId,
        conversationId,
        inboundVersion,
        conversation: preSendCheck?.conversation ?? convData.conversation,
      });
      if (!preSendPolicy.eligible) {
        console.warn(
          `[Sender Worker] Policy disallowed reply right before send (${preSendPolicy.reasonCode}): ${preSendPolicy.reason}`
        );
        await this.adapter.clearComposer();
        this.activeTypings.delete(conversationId);
        cancelAck();

        await this.outboundRepo.updateStatus(actionId, "ABORTED", {
          errorMessage: `Policy ineligible pre-enter: ${preSendPolicy.reason}`,
          ownerToken,
          fencingEpoch,
        });

        if (turnId && this.turnRepo) {
          await this.turnRepo.cancelTurn(turnId, `Policy ineligible pre-enter: ${preSendPolicy.reason}`).catch(() => {});
        }

        await this.eventRepo.recordEvent({
          channelAccountId,
          conversationId,
          type: "TYPING_ABORTED",
          inboundVersion,
          actor,
          payload: { actionId, reason: "policy_disallowed_pre_enter", reasonCode: preSendPolicy.reasonCode },
        });
        return;
      }
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
      if (turnId && this.turnRepo) {
        if (typeof this.turnRepo.completeTurn === "function") {
          await this.turnRepo.completeTurn(turnId);
        } else {
          await this.turnRepo.transitionStatus(
            turnId,
            "DRAFT_READY",
            "COMPLETED",
            ownerToken,
            fencingEpoch
          );
        }
      }
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

    if (turnId && this.turnRepo) {
      await this.turnRepo.cancelTurn(turnId, "SEND_UNCERTAIN").catch(() => {});
    }

    // Isolate failure to the specific conversation (uses REVIEW_HOLD for SEND_UNCERTAIN via setManualMode)
    // Do NOT suspend the entire channel account for all customers
    if (this.convRepo) {
      if (typeof this.convRepo.setManualMode === "function") {
        await this.convRepo.setManualMode(conversationId, true).catch((err) => {
          console.warn(`[Sender Worker] Failed to set manual mode on conversation ${conversationId}:`, err);
        });
      } else if (typeof this.convRepo.setReviewHold === "function") {
        await this.convRepo.setReviewHold(conversationId, "SEND_UNCERTAIN").catch((err) => {
          console.warn(`[Sender Worker] Failed to set review hold on conversation ${conversationId}:`, err);
        });
      } else if (typeof this.convRepo.updateStatus === "function") {
        await this.convRepo.updateStatus(conversationId, "WAITING_CUSTOMER").catch((err) => {
          console.warn(`[Sender Worker] Failed to update conversation status ${conversationId}:`, err);
        });
      }
    }

    // Create incident
    let outboundActionUuid: string | null = null;
    try {
      const actionRecord = typeof this.outboundRepo.getActionById === "function"
        ? await this.outboundRepo.getActionById(actionId)
        : null;
      if (actionRecord?.id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(actionRecord.id)) {
        outboundActionUuid = actionRecord.id;
      }
    } catch (e) {
      console.warn(`[Sender Worker] Failed to fetch outbound action uuid for ${actionId}:`, e);
    }

    try {
      await this.incidentRepo.createIncident({
        channelAccountId,
        conversationId,
        outboundActionId: outboundActionUuid,
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
        autoSuspendChannel: false,
      });
    } catch (incidentErr) {
      console.error(`[Sender Worker] Failed to create incident for ${actionId}:`, incidentErr);
    }

    // Terminate without retry ("không retry")
  }
}
