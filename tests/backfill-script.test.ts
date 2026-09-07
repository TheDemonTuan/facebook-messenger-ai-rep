import { describe, it, expect, vi } from "vitest";
import { cleanContaminatedText, runBackfill } from "../scripts/backfill-normalized-messages.js";
import type { Database } from "../packages/db/src/index.js";

describe("PR-07 Message Normalization Backfill Script", () => {
  describe("cleanContaminatedText logic", () => {
    it("strips trailing UI navigation artifacts while preserving legitimate customer speech", () => {
      const contaminated =
        "Dạ cho em hỏi shop còn áo mẫu màu xanh size L không ạ? Active now Profile Mute Search";
      const result = cleanContaminatedText(contaminated);

      expect(result.isContaminated).toBe(true);
      expect(result.isQuarantined).toBe(false);
      expect(result.cleanedText).toBe("Dạ cho em hỏi shop còn áo mẫu màu xanh size L không ạ?");
      expect(result.reasons).toEqual(expect.arrayContaining([expect.stringContaining("MATCHED_PATTERN")]));
    });

    it("strips full navigation headers from legacy parser splits", () => {
      const contaminated =
        "Giá bao nhiêu vậy shop? Profile Mute Search Chat info Customize chat Media, files and links Privacy & support";
      const result = cleanContaminatedText(contaminated);

      expect(result.isContaminated).toBe(true);
      expect(result.isQuarantined).toBe(false);
      expect(result.cleanedText).toBe("Giá bao nhiêu vậy shop?");
    });

    it("quarantines messages that are 100% UI artifacts without fabricating user text", () => {
      const pureArtifact = "Active now Profile Mute Search";
      const result = cleanContaminatedText(pureArtifact);

      expect(result.isContaminated).toBe(true);
      expect(result.isQuarantined).toBe(true);
      expect(result.cleanedText).toBe("");
      expect(result.reasons).toContain("FULL_UI_ARTIFACT_QUARANTINED");
    });

    it("leaves clean messages untouched", () => {
      const clean = "Chào shop, mình muốn đặt hàng giao về Hà Nội.";
      const result = cleanContaminatedText(clean);

      expect(result.isContaminated).toBe(false);
      expect(result.isQuarantined).toBe(false);
      expect(result.cleanedText).toBe(clean);
      expect(result.reasons).toHaveLength(0);
    });
  });

  describe("runBackfill batching and DB safety invariants", () => {
    it("defaults to DRY-RUN mode and performs ZERO database writes", async () => {
      const mockRows = [
        {
          id: "msg-1",
          channelAccountId: "chan-1",
          conversationId: "conv-1",
          externalMessageId: "mid-1",
          text: "Áo này còn hàng không? Active now Profile Mute Search",
          content: null, // Legacy v1
          contentSchemaVersion: 1,
          contentStatus: "READY",
          contentRevision: 1,
          inboundVersion: 5,
        },
      ];

      const mockDb = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue(mockRows),
              }),
            }),
          }),
        }),
        update: vi.fn(),
        insert: vi.fn(),
      } as unknown as Database;

      const summary = await runBackfill({ dryRun: true, batchSize: 10 }, mockDb);

      expect(summary.mode).toBe("DRY-RUN");
      expect(summary.totalScanned).toBe(1);
      expect(summary.contaminatedCount).toBe(1);
      expect(summary.cleanedCount).toBe(1);
      expect(summary.auditEntries).toHaveLength(1);
      expect(summary.auditEntries[0]!.newText).toBe("Áo này còn hàng không?");

      // Absolute invariant: in dry-run, NEVER call update or insert!
      expect(mockDb.update).not.toHaveBeenCalled();
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it("in apply mode, updates message and records audit WITHOUT touching inboundVersion, jobs, or turns", async () => {
      const mockRows = [
        {
          id: "msg-artifact",
          channelAccountId: "chan-1",
          conversationId: "conv-1",
          externalMessageId: "mid-artifact",
          text: "Active now Profile Mute Search",
          content: null,
          contentSchemaVersion: 1,
          contentStatus: "READY",
          contentRevision: 1,
          inboundVersion: 7,
        },
      ];

      const setMock = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      });
      const insertValuesMock = vi.fn().mockResolvedValue(undefined);

      const mockDb = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue(mockRows),
              }),
            }),
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: setMock,
        }),
        insert: vi.fn().mockReturnValue({
          values: insertValuesMock,
        }),
      } as unknown as Database;

      const summary = await runBackfill({ dryRun: false, batchSize: 10 }, mockDb);

      expect(summary.mode).toBe("APPLIED");
      expect(summary.quarantinedCount).toBe(1);

      // Verify update was called on messages table
      expect(mockDb.update).toHaveBeenCalledTimes(1);
      expect(setMock).toHaveBeenCalledWith(
        expect.objectContaining({
          contentStatus: "QUARANTINED",
          text: "",
          contentSchemaVersion: 2,
        })
      );

      // Verify audit record was inserted
      expect(mockDb.insert).toHaveBeenCalledTimes(1);
      expect(insertValuesMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "BACKFILL_AUDIT",
          actor: "SYSTEM",
          inboundVersion: 7, // Kept message's existing version, did not bump
        })
      );
    });
  });
});
