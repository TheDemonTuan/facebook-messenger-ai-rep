import { describe, it, expect } from "vitest";
import {
  buildWorkflowView,
  shortStatus,
  itemNeedsAttention,
  itemIsActive,
  formatTime,
  timestamp,
} from "../apps/dashboard/src/features/workflow/model";
import type { ConversationDetailData, ConversationItem } from "../apps/dashboard/src/types";

function createMockData(overrides?: Partial<ConversationDetailData>): ConversationDetailData {
  const base = new Date("2026-09-07T08:00:00.000Z").getTime();
  const iso = (deltaMs = 0) => new Date(base + deltaMs).toISOString();

  return {
    conversation: {
      id: "conv-test-1",
      channelAccountId: "channel-1",
      customerId: "cust-1",
      externalThreadId: "thread-1",
      inboundVersion: 5,
      lastInboundAt: iso(0),
      lastOutboundAt: null,
      status: "WAITING_CUSTOMER",
      threadKind: "DIRECT",
      title: "Mai Anh",
      isBlocked: false,
      manualMode: false,
      unreadCount: 0,
      ...(overrides?.conversation || {}),
    },
    customer: {
      id: "cust-1",
      name: "Mai Anh",
      avatarUrl: null,
      ...(overrides?.customer || {}),
    },
    messages: overrides?.messages || [
      {
        id: "msg-1",
        direction: "INBOUND",
        actor: "SYSTEM",
        text: "Shop còn mẫu váy này không ạ?",
        inboundVersion: 5,
        responseIndex: 0,
        timestamp: iso(0),
        skipReason: {
          decision: "ELIGIBLE",
          eligible: true,
          reasonCode: "ELIGIBLE",
          reason: "Cho phép trả lời",
          humanReadableReason: "Được phép trả lời tự động",
          precedenceStep: "ELIGIBLE",
        },
      },
    ],
    aiRuns: overrides?.aiRuns || [],
    outboundActions: overrides?.outboundActions || [],
    events: overrides?.events || [
      {
        id: "evt-1",
        type: "INBOUND_RECEIVED",
        inboundVersion: 5,
        actor: "CUSTOMER",
        payload: {},
        createdAt: iso(0),
      },
    ],
  };
}

