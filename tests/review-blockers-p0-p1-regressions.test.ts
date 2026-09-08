import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import {
  parseMessengerBubblesFromHtml,
  extractRowMediaParts,
  type ParsedBubble,
} from "../packages/channel/src/dom-parser.js";
import { PlaywrightMessengerAdapter } from "../apps/browser-agent/src/messenger-adapter.js";
import {
  MessagePartSchema,
  InboundMessagePayloadSchema,
  isMeaningfulContent,
} from "../packages/contracts/src/index.js";
import {
  getSafeHref,
  getSafeExternalHref,
  getSafeMediaSrc,
} from "../apps/dashboard/src/helpers/url-helpers.js";
import {
  resolveAndValidateDns,
  isPrivateOrBlockedIp,
  fetchMediaSecurely,
} from "../packages/ai/src/index.js";
import {
  OutboxRepository,
} from "../packages/db/src/index.js";
import { createInboxRoutes } from "../apps/core/src/routes/inbox.js";

describe("Review Blockers P0/P1 Regressions", () => {
  describe("(1) End-to-end parser/adapter ingest media-only", () => {
    it("ParsedBubble generates valid parts conforming to MessagePartSchema for media-only image", () => {
      const mediaOnlyHtml = `
        <div role="main">
          <div data-scope="messages_table">
            <div role="row" id="mid.$mediaOnly001" aria-label="Sin Sin: hình ảnh">
              <div class="bubble">
                <img src="https://scontent.xx.fbcdn.net/v/t39.1997-6/customer_photo_123.jpg" alt="Váy hoa vintage" width="800" height="600" />
              </div>
              <time datetime="2026-09-07T10:00:00Z"></time>
            </div>
          </div>
        </div>
      `;

      const result = parseMessengerBubblesFromHtml(mediaOnlyHtml);
      expect(result.ok).toBe(true);
      expect(result.bubbles).toHaveLength(1);

      const bubble = result.bubbles[0]!;
      expect(bubble.id).toBe("mid.$mediaOnly001");
      expect(bubble.text).toBe(""); // Media-only has no text
      expect(bubble.hasMedia).toBe(true);
      expect(bubble.contentStatus).toBe("READY");
      expect(bubble.eventKind).toBe("MESSAGE_CREATED");
      expect(bubble.contentQuality).toBe("TRUSTED");

      expect(bubble.parts).toBeDefined();
      expect(bubble.parts).toHaveLength(1);

      const part = bubble.parts![0]!;
      expect(part.type).toBe("IMAGE");
      const validation = MessagePartSchema.safeParse(part);
      expect(validation.success).toBe(true);

      if (part.type === "IMAGE") {
        expect(part.media.mediaId).toBeDefined();
        expect(part.media.mediaId.startsWith("img:")).toBe(true);
        expect(part.media.mediaRefId).toBe("mid.$mediaOnly001:image:0");
        expect(part.media.role).toBe("ATTACHMENT");
        expect(part.media.status).toBe("READY");
        expect(part.media.sourceUrl).toBe("https://scontent.xx.fbcdn.net/v/t39.1997-6/customer_photo_123.jpg");
        expect(part.media.width).toBe(800);
        expect(part.media.height).toBe(600);
        expect(part.altText).toBe("Váy hoa vintage");
      }
    });

    it("does NOT treat sender avatar as an attachment", () => {
      const rowWithAvatarHtml = `
        <div role="main">
          <div data-scope="messages_table">
            <div role="row" id="mid.$avatarRow001" aria-label="Sin Sin: Xin chào shop">
              <!-- Avatar container -->
              <div data-testid="message_sender_avatar" class="avatar">
                <img src="https://cdn.facebook.com/avatar_sinsin_token_123.jpg" alt="Sin Sin" />
              </div>
              <div class="bubble">
                <div dir="auto">Xin chào shop</div>
              </div>
              <time datetime="2026-09-07T10:00:00Z"></time>
            </div>
          </div>
        </div>
      `;

      const result = parseMessengerBubblesFromHtml(rowWithAvatarHtml);
      expect(result.ok).toBe(true);
      expect(result.bubbles).toHaveLength(1);

      const bubble = result.bubbles[0]!;
      expect(bubble.text).toBe("Xin chào shop");
      expect(bubble.hasMedia).toBeFalsy();

      // Avatar must NOT be present as an IMAGE attachment in parts
      const imageParts = bubble.parts?.filter((p) => p.type === "IMAGE") || [];
      expect(imageParts).toHaveLength(0);
    });


    it("extracts group share card as SHARE with previewMedia and NOT standalone attachment", () => {
      const rowWithShareCardHtml = `
        <div role="main">
          <div data-scope="messages_table">
            <div role="row" id="mid.$groupShare002" aria-label="Sin Sin: Xem nhóm này nhé">
              <div class="bubble">
                <div dir="auto">Xem nhóm này nhé</div>
              </div>
              <div class="shared_card" data-thread-type="GROUP" aria-label="Thông tin nhóm: Hội Đam Mê Thời Trang">
                <div class="group_title">Hội Đam Mê Thời Trang</div>
                <div class="group_member_count">120.000 members · 500 thành viên mới</div>
                <img src="https://cdn.facebook.com/group_cover_thumb.jpg" alt="Cover" />
                <a href="https://www.facebook.com/groups/fashionclub" aria-label="Thông tin nhóm">Xem nhóm</a>
              </div>
              <time datetime="2026-09-07T10:05:00Z"></time>
            </div>
          </div>
        </div>
      `;

      const result = parseMessengerBubblesFromHtml(rowWithShareCardHtml);
      expect(result.ok).toBe(true);
      expect(result.bubbles).toHaveLength(1);

      const bubble = result.bubbles[0]!;
      expect(bubble.text).toBe("Xem nhóm này nhé");

      // Standalone IMAGE parts must be 0 (the cover image belongs to SHARE part's previewMedia)
      const imageParts = bubble.parts?.filter((p) => p.type === "IMAGE") || [];
      expect(imageParts).toHaveLength(0);

      const shareParts = bubble.parts?.filter((p) => p.type === "SHARE") || [];
      expect(shareParts).toHaveLength(1);

      const sharePart = shareParts[0]!;
      if (sharePart.type === "SHARE") {
        expect(sharePart.origin).toBe("FACEBOOK_GROUP");
        expect(sharePart.url).toBe("https://www.facebook.com/groups/fashionclub");
        expect(sharePart.title).toContain("Hội Đam Mê Thời Trang");
        expect(sharePart.previewText).toContain("120.000 members");
        expect(sharePart.previewMedia).toBeDefined();
        expect(sharePart.previewMedia?.role).toBe("SHARE_PREVIEW");
        expect(sharePart.previewMedia?.sourceUrl).toBe("https://cdn.facebook.com/group_cover_thumb.jpg");
        expect(sharePart.previewMedia?.status).toBe("READY");
        expect(sharePart.previewMedia?.mediaRefId).toBe("mid.$groupShare002:share_preview");
      }
    });

    it("extracts voice, video, and file metadata with deterministic mediaId and status", () => {
      const rowChunk = `
        <div role="row" id="mid.$rich003">
          <audio src="https://cdn.facebook.com/voice_clip.mp3" data-duration="15000" aria-label="Tin nhắn thoại"></audio>
          <video src="https://cdn.facebook.com/video.mp4" poster="https://cdn.facebook.com/poster.jpg" aria-label="Video đính kèm"></video>
          <a href="https://cdn.facebook.com/invoice.pdf" download="invoice.pdf" aria-label="Tệp đính kèm: invoice.pdf">Tải về</a>
        </div>
      `;

      const { parts, hasMedia } = extractRowMediaParts("mid.$rich003", '<div role="row" id="mid.$rich003">', rowChunk);
      expect(hasMedia).toBe(true);

      const voice = parts.find((p) => p.type === "VOICE");
      expect(voice).toBeDefined();
      if (voice && voice.type === "VOICE") {
        expect(voice.media.role).toBe("ATTACHMENT");
        expect(voice.media.status).toBe("READY");
        expect(voice.media.sourceUrl).toBe("https://cdn.facebook.com/voice_clip.mp3");
        expect(voice.media.durationMs).toBe(15000);
        expect(voice.media.mediaRefId).toBe("mid.$rich003:voice:0");
      }

      const video = parts.find((p) => p.type === "VIDEO");
      expect(video).toBeDefined();
      if (video && video.type === "VIDEO") {
        expect(video.media.role).toBe("ATTACHMENT");
        expect(video.media.status).toBe("READY");
        expect(video.media.sourceUrl).toBe("https://cdn.facebook.com/video.mp4");
        expect(video.posterRef).toBe("https://cdn.facebook.com/poster.jpg");
      }

      const file = parts.find((p) => p.type === "FILE");
      expect(file).toBeDefined();
      if (file && file.type === "FILE") {
        expect(file.media.role).toBe("ATTACHMENT");
        expect(file.media.status).toBe("READY");
        expect(file.media.sourceUrl).toBe("https://cdn.facebook.com/invoice.pdf");
        expect(file.fileName).toBe("invoice.pdf");
      }
    });

    it("adapter passes parts, contentStatus, eventKind, and quality into inbound callback", async () => {
      const adapter = new PlaywrightMessengerAdapter({
        profileDir: "./test-profile",
        channelAccountId: "channel-acc-1",
      });

      const mediaBubble: ParsedBubble = {
        id: "mid.$mediaCallback001",
        text: "",
        isOutgoing: false,
        hasMedia: true,
        parts: [
          {
            type: "IMAGE",
            media: {
              mediaId: "img:12345",
              mediaRefId: "mid.$mediaCallback001:image:0",
              role: "ATTACHMENT",
              status: "READY",
              sourceUrl: "https://scontent.xx.fbcdn.net/sample.jpg",
            },
          },
        ],
        contentStatus: "READY",
        eventKind: "MESSAGE_CREATED",
        quality: "TRUSTED",
        contentQuality: "TRUSTED",
        senderId: "customer-999",
        senderKind: "PERSON",
        senderReliability: "VERIFIED",
        threadKind: "DIRECT",
        threadReliability: "VERIFIED",
        observedTimestamp: new Date(),
      };

      const callback = vi.fn().mockResolvedValue(undefined);
      const adapterInternals = adapter as unknown as {
        inboundCallback: typeof callback;
        processInboundBubbles: (
          res: { ok: boolean; bubbles: ParsedBubble[]; isDegraded: boolean },
          info: { threadId: string; customerName: string; avatarUrl: string | null },
          fallback: boolean
        ) => Promise<void>;
      };

      adapterInternals.inboundCallback = callback;
      await adapterInternals.processInboundBubbles(
        {
          ok: true,
          bubbles: [mediaBubble],
          isDegraded: false,
        },
        { threadId: "thread-media-1", customerName: "Khách Media", avatarUrl: null },
        true
      );

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          channelAccountId: "channel-acc-1",
          externalThreadId: "thread-media-1",
          externalMessageId: expect.any(String),
          text: "",
          parts: expect.arrayContaining([
            expect.objectContaining({ type: "IMAGE" }),
          ]),
          contentStatus: "READY",
          eventKind: "MESSAGE_CREATED",
          contentQuality: "TRUSTED",
        })
      );
    });

    it("media-only inbound is recognized as meaningful and NOT dropped as EMPTY_MEANINGLESS", () => {
      const mediaOnlyPayload = {
        channelAccountId: "channel-1",
        externalThreadId: "thread-100",
        externalThreadRef: "https://facebook.com/messages/t/thread-100",
        externalMessageId: "mid.media.meaningful.001",
        text: "",
        timestamp: new Date(),
        parts: [
          {
            type: "IMAGE" as const,
            media: {
              mediaId: "img:hash123",
              role: "ATTACHMENT" as const,
              status: "READY" as const,
              sourceUrl: "https://scontent.xx.fbcdn.net/sample.jpg",
            },
          },
        ],
        contentStatus: "READY" as const,
        eventKind: "MESSAGE_CREATED" as const,
      };

      // 1. InboundMessagePayloadSchema validates successfully without EMPTY_MEANINGLESS error
      const parsed = InboundMessagePayloadSchema.safeParse(mediaOnlyPayload);
      expect(parsed.success).toBe(true);

      // 2. isMeaningfulContent recognizes media parts
      const meaningful = isMeaningfulContent({
        text: mediaOnlyPayload.text,
        parts: mediaOnlyPayload.parts,
        eventKind: mediaOnlyPayload.eventKind,
      });
      expect(meaningful).toBe(true);
    });
  });

  describe("(2) Safe href UI sanitizer", () => {
    it("allows valid http: and https: protocols", () => {
      expect(getSafeHref("https://example.com/image.jpg")).toBe("https://example.com/image.jpg");
      expect(getSafeHref("http://cdn.facebook.com/file.pdf")).toBe("http://cdn.facebook.com/file.pdf");
      expect(getSafeExternalHref("https://facebook.com/messages")).toBe("https://facebook.com/messages");
    });

    it("allows internal /api/... routes for safe href", () => {
      expect(getSafeHref("/api/media/download/123")).toBe("/api/media/download/123");
      expect(getSafeHref("/api/inbox")).toBe("/api/inbox");
      // But disallows other relative paths
      expect(getSafeHref("/admin/settings")).toBeNull();
      expect(getSafeHref("../secret")).toBeNull();
      // External links forbid internal paths
      expect(getSafeExternalHref("/api/media/download/123")).toBeNull();
    });

    it("strictly blocks javascript:, data:, file:, vbscript: and protocol-relative URLs", () => {
      expect(getSafeHref("javascript:alert(1)")).toBeNull();
      expect(getSafeHref("JAVASCRIPT:void(0)")).toBeNull();
      expect(getSafeHref("data:text/html,<script>alert(1)</script>")).toBeNull();
      expect(getSafeHref("DATA:image/svg+xml;base64,PHN2Zy...")).toBeNull();
      expect(getSafeHref("file:///etc/passwd")).toBeNull();
      expect(getSafeHref("file://C:/Windows/system32")).toBeNull();
      expect(getSafeHref("vbscript:msgbox(1)")).toBeNull();
      expect(getSafeHref("//evil.com/xss")).toBeNull();

      // Also for media src
      expect(getSafeMediaSrc("javascript:alert(1)")).toBeNull();
      expect(getSafeMediaSrc("data:text/html,<script>alert(1)</script>")).toBeNull();
      expect(getSafeMediaSrc("file:///etc/hosts")).toBeNull();
    });

    it("permits blob: URLs only for same-origin media rendering, never for external navigation", () => {
      // External navigation (<a target="_blank">) must NEVER allow blob:
      expect(getSafeExternalHref("blob:http://localhost/1234-5678")).toBeNull();
      expect(getSafeHref("blob:http://localhost/1234-5678", { allowBlob: false })).toBeNull();

      // Media rendering permits blob:
      const safeBlob = getSafeMediaSrc("blob:http://localhost/1234-5678");
      expect(safeBlob).toBe("blob:http://localhost/1234-5678");
    });
  });

  describe("(3) SSRF DNS resolve A/AAAA & redirect revalidation", () => {
    it("blocks private, loopback, link-local, and cloud metadata IP literals", () => {
      expect(isPrivateOrBlockedIp("127.0.0.1")).toBe(true);
      expect(isPrivateOrBlockedIp("10.0.0.1")).toBe(true);
      expect(isPrivateOrBlockedIp("192.168.1.1")).toBe(true);
      expect(isPrivateOrBlockedIp("172.16.0.1")).toBe(true);
      expect(isPrivateOrBlockedIp("169.254.169.254")).toBe(true); // AWS/GCP/Azure
      expect(isPrivateOrBlockedIp("100.100.100.200")).toBe(true); // Alibaba Cloud
      expect(isPrivateOrBlockedIp("::1")).toBe(true);
      expect(isPrivateOrBlockedIp("fe80::1")).toBe(true);
      expect(isPrivateOrBlockedIp("fd00:ec2::254")).toBe(true); // AWS IPv6 metadata
    });

    it("resolveAndValidateDns resolves A/AAAA and rejects hostnames pointing to private IPv4", async () => {
      const mockResolver = {
        resolve4: vi.fn().mockResolvedValue(["127.0.0.1"]),
        resolve6: vi.fn().mockRejectedValue(new Error("ENODATA")),
      };

      const result = await resolveAndValidateDns("spoofed-internal.nip.io", mockResolver);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("RESOLVED_BLOCKED_IP");
      expect(result.resolvedIps).toContain("127.0.0.1");
    });

    it("resolveAndValidateDns resolves A/AAAA and rejects hostnames pointing to private IPv6", async () => {
      const mockResolver = {
        resolve4: vi.fn().mockRejectedValue(new Error("ENODATA")),
        resolve6: vi.fn().mockResolvedValue(["::1"]),
      };

      const result = await resolveAndValidateDns("ipv6-loopback.example", mockResolver);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("RESOLVED_BLOCKED_IP");
    });

    it("resolveAndValidateDns rejects multi-IP responses if any IP is private or link-local", async () => {
      const mockResolver = {
        resolve4: vi.fn().mockResolvedValue(["8.8.8.8", "169.254.169.254"]),
        resolve6: vi.fn().mockResolvedValue([]),
      };

      const result = await resolveAndValidateDns("dual-homed-metadata.example", mockResolver);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("RESOLVED_BLOCKED_IP");
    });

    it("fetchMediaSecurely checks DNS prior to request and aborts on blocked resolved IP", async () => {
      const mockResolver = {
        resolve4: vi.fn().mockResolvedValue(["10.0.0.5"]),
        resolve6: vi.fn().mockRejectedValue(new Error("ENODATA")),
      };
      const mockFetch = vi.fn();

      const result = await fetchMediaSecurely("https://malicious-private-hop.com/image.png", {
        dnsResolver: mockResolver,
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe("ERROR");
      expect(result.error).toContain("RESOLVED_BLOCKED_IP");
      // Fetch was NEVER called
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("fetchMediaSecurely revalidates DNS on redirect and blocks redirect to private IP", async () => {
      const mockResolver = {
        resolve4: vi.fn((host: string) => {
          if (host === "public-gateway.com") {
            return Promise.resolve(["93.184.216.34"]); // Safe public IP
          }
          if (host === "internal-vault.company.lan") {
            return Promise.resolve(["192.168.1.50"]); // Private IP
          }
          return Promise.resolve(["127.0.0.1"]);
        }),
        resolve6: vi.fn().mockRejectedValue(new Error("ENODATA")),
      };

      const mockFetch = vi.fn().mockResolvedValue({
        status: 302,
        ok: false,
        headers: new Headers({
          location: "https://internal-vault.company.lan/secret-image.jpg",
        }),
      });

      const result = await fetchMediaSecurely("https://public-gateway.com/redirect", {
        dnsResolver: mockResolver,
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe("ERROR");
      expect(result.error).toContain("REDIRECT_TO_UNSAFE_HOST");
      // Initial fetch was called, but redirect was blocked before second fetch
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("(4) Cursor UUID validation before SQL cast", () => {
    const createChainFor = (rows: unknown[] = []) => {
      const chain: unknown = {
        from: vi.fn(() => chain),
        leftJoin: vi.fn(() => chain),
        where: vi.fn(() => chain),
        orderBy: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        offset: vi.fn(() => chain),
        then: (resolve: (val: unknown[]) => unknown) => resolve(rows),
        [Symbol.iterator]: function* () {
          for (const row of rows) {
            yield row;
          }
        },
      };
      return chain;
    };

    const setupTestFastify = async () => {
      const fastify = Fastify();
      const mockDb = {
        select: vi.fn((selector?: unknown) => {
          if (selector && typeof selector === "object" && "count" in selector) {
            return createChainFor([{ count: 0 }]);
          }
          return createChainFor([]);
        }),
        execute: vi.fn().mockResolvedValue([]),
      };

      const mockConvRepo = {
        getConversationById: vi.fn((id: string) => {
          if (id === "conv-404") return Promise.resolve(null);
          return Promise.resolve({
            conversation: { id, channelAccountId: "channel-1" },
            customer: { id: "cust-1", name: "Test" },
          });
        }),
      };

      const mockBroadcaster = {
        addClient: vi.fn().mockResolvedValue(undefined),
        broadcast: vi.fn(),
      };

      const requireAuth = vi.fn().mockResolvedValue({
        id: "user-1",
        email: "agent@example.com",
        role: "AGENT",
      });

      await fastify.register(
        createInboxRoutes({
          db: mockDb as unknown as import("@messenger/db").Database,
          convRepo: mockConvRepo as unknown as import("@messenger/db").ConversationRepository,
          queueRepo: {} as unknown as import("@messenger/db").QueueRepository,
          outboundRepo: {} as unknown as import("@messenger/db").OutboundRepository,
          eventRepo: { getRecentEvents: vi.fn().mockResolvedValue([]) } as unknown as import("@messenger/db").EventRepository,
          outboxRepo: {} as unknown as import("@messenger/db").OutboxRepository,
          channelAccountId: "channel-1",
          broadcaster: mockBroadcaster as unknown as import("../apps/core/src/sse/outbox-broadcaster.js").OutboxBroadcaster,
          requireAuth,
        })
      );

      await fastify.ready();
      return fastify;
    };

    it("returns HTTP 400 for invalid UUID in compound messageCursor", async () => {
      const app = await setupTestFastify();

      const response = await app.inject({
        method: "GET",
        url: "/api/inbox/conv-1?messageCursor=2026-09-07T12:00:00.000Z__not-a-valid-uuid",
      });

      expect(response.statusCode).toBe(400);
      const json = JSON.parse(response.payload);
      expect(json.error).toContain("Invalid cursor");
      expect(json.error).toContain("UUID");
    });

    it("returns HTTP 400 for invalid timestamp in compound messageCursor", async () => {
      const app = await setupTestFastify();

      const response = await app.inject({
        method: "GET",
        url: "/api/inbox/conv-1?messageCursor=invalid-date__11111111-1111-1111-1111-111111111111",
      });

      expect(response.statusCode).toBe(400);
      const json = JSON.parse(response.payload);
      expect(json.error).toContain("Invalid cursor");
    });

    it("returns HTTP 400 for invalid single messageCursor", async () => {
      const app = await setupTestFastify();

      const response = await app.inject({
        method: "GET",
        url: "/api/inbox/conv-1?messageCursor=completely-invalid-date",
      });

      expect(response.statusCode).toBe(400);
      const json = JSON.parse(response.payload);
      expect(json.error).toContain("Invalid cursor");
    });

    it("returns HTTP 400 for invalid cursor in /api/inbox", async () => {
      const app = await setupTestFastify();

      const response = await app.inject({
        method: "GET",
        url: "/api/inbox?cursor=not-a-date",
      });

      expect(response.statusCode).toBe(400);
      const json = JSON.parse(response.payload);
      expect(json.error).toContain("Invalid cursor");
    });

    it("outboxRepo.getEventsSince safely ignores invalid UUID cursor without 500 error", async () => {
      const mockDb = {
        execute: vi.fn().mockResolvedValue([]),
      };
      const outboxRepo = new OutboxRepository(mockDb as unknown as import("@messenger/db").Database);

      const events = await outboxRepo.getEventsSince("channel-1", "invalid-not-a-uuid-cursor");
      expect(events).toEqual([]);
      // SQL execute was NEVER called because afterId is not a UUID
      expect(mockDb.execute).not.toHaveBeenCalled();
    });

    it("accepts valid compound UUID cursor without error", async () => {
      const app = await setupTestFastify();

      const response = await app.inject({
        method: "GET",
        url: "/api/inbox/conv-1?messageCursor=2026-09-07T12:00:00.000Z__e3b0c442-98fc-1c14-9afb-4c72e04e9c70",
      });

      expect(response.statusCode).toBe(200);
    });
  });
});
