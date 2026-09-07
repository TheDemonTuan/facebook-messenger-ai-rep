import { describe, it, expect } from "vitest";
import {
  InboundMessagePayloadSchema,
  MessageTimelineDtoSchema,
  MessagePartSchema,
  normalizeMessageContent,
  isMeaningfulContent,
  type MessagePart,
  type MediaRef,
} from "../packages/contracts/src/message.js";

describe("PR-03: Message Pipeline Contract v2", () => {
  const basePayload = {
    channelAccountId: "acc-fb-1",
    externalThreadId: "thread-100",
    externalThreadRef: "https://facebook.com/messages/t/thread-100",
    externalMessageId: "mid-test-1",
    customerName: "Nguyen Van A",
    timestamp: new Date("2026-09-07T10:00:00.000Z"),
  };

  const sampleMedia: MediaRef = {
    mediaId: "media-uuid-1",
    role: "ATTACHMENT",
    mimeType: "image/jpeg",
    byteSize: 1048576,
    width: 1920,
    height: 1080,
    status: "READY",
  };

  describe("Message Parts Round-trip and Validation", () => {
    it("validates TEXT part", () => {
      const part: MessagePart = { type: "TEXT", text: "Xin chào shop" };
      const parsed = MessagePartSchema.safeParse(part);
      expect(parsed.success).toBe(true);
    });

    it("validates IMAGE part with media reference", () => {
      const part: MessagePart = {
        type: "IMAGE",
        media: sampleMedia,
        altText: "Ảnh mẫu áo thun",
      };
      const parsed = MessagePartSchema.safeParse(part);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.type).toBe("IMAGE");
        expect(parsed.data.media.mediaId).toBe("media-uuid-1");
      }
    });

    it("validates VOICE and AUDIO parts with transcript reference", () => {
      const voicePart: MessagePart = {
        type: "VOICE",
        media: { ...sampleMedia, mimeType: "audio/ogg", role: "ATTACHMENT" },
        transcriptRef: "transcript-rec-1",
        durationMs: 4500,
      };
      const parsedVoice = MessagePartSchema.safeParse(voicePart);
      expect(parsedVoice.success).toBe(true);

      const audioPart: MessagePart = {
        type: "AUDIO",
        media: { ...sampleMedia, mimeType: "audio/mp3", role: "ATTACHMENT" },
        durationMs: 12000,
      };
      const parsedAudio = MessagePartSchema.safeParse(audioPart);
      expect(parsedAudio.success).toBe(true);
    });

    it("validates VIDEO part with poster and analysis refs", () => {
      const videoPart: MessagePart = {
        type: "VIDEO",
        media: { ...sampleMedia, mimeType: "video/mp4", role: "ATTACHMENT" },
        posterRef: "poster-media-1",
        analysisRef: "analysis-run-1",
        durationMs: 30000,
      };
      const parsed = MessagePartSchema.safeParse(videoPart);
      expect(parsed.success).toBe(true);
    });

    it("validates STICKER and GIF parts", () => {
      const stickerPart: MessagePart = {
        type: "STICKER",
        label: "thumbs_up",
        media: sampleMedia,
      };
      expect(MessagePartSchema.safeParse(stickerPart).success).toBe(true);

      const gifPart: MessagePart = {
        type: "GIF",
        media: { ...sampleMedia, mimeType: "image/gif" },
      };
      expect(MessagePartSchema.safeParse(gifPart).success).toBe(true);
    });

    it("validates SHARE part with group/post origin and preview", () => {
      const sharePart: MessagePart = {
        type: "SHARE",
        origin: "FACEBOOK_POST",
        url: "https://www.facebook.com/shop/posts/12345",
        title: "Bài viết khuyến mãi tháng 9",
        previewText: "Giảm giá lên đến 50% tất cả sản phẩm",
        previewMedia: sampleMedia,
        access: "READABLE",
      };
      const parsed = MessagePartSchema.safeParse(sharePart);
      expect(parsed.success).toBe(true);
    });

    it("validates FILE part with fileName and byteSize", () => {
      const filePart: MessagePart = {
        type: "FILE",
        media: { ...sampleMedia, mimeType: "application/pdf" },
        fileName: "bang-gia-2026.pdf",
        byteSize: 204800,
      };
      expect(MessagePartSchema.safeParse(filePart).success).toBe(true);
    });

    it("validates LOCATION, CONTACT, and UNKNOWN parts", () => {
      const locPart: MessagePart = {
        type: "LOCATION",
        label: "Hà Nội, Việt Nam",
        latitude: 21.0285,
        longitude: 105.8542,
      };
      expect(MessagePartSchema.safeParse(locPart).success).toBe(true);

      const contactPart: MessagePart = {
        type: "CONTACT",
        displayName: "Trần Thị B",
        normalizedFields: { phone: "0901234567" },
      };
      expect(MessagePartSchema.safeParse(contactPart).success).toBe(true);

      const unknownPart: MessagePart = {
        type: "UNKNOWN",
        observedLabel: "Unrecognized interactive button",
      };
      expect(MessagePartSchema.safeParse(unknownPart).success).toBe(true);
    });
  });

  describe("Inbound Message Payload Validation & Compatibility", () => {
    it("accepts backward-compatible v1 payload with text only", () => {
      const v1Payload = {
        ...basePayload,
        text: "Sản phẩm này còn size L không?",
      };

      const parsed = InboundMessagePayloadSchema.safeParse(v1Payload);
      expect(parsed.success).toBe(true);

      const normalized = normalizeMessageContent(parsed.data!);
      expect(normalized.contentSchemaVersion).toBe(2);
      expect(normalized.parts).toHaveLength(1);
      expect(normalized.parts[0]).toEqual({
        type: "TEXT",
        text: "Sản phẩm này còn size L không?",
      });
      expect(normalized.contentStatus).toBe("READY");
      expect(normalized.contentRevision).toBe(1);
    });

    it("accepts media-only payload with empty text", () => {
      const mediaOnlyPayload = {
        ...basePayload,
        text: "",
        parts: [
          {
            type: "IMAGE",
            media: sampleMedia,
            altText: "Ảnh sản phẩm đính kèm",
          },
        ],
      };

      const parsed = InboundMessagePayloadSchema.safeParse(mediaOnlyPayload);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.text).toBe("");
        expect(parsed.data.parts).toHaveLength(1);
        expect(parsed.data.parts![0].type).toBe("IMAGE");
      }
    });

    it("rejects empty meaningless payload (empty text and no parts)", () => {
      const emptyPayload = {
        ...basePayload,
        text: "   ",
        parts: [],
      };

      const parsed = InboundMessagePayloadSchema.safeParse(emptyPayload);
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues[0].message).toContain("Empty meaningless message");
      }
    });

    it("accepts message unsent tombstone with empty text and no parts", () => {
      const unsentPayload = {
        ...basePayload,
        text: "",
        eventKind: "MESSAGE_UNSENT" as const,
      };

      const parsed = InboundMessagePayloadSchema.safeParse(unsentPayload);
      expect(parsed.success).toBe(true);
      expect(parsed.data?.eventKind).toBe("MESSAGE_UNSENT");
    });

    it("enforces part bounds (max 50 parts)", () => {
      const excessiveParts: MessagePart[] = Array.from({ length: 51 }, (_, i) => ({
        type: "TEXT",
        text: `Part ${i}`,
      }));

      const payload = {
        ...basePayload,
        text: "Multiple parts",
        parts: excessiveParts,
      };

      const parsed = InboundMessagePayloadSchema.safeParse(payload);
      expect(parsed.success).toBe(false);
    });

    it("enforces text length limit (max 10,000 characters)", () => {
      const hugeText = "a".repeat(10001);
      const payload = {
        ...basePayload,
        text: hugeText,
      };

      const parsed = InboundMessagePayloadSchema.safeParse(payload);
      expect(parsed.success).toBe(false);
    });
  });

  describe("Meaningful Content Guard", () => {
    it("returns true for non-empty text", () => {
      expect(isMeaningfulContent({ text: "Hello" })).toBe(true);
    });

    it("returns false for whitespace only without parts", () => {
      expect(isMeaningfulContent({ text: "   \n\t  " })).toBe(false);
      expect(isMeaningfulContent({ text: "" })).toBe(false);
    });

    it("returns true for media parts even with empty text", () => {
      expect(
        isMeaningfulContent({
          text: "",
          parts: [{ type: "VOICE", media: sampleMedia }],
        })
      ).toBe(true);
    });

    it("returns true for tombstone event kinds", () => {
      expect(
        isMeaningfulContent({
          text: "",
          eventKind: "MESSAGE_UNSENT",
        })
      ).toBe(true);
      expect(
        isMeaningfulContent({
          text: "",
          eventKind: "REACTION_CHANGED",
        })
      ).toBe(true);
    });
  });

  describe("MessageTimelineDtoSchema", () => {
    it("validates full rich content timeline DTO with sender and time details", () => {
      const dto = {
        id: "11111111-1111-4111-8111-111111111111",
        direction: "INBOUND",
        actor: "SYSTEM",
        text: "Check áo này nhé",
        parts: [
          { type: "TEXT", text: "Check áo này nhé" },
          { type: "IMAGE", media: sampleMedia },
        ],
        contentStatus: "READY",
        contentRevision: 1,
        eventKind: "MESSAGE_CREATED",
        sender: {
          name: "Khách hàng Sin",
          avatarMediaRef: "https://avatar.fb.com/sin.jpg",
          senderKind: "PERSON",
          isVerified: true,
        },
        time: {
          eventAt: "2026-09-07T10:00:00.000Z",
          observedAt: "2026-09-07T10:00:02.000Z",
          displayAt: "2026-09-07T10:00:00.000Z",
          source: "FACEBOOK_EVENT",
          precision: "SECOND",
        },
        // Legacy aliases
        senderName: "Khách hàng Sin",
        avatarUrl: "https://avatar.fb.com/sin.jpg",
      };

      const parsed = MessageTimelineDtoSchema.safeParse(dto);
      expect(parsed.success).toBe(true);
    });
  });
});