describe("Workflow Model State Projection Tests", () => {
  it("1. Inbound stage is done when inbound message or INBOUND_RECEIVED event exists", () => {
    const data = createMockData();
    const view = buildWorkflowView(data);
    const inboundStage = view.stages.find((s) => s.id === "inbound");
    expect(inboundStage?.state).toBe("done");
    expect(inboundStage?.evidence).toContain("Đã tải 1 tin");
  });

  it("2. Policy check is done when eligible, warning when ineligible, unknown when missing", () => {
    // Eligible
    const eligibleData = createMockData();
    const eligibleView = buildWorkflowView(eligibleData);
    expect(eligibleView.stages.find((s) => s.id === "policy")?.state).toBe("done");

    // Ineligible
    const ineligibleData = createMockData({
      messages: [
        {
          id: "msg-1",
          direction: "INBOUND",
          actor: "SYSTEM",
          text: "Tin nhắn bị chặn",
          inboundVersion: 5,
          responseIndex: 0,
          timestamp: new Date().toISOString(),
          skipReason: {
            decision: "INELIGIBLE",
            eligible: false,
            reasonCode: "MANUAL_MODE",
            reason: "Nhân viên đang tiếp quản",
            humanReadableReason: "Hội thoại đang ở chế độ nhân viên hỗ trợ",
            precedenceStep: "MANUAL_CHECK",
          },
        },
      ],
    });
    const ineligileView = buildWorkflowView(ineligibleData);
    expect(ineligileView.stages.find((s) => s.id === "policy")?.state).toBe("warning");

    // Missing skipReason
    const missingData = createMockData({
      messages: [
        {
          id: "msg-1",
          direction: "INBOUND",
          actor: "SYSTEM",
          text: "Tin không có skipReason",
          inboundVersion: 5,
          responseIndex: 0,
          timestamp: new Date().toISOString(),
          skipReason: null,
        },
      ],
    });
    const missingView = buildWorkflowView(missingData);
    expect(missingView.stages.find((s) => s.id === "policy")?.state).toBe("unknown");
  });

  it("3. Debounce stage reflects waiting when DEBOUNCING, done when worker started, cancelled when stale", () => {
    // Waiting
    const waitingData = createMockData();
    waitingData.conversation.status = "DEBOUNCING";
    waitingData.events.push({
      id: "evt-deb",
      type: "DEBOUNCE_STARTED",
      inboundVersion: 5,
      actor: "BROWSER_AGENT",
      payload: {},
      createdAt: new Date().toISOString(),
    });
    const waitingView = buildWorkflowView(waitingData);
    expect(waitingView.stages.find((s) => s.id === "debounce")?.state).toBe("waiting");

    // Done
    const doneData = createMockData();
    doneData.events.push(
      {
        id: "evt-deb",
        type: "DEBOUNCE_STARTED",
        inboundVersion: 5,
        actor: "BROWSER_AGENT",
        payload: {},
        createdAt: new Date().toISOString(),
      },
      {
        id: "evt-ai-start",
        type: "AI_STARTED",
        inboundVersion: 5,
        actor: "AI_WORKER",
        payload: {},
        createdAt: new Date().toISOString(),
      }
    );
    const doneView = buildWorkflowView(doneData);
    expect(doneView.stages.find((s) => s.id === "debounce")?.state).toBe("done");

    // Cancelled
    const staleData = createMockData();
    staleData.events.push(
      {
        id: "evt-deb",
        type: "DEBOUNCE_STARTED",
        inboundVersion: 5,
        actor: "BROWSER_AGENT",
        payload: {},
        createdAt: new Date().toISOString(),
      },
      {
        id: "evt-stale",
        type: "AI_CANCELLED_STALE",
        inboundVersion: 5,
        actor: "AI_WORKER",
        payload: {},
        createdAt: new Date().toISOString(),
      }
    );
    const staleView = buildWorkflowView(staleData);
    expect(staleView.stages.find((s) => s.id === "debounce")?.state).toBe("cancelled");
  });

  it("4. AI stage: active on THINKING, done on SUCCESS, error on GUARD_REJECTED / ERROR", () => {
    // Active
    const activeData = createMockData();
    activeData.conversation.status = "THINKING";
    const activeView = buildWorkflowView(activeData);
    expect(activeView.stages.find((s) => s.id === "ai")?.state).toBe("active");

    // Done
    const doneData = createMockData({
      aiRuns: [
        {
          id: "run-1",
          channelAccountId: "channel-1",
          conversationId: "conv-test-1",
          inboundVersion: 5,
          model: "gpt-4o",
          promptTokens: 1000,
          completionTokens: 150,
          totalTokens: 1150,
          latencyMs: 1200,
          status: "SUCCESS",
          parsedOutput: { messageCount: 1 },
          usedResult: { messages: ["Dạ shop còn hàng ạ"] },
          errorMessage: null,
          createdAt: new Date().toISOString(),
        },
      ],
    });
    const doneView = buildWorkflowView(doneData);
    expect(doneView.stages.find((s) => s.id === "ai")?.state).toBe("done");

    // Error
    const errorData = createMockData({
      aiRuns: [
        {
          id: "run-err",
          channelAccountId: "channel-1",
          conversationId: "conv-test-1",
          inboundVersion: 5,
          model: "gpt-4o",
          promptTokens: 1000,
          completionTokens: 0,
          totalTokens: 1000,
          latencyMs: 500,
          status: "GUARD_REJECTED",
          parsedOutput: null,
          usedResult: null,
          errorMessage: "Content policy violated",
          createdAt: new Date().toISOString(),
        },
      ],
    });
    const errorView = buildWorkflowView(errorData);
    expect(errorView.stages.find((s) => s.id === "ai")?.state).toBe("error");
  });

  it("5. Typing stage is active when TYPING, done when sent/confirmed", () => {
    // Active
    const typingData = createMockData({
      outboundActions: [
        {
          id: "act-1",
          actionId: "action-1",
          inboundVersion: 5,
          responseIndex: 0,
          text: "Dạ shop còn màu này ạ",
          actor: "AI",
          status: "TYPING",
          unconfirmedReason: null,
          errorMessage: null,
          createdAt: new Date().toISOString(),
        },
      ],
    });
    const typingView = buildWorkflowView(typingData);
    expect(typingView.stages.find((s) => s.id === "typing")?.state).toBe("active");

    // Done
    const doneData = createMockData({
      aiRuns: [
        {
          id: "run-1",
          channelAccountId: "channel-1",
          conversationId: "conv-test-1",
          inboundVersion: 5,
          model: "gpt-4o",
          promptTokens: 100,
          completionTokens: 20,
          totalTokens: 120,
          latencyMs: 800,
          status: "SUCCESS",
          usedResult: { messages: ["Dạ shop còn hàng ạ"] },
          parsedOutput: { messageCount: 1 },
          errorMessage: null,
          createdAt: new Date().toISOString(),
        },
      ],
      outboundActions: [
        {
          id: "act-1",
          actionId: "action-1",
          inboundVersion: 5,
          responseIndex: 0,
          text: "Dạ shop còn hàng ạ",
          actor: "AI",
          status: "CONFIRMED",
          unconfirmedReason: null,
          errorMessage: null,
          createdAt: new Date().toISOString(),
        },
      ],
    });
    const doneView = buildWorkflowView(doneData);
    expect(doneView.stages.find((s) => s.id === "typing")?.state).toBe("done");
  });

  it("6. Delivery stage is done ONLY when all expected confirmed, warning on SEND_UNCERTAIN", () => {
    // Warning on uncertain
    const uncertainData = createMockData({
      outboundActions: [
        {
          id: "act-1",
          actionId: "action-1",
          inboundVersion: 5,
          responseIndex: 0,
          text: "Dạ shop còn hàng",
          actor: "AI",
          status: "SEND_UNCERTAIN",
          unconfirmedReason: "Timeout waiting for DOM echo",
          errorMessage: null,
          createdAt: new Date().toISOString(),
        },
      ],
    });
    const uncertainView = buildWorkflowView(uncertainData);
    expect(uncertainView.stages.find((s) => s.id === "delivery")?.state).toBe("warning");
    expect(uncertainView.hasUncertain).toBe(true);
    expect(uncertainView.tone).toBe("warning");

    // Done when all confirmed
    const confirmedData = createMockData({
      aiRuns: [
        {
          id: "run-1",
          channelAccountId: "channel-1",
          conversationId: "conv-test-1",
          inboundVersion: 5,
          model: "gpt-4o",
          promptTokens: 100,
          completionTokens: 20,
          totalTokens: 120,
          latencyMs: 800,
          status: "SUCCESS",
          usedResult: { messages: ["Tin 1", "Tin 2"] },
          parsedOutput: { messageCount: 2 },
          errorMessage: null,
          createdAt: new Date().toISOString(),
        },
      ],
      outboundActions: [
        {
          id: "act-1",
          actionId: "action-1",
          inboundVersion: 5,
          responseIndex: 0,
          text: "Tin 1",
          actor: "AI",
          status: "CONFIRMED",
          unconfirmedReason: null,
          errorMessage: null,
          createdAt: new Date().toISOString(),
        },
        {
          id: "act-2",
          actionId: "action-2",
          inboundVersion: 5,
          responseIndex: 1,
          text: "Tin 2",
          actor: "AI",
          status: "SENT",
          unconfirmedReason: null,
          errorMessage: null,
          createdAt: new Date().toISOString(),
        },
      ],
    });
    const confirmedView = buildWorkflowView(confirmedData);
    expect(confirmedView.stages.find((s) => s.id === "delivery")?.state).toBe("done");
    expect(confirmedView.allExpectedConfirmed).toBe(true);
    expect(confirmedView.tone).toBe("done");
  });

  it("7. CRITICAL: AI success alone NEVER implies delivery done", () => {
    // AI succeeded with 2 messages, but 0 actions confirmed
    const data = createMockData({
      aiRuns: [
        {
          id: "run-1",
          channelAccountId: "channel-1",
          conversationId: "conv-test-1",
          inboundVersion: 5,
          model: "gpt-4o",
          promptTokens: 500,
          completionTokens: 50,
          totalTokens: 550,
          latencyMs: 1000,
          status: "SUCCESS",
          usedResult: { messages: ["Tin 1", "Tin 2"] },
          parsedOutput: { messageCount: 2 },
          errorMessage: null,
          createdAt: new Date().toISOString(),
        },
      ],
      outboundActions: [],
    });
    const view = buildWorkflowView(data);
    expect(view.stages.find((s) => s.id === "delivery")?.state).toBe("unknown");
    expect(view.allExpectedConfirmed).toBe(false);
    expect(view.tone).not.toBe("done");
  });

  it("8. Multi-version filtering: filters messages and actions by inboundVersion", () => {
    const data = createMockData({
      messages: [
        {
          id: "msg-v4",
          direction: "INBOUND",
          actor: "SYSTEM",
          text: "Tin cũ ở lượt 4",
          inboundVersion: 4,
          responseIndex: 0,
          timestamp: new Date("2026-09-07T07:00:00Z").toISOString(),
        },
        {
          id: "msg-v5",
          direction: "INBOUND",
          actor: "SYSTEM",
          text: "Tin mới ở lượt 5",
          inboundVersion: 5,
          responseIndex: 0,
          timestamp: new Date("2026-09-07T08:00:00Z").toISOString(),
        },
      ],
    });

    // View for latest version 5
    const viewV5 = buildWorkflowView(data, 5);
    expect(viewV5.messages.length).toBe(1);
    expect(viewV5.messages[0].text).toBe("Tin mới ở lượt 5");
    expect(viewV5.current).toBe(true);

    // View for previous version 4
    const viewV4 = buildWorkflowView(data, 4);
    expect(viewV4.messages.length).toBe(1);
    expect(viewV4.messages[0].text).toBe("Tin cũ ở lượt 4");
    expect(viewV4.current).toBe(false);
    expect(viewV4.title).toContain("Lượt trước #4");
  });

  it("9. Cross-conversation isolation: ignores runs from other conversations", () => {
    const data = createMockData({
      aiRuns: [
        {
          id: "run-other",
          channelAccountId: "channel-1",
          conversationId: "conv-DIFFERENT",
          inboundVersion: 5,
          model: "gpt-4o",
          promptTokens: 100,
          completionTokens: 20,
          totalTokens: 120,
          latencyMs: 500,
          status: "SUCCESS",
          parsedOutput: { messageCount: 1 },
          usedResult: { messages: ["Tin người khác"] },
          errorMessage: null,
          createdAt: new Date().toISOString(),
        },
      ],
    });
    const view = buildWorkflowView(data);
    expect(view.run).toBeNull();
    expect(view.runs.length).toBe(0);
  });

  it("10. Version extraction: extracts and sorts all available versions", () => {
    const data = createMockData({
      messages: [
        {
          id: "m1",
          direction: "INBOUND",
          actor: "SYSTEM",
          text: "m1",
          inboundVersion: 2,
          responseIndex: 0,
          timestamp: new Date().toISOString(),
        },
        {
          id: "m2",
          direction: "INBOUND",
          actor: "SYSTEM",
          text: "m2",
          inboundVersion: 5,
          responseIndex: 0,
          timestamp: new Date().toISOString(),
        },
      ],
      aiRuns: [
        {
          id: "r1",
          channelAccountId: "channel-1",
          conversationId: "conv-test-1",
          inboundVersion: 7,
          model: "gpt-4o",
          promptTokens: 10,
          completionTokens: 10,
          totalTokens: 20,
          latencyMs: 100,
          status: "SUCCESS",
          parsedOutput: null,
          usedResult: null,
          errorMessage: null,
          createdAt: new Date().toISOString(),
        },
      ],
    });
    const view = buildWorkflowView(data);
    expect(view.versions).toEqual([7, 5, 2]);
  });

  it("11. Helpers shortStatus, itemNeedsAttention, itemIsActive", () => {
    expect(shortStatus("THINKING")).toBe("AI đang trả lời");
    expect(shortStatus("MANUAL", true)).toBe("Nhân viên hỗ trợ");
    expect(shortStatus("UNKNOWN_STATUS")).toBe("Chưa rõ trạng thái");

    const activeItem: ConversationItem = {
      conversation: {
        id: "c1",
        status: "TYPING",
        inboundVersion: 1,
        lastInboundAt: null,
        lastOutboundAt: null,
        unreadCount: 0,
        isBlocked: false,
        manualMode: false,
      },
      customer: { id: "cust-1", name: "Test", avatarUrl: null },
    };
    expect(itemIsActive(activeItem)).toBe(true);
    expect(itemNeedsAttention(activeItem)).toBe(false);

    const errorItem: ConversationItem = {
      conversation: {
        id: "c2",
        status: "ERROR",
        inboundVersion: 1,
        lastInboundAt: null,
        lastOutboundAt: null,
        unreadCount: 0,
        isBlocked: false,
        manualMode: false,
      },
      customer: { id: "cust-2", name: "Test", avatarUrl: null },
    };
    expect(itemNeedsAttention(errorItem)).toBe(true);
  });

  it("12. Time formatting and timestamp parsing", () => {
    expect(timestamp("invalid-date")).toBeNull();
    expect(timestamp(null)).toBeNull();
    const valid = new Date("2026-09-07T08:15:30Z");
    expect(timestamp(valid)).toBe(valid.getTime());
    expect(formatTime(valid)).toContain(":");
  });

  it("13. Always sets limited flag to true", () => {
    const data = createMockData();
    const view = buildWorkflowView(data);
    expect(view.limited).toBe(true);
  });
});
