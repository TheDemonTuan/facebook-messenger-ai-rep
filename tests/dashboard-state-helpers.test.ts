import { describe, it, expect } from "vitest";
import {
  createTakeoverContext,
  transitionToWaitingCancelAck,
  transitionToManualActive,
  transitionToResuming,
  transitionToAuto,
  canSendManualMessage,
  canInitiateTakeover,
} from "../apps/dashboard/src/helpers/takeover-machine";
import {
  buildInboxQuery,
  mergePaginatedConversations,
  mergePaginatedMessages,
  extractNextCursor,
} from "../apps/dashboard/src/helpers/pagination";
import {
  isSendUncertain,
  isCheckpoint,
  isDomDegraded,
  getIncidentSafetyPolicy,
} from "../apps/dashboard/src/helpers/incident-helpers";
import {
  sanitizeSettingsForSave,
  hasSecretFields,
} from "../apps/dashboard/src/helpers/settings-helpers";
import {
  shouldRefetchInbox,
  shouldRefetchConversationDetail,
  shouldRefetchQueue,
  shouldRefetchIncidents,
  shouldRefetchOverview,
} from "../apps/dashboard/src/helpers/sse-helpers";
import type { ConversationItem, MessageItem, OutboundActionItem, IncidentItem } from "../apps/dashboard/src/types";

