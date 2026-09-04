import type { ChannelAdapter } from "./channel-adapter.js";
import type {
  InboundMessagePayload,
  ChannelHealthReport,
  ActiveConversationRef,
} from "@messenger/contracts";

export class MockChannelAdapter implements ChannelAdapter {
  readonly channelAccountId: string;
  private inboundCallback: ((inbound: InboundMessagePayload) => Promise<void>) | null = null;
  public currentOpenRef: ActiveConversationRef | null = null;
  public composerText: string = "";
  public sentMessages: Array<{ text: string; hash: string; actionId: string; timestamp: Date }> = [];
  public isHealthy: boolean = true;
  public checkpointTriggered: boolean = false;
  public rateLimitTriggered: boolean = false;
  public domError: boolean = false;
  public simulateSendDelayMs: number = 50;

  constructor(channelAccountId = "personal-messenger") {
    this.channelAccountId = channelAccountId;
  }

  async observeInbound(
    callback: (inbound: InboundMessagePayload) => Promise<void>
  ): Promise<void> {
    this.inboundCallback = callback;
  }

  async stopObserving(): Promise<void> {
    this.inboundCallback = null;
  }

  /**
   * Helper for tests to simulate an inbound message arriving from customer.
   */
  async simulateInbound(payload: Omit<InboundMessagePayload, "channelAccountId">): Promise<void> {
    if (this.inboundCallback) {
      await this.inboundCallback({
        ...payload,
        channelAccountId: this.channelAccountId,
      });
    }
  }

  async openConversation(threadRef: string): Promise<boolean> {
    this.currentOpenRef = {
      externalThreadId: threadRef.split("/").pop() || threadRef,
      externalThreadRef: threadRef,
      externalCustomerId: "mock-cust-" + threadRef,
      customerName: "Mock Customer " + threadRef,
    };
    return true;
  }

  async getOpenConversationRef(): Promise<ActiveConversationRef | null> {
    return this.currentOpenRef;
  }

  async typeDraft(
    text: string,
    options?: { targetWpmMin?: number; targetWpmMax?: number; signal?: AbortSignal }
  ): Promise<{ completed: boolean; aborted?: boolean }> {
    if (options?.signal?.aborted) {
      return { completed: false, aborted: true };
    }
    this.composerText = text;
    return { completed: true };
  }

  async clearComposer(): Promise<void> {
    this.composerText = "";
  }

  async sendDraft(actionId: string): Promise<{ sent: boolean }> {
    if (!this.composerText) {
      return { sent: false };
    }
    const text = this.composerText;
    this.sentMessages.push({
      text,
      hash: "hash-" + Buffer.from(text).toString("hex").slice(0, 8),
      actionId,
      timestamp: new Date(),
    });
    this.composerText = "";
    return { sent: true };
  }

  async verifySent(
    expectedText: string,
    expectedHash: string,
    _timeoutMs?: number
  ): Promise<{ verified: boolean; messageRef?: string }> {
    const found = this.sentMessages.find(
      (m) => m.text.trim() === expectedText.trim()
    );
    if (found) {
      return { verified: true, messageRef: "mock-msg-" + Date.now() };
    }
    return { verified: false };
  }

  async health(): Promise<ChannelHealthReport> {
    const isOk = this.isHealthy && !this.checkpointTriggered && !this.rateLimitTriggered && !this.domError;
    return {
      healthy: isOk,
      status: isOk ? "RUNNING" : "SUSPENDED",
      domOk: !this.domError,
      sessionActive: !this.checkpointTriggered,
      checkpointDetected: this.checkpointTriggered,
      rateLimitDetected: this.rateLimitTriggered,
      errorMessage: isOk ? null : "Mock channel reported unhealthy state",
      timestamp: new Date(),
    };
  }

  async close(): Promise<void> {
    this.inboundCallback = null;
    this.currentOpenRef = null;
  }
}
