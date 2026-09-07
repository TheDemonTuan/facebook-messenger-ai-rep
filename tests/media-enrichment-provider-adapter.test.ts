import { describe, it, expect } from "vitest";
import {
  buildChatMessages,
  buildSanitizedRequestSnapshot,
  globalMediaCache,
  type ConversationContext,
} from "../packages/ai/src/index.js";
import { SystemSettingsDefaults } from "../packages/contracts/src/index.js";

describe("PR-06 Provider Adapter Formatting & Snapshot Redaction", () => {
  describe("1. Multimodal Content Block Formatting", () => {
    it("builds image_url content block when image is cached and vision is enabled", () => {
      const dummyJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
      const base64Data = dummyJpeg.toString("base64");
      const mediaRefId = "mref_sample_hoodie";

      globalMediaCache.set({
        mediaRefId,
        mimeType: "image/jpeg",
        byteSize: dummyJpeg.length,
        buffer: dummyJpeg,
        base64: base64Data,
      });

      const context: ConversationContext = {
        settings: {
          ...SystemSettingsDefaults,
          aiModel: "grok-2-vision-1212",
        },
        recentMessages: [
          {
            direction: "INBOUND",
            text: "Áo này còn size L không?",
            parts: [
              {
                type: "TEXT",
                text: "Áo này còn size L không?",
              },
              {
                type: "IMAGE",
                media: {
                  mediaId: mediaRefId,
                  role: "ATTACHMENT",
                  status: "READY",
                },
              },
            ],
          },
        ],
      };

      const messages = buildChatMessages(context, {
        capabilities: {
          text: true,
          imageInput: true,
          audioInput: false,
          audioTranscription: false,
          videoInput: false,
          structuredOutput: true,
        },
      });

      const userMsg = messages.find((m) => m.role === "user");
      expect(userMsg).toBeDefined();
      expect(Array.isArray(userMsg?.content)).toBe(true);

      const parts = userMsg?.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
      const textPart = parts.find((p) => p.type === "text");
      const imagePart = parts.find((p) => p.type === "image_url");

      expect(textPart?.text).toContain("Áo này còn size L không?");
      expect(imagePart?.image_url?.url).toBe(`data:image/jpeg;base64,${base64Data}`);
    });

    it("formats voice ASR transcript with explicit provenance label", () => {
      const context: ConversationContext = {
        settings: {
          ...SystemSettingsDefaults,
          aiModel: "grok-4.5",
        },
        recentMessages: [
          {
            direction: "INBOUND",
            text: "",
            parts: [
              {
                type: "VOICE",
                transcript: {
                  text: "Shop ơi giao hàng ra Hà Nội mất mấy ngày ạ?",
                  language: "vi",
                  confidence: 0.98,
                  provenance: "ASR",
                },
                media: {
                  mediaId: "mref_voice_01",
                  role: "ATTACHMENT",
                  status: "READY",
                  durationMs: 4500,
                },
              },
            ],
          },
        ],
      };

      const messages = buildChatMessages(context);
      const userMsg = messages.find((m) => m.role === "user");
      expect(userMsg).toBeDefined();

      const contentStr = typeof userMsg?.content === "string" ? userMsg.content : JSON.stringify(userMsg?.content);
      expect(contentStr).toContain("[Tin nhắn thoại của khách (ASR)]");
      expect(contentStr).toContain("Shop ơi giao hàng ra Hà Nội mất mấy ngày ạ?");
    });
  });

  describe("2. Request Snapshot Sanitization & Redaction", () => {
    it("redacts base64 image data URLs from snapshot logs", () => {
      const largeBase64 = "a".repeat(5000); // 5KB base64 string
      const rawMessages = [
        {
          role: "system" as const,
          content: "System persona text",
        },
        {
          role: "user" as const,
          content: [
            { type: "text" as const, text: "Khách gửi hình ảnh:" },
            {
              type: "image_url" as const,
              image_url: { url: `data:image/jpeg;base64,${largeBase64}` },
              mediaRefId: "mref_secret_photo",
            },
          ],
        },
      ];

      const snapshot = buildSanitizedRequestSnapshot(
        {
          apiFormat: "OPENAI_COMPATIBLE",
          baseUrl: "https://api.x.ai/v1",
          apiKey: "xai-secret-live-key-12345",
          model: "grok-2-vision-1212",
        },
        "grok-2-vision-1212",
        rawMessages
      );

      const snapshotJson = JSON.stringify(snapshot);

      // Raw base64 data MUST NOT exist in snapshot
      expect(snapshotJson).not.toContain(largeBase64);
      // Secret API key MUST NOT exist in snapshot
      expect(snapshotJson).not.toContain("xai-secret-live-key-12345");
      // Must contain redacted placeholder with mime and ref
      expect(snapshotJson).toContain("[IMAGE_DATA_REDACTED");
      expect(snapshotJson).toContain("mref_secret_photo");
    });
  });
});
