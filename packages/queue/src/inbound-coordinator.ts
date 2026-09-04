import type { InboundMessagePayload } from "@messenger/contracts";
import type { ConversationRepository, EventRepository, SettingsRepository } from "@messenger/db";
import type { DebounceManager } from "./debounce.js";

export class InboundCoordinator {
  constructor(
    private convRepo: ConversationRepository,
    private eventRepo: EventRepository,
    private debounceManager: DebounceManager,
    private settingsRepo: SettingsRepository
  ) {}

  async handleInbound(payload: InboundMessagePayload): Promise<{
    isDuplicate: boolean;
    conversationId: string;
    inboundVersion: number;
    messageId?: string;
  }> {
    // 1. Ingest into DB (handles dedupe, creates customer/conv, bumps version, records message, upserts queue row)
    const result = await this.convRepo.ingestInboundMessage(payload);
    if (result.isDuplicate) {
      return result;
    }

    // 2. Fetch current debounce settings
    const { settings } = await this.settingsRepo.getSettings(payload.channelAccountId);

    // 3. Register debounce timer
    await this.debounceManager.registerInbound(
      payload.channelAccountId,
      result.conversationId,
      result.inboundVersion,
      settings.debounceMs
    );

    // 4. Record event
    await this.eventRepo.recordEvent({
      channelAccountId: payload.channelAccountId,
      conversationId: result.conversationId,
      type: "DEBOUNCE_STARTED",
      inboundVersion: result.inboundVersion,
      actor: "SYSTEM",
      payload: {
        debounceMs: settings.debounceMs,
      },
    });

    return result;
  }
}
