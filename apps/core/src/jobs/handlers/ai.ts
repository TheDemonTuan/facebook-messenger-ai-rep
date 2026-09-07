import type {
  Database,
  ConversationRepository,
  TurnRepository,
  OutboundRepository,
  SettingsRepository,
  AiConfigRepository,
  IncidentRepository,
  EventRepository,
  OutboxRepository,
  JobRepository,
  JobExecutionContext,
} from "@messenger/db";
import { aiRuns, aiDrafts, ReplyPolicyService, ConversationControlService } from "@messenger/db";
import type { AiReplyGenerator } from "@messenger/ai";
import { buildLeanConversationContext } from "@messenger/ai";
import type { OutboxBroadcaster } from "../../sse/outbox-broadcaster.js";

export interface AiJobPayload {
  channelAccountId: string;
  conversationId: string;
  inboundVersion: number;
  controlEpoch?: number;
  turnId?: string;
}

export interface AiHandlerDeps {
  db: Database;
  convRepo: ConversationRepository;
  turnRepo: TurnRepository;
  outboundRepo: OutboundRepository;
  settingsRepo: SettingsRepository;
  aiConfigRepo: AiConfigRepository;
  incidentRepo: IncidentRepository;
  eventRepo: EventRepository;
  outboxRepo: OutboxRepository;
  broadcaster: OutboxBroadcaster;
  aiGenerator: AiReplyGenerator;
  jobRepo?: JobRepository;
  replyPolicyService?: ReplyPolicyService;
}

