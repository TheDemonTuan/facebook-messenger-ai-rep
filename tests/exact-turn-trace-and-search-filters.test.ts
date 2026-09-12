import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import { createInboxRoutes } from "../apps/core/src/routes/inbox.js";
import { createAdminRoutes } from "../apps/core/src/routes/admin.js";
import type {
  Database,
  ConversationRepository,
  QueueRepository,
  OutboundRepository,
  EventRepository,
  OutboxRepository,
  SettingsRepository,
  AiConfigRepository,
  IncidentRepository,
  JobRepository,
} from "@messenger/db";
import type { OutboxBroadcaster } from "../apps/core/src/sse/outbox-broadcaster.js";

describe("Exact-Turn Trace & Server-Side Search/Filter Tests", () => {
  const channelAccountId = "personal-messenger";
  const conversationId = "11111111-1111-4111-8111-111111111111";

  describe("Exact-Turn Trace Endpoint: GET /api/inbox/:conversationId/turns/:version/trace", () => {
    it("returns 400 when version is not a valid positive integer", async () => {
      const fastify = Fastify();
      await fastify.register(
        createInboxRoutes({
          db: {} as unknown as Database,
          convRepo: {} as unknown as ConversationRepository,
          queueRepo: {} as unknown as QueueRepository,
          outboundRepo: {} as unknown as OutboundRepository,
          eventRepo: {} as unknown as EventRepository,
          outboxRepo: {} as unknown as OutboxRepository,
          broadcaster: { broadcast: vi.fn() } as unknown as OutboxBroadcaster,
          requireAuth: async () => ({
            id: "u-1",
            email: "admin@example.com",
            role: "OPERATOR",
          }),
          channelAccountId,
        })
      );

      const res = await fastify.inject({
        method: "GET",
        url: `/api/inbox/${conversationId}/turns/abc/trace`,
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload)).toHaveProperty("error");
    });

    it("returns 404 when conversation is not found", async () => {
      const mockDb = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(async () => []),
            })),
          })),
        })),
      };

      const fastify = Fastify();
      await fastify.register(
        createInboxRoutes({
          db: mockDb as unknown as Database,
          convRepo: {} as unknown as ConversationRepository,
          queueRepo: {} as unknown as QueueRepository,
          outboundRepo: {} as unknown as OutboundRepository,
          eventRepo: {} as unknown as EventRepository,
          outboxRepo: {} as unknown as OutboxRepository,
          broadcaster: { broadcast: vi.fn() } as unknown as OutboxBroadcaster,
          requireAuth: async () => ({
            id: "u-1",
            email: "admin@example.com",
            role: "OPERATOR",
          }),
          channelAccountId,
        })
      );

      const res = await fastify.inject({
        method: "GET",
        url: `/api/inbox/${conversationId}/turns/1/trace`,
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns comprehensive trace with turn, messages, runs, drafts, actions, events and completeness", async () => {
      const mockConv = [{ id: conversationId, channelAccountId }];
      const mockInbound = [
        {
          id: "inb-1",
          conversationId,
          inboundVersion: 2,
          text: "Áo này còn size L không shop?",
          receivedAt: new Date("2026-09-10T10:00:00Z"),
        },
      ];
      const mockTurn = [
        {
          id: "turn-2",
          conversationId,
          inboundVersion: 2,
          status: "DRAFT_READY",
        },
      ];
      const mockRun = [
        {
          id: "run-201",
          conversationId,
          inboundVersion: 2,
          status: "SUCCESS",
          model: "grok-4.5",
          requestSnapshot: { prompt: "test prompt", apiKey: "sk-secret" },
          responseSnapshot: { content: "Dạ còn bạn nhé!" },
          usedResult: { messages: ["Dạ còn bạn nhé!"] },
          createdAt: new Date("2026-09-10T10:00:05Z"),
        },
      ];
      const mockDraft = [
        {
          id: "draft-1",
          conversationId,
          inboundVersion: 2,
          aiRunId: "run-201",
          messages: ["Dạ còn bạn nhé!"],
          createdAt: new Date("2026-09-10T10:00:06Z"),
        },
      ];
      const mockAction = [
        {
          id: "act-1",
          conversationId,
          inboundVersion: 2,
          sourceAiRunId: "run-201",
          responseIndex: 0,
          text: "Dạ còn bạn nhé!",
          status: "CONFIRMED",
          createdAt: new Date("2026-09-10T10:00:07Z"),
        },
      ];
      const mockEvents = [
        {
          id: "ev-1",
          conversationId,
          type: "turn:completed",
          createdAt: new Date("2026-09-10T10:00:08Z"),
        },
      ];

      let queryCount = 0;
      const mockDb = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => {
              queryCount++;
              if (queryCount === 1) {
                // Conversation existence check
                return { limit: vi.fn(async () => mockConv) };
              }
              if (queryCount === 2) {
                // inboundMessages
                return { orderBy: vi.fn(async () => mockInbound) };
              }
              if (queryCount === 3) {
                // turns
                return { limit: vi.fn(async () => mockTurn) };
              }
              if (queryCount === 4) {
                // aiRuns
                return { orderBy: vi.fn(async () => mockRun) };
              }
              if (queryCount === 5) {
                // aiDrafts
                return { orderBy: vi.fn(async () => mockDraft) };
              }
              if (queryCount === 6) {
                // outboundActions
                return { orderBy: vi.fn(async () => mockAction) };
              }
              // conversationEvents
              return { orderBy: vi.fn(() => ({ limit: vi.fn(async () => mockEvents) })) };
            }),
          })),
        })),
      };

      const fastify = Fastify();
      await fastify.register(
        createInboxRoutes({
          db: mockDb as unknown as Database,
          convRepo: {} as unknown as ConversationRepository,
          queueRepo: {} as unknown as QueueRepository,
          outboundRepo: {} as unknown as OutboundRepository,
          eventRepo: {} as unknown as EventRepository,
          outboxRepo: {} as unknown as OutboxRepository,
          broadcaster: { broadcast: vi.fn() } as unknown as OutboxBroadcaster,
          requireAuth: async () => ({
            id: "u-1",
            email: "admin@example.com",
            role: "OPERATOR",
          }),
          channelAccountId,
        })
      );

      const res = await fastify.inject({
        method: "GET",
        url: `/api/inbox/${conversationId}/turns/2/trace`,
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.payload);
      expect(data.conversationId).toBe(conversationId);
      expect(data.inboundVersion).toBe(2);
      expect(data.inboundMessages).toHaveLength(1);
      expect(data.turn).not.toBeNull();
      expect(data.aiRuns).toHaveLength(1);
      expect(data.drafts).toHaveLength(1);
      expect(data.outboundActions).toHaveLength(1);
      expect(data.completeness).toEqual({
        messages: "AVAILABLE",
        aiRuns: "AVAILABLE",
        snapshots: "AVAILABLE",
        delivery: "AVAILABLE",
      });
    });

    it("evaluates snapshots as PARTIAL when some runs miss request or response snapshot", () => {
      // Invariant logic test:
      const evaluateSnapshotsCompleteness = (runs: Array<{ requestSnapshot: unknown; responseSnapshot: unknown }>) => {
        if (runs.length === 0) return "NOT_CAPTURED";
        if (runs.every((r) => r.requestSnapshot && r.responseSnapshot)) return "AVAILABLE";
        if (runs.some((r) => r.requestSnapshot || r.responseSnapshot)) return "PARTIAL";
        return "NOT_CAPTURED";
      };

      // Case 1: Run has only requestSnapshot, missing responseSnapshot -> PARTIAL
      expect(evaluateSnapshotsCompleteness([{ requestSnapshot: {}, responseSnapshot: null }])).toBe("PARTIAL");
      // Case 2: One complete run, one empty run -> PARTIAL
      expect(evaluateSnapshotsCompleteness([
        { requestSnapshot: {}, responseSnapshot: {} },
        { requestSnapshot: null, responseSnapshot: null },
      ])).toBe("PARTIAL");
      // Case 3: All complete -> AVAILABLE
      expect(evaluateSnapshotsCompleteness([
        { requestSnapshot: {}, responseSnapshot: {} },
      ])).toBe("AVAILABLE");
      // Case 4: No snapshots -> NOT_CAPTURED
      expect(evaluateSnapshotsCompleteness([
        { requestSnapshot: null, responseSnapshot: null },
      ])).toBe("NOT_CAPTURED");
    });
  });

  describe("Server-Side Search & Filter Endpoints", () => {
    it("accepts q, from, to, model, status filters on /api/ai-runs", async () => {
      const mockRuns = [
        {
          id: "run-101",
          channelAccountId,
          conversationId,
          inboundVersion: 1,
          model: "grok-4.5",
          status: "SUCCESS",
          promptTokens: 10,
          completionTokens: 20,
          totalTokens: 30,
          latencyMs: 150,
          createdAt: new Date(),
        },
      ];

      const mockDb = {
        select: vi.fn((fields?: unknown) => ({
          from: vi.fn(() => ({
            where: vi.fn(() => {
              if (fields && typeof fields === "object" && "count" in fields) {
                return Promise.resolve([{ count: 1 }]);
              }
              return {
                orderBy: vi.fn(() => ({
                  limit: vi.fn(() => ({
                    offset: vi.fn(async () => mockRuns),
                  })),
                })),
              };
            }),
          })),
        })),
      };

      const fastify = Fastify();
      await fastify.register(
        createAdminRoutes({
          db: mockDb as unknown as Database,
          queueRepo: {} as unknown as QueueRepository,
          settingsRepo: { getSettings: vi.fn(async () => ({ settings: {} })) } as unknown as SettingsRepository,
          aiConfigRepo: {} as unknown as AiConfigRepository,
          incidentRepo: {} as unknown as IncidentRepository,
          eventRepo: {} as unknown as EventRepository,
          jobRepo: {} as unknown as JobRepository,
          broadcaster: { broadcast: vi.fn() } as unknown as OutboxBroadcaster,
          requireAuth: async () => ({
            id: "u-1",
            email: "admin@example.com",
            role: "OPERATOR",
          }),
          channelAccountId,
        })
      );

      const res = await fastify.inject({
        method: "GET",
        url: "/api/ai-runs?q=grok&model=grok-4.5&status=SUCCESS&from=2026-01-01T00:00:00Z&to=2026-12-31T23:59:59Z",
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.payload);
      expect(data.items).toHaveLength(1);
      expect(data.total).toBe(1);
    });

    it("rejects VIEWER role with 403 Forbidden on GET /api/ai-runs", async () => {
      const fastify = Fastify();
      await fastify.register(
        createAdminRoutes({
          db: {} as unknown as Database,
          queueRepo: {} as unknown as QueueRepository,
          settingsRepo: { getSettings: vi.fn(async () => ({ settings: {} })) } as unknown as SettingsRepository,
          aiConfigRepo: {} as unknown as AiConfigRepository,
          incidentRepo: {} as unknown as IncidentRepository,
          eventRepo: {} as unknown as EventRepository,
          jobRepo: {} as unknown as JobRepository,
          broadcaster: { broadcast: vi.fn() } as unknown as OutboxBroadcaster,
          requireAuth: async () => ({
            id: "u-viewer",
            email: "viewer@example.com",
            role: "VIEWER",
          }),
          channelAccountId,
        })
      );

      const res = await fastify.inject({
        method: "GET",
        url: "/api/ai-runs",
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.payload);
      expect(body.error).toContain("Forbidden");
    });

    it("accepts q, from, to, type, status filters on /api/incidents", async () => {
      const mockIncidents = [
        {
          id: "inc-101",
          channelAccountId,
          type: "SEND_UNCERTAIN",
          status: "OPEN",
          title: "Send uncertain incident",
          description: "Details here",
          createdAt: new Date(),
        },
      ];

      const mockDb = {
        select: vi.fn((fields?: unknown) => ({
          from: vi.fn(() => ({
            where: vi.fn(() => {
              if (fields && typeof fields === "object" && "type" in fields) {
                return {
                  groupBy: vi.fn(() => ({
                    orderBy: vi.fn(async () => [{ type: "SEND_UNCERTAIN", count: 1 }]),
                  })),
                };
              }
              if (fields && typeof fields === "object" && "count" in fields) {
                return Promise.resolve([{ count: 1 }]);
              }
              return {
                orderBy: vi.fn(() => ({
                  limit: vi.fn(() => ({
                    offset: vi.fn(async () => mockIncidents),
                  })),
                })),
              };
            }),
          })),
        })),
      };

      const fastify = Fastify();
      await fastify.register(
        createAdminRoutes({
          db: mockDb as unknown as Database,
          queueRepo: {} as unknown as QueueRepository,
          settingsRepo: { getSettings: vi.fn(async () => ({ settings: {} })) } as unknown as SettingsRepository,
          aiConfigRepo: {} as unknown as AiConfigRepository,
          incidentRepo: {} as unknown as IncidentRepository,
          eventRepo: {} as unknown as EventRepository,
          jobRepo: {} as unknown as JobRepository,
          broadcaster: { broadcast: vi.fn() } as unknown as OutboxBroadcaster,
          requireAuth: async () => ({
            id: "u-1",
            email: "admin@example.com",
            role: "OPERATOR",
          }),
          channelAccountId,
        })
      );

      const res = await fastify.inject({
        method: "GET",
        url: "/api/incidents?q=uncertain&type=SEND_UNCERTAIN&status=OPEN&from=2026-01-01T00:00:00Z&to=2026-12-31T23:59:59Z",
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.payload);
      expect(data.items).toHaveLength(1);
      expect(data.total).toBe(1);
      expect(data.openTotal).toBe(1);
      expect(data.typeFacets).toEqual([{ type: "SEND_UNCERTAIN", count: 1 }]);
    });
  });
});
