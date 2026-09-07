import { describe, it, expect, vi } from "vitest";
import { createMediaEnrichmentHandler } from "../apps/core/src/jobs/handlers/media-enrichment.js";
import type {
  Database,
  ConversationRepository,
  EventRepository,
  OutboxRepository,
  SettingsRepository,
  JobExecutionContext,
} from "../packages/db/src/index.js";
import type { OutboxBroadcaster } from "../apps/core/src/sse/outbox-broadcaster.js";
import { SystemSettingsDefaults } from "../packages/contracts/src/index.js";

describe("PR-06 Media Enrichment Race Conditions & Fencing Guards", () => {
  it("enriches message parts without triggering stale AI when inboundVersion advances", async () => {
    // Current conversation has moved to version 2 (newer customer message arrived)
    const mockDb = {
      select: vi.fn().mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockImplementation(() => {
              // First call: select conversation (now at v2)
              // Second call: select message
              // Third call: post-fencing select conversation
              return Promise.resolve([
                {
                  id: "conv-1",
                  inboundVersion: 2, // Conversation advanced to 2
                  controlEpoch: 0,
                  replyControlMode: "AUTO",
                  manualMode: false,
                  isBlocked: false,
                  externalMessageId: "mid-1",
                  contentRevision: 1,
                  contentStatus: "PENDING",
                  text: "Xem giúp em cái này",
                  content: {
                    parts: [
                      {
                        type: "IMAGE",
                        media: {
                          mediaId: "mref_old",
                          role: "ATTACHMENT",
                          status: "PENDING",
                          sourceUrl: "https://example.com/fake.jpg",
                        },
                      },
                    ],
                  },
                },
              ]);
            }),
          }),
        }),
      })),
    } as unknown as Database;

    const mockConvRepo = {
      updateMessageEnrichment: vi.fn().mockResolvedValue({
        isUpdated: true,
        contentRevision: 2,
        contentStatus: "READY",
        parts: [],
      }),
    } as unknown as ConversationRepository;

    const mockEventRepo = {
      recordEvent: vi.fn().mockResolvedValue({}),
    } as unknown as EventRepository;

    const mockOutboxRepo = {
      enqueue: vi.fn().mockResolvedValue({}),
    } as unknown as OutboxRepository;

    const mockBroadcaster = {
      broadcast: vi.fn().mockResolvedValue({}),
    } as unknown as OutboxBroadcaster;

    const mockSettingsRepo = {
      getSettings: vi.fn().mockResolvedValue({ settings: SystemSettingsDefaults }),
    } as unknown as SettingsRepository;

    const handler = createMediaEnrichmentHandler({
      db: mockDb,
      convRepo: mockConvRepo,
      eventRepo: mockEventRepo,
      outboxRepo: mockOutboxRepo,
      broadcaster: mockBroadcaster,
      settingsRepo: mockSettingsRepo,
    });

    const context: JobExecutionContext = {
      job: {
        id: "job-enrich-1",
        channelAccountId: "acc-1",
        queue: "media_enrichment",
        jobType: "media_enrichment",
        status: "RUNNING",
        priority: 15,
        attempts: 1,
        maxAttempts: 3,
        fencingEpoch: 0,
        availableAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        payload: {
          channelAccountId: "acc-1",
          conversationId: "conv-1",
          messageId: "msg-1",
          inboundVersion: 1, // Job was scheduled for version 1
        },
      },
      signal: new AbortController().signal,
      ownerToken: "test-owner",
      fencingEpoch: 0,
    };

    await handler(context);

    // Update message enrichment was called to persist enriched media
    expect(mockConvRepo.updateMessageEnrichment).toHaveBeenCalled();
    // Audit event MEDIA_ENRICHED was recorded
    expect(mockEventRepo.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "MEDIA_ENRICHED",
      })
    );
    // Broadcast message:updated was emitted to update UI timeline
    expect(mockBroadcaster.broadcast).toHaveBeenCalledWith(
      "message:updated",
      expect.anything()
    );
  });

  it("skips enrichment when conversation is blocked", async () => {
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                id: "conv-blocked",
                inboundVersion: 1,
                controlEpoch: 0,
                replyControlMode: "AUTO",
                manualMode: false,
                isBlocked: true, // Blocked conversation
              },
            ]),
          }),
        }),
      }),
    } as unknown as Database;

    const mockConvRepo = {
      updateMessageEnrichment: vi.fn(),
    } as unknown as ConversationRepository;

    const handler = createMediaEnrichmentHandler({
      db: mockDb,
      convRepo: mockConvRepo,
      eventRepo: { recordEvent: vi.fn() } as unknown as EventRepository,
      outboxRepo: { enqueue: vi.fn() } as unknown as OutboxRepository,
      broadcaster: { broadcast: vi.fn() } as unknown as OutboxBroadcaster,
      settingsRepo: { getSettings: vi.fn() } as unknown as SettingsRepository,
    });

    await handler({
      job: {
        id: "job-blocked",
        channelAccountId: "acc-1",
        queue: "media_enrichment",
        jobType: "media_enrichment",
        status: "RUNNING",
        priority: 15,
        attempts: 1,
        maxAttempts: 3,
        fencingEpoch: 0,
        availableAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        payload: {
          channelAccountId: "acc-1",
          conversationId: "conv-blocked",
          messageId: "msg-1",
          inboundVersion: 1,
        },
      },
      signal: new AbortController().signal,
      ownerToken: "test-owner",
      fencingEpoch: 0,
    });

    expect(mockConvRepo.updateMessageEnrichment).not.toHaveBeenCalled();
  });
});