describe("Dashboard PostgreSQL Architecture State Helpers", () => {
  describe("1. Takeover State Machine (Takeover -> Wait Cancel Ack -> Manual Composer -> Resume)", () => {
    it("initializes in AUTO mode when manualMode is false, and allows takeover initiation", () => {
      const ctx = createTakeoverContext(false);
      expect(ctx.state).toBe("AUTO");
      expect(ctx.manualMode).toBe(false);
      expect(ctx.cancelAckReceived).toBe(false);
      expect(canInitiateTakeover(ctx)).toBe(true);
      expect(canSendManualMessage(ctx)).toBe(false);
    });

    it("transitions to WAITING_CANCEL_ACK and locks manual sending while waiting for cancel ack", () => {
      let ctx = createTakeoverContext(false);
      ctx = transitionToWaitingCancelAck(ctx);

      expect(ctx.state).toBe("WAITING_CANCEL_ACK");
      expect(ctx.cancelAckReceived).toBe(false);
      expect(canSendManualMessage(ctx)).toBe(false);
      expect(canInitiateTakeover(ctx)).toBe(false);
    });

    it("prevents transition to MANUAL_ACTIVE if any action is still TYPING or SENDING without forceAck", () => {
      let ctx = createTakeoverContext(false);
      ctx = transitionToWaitingCancelAck(ctx);

      const mockActions: OutboundActionItem[] = [
        {
          id: "act-1",
          actionId: "act-1",
          inboundVersion: 1,
          responseIndex: 0,
          text: "Typing reply...",
          actor: "AI",
          status: "TYPING",
          unconfirmedReason: null,
          errorMessage: null,
          createdAt: new Date().toISOString(),
        },
      ];

      // With active typing, stays in WAITING_CANCEL_ACK
      const updated = transitionToManualActive(ctx, { actions: mockActions, forceAck: false });
      expect(updated.state).toBe("WAITING_CANCEL_ACK");
      expect(canSendManualMessage(updated)).toBe(false);
    });

    it("transitions to MANUAL_ACTIVE once cancel ack is confirmed and enables manual composer/send", () => {
      let ctx = createTakeoverContext(false);
      ctx = transitionToWaitingCancelAck(ctx);

      const mockActions: OutboundActionItem[] = [
        {
          id: "act-1",
          actionId: "act-1",
          inboundVersion: 1,
          responseIndex: 0,
          text: "Cancelled",
          actor: "AI",
          status: "ABORTED",
          unconfirmedReason: null,
          errorMessage: null,
          createdAt: new Date().toISOString(),
        },
      ];

      // When actions are aborted or cancel ack confirmed:
      const manualActive = transitionToManualActive(ctx, { actions: mockActions });
      expect(manualActive.state).toBe("MANUAL_ACTIVE");
      expect(manualActive.manualMode).toBe(true);
      expect(manualActive.cancelAckReceived).toBe(true);
      expect(canSendManualMessage(manualActive)).toBe(true);
    });

    it("transitions to RESUMING and back to AUTO when operator releases takeover", () => {
      let ctx = createTakeoverContext(true); // already in manual
      expect(ctx.state).toBe("MANUAL_ACTIVE");

      ctx = transitionToResuming(ctx);
      expect(ctx.state).toBe("RESUMING");
      expect(canSendManualMessage(ctx)).toBe(false);

      ctx = transitionToAuto(ctx);
      expect(ctx.state).toBe("AUTO");
      expect(ctx.manualMode).toBe(false);
      expect(canInitiateTakeover(ctx)).toBe(true);
    });
  });

  describe("2. Cursor Pagination Helpers", () => {
    it("builds cursor query string correctly with cursor or offset", () => {
      expect(buildInboxQuery({ filter: "queued", limit: 20 })).toBe("?filter=queued&limit=20");
      expect(buildInboxQuery({ filter: "all", limit: 20, cursor: "2026-09-05T12:00:00.000Z" })).toBe(
        "?limit=20&cursor=2026-09-05T12%3A00%3A00.000Z"
      );
      expect(buildInboxQuery({ filter: "manual", limit: 10, offset: 30 })).toBe(
        "?filter=manual&limit=10&offset=30"
      );
    });

    it("merges paginated conversations without duplicates and preserves descending order by lastInboundAt", () => {
      const conv1: ConversationItem = {
        conversation: {
          id: "c-1",
          status: "WAITING_CUSTOMER",
          inboundVersion: 1,
          lastInboundAt: "2026-09-05T10:00:00.000Z",
          lastOutboundAt: null,
          unreadCount: 0,
          isBlocked: false,
          manualMode: false,
        },
        customer: { id: "cust-1", name: "Alice", avatarUrl: null },
      };

      const conv2: ConversationItem = {
        conversation: {
          id: "c-2",
          status: "QUEUED",
          inboundVersion: 2,
          lastInboundAt: "2026-09-05T11:00:00.000Z",
          lastOutboundAt: null,
          unreadCount: 1,
          isBlocked: false,
          manualMode: false,
        },
        customer: { id: "cust-2", name: "Bob", avatarUrl: null },
      };

      const conv3: ConversationItem = {
        conversation: {
          id: "c-3",
          status: "MANUAL",
          inboundVersion: 1,
          lastInboundAt: "2026-09-05T09:00:00.000Z",
          lastOutboundAt: null,
          unreadCount: 0,
          isBlocked: false,
          manualMode: true,
        },
        customer: { id: "cust-3", name: "Charlie", avatarUrl: null },
      };

      // Merge [conv2, conv1] with incoming [conv1 (duplicate), conv3]
      const merged = mergePaginatedConversations([conv2, conv1], [conv1, conv3]);

      expect(merged).toHaveLength(3);
      expect(merged[0]?.conversation.id).toBe("c-2"); // 11:00
      expect(merged[1]?.conversation.id).toBe("c-1"); // 10:00
      expect(merged[2]?.conversation.id).toBe("c-3"); // 09:00
    });

    it("merges paginated messages chronologically without duplicates", () => {
      const m1: MessageItem = {
        id: "m-1",
        direction: "INBOUND",
        actor: "SYSTEM",
        text: "Hi",
        inboundVersion: 1,
        responseIndex: 0,
        timestamp: "2026-09-05T10:00:00.000Z",
      };
      const m2: MessageItem = {
        id: "m-2",
        direction: "OUTBOUND",
        actor: "AI",
        text: "Hello!",
        inboundVersion: 1,
        responseIndex: 0,
        timestamp: "2026-09-05T10:01:00.000Z",
      };
      const m0: MessageItem = {
        id: "m-0",
        direction: "INBOUND",
        actor: "SYSTEM",
        text: "Earlier message",
        inboundVersion: 1,
        responseIndex: 0,
        timestamp: "2026-09-05T09:50:00.000Z",
      };

      const merged = mergePaginatedMessages([m1, m2], [m0, m1]);
      expect(merged).toHaveLength(3);
      expect(merged[0]?.id).toBe("m-0");
      expect(merged[1]?.id).toBe("m-1");
      expect(merged[2]?.id).toBe("m-2");
    });

    it("extracts next cursor timestamp when page is full", () => {
      const items = [
        { id: "1", createdAt: "2026-09-05T10:00:00.000Z" },
        { id: "2", createdAt: "2026-09-05T09:00:00.000Z" },
      ];

      expect(extractNextCursor(items, 2, (i) => i.createdAt)).toBe("2026-09-05T09:00:00.000Z");
      // Not enough items for next page:
      expect(extractNextCursor(items, 3, (i) => i.createdAt)).toBeNull();
    });
  });

  describe("3. Incident Safety Guards (SEND_UNCERTAIN / CHECKPOINT / DOM_DEGRADED - No Blind Retry)", () => {
    it("identifies SEND_UNCERTAIN and enforces canBlindRetry = false with safe operator reconciliation", () => {
      const inc: IncidentItem = {
        id: "inc-1",
        type: "SEND_UNCERTAIN",
        title: "Action action-123 entered SEND_UNCERTAIN after Enter was pressed",
        description: "Verification timed out post-Enter",
        metadata: { actionId: "action-123" },
        status: "OPEN",
        createdAt: new Date().toISOString(),
      };

      expect(isSendUncertain(inc)).toBe(true);
      const policy = getIncidentSafetyPolicy(inc);
      expect(policy.category).toBe("SEND_UNCERTAIN");
      expect(policy.canBlindRetry).toBe(false);
      expect(policy.allowedActions).toContain("MARK_SENT");
      expect(policy.allowedActions).toContain("CONFIRM_RETRY");
      expect(policy.warningMessage).toContain("Không tự động thử lại (No blind retry)");
    });

    it("identifies CHECKPOINT and enforces no blind retry, directing to session console", () => {
      const inc: IncidentItem = {
        id: "inc-2",
        type: "CHECKPOINT",
        title: "Facebook account checkpoint detected",
        description: "CAPTCHA or identity check required",
        status: "OPEN",
        createdAt: new Date().toISOString(),
      };

      expect(isCheckpoint(inc)).toBe(true);
      const policy = getIncidentSafetyPolicy(inc);
      expect(policy.category).toBe("CHECKPOINT");
      expect(policy.canBlindRetry).toBe(false);
      expect(policy.allowedActions).toContain("OPEN_CONSOLE");
      expect(policy.allowedActions).toContain("RESUME_CHANNEL");
      expect(policy.warningMessage).toContain("Tuyệt đối không retry tự động");
    });

    it("identifies DOM_DEGRADED and enforces fail-closed safety policy", () => {
      const inc: IncidentItem = {
        id: "inc-3",
        type: "DOM_CHANGED",
        title: "Messenger DOM degraded: missing stable message identity",
        description: "Selector failed",
        status: "OPEN",
        createdAt: new Date().toISOString(),
      };

      expect(isDomDegraded(inc)).toBe(true);
      const policy = getIncidentSafetyPolicy(inc);
      expect(policy.category).toBe("DOM_DEGRADED");
      expect(policy.canBlindRetry).toBe(false);
      expect(policy.allowedActions).toContain("OPEN_CONSOLE");
    });
  });

  describe("4. Settings Stripping & Sanitization (Never expose or send aiBaseUrl / aiApiKey)", () => {
    it("strips aiBaseUrl and aiApiKey from settings output while preserving non-secret config", () => {
      const rawInput = {
        aiModel: "grok-beta",
        aiBaseUrl: "https://secret-proxy.internal.net/v1",
        aiApiKey: "sk-super-secret-production-key",
        debounceMs: 4000,
        stickyWindowMs: 60000,
        stickyMaxTurns: 4,
        stickyMaxDurationMs: 150000,
        typingTargetWpmMin: 90,
        typingTargetWpmMax: 150,
        autoReplyEnabled: true,
        busyMode: false,
      };

      expect(hasSecretFields(rawInput)).toBe(true);

      const sanitized = sanitizeSettingsForSave(rawInput);

      expect(sanitized.aiModel).toBe("grok-beta");
      expect(sanitized.debounceMs).toBe(4000);
      expect(sanitized.stickyWindowMs).toBe(60000);
      expect(sanitized.autoReplyEnabled).toBe(true);

      // Verify secrets are strictly stripped
      expect("aiBaseUrl" in sanitized).toBe(false);
      expect("aiApiKey" in sanitized).toBe(false);
      expect(hasSecretFields(sanitized as Record<string, unknown>)).toBe(false);
    });

    it("clamps numeric values to safe operational ranges", () => {
      const sanitized = sanitizeSettingsForSave({
        debounceMs: 10, // below min 500
        stickyMaxTurns: 50, // above max 10
        typingTargetWpmMin: 5, // below min 20
        typingTargetWpmMax: 500, // above max 300
      });

      expect(sanitized.debounceMs).toBe(500);
      expect(sanitized.stickyMaxTurns).toBe(10);
      expect(sanitized.typingTargetWpmMin).toBe(20);
      expect(sanitized.typingTargetWpmMax).toBe(300);
    });
  });

  describe("5. SSE Event Routing & Wakeup Matching", () => {
    it("routes inbox events accurately", () => {
      expect(shouldRefetchInbox("inbound:received")).toBe(true);
      expect(shouldRefetchInbox("conversation:takeover")).toBe(true);
      expect(shouldRefetchInbox("conversation:manual-send")).toBe(true);
      expect(shouldRefetchInbox("unrelated:event")).toBe(false);
    });

    it("routes conversation detail events matching target conversationId", () => {
      expect(
        shouldRefetchConversationDetail("inbound:received", "conv-1", { conversationId: "conv-1" })
      ).toBe(true);
      // Different conversation ID ignored:
      expect(
        shouldRefetchConversationDetail("inbound:received", "conv-1", { conversationId: "conv-2" })
      ).toBe(false);
      // Outbound transition for same conversation:
      expect(
        shouldRefetchConversationDetail("outbound:transition", "conv-1", { conversationId: "conv-1" })
      ).toBe(true);
    });

    it("routes queue and incident events accurately", () => {
      expect(shouldRefetchQueue("queue:updated")).toBe(true);
      expect(shouldRefetchQueue("outbox:debounce")).toBe(true);
      expect(shouldRefetchIncidents("incident:created")).toBe(true);
      expect(shouldRefetchIncidents("incident:resolved")).toBe(true);
      expect(shouldRefetchIncidents("outbound:uncertain")).toBe(true);
      expect(shouldRefetchOverview("channel:status")).toBe(true);
      expect(shouldRefetchOverview("incident:created")).toBe(true);
    });
  });
});