export function createAiHandler(deps: AiHandlerDeps) {
  const {
    db,
    convRepo,
    turnRepo,
    outboundRepo,
    settingsRepo,
    aiConfigRepo,
    incidentRepo,
    eventRepo,
    outboxRepo,
    broadcaster,
    aiGenerator,
    jobRepo,
  } = deps;
  const replyPolicyService = deps.replyPolicyService ?? new ReplyPolicyService(db);
  const controlService = new ConversationControlService(db);

  return async function handleAi(context: JobExecutionContext): Promise<void> {
    const payload = context.job.payload as unknown as AiJobPayload;
    const { channelAccountId, conversationId, inboundVersion, controlEpoch, turnId } = payload;

    if (context.signal.aborted) {
      console.warn(`[AiHandler] Job ${context.job.id} aborted before execution`);
      return;
    }

    // 1. Pre-execution check: read conversation state
    const convData = await convRepo.getConversationById(conversationId);
    if (!convData) {
      console.warn(`[AiHandler] Conversation not found: ${conversationId}`);
      return;
    }

    const { conversation, customer } = convData;
    const expectedControlEpoch = controlEpoch ?? conversation.controlEpoch;

    // Older jobs/tests may not carry control columns yet; their existing policy gates remain active.
    if (
      typeof (db as unknown as { select?: unknown }).select === "function" &&
      typeof conversation.controlEpoch === "number" &&
      typeof conversation.replyControlMode === "string" &&
      !(await controlService.canAiReply(conversationId, expectedControlEpoch, inboundVersion))
    ) {
      console.warn(`[AiHandler] Conversation ${conversationId} lost AI reply control before generation.`);
      if (turnId) await turnRepo.cancelTurn(turnId, "Reply control no longer permits AI");
      return;
    }

    // Check version staleness
    if (conversation.inboundVersion !== inboundVersion) {
      console.warn(
        `[AiHandler] Stale job: expected version ${inboundVersion} but conversation is at ${conversation.inboundVersion}. Cancelling.`
      );
      if (turnId) {
        await turnRepo.cancelTurn(turnId, "Inbound version changed during scheduling");
      }
      await eventRepo.recordEvent({
        channelAccountId,
        conversationId,
        type: "AI_CANCELLED_STALE",
        inboundVersion,
        actor: "AI_WORKER",
        payload: {
          jobVersion: inboundVersion,
          actualVersion: conversation.inboundVersion,
        },
      });
      return;
    }

    if (conversation.manualMode || conversation.isBlocked) {
      console.log(
        `[AiHandler] Skipping conversation ${conversationId}: manualMode=${conversation.manualMode}, blocked=${conversation.isBlocked}`
      );
      return;
    }

    // Re-check policy revision & eligibility before AI generation
    const policyResult = await replyPolicyService.recheckEligibility({
      channelAccountId,
      conversationId,
      inboundVersion,
      conversation,
    });

    if (!policyResult.eligible) {
      console.warn(
        `[AiHandler] Inbound v${inboundVersion} for conv ${conversationId} became ineligible before AI generation (${policyResult.reasonCode}): ${policyResult.reason}. Cancelling.`
      );
      if (turnId && typeof turnRepo.cancelTurn === "function") {
        await turnRepo.cancelTurn(turnId, `Policy ineligible: ${policyResult.reason}`);
      }
      await convRepo.updateStatus(conversationId, "WAITING_CUSTOMER");
      await eventRepo.recordEvent({
        channelAccountId,
        conversationId,
        type: "AI_CANCELLED_STALE",
        inboundVersion,
        actor: "AI_WORKER",
        payload: {
          reason: "POLICY_INELIGIBLE",
          reasonCode: policyResult.reasonCode,
          details: policyResult.details,
        },
      });
      return;
    }

    // 2. Claim turn if present
    let claimedTurn = null;
    if (turnId) {
      claimedTurn = await turnRepo.claimTurn(turnId, context.ownerToken);
      if (!claimedTurn) {
        console.warn(
          `[AiHandler] Failed to claim turn ${turnId} for conversation ${conversationId}. Requeueing job.`
        );
        throw new Error(`Turn ${turnId} is still occupied; retry AI job`);
      }
    }
    const currentFencingEpoch = claimedTurn?.fencingEpoch ?? context.fencingEpoch;

    await convRepo.updateStatus(conversationId, "THINKING");
    await eventRepo.recordEvent({
      channelAccountId,
      conversationId,
      type: "AI_STARTED",
      inboundVersion,
      actor: "AI_WORKER",
      payload: { turnId, ownerToken: context.ownerToken },
    });

    // 3. Gather context and generate reply
    const [rawRecentMessages, { settings }, aiConfig] = await Promise.all([
      convRepo.getRecentMessages(conversationId, 30),
      settingsRepo.getSettings(channelAccountId),
      aiConfigRepo.getConfig(channelAccountId),
    ]);

    const { messages: recentMessages, manifest: contextManifest } = buildLeanConversationContext(
      rawRecentMessages,
      {
        customerName: customer.name,
        customerSummary: conversation.summary,
        settings,
      }
    );

    const result = await aiGenerator.generateReply({
      customerName: customer.name,
      customerSummary: conversation.summary,
      recentMessages,
      settings,
    }, {
      apiFormat: aiConfig.apiFormat,
      baseUrl: aiConfig.baseUrl,
      apiKey: aiConfig.apiKey,
      model: aiConfig.model,
      timeoutMs: settings.aiTimeoutMs,
    }, context.signal);

    // 4. Save AI Run record
    const isGuardRejected = !result.success && Boolean(result.errorMessage?.includes("Guard rejection"));
    const runStatus = result.success ? "SUCCESS" : isGuardRejected ? "GUARD_REJECTED" : "ERROR";

    const [runRecord] = await db
      .insert(aiRuns)
      .values({
        channelAccountId,
        conversationId,
        inboundVersion,
        model: result.model,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        totalTokens: result.totalTokens,
        latencyMs: result.latencyMs,
        status: runStatus,
        promptHash: result.promptHash,
        responseHash: result.responseHash || null,
        requestSnapshot: result.requestSnapshot ? { ...result.requestSnapshot, contextManifest } : (contextManifest ? { contextManifest } : null),
        responseSnapshot: result.responseSnapshot || null,
        usedResult: result.usedResult || null,
        parsedOutput: {
          data: result.data
            ? {
                messages: result.data.messages,
                needsClarification: result.data.needsClarification,
              }
            : null,
          messageCount: result.data?.messages?.length || 0,
        },
        errorMessage: result.errorMessage || null,
      })
      .returning();

    // 5. Handle generation failure
    if (!result.success || !result.data) {
      console.error(`[AiHandler] Generation rejected for conversation ${conversationId}: ${result.errorMessage}`);

      await eventRepo.recordEvent({
        channelAccountId,
        conversationId,
        type: "ERROR",
        inboundVersion,
        actor: "AI_WORKER",
        payload: {
          error: result.errorMessage,
          promptHash: result.promptHash,
          responseHash: result.responseHash || null,
        },
      });

      await incidentRepo.createIncident({
        channelAccountId,
        conversationId,
        type: "AI_ERROR",
        title: isGuardRejected ? "AI Draft Guard Rejection" : "AI Gateway Error",
        description: result.errorMessage || "Unknown generation failure",
        metadata: {
          promptHash: result.promptHash,
          responseHash: result.responseHash || null,
          inboundVersion,
          model: result.model,
        },
      });

      if (turnId) {
        await turnRepo.failTurn(
          turnId,
          context.ownerToken,
          currentFencingEpoch,
          result.errorMessage || "AI generation failed"
        );
      }

      await convRepo.updateStatus(conversationId, "ERROR");

      await outboxRepo.enqueue({
        channelAccountId,
        conversationId,
        eventType: "ai:error",
        payload: { conversationId, error: result.errorMessage },
      });

      await broadcaster.broadcast("incident:created", {
        conversationId,
        error: result.errorMessage,
      });

      return;
    }

    // 5.5 Post-generation gate: verify conversation state hasn't moved or entered manual mode
    const postGenConv = await convRepo.getConversationById(conversationId);
    const freshConversation = postGenConv?.conversation;
    if (
      !freshConversation ||
      freshConversation.inboundVersion !== inboundVersion ||
      freshConversation.manualMode ||
      freshConversation.isBlocked ||
      freshConversation.status === "MANUAL"
    ) {
      console.log(
        `[AiHandler] Discarding AI output for conv ${conversationId}: conversation changed during generation (manualMode=${freshConversation?.manualMode}, freshVer=${freshConversation?.inboundVersion}, jobVer=${inboundVersion})`
      );
      await eventRepo.recordEvent({
        channelAccountId,
        conversationId,
        type: "AI_CANCELLED_STALE",
        inboundVersion,
        actor: "AI_WORKER",
        payload: {
          reason: freshConversation?.manualMode ? "HUMAN_TAKEOVER" : "VERSION_MOVED",
          freshVersion: freshConversation?.inboundVersion,
        },
      });
      if (turnId && typeof turnRepo.cancelTurn === "function") {
        await turnRepo.cancelTurn(turnId, "Cancelled due to human takeover or stale version").catch(() => {});
      }
      return;
    }

    // 6. Handle successful generation: save drafts and create outbound actions
    const messagesToDraft = result.data.messages;

    if (runRecord && messagesToDraft.length > 0) {
      await db.insert(aiDrafts).values({
        channelAccountId,
        conversationId,
        aiRunId: runRecord.id,
        inboundVersion,
        messages: messagesToDraft,
      });
    }

    for (let i = 0; i < messagesToDraft.length; i++) {
      const msgText = messagesToDraft[i]!;
      const action = await outboundRepo.createAction({
        channelAccountId,
        conversationId,
        turnId: turnId || undefined,
        inboundVersion,
        responseIndex: i,
        text: msgText,
        actor: "AI",
        claimToken: context.ownerToken,
        fencingToken: currentFencingEpoch,
        controlEpoch: expectedControlEpoch,
      });

      const effectiveFencingEpoch = action?.fencingEpoch ?? action?.fencingToken ?? currentFencingEpoch;

      if (jobRepo && action) {
        await jobRepo.enqueue({
          channelAccountId,
          queue: "browser",
          jobType: "BROWSER_SEND",
          priority: 10,
          maxAttempts: 1,
          payload: {
            actionId: action.actionId,
            channelAccountId,
            conversationId,
            turnId: turnId || undefined,
            externalThreadRef: conversation.externalThreadRef,
            inboundVersion,
            responseIndex: i,
            text: msgText,
            textHash: action.textHash,
            actor: "AI",
            claimToken: action.claimToken || context.ownerToken,
            ownerToken: action.ownerToken || context.ownerToken,
            fencingToken: effectiveFencingEpoch,
            fencingEpoch: effectiveFencingEpoch,
            controlEpoch: expectedControlEpoch,
          },
          idempotencyKey: `browser-send:${action.actionId}`,
        });
      }
    }

    // 7. Update turn and conversation status
    if (turnId) {
      await turnRepo.transitionStatus(
        turnId,
        "THINKING",
        "DRAFT_READY",
        context.ownerToken,
        currentFencingEpoch
      );
    }

    await convRepo.updateStatus(conversationId, "DRAFT_READY");

    await eventRepo.recordEvent({
      channelAccountId,
      conversationId,
      type: "DRAFT_CREATED",
      inboundVersion,
      actor: "AI_WORKER",
      payload: { messageCount: messagesToDraft.length, runId: runRecord?.id },
    });

    await outboxRepo.enqueue({
      channelAccountId,
      conversationId,
      eventType: "outbound:ready",
      payload: {
        conversationId,
        inboundVersion,
        messageCount: messagesToDraft.length,
      },
    });

    await broadcaster.broadcast("conversation:status", {
      conversationId,
      status: "DRAFT_READY",
      inboundVersion,
    });
  };
}
