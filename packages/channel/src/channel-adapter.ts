import type {
  InboundMessagePayload,
  ChannelHealthReport,
  ActiveConversationRef,
} from "@messenger/contracts";

export interface ChannelAdapter {
  readonly channelAccountId: string;

  /**
   * Start listening for inbound messages. Calls `callback` whenever a message arrives.
   */
  observeInbound(
    callback: (inbound: InboundMessagePayload) => Promise<void>
  ): Promise<void>;

  /**
   * Stop observing inbound.
   */
  stopObserving(): Promise<void>;

  /**
   * Navigate to / open conversation with the given stable thread reference.
   */
  openConversation(threadRef: string): Promise<boolean>;

  /**
   * Get the currently active open conversation ref in the browser DOM.
   */
  getOpenConversationRef(): Promise<ActiveConversationRef | null>;

  /**
   * Type text draft into the active conversation composer.
   * If `signal` is aborted (e.g. newer inbound received), stop immediately.
   */
  typeDraft(
    text: string,
    options?: {
      targetWpmMin?: number;
      targetWpmMax?: number;
      signal?: AbortSignal;
    }
  ): Promise<{ completed: boolean; aborted?: boolean }>;

  /**
   * Clear any draft currently present in the composer.
   */
  clearComposer(): Promise<void>;

  /**
   * Press Enter / click Send in the composer for the active conversation.
   */
  sendDraft(actionId: string): Promise<{ sent: boolean }>;

  /**
   * Verify whether the outgoing message bubble with expected text/hash appears in DOM.
   */
  verifySent(
    expectedText: string,
    expectedHash: string,
    timeoutMs?: number
  ): Promise<{ verified: boolean; messageRef?: string }>;

  /**
   * Run a health check against the channel (DOM locator check, session validity, checkpoints).
   */
  health(): Promise<ChannelHealthReport>;

  /**
   * Clean up resources (e.g. close browser context).
   */
  close(): Promise<void>;
}
