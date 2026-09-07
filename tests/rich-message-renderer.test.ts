import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  MessageContentRenderer,
  MessageTimeBadge,
  MessageStatusBadges,
  getMessagePreviewSummary,
} from "../apps/dashboard/src/components/messages";
import type { MessagePart } from "../apps/dashboard/src/types";

describe("PR-04 Rich Message Renderer & Timeline Components", () => {
  describe("1. Message Preview Summary (Inbox / Workflow preview)", () => {
    it("summarizes plain text messages cleanly", () => {
      const summary = getMessagePreviewSummary({ text: "Xin chào bạn" });
      expect(summary.text).toBe("Xin chào bạn");
      expect(summary.icon).toBeNull();
    });

    it("summarizes image parts with and without accompanying text", () => {
      const imageOnly: MessagePart = {
        type: "IMAGE",
        media: { mediaId: "img-1", sourceUrl: "https://example.com/photo.jpg" },
      };
      const s1 = getMessagePreviewSummary({ parts: [imageOnly] });
      expect(s1.text).toBe("[Hình ảnh]");
      expect(s1.icon).not.toBeNull();

      const s2 = getMessagePreviewSummary({ parts: [imageOnly], text: "Xem hóa đơn này" });
      expect(s2.text).toBe("[Hình ảnh] Xem hóa đơn này");
    });

    it("summarizes audio and voice parts with icon", () => {
      const voicePart: MessagePart = {
        type: "VOICE",
        media: { mediaId: "audio-1", durationMs: 15000 },
      };
      const s = getMessagePreviewSummary({ parts: [voicePart] });
      expect(s.text).toBe("[Tin nhắn thoại]");
      expect(s.icon).not.toBeNull();
    });

    it("summarizes video parts", () => {
      const videoPart: MessagePart = {
        type: "VIDEO",
        media: { mediaId: "vid-1", durationMs: 45000 },
      };
      const s = getMessagePreviewSummary({ parts: [videoPart] });
      expect(s.text).toBe("[Video]");
    });

    it("summarizes share, file, sticker, gif, location, contact, and unknown parts", () => {
      expect(
        getMessagePreviewSummary({
          parts: [{ type: "SHARE", title: "Khuyến mãi hè", origin: "FACEBOOK_POST" }],
        }).text
      ).toBe("[Chia sẻ: Khuyến mãi hè]");

      expect(
        getMessagePreviewSummary({
          parts: [{ type: "FILE", fileName: "bao-gia.pdf", media: { mediaId: "f-1" } }],
        }).text
      ).toBe("[Tập tin: bao-gia.pdf]");

      expect(
        getMessagePreviewSummary({
          parts: [{ type: "STICKER", label: "like" }],
        }).text
      ).toBe("[Nhãn dán: like]");

      expect(
        getMessagePreviewSummary({
          parts: [{ type: "GIF", media: { mediaId: "g-1" } }],
        }).text
      ).toBe("[Ảnh động GIF]");

      expect(
        getMessagePreviewSummary({
          parts: [{ type: "LOCATION", label: "Quận 1, TP.HCM" }],
        }).text
      ).toBe("[Vị trí: Quận 1, TP.HCM]");

      expect(
        getMessagePreviewSummary({
          parts: [{ type: "CONTACT", displayName: "Nguyễn Văn A" }],
        }).text
      ).toBe("[Danh thiếp: Nguyễn Văn A]");

      expect(
        getMessagePreviewSummary({
          parts: [{ type: "UNKNOWN", observedLabel: "Poll Widget" }],
        }).text
      ).toBe("[Poll Widget]");
    });

    it("indicates unsent messages and non-ready content statuses in preview", () => {
      expect(
        getMessagePreviewSummary({ eventKind: "MESSAGE_UNSENT", text: "Tin đã xóa" }).text
      ).toBe("[Tin nhắn đã bị thu hồi]");

      expect(
        getMessagePreviewSummary({ contentStatus: "PENDING", text: "Chờ tải" }).text
      ).toBe("[Đang tải nội dung...]");

      expect(
        getMessagePreviewSummary({ contentStatus: "UNAVAILABLE" }).text
      ).toBe("[Nội dung không khả dụng]");

      expect(
        getMessagePreviewSummary({ contentStatus: "UNSUPPORTED" }).text
      ).toBe("[Nội dung chưa hỗ trợ]");
    });
  });

  describe("2. MessageContentRenderer (Strict contract, no autoplay, no dangerouslySetInnerHTML)", () => {
    it("renders text with pre-wrap and word-break style", () => {
      const html = renderToStaticMarkup(
        React.createElement(MessageContentRenderer, {
          text: "Dòng 1\nDòng 2",
        })
      );
      expect(html).toContain("Dòng 1");
      expect(html).toContain("Dòng 2");
      expect(html).toContain("pre-wrap");
      expect(html).not.toContain("dangerouslySetInnerHTML");
    });

    it("renders voice/audio with controls and never autoplays", () => {
      const parts: MessagePart[] = [
        {
          type: "VOICE",
          media: {
            mediaId: "voice-1",
            sourceUrl: "https://example.com/voice.mp3",
            durationMs: 14000,
          },
          transcriptRef: "tr-987",
        },
      ];

      const html = renderToStaticMarkup(
        React.createElement(MessageContentRenderer, {
          parts,
        })
      );

      expect(html).toContain("<audio");
      expect(html).toContain("controls");
      expect(html).not.toContain("autoplay");
      expect(html).toContain("tr-987");
      expect(html).toContain("0:14");
    });

    it("renders video with controls, poster, and never autoplays", () => {
      const parts: MessagePart[] = [
        {
          type: "VIDEO",
          media: {
            mediaId: "vid-1",
            sourceUrl: "https://example.com/clip.mp4",
            durationMs: 30000,
          },
          posterRef: "https://example.com/poster.jpg",
        },
      ];

      const html = renderToStaticMarkup(
        React.createElement(MessageContentRenderer, {
          parts,
        })
      );

      expect(html).toContain("<video");
      expect(html).toContain("controls");
      expect(html).not.toContain("autoplay");
      expect(html).toContain("https://example.com/poster.jpg");
    });

    it("renders clear state cards for PENDING, UNAVAILABLE, and UNSUPPORTED media", () => {
      const pendingImg: MessagePart = {
        type: "IMAGE",
        media: { mediaId: "img-pending", status: "PENDING" },
      };
      const unavailVoice: MessagePart = {
        type: "VOICE",
        media: { mediaId: "voice-unavail", status: "UNAVAILABLE" },
      };
      const unsuppVideo: MessagePart = {
        type: "VIDEO",
        media: { mediaId: "vid-unsupp", status: "UNSUPPORTED" },
      };

      const html = renderToStaticMarkup(
        React.createElement(MessageContentRenderer, {
          parts: [pendingImg, unavailVoice, unsuppVideo],
        })
      );

      expect(html).toContain("Đang tải hình ảnh (PENDING)");
      expect(html).toContain("Tin nhắn âm thanh không khả dụng (UNAVAILABLE)");
      expect(html).toContain("Định dạng video chưa hỗ trợ (UNSUPPORTED)");
    });

    it("renders rich cards for share, file, location, and contact without raw HTML injection", () => {
      const parts: MessagePart[] = [
        {
          type: "SHARE",
          origin: "FACEBOOK_POST",
          title: "Sản phẩm mới ra mắt",
          url: "https://facebook.com/post/123",
          previewText: "Mô tả sản phẩm rất chi tiết",
          access: "PREVIEW_ONLY",
        },
        {
          type: "FILE",
          fileName: "catalogue-2026.pdf",
          byteSize: 1024 * 1024 * 2.5,
          media: { mediaId: "file-1", sourceUrl: "https://example.com/cat.pdf" },
        },
        {
          type: "LOCATION",
          label: "Cửa hàng chính",
          latitude: 10.7769,
          longitude: 106.7009,
        },
        {
          type: "CONTACT",
          displayName: "Hotline CSKH",
          normalizedFields: { Điện_thoại: "0901234567" },
        },
      ];

      const html = renderToStaticMarkup(
        React.createElement(MessageContentRenderer, {
          parts,
        })
      );

      expect(html).toContain("Bài viết Facebook");
      expect(html).toContain("Sản phẩm mới ra mắt");
      expect(html).toContain("catalogue-2026.pdf");
      expect(html).toContain("2.5 MB");
      expect(html).toContain("Cửa hàng chính");
      expect(html).toContain("10.7769");
      expect(html).toContain("Hotline CSKH");
      expect(html).toContain("0901234567");
      expect(html).not.toContain("dangerouslySetInnerHTML");
    });
  });

  describe("3. MessageTimeBadge (Source & Precision - Never fakes send time)", () => {
    it("displays Facebook event time when source is FACEBOOK_EVENT", () => {
      const html = renderToStaticMarkup(
        React.createElement(MessageTimeBadge, {
          time: {
            eventAt: "2026-09-05T07:30:00.000Z",
            source: "FACEBOOK_EVENT",
            precision: "MINUTE",
          },
        })
      );

      expect(html).toContain("(phút)");
      expect(html).toContain("Giờ gửi từ Facebook");
    });

    it("displays OBSERVED time clearly without disguising it as the send time", () => {
      const html = renderToStaticMarkup(
        React.createElement(MessageTimeBadge, {
          time: {
            observedAt: "2026-09-05T07:35:00.000Z",
            source: "OBSERVED",
            precision: "SECOND",
          },
        })
      );

      // Must state "Ghi nhận" and not claim to be send time
      expect(html).toContain("Ghi nhận:");
      expect(html).toContain("không phải giờ gửi từ Facebook");
    });

    it("displays SYSTEM time accurately for system generated messages", () => {
      const html = renderToStaticMarkup(
        React.createElement(MessageTimeBadge, {
          time: {
            displayAt: "2026-09-05T08:00:00.000Z",
            source: "SYSTEM",
            precision: "SECOND",
          },
        })
      );

      expect(html).toContain("Hệ thống:");
    });
  });

  describe("4. MessageStatusBadges (Distinct badges for decision, manual, waiting, parse error)", () => {
    it("renders distinct decision badge for AI reply decisions", () => {
      const htmlGenerate = renderToStaticMarkup(
        React.createElement(MessageStatusBadges, {
          replyDecision: {
            action: "GENERATE",
            reasonCode: "ELIGIBLE",
            displayLabel: "AI tạo phản hồi",
          },
        })
      );
      expect(htmlGenerate).toContain("Quyết định: AI tạo phản hồi");

      const htmlHandoff = renderToStaticMarkup(
        React.createElement(MessageStatusBadges, {
          replyDecision: {
            action: "HANDOFF",
            reasonCode: "HUMAN_SESSION_ACTIVE",
            displayLabel: "Chuyển giao nhân viên",
          },
        })
      );
      expect(htmlHandoff).toContain("Quyết định: Chuyển giao nhân viên");

      const htmlSkip = renderToStaticMarkup(
        React.createElement(MessageStatusBadges, {
          skipReason: {
            decision: "INELIGIBLE",
            eligible: false,
            reasonCode: "PERSON_EXCLUDED",
            reason: "Person is excluded",
            humanReadableReason: "Khách thuộc danh sách loại trừ",
            precedenceStep: "PERSON_LIST_MODE",
          },
        })
      );
      expect(htmlSkip).toContain("Quyết định: Bỏ qua (Khách thuộc danh sách loại trừ)");
    });

    it("renders distinct manual badge when sent by human operator", () => {
      const html = renderToStaticMarkup(
        React.createElement(MessageStatusBadges, {
          actor: "MANUAL_OWNER",
        })
      );

      expect(html).toContain("Thủ công (Nhân viên)");
    });

    it("renders distinct waiting badge when media or turn is pending", () => {
      const html = renderToStaticMarkup(
        React.createElement(MessageStatusBadges, {
          contentStatus: "PENDING",
        })
      );

      expect(html).toContain("Đang chờ media / xử lý");
    });

    it("renders distinct parse error badge when content is unsupported or parse quality is unverified", () => {
      const htmlUnsupported = renderToStaticMarkup(
        React.createElement(MessageStatusBadges, {
          contentStatus: "UNSUPPORTED",
        })
      );
      expect(htmlUnsupported).toContain("Lỗi phân tích cú pháp");

      const htmlWarnings = renderToStaticMarkup(
        React.createElement(MessageStatusBadges, {
          normalization: {
            warnings: ["Unrecognized nested structure"],
            parseQuality: "UNVERIFIED",
          },
        })
      );
      expect(htmlWarnings).toContain("Lỗi phân tích cú pháp");
    });
  });
});
