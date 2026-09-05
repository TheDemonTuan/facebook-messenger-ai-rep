import type { ChannelAdapter, PreSendMarker } from "./channel-adapter.js";
import {
  isValidTimeZone,
  resolveBusinessTimeZone,
  type InboundMessagePayload,
  type ChannelHealthReport,
  type ActiveConversationRef,
} from "@messenger/contracts";
import { createHash } from "node:crypto";

export interface MockSentMessage {
  text: string;
  hash: string;
  actionId: string;
  messageRef: string;
  timestamp: Date;
}

export class MockChannelAdapter implements ChannelAdapter {
  readonly channelAccountId: string;
  public timeZone: string = "Asia/Ho_Chi_Minh";
  public activeContextTimeZone: string = "Asia/Ho_Chi_Minh";
  public contextRecreationCount: number = 0;
  private inboundCallback: ((inbound: InboundMessagePayload) => Promise<void>) | null = null;
  private degradedCallback: ((reason: string) => Promise<void>) | null = null;
  public currentOpenRef: ActiveConversationRef | null = null;
  public composerText: string = "";
  public sentMessages: MockSentMessage[] = [];
  public isHealthy: boolean = true;
  public checkpointTriggered: boolean = false;
  public rateLimitTriggered: boolean = false;
  public domError: boolean = false;
  public simulateSendDelayMs: number = 0;
  public simulateCrashAfterEnter: boolean = false;
  public simulateDegradedDom: boolean = false;
  public abortOnType: boolean = false;

  constructor(channelAccountId = "personal-messenger") {
    this.channelAccountId = channelAccountId;
  }

  setTimeZone(timeZone: string): boolean {
    if (!isValidTimeZone(timeZone)) {
      return false;
    }
    const normalized = resolveBusinessTimeZone(timeZone);
    this.timeZone = normalized;
    if (this.activeContextTimeZone !== normalized) {
      return true;
    }
    return false;
  }

  async reinitializeContext(timeZone?: string): Promise<void> {
    if (timeZone && isValidTimeZone(timeZone)) {
      this.timeZone = resolveBusinessTimeZone(timeZone);
    }
    this.activeContextTimeZone = this.timeZone;
    this.contextRecreationCount++;
  }

  getActiveContextTimeZone(): string {
    return this.activeContextTimeZone;
  }

  async observeInbound(
    callback: (inbound: InboundMessagePayload) => Promise<void>
  ): Promise<void> {
    this.inboundCallback = callback;
  }

  async stopObserving(): Promise<void> {
    this.inboundCallback = null;
  }

  onDegradedDom(callback: (reason: string) => Promise<void>): void {
    this.degradedCallback = callback;
  }

  async triggerDegradedDom(reason: string): Promise<void> {
    this.domError = true;
    if (this.degradedCallback) {
      await this.degradedCallback(reason);
    }
  }

  /**
   * Helper for tests to simulate an inbound message arriving from customer.
   */
  async simulateInbound(payload: Omit<InboundMessagePayload, "channelAccountId">): Promise<void> {
    if (this.simulateDegradedDom) {
      await this.triggerDegradedDom("Simulated degraded DOM on message arrival");
      return;
    }
    if (this.inboundCallback) {
      await this.inboundCallback({
        ...payload,
        channelAccountId: this.channelAccountId,
      });
    }
  }

  async openConversation(threadRef: string): Promise<boolean> {
    const threadId = threadRef.split("/").pop() || threadRef;
    this.currentOpenRef = {
      externalThreadId: threadId,
      externalThreadRef: threadRef,
      externalCustomerId: "mock-cust-" + threadId,
      customerName: "Mock Customer " + threadId,
    };
    return true;
  }

  async getOpenConversationRef(): Promise<ActiveConversationRef | null> {
    return this.currentOpenRef;
  }

  async capturePreSendMarker(threadRef?: string): Promise<PreSendMarker> {
    const ref = threadRef || this.currentOpenRef?.externalThreadRef || "default";
    const knownIds = this.sentMessages.map((m) => m.messageRef);
    const lastId = knownIds.length > 0 ? knownIds[knownIds.length - 1]! : null;
    return {
      threadRef: ref,
      knownMessageIds: [...knownIds],
      lastMessageId: lastId,
      messageCount: this.sentMessages.length,
      capturedAt: new Date(),
    };
  }

  async typeDraft(
    text: string,
    options?: { targetWpmMin?: number; targetWpmMax?: number; signal?: AbortSignal }
  ): Promise<{ completed: boolean; aborted?: boolean }> {
    if (options?.signal?.aborted || this.abortOnType) {
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
    const textHash = createHash("sha256").update(text.trim()).digest("hex");
    const stableRef = `mid.$mock_${textHash.slice(0, 16)}_${this.sentMessages.length + 1}`;

    this.sentMessages.push({
      text,
      hash: textHash,
      actionId,
      messageRef: stableRef,
      timestamp: new Date(),
    });
    this.composerText = "";
    return { sent: true };
  }

  async verifySent(
    expectedText: string,
    expectedHash: string,
    marker?: PreSendMarker | string,
    _timeoutMs?: number
  ): Promise<{ verified: boolean; messageRef?: string }> {
    if (this.simulateCrashAfterEnter) {
      // Simulate post-Enter uncertainty where confirmation cannot be verified
      return { verified: false };
    }

    const normExpected = expectedText.trim();
    let eligible = this.sentMessages;

    if (marker && typeof marker === "object" && marker.knownMessageIds) {
      eligible = this.sentMessages.filter((m) => !marker.knownMessageIds.includes(m.messageRef));
    }

    const found = eligible.find(
      (m) => m.text.trim() === normExpected || (expectedHash && m.hash === expectedHash)
    );

    if (found) {
      return { verified: true, messageRef: found.messageRef };
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
    this.degradedCallback = null;
    this.currentOpenRef = null;
  }
}
