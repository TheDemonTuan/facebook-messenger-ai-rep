import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  parseMessengerBubblesFromHtml,
  parseSidebarThreadsFromHtml,
  parseThreadClassification,
  getUtcDateFromZonedParts,
} from "../packages/channel/src/index.js";
import {
  evaluateReplyEligibility,
  SystemSettingsSchema,
  InboundMessagePayloadSchema,
} from "../packages/contracts/src/index.js";

describe("Messenger DOM Identity, Thread Type, Mention & Timestamp Observation (PR 3)", () => {
  const groupMentionHtml = fs.readFileSync(
    path.resolve(__dirname, "fixtures/messenger-dom-group-mention.html"),
    "utf-8"
  );
  const identitiesHtml = fs.readFileSync(
    path.resolve(__dirname, "fixtures/messenger-dom-identities.html"),
    "utf-8"
  );
  const timestampsHtml = fs.readFileSync(
    path.resolve(__dirname, "fixtures/messenger-dom-timestamps.html"),
    "utf-8"
  );
  const viHtml = fs.readFileSync(
    path.resolve(__dirname, "fixtures/messenger-dom-vi.html"),
    "utf-8"
  );
  const enHtml = fs.readFileSync(
    path.resolve(__dirname, "fixtures/messenger-dom-en.html"),
    "utf-8"
  );
  const degradedHtml = fs.readFileSync(
    path.resolve(__dirname, "fixtures/messenger-dom-degraded.html"),
    "utf-8"
  );

  const mockBotOptions = {
    botParticipantId: "1000888000",
    botProfileUrl: "https://www.facebook.com/profile.php?id=1000888000",
    botChannelAccountId: "personal-messenger",
    timeZone: "Asia/Ho_Chi_Minh",
  };

  describe("production receipt/avatar regressions", () => {
    it("keeps a text-only message text and excludes sender/seen-head avatars", () => {
      const html = `
        <main data-testid="direct_thread_header">
          <div role="row" aria-roledescription="message" id="mid.$huii" aria-label="Sin Sin: huii">
            <a href="/100010082286691"><img src="https://scontent.example/avatar.jpg" alt="Sin Sin" data-render-width="40" data-render-height="40"></a>
            <div dir="auto">huii</div>
            <div aria-label="Seen by Sin Sin at Monday 10:24pm">
              <img src="https://scontent.example/avatar.jpg" alt="Seen by Sin Sin at Monday 10:24pm" data-render-width="14" data-render-height="14" data-message-status-image="true">
            </div>
          </div>
        </main>`;

      const result = parseMessengerBubblesFromHtml(html, mockBotOptions);

      expect(result.bubbles).toHaveLength(1);
      expect(result.bubbles[0]!.id).toBe("mid.$huii");
      expect(result.bubbles[0]!.text).toBe("huii");
      expect(result.bubbles[0]!.parts).toEqual([{ type: "TEXT", text: "huii" }]);
    });

    it("still accepts a large image explicitly marked by the live DOM collector", () => {
      const html = `
        <main data-testid="direct_thread_header">
          <div role="row" aria-roledescription="message" id="mid.$photo" aria-label="Sin Sin sent a photo">
            <img src="https://scontent.example/photo.jpg" alt="Photo" data-render-width="640" data-render-height="480" data-message-attachment-image="true">
          </div>
        </main>`;

      const result = parseMessengerBubblesFromHtml(html, mockBotOptions);

      expect(result.bubbles).toHaveLength(1);
      expect(result.bubbles[0]!.parts?.map((part) => part.type)).toEqual(["IMAGE"]);
    });
  });

  describe("1. Thread Classification", () => {
    it("classifies group thread with verified evidence from member count and group header", () => {
      const result = parseThreadClassification(groupMentionHtml);
      expect(result.kind).toBe("GROUP");
      expect(result.reliability).toBe("VERIFIED");
      expect(result.evidence.length).toBeGreaterThan(0);
      expect(result.evidence[0]!.source).toBe("DOM_SELECTOR");
      expect(result.evidence[0]!.confidence).toBe(1.0);
    });

    it("classifies direct thread with verified evidence", () => {
      const directHtml = `
        <div role="banner">
          <div aria-label="Thông tin cuộc trò chuyện" data-testid="direct_chat_header">
            <span>Nguyễn Văn An</span>
          </div>
        </div>
      `;
      const result = parseThreadClassification(directHtml);
      expect(result.kind).toBe("DIRECT");
      expect(result.reliability).toBe("VERIFIED");
      expect(result.evidence[0]!.signal).toBe("direct_header_indicator");
    });

    it("emits UNKNOWN and UNVERIFIED when thread cues are absent or ambiguous", () => {
      const ambiguousHtml = `<div><span>Some random page text</span></div>`;
      const result = parseThreadClassification(ambiguousHtml);
      expect(result.kind).toBe("UNKNOWN");
      expect(result.reliability).toBe("UNVERIFIED");
      expect(result.evidence).toEqual([]);
    });

    it("preserves sidebar parsing with unverified threadKind indicators", () => {
      const sidebarHtml = `
        <a href="https://www.facebook.com/messages/t/12345">
          <span>Nhóm Mua Hàng Sỉ (5 thành viên)</span>
          <div class="unread"></div>
          <div>Bạn: ok</div>
        </a>
        <a href="https://www.facebook.com/messages/e2ee/t/67890">
          <span>Sin</span>
          <div class="unread"></div>
          <div>alo</div>
        </a>
      `;
      const threads = parseSidebarThreadsFromHtml(sidebarHtml);
      expect(threads.length).toBe(2);
      expect(threads[0]!.threadKind).toBe("GROUP");
      expect(threads[0]!.threadReliability).toBe("UNVERIFIED");
      expect(threads[1]!.threadId).toBe("67890");
      expect(threads[1]!.threadKind).toBe("DIRECT");
    });
    it("extracts multiple sidebar threads with cleaned snippet, name, avatar, participant ID, annotations, unread polarity, and dedupes same threadId", () => {
      const html = `
        <a href="https://www.facebook.com/messages/t/111"
           data-messenger-customer-name="Annotated Customer"
           data-messenger-snippet="Annotated snippet text"
           data-messenger-unread="true"
           data-messenger-participant-id="part-111"
           data-messenger-avatar-url="https://scontent.xx/avatar1.jpg">
          <span>Fallback Customer</span>
          <div>Fallback snippet</div>
        </a>
        <a href="https://www.facebook.com/messages/e2ee/t/222" aria-label="Đoạn chat với Khách E2EE, chưa đọc">
          <span dir="auto">Khách E2EE</span>
          <img src="https://fbcdn.net/avatar2.jpg" />
          <div class="unread"></div>
          <div>Khách E2EE: Alo shop ơi · 5 phút</div>
        </a>
        <a href="https://www.facebook.com/messages/t/333" aria-label="Đoạn chat với Đã Đọc">
          <span dir="auto">Đã Đọc</span>
          <div aria-label="Đánh dấu là chưa đọc"></div>
          <div>Cảm ơn shop nhiều</div>
        </a>
        <a href="https://www.facebook.com/messages/t/111">
          <span>Duplicate Link</span>
        </a>
      `;

      const threads = parseSidebarThreadsFromHtml(html);
      expect(threads).toHaveLength(3);

      // Thread 1: Annotated values prioritized
      expect(threads[0]?.threadId).toBe("111");
      expect(threads[0]?.customerName).toBe("Annotated Customer");
      expect(threads[0]?.snippet).toBe("Annotated snippet text");
      expect(threads[0]?.isUnread).toBe(true);
      expect(threads[0]?.participantId).toBe("part-111");
      expect(threads[0]?.avatarUrl).toBe("https://scontent.xx/avatar1.jpg");

      // Thread 2: E2EE route preserved, clean snippet, avatar, unread
      expect(threads[1]?.threadId).toBe("222");
      expect(threads[1]?.threadRef).toBe("https://www.facebook.com/messages/e2ee/t/222");
      expect(threads[1]?.customerName).toBe("Khách E2EE");
      expect(threads[1]?.avatarUrl).toBe("https://fbcdn.net/avatar2.jpg");
      expect(threads[1]?.snippet).toBe("Alo shop ơi");
      expect(threads[1]?.isUnread).toBe(true);
      expect(threads[1]?.participantId).toBe("222");

      // Thread 3: "Mark as unread" action must NOT be treated as unread
      expect(threads[2]?.threadId).toBe("333");
      expect(threads[2]?.customerName).toBe("Đã Đọc");
      expect(threads[2]?.isUnread).toBe(false);
    });
  });

  describe("2. Sender Identity & Sender Kind Parsing", () => {
    it("parses PERSON sender with structured profile URL and stable entity ID", () => {
      const result = parseMessengerBubblesFromHtml(identitiesHtml);
      expect(result.ok).toBe(true);

      const personBubble = result.bubbles[0]!;
      expect(personBubble.id).toBe("mid.$gABident1001");
      expect(personBubble.senderKind).toBe("PERSON");
      expect(personBubble.senderReliability).toBe("VERIFIED");
      expect(personBubble.senderId).toBe("alice.nguyen.123");
      expect(personBubble.senderProfileUrl).toBe("https://www.facebook.com/alice.nguyen.123");
      expect(personBubble.senderName).toBe("Alice Nguyễn");
    });

    it("parses PAGE sender with verified Page badge and profile link", () => {
      const result = parseMessengerBubblesFromHtml(identitiesHtml);
      const pageBubble = result.bubbles[1]!;

      expect(pageBubble.id).toBe("mid.$gABident1002");
      expect(pageBubble.senderKind).toBe("PAGE");
      expect(pageBubble.senderReliability).toBe("VERIFIED");
      expect(pageBubble.senderId).toBe("100077700011");
      expect(pageBubble.senderProfileUrl).toBe("https://www.facebook.com/pages/vietnam-apparel/100077700011");
    });

    it("parses NON_PERSON system message with verified reliability", () => {
      const result = parseMessengerBubblesFromHtml(identitiesHtml);
      const systemBubble = result.bubbles[2]!;

      expect(systemBubble.id).toBe("mid.$gABident1003");
      expect(systemBubble.senderKind).toBe("NON_PERSON");
      expect(systemBubble.senderReliability).toBe("VERIFIED");
      expect(systemBubble.senderId).toBe("system");
    });

    it("fails closed for UNKNOWN sender without structured identity evidence (names/avatars/text are not proof)", () => {
      const result = parseMessengerBubblesFromHtml(identitiesHtml);
      const unknownBubble = result.bubbles[3]!;

      expect(unknownBubble.id).toBe("mid.$gABident1004");
      expect(unknownBubble.senderKind).toBe("UNKNOWN");
      expect(unknownBubble.senderReliability).toBe("UNVERIFIED");
      expect(unknownBubble.senderId).toBeNull();
      expect(unknownBubble.senderProfileUrl).toBeNull();
      expect(unknownBubble.senderName).toBe("Khách Ẩn Danh");
    });
  });

  describe("3. Structured Mentions & Group Mention Verification", () => {
    it("verifies structured mention linking to configured bot profile metadata", () => {
      const result = parseMessengerBubblesFromHtml(groupMentionHtml, mockBotOptions);
      expect(result.ok).toBe(true);

      const verifiedMentionBubble = result.bubbles[0]!;
      expect(verifiedMentionBubble.mentions).toBeDefined();
      expect(verifiedMentionBubble.mentions!.length).toBe(1);

      const mention = verifiedMentionBubble.mentions![0]!;
      expect(mention.evidenceType).toBe("DOM_ANCHOR");
      expect(mention.entityId).toBe("1000888000");
      expect(mention.profileUrl).toBe("https://www.facebook.com/profile.php?id=1000888000");
      expect(mention.mentionText).toBe("@ShopBot");
      expect(mention.isVerified).toBe(true);
    });

    it("marks fake plain text mention as unverified TEXT_FALLBACK (never verified)", () => {
      const result = parseMessengerBubblesFromHtml(groupMentionHtml, mockBotOptions);
      const fakeMentionBubble = result.bubbles[1]!;

      expect(fakeMentionBubble.mentions).toBeDefined();
      expect(fakeMentionBubble.mentions!.length).toBe(1);

      const mention = fakeMentionBubble.mentions![0]!;
      expect(mention.evidenceType).toBe("TEXT_FALLBACK");
      expect(mention.entityId).toBe("");
      expect(mention.profileUrl).toBeNull();
      expect(mention.mentionText).toBe("@ShopBot");
      expect(mention.isVerified).toBe(false);
    });

    it("does not verify mention of another group member as bot mention", () => {
      const result = parseMessengerBubblesFromHtml(groupMentionHtml, mockBotOptions);
      const otherMentionBubble = result.bubbles[2]!;

      expect(otherMentionBubble.mentions).toBeDefined();
      expect(otherMentionBubble.mentions!.length).toBe(1);

      const mention = otherMentionBubble.mentions![0]!;
      expect(mention.evidenceType).toBe("DOM_ANCHOR");
      expect(mention.entityId).toBe("100099999999");
      expect(mention.isVerified).toBe(false);
    });
  });

  describe("4. Timestamp Observation & Timezone Conversion", () => {
    it("extracts exact ISO datetime attribute with FACEBOOK_EVENT provenance", () => {
      const result = parseMessengerBubblesFromHtml(timestampsHtml, mockBotOptions);
      const b1 = result.bubbles[0]!;

      expect(b1.timestampProvenance).toBe("FACEBOOK_EVENT");
      expect(b1.timestampPrecision).toBe("SECOND");
      expect(b1.facebookEventTimestamp).toEqual(new Date("2026-09-05T07:30:00.000Z"));
      expect(b1.timestamps?.facebookEvent?.provenance).toBe("FACEBOOK_EVENT");
    });

    it("extracts epoch milliseconds attribute with FACEBOOK_EVENT provenance", () => {
      const result = parseMessengerBubblesFromHtml(timestampsHtml, mockBotOptions);
      const b2 = result.bubbles[1]!;

      expect(b2.timestampProvenance).toBe("FACEBOOK_EVENT");
      expect(b2.timestampPrecision).toBe("MILLISECOND");
      expect(b2.facebookEventTimestamp).toEqual(new Date(1788614546000));
    });

    it("parses localized Vietnamese time today in business timezone Asia/Ho_Chi_Minh without fixed offsets", () => {
      const fixedObserved = new Date("2026-09-05T09:00:00.000Z"); // 16:00 in Asia/Ho_Chi_Minh
      const result = parseMessengerBubblesFromHtml(timestampsHtml, {
        ...mockBotOptions,
        observedAt: fixedObserved,
      });
      const b3 = result.bubbles[2]!; // 14:30 today

      expect(b3.timestampProvenance).toBe("FACEBOOK_EVENT");
      expect(b3.timestampPrecision).toBe("MINUTE");
      // 14:30 in Asia/Ho_Chi_Minh (UTC+7) is 07:30 UTC
      expect(b3.facebookEventTimestamp?.toISOString()).toBe("2026-09-05T07:30:00.000Z");
    });

    it("parses localized Vietnamese yesterday time correctly", () => {
      const fixedObserved = new Date("2026-09-05T09:00:00.000Z"); // 16:00 on Sep 5 in Asia/Ho_Chi_Minh
      const result = parseMessengerBubblesFromHtml(timestampsHtml, {
        ...mockBotOptions,
        observedAt: fixedObserved,
      });
      const b4 = result.bubbles[3]!; // Hôm qua lúc 14:30 -> Sep 4 14:30 in Asia/Ho_Chi_Minh = Sep 4 07:30 UTC

      expect(b4.timestampProvenance).toBe("FACEBOOK_EVENT");
      expect(b4.facebookEventTimestamp?.toISOString()).toBe("2026-09-04T07:30:00.000Z");
    });

    it("parses localized English 2:30 PM correctly in business timezone", () => {
      const fixedObserved = new Date("2026-09-05T09:00:00.000Z");
      const result = parseMessengerBubblesFromHtml(timestampsHtml, {
        ...mockBotOptions,
        observedAt: fixedObserved,
      });
      const b5 = result.bubbles[4]!; // 2:30 PM today = 14:30 = 07:30 UTC

      expect(b5.timestampProvenance).toBe("FACEBOOK_EVENT");
      expect(b5.facebookEventTimestamp?.toISOString()).toBe("2026-09-05T07:30:00.000Z");
    });

    it("carries OBSERVED timestamp and null facebookEvent for degraded/missing timestamp (does not pretend fallback is FB exact)", () => {
      const fixedObserved = new Date("2026-09-05T12:00:00.000Z");
      const result = parseMessengerBubblesFromHtml(timestampsHtml, {
        ...mockBotOptions,
        observedAt: fixedObserved,
      });
      const b6 = result.bubbles[5]!;

      expect(b6.timestampProvenance).toBe("OBSERVED");
      expect(b6.timestampPrecision).toBe("MILLISECOND");
      expect(b6.facebookEventTimestamp).toBeNull();
      expect(b6.observedTimestamp).toEqual(fixedObserved);
      expect(b6.timestamps?.facebookEvent).toBeNull();
      expect(b6.timestamps?.observed.provenance).toBe("OBSERVED");
    });

    it("verifies pure timezone math with getUtcDateFromZonedParts across timezones", () => {
      // 14:30 on 2026-09-05 in Asia/Tokyo (UTC+9) is 05:30 UTC
      const tokyoDate = getUtcDateFromZonedParts(
        { year: 2026, month: 9, day: 5, hour: 14, minute: 30 },
        "Asia/Tokyo"
      );
      expect(tokyoDate.toISOString()).toBe("2026-09-05T05:30:00.000Z");

      // 14:30 on 2026-09-05 in America/New_York (EDT = UTC-4) is 18:30 UTC
      const nyDate = getUtcDateFromZonedParts(
        { year: 2026, month: 9, day: 5, hour: 14, minute: 30 },
        "America/New_York"
      );
      expect(nyDate.toISOString()).toBe("2026-09-05T18:30:00.000Z");
    });
  });

  describe("5. End-to-End Contract & Reply Policy Integration", () => {
    it("evaluates ELIGIBLE for group message with verified bot mention", () => {
      const parsed = parseMessengerBubblesFromHtml(groupMentionHtml, mockBotOptions);
      const bubble = parsed.bubbles[0]!;

      const payload = InboundMessagePayloadSchema.parse({
        channelAccountId: "personal-messenger",
        externalThreadId: "grp-12345",
        externalThreadRef: "https://www.facebook.com/messages/t/grp-12345",
        externalCustomerId: bubble.senderId,
        customerName: bubble.senderName,
        externalMessageId: bubble.id,
        text: bubble.text,
        timestamp: bubble.facebookEventTimestamp || new Date(),
        threadKind: bubble.threadKind,
        threadReliability: bubble.threadReliability,
        senderKind: bubble.senderKind,
        senderReliability: bubble.senderReliability,
        senderExternalId: bubble.senderId,
        senderParticipantId: bubble.senderId,
        participantIdentity: {
          channelAccountId: "personal-messenger",
          participantId: bubble.senderId!,
          senderKind: bubble.senderKind!,
          isVerified: true,
          profileUrl: bubble.senderProfileUrl,
          displayName: bubble.senderName,
          verifiedAt: new Date(),
          metadata: {},
        },
        mentions: bubble.mentions,
        timestamps: bubble.timestamps,
      });

      const decision = evaluateReplyEligibility({
        channel: {
          id: "personal-messenger",
          accountType: "PERSONAL_MESSENGER",
          botParticipantId: "1000888000",
          botProfileUrl: "https://www.facebook.com/profile.php?id=1000888000",
        },
        thread: {
          id: "conv-1",
          externalThreadId: payload.externalThreadId,
          kind: payload.threadKind!,
          reliability: payload.threadReliability!,
        },
        sender: {
          id: payload.senderParticipantId!,
          kind: payload.senderKind!,
          reliability: payload.senderReliability!,
          participantIdentity: payload.participantIdentity,
        },
        message: {
          id: "msg-1",
          direction: "INBOUND",
          actor: "SYSTEM",
          text: payload.text,
          mentions: payload.mentions!,
          timestamps: payload.timestamps,
        },
        settings: SystemSettingsSchema.parse({
          groupRepliesEnabled: true,
          requireGroupMention: true,
        }),
      });

      expect(decision.eligible).toBe(true);
      expect(decision.decision).toBe("ELIGIBLE");
      expect(decision.reasonCode).toBe("ELIGIBLE");
    });

    it("evaluates INELIGIBLE (GROUP_MENTION_REQUIRED) for group message with fake plain text mention", () => {
      const parsed = parseMessengerBubblesFromHtml(groupMentionHtml, mockBotOptions);
      const bubble = parsed.bubbles[1]!; // Fake plain text mention

      const decision = evaluateReplyEligibility({
        channel: {
          id: "personal-messenger",
          accountType: "PERSONAL_MESSENGER",
          botParticipantId: "1000888000",
          botProfileUrl: "https://www.facebook.com/profile.php?id=1000888000",
        },
        thread: {
          id: "conv-1",
          kind: bubble.threadKind!,
          reliability: bubble.threadReliability!,
        },
        sender: {
          id: bubble.senderId!,
          kind: bubble.senderKind!,
          reliability: bubble.senderReliability!,
        },
        message: {
          id: "msg-2",
          direction: "INBOUND",
          actor: "SYSTEM",
          text: bubble.text,
          mentions: bubble.mentions!,
          timestamps: bubble.timestamps,
        },
        settings: SystemSettingsSchema.parse({
          groupRepliesEnabled: true,
          requireGroupMention: true,
        }),
      });

      expect(decision.eligible).toBe(false);
      expect(decision.reasonCode).toBe("GROUP_MENTION_REQUIRED");
    });

    it("evaluates INELIGIBLE (UNVERIFIED_SENDER_CLASSIFICATION) when sender is UNKNOWN / UNVERIFIED", () => {
      const parsed = parseMessengerBubblesFromHtml(identitiesHtml, mockBotOptions);
      const unknownBubble = parsed.bubbles[3]!;

      const decision = evaluateReplyEligibility({
        channel: {
          id: "personal-messenger",
          accountType: "PERSONAL_MESSENGER",
        },
        thread: {
          kind: "DIRECT",
          reliability: "VERIFIED",
        },
        sender: {
          id: unknownBubble.senderId || undefined,
          kind: unknownBubble.senderKind!,
          reliability: unknownBubble.senderReliability!,
        },
        message: {
          direction: "INBOUND",
          actor: "SYSTEM",
          text: unknownBubble.text,
        },
        settings: SystemSettingsSchema.parse({}),
      });

      expect(decision.eligible).toBe(false);
      expect(decision.reasonCode).toBe("UNKNOWN_SENDER_KIND");
    });

    it("evaluates INELIGIBLE (PAGE_REPLIES_DISABLED) when sender is PAGE and pageRepliesEnabled is false", () => {
      const parsed = parseMessengerBubblesFromHtml(identitiesHtml, mockBotOptions);
      const pageBubble = parsed.bubbles[1]!;

      const decision = evaluateReplyEligibility({
        channel: {
          id: "personal-messenger",
          accountType: "PERSONAL_MESSENGER",
        },
        thread: {
          kind: "DIRECT",
          reliability: "VERIFIED",
        },
        sender: {
          id: pageBubble.senderId!,
          kind: pageBubble.senderKind!,
          reliability: pageBubble.senderReliability!,
        },
        message: {
          direction: "INBOUND",
          actor: "SYSTEM",
          text: pageBubble.text,
        },
        settings: SystemSettingsSchema.parse({
          pageRepliesEnabled: false,
        }),
      });

      expect(decision.eligible).toBe(false);
      expect(decision.reasonCode).toBe("PAGE_REPLIES_DISABLED");
    });
  });

  describe("6. Degraded DOM & Existing Fixtures Compatibility", () => {
    it("marks isDegraded = true when row lacks stable mid (never invents fallback ID)", () => {
      const result = parseMessengerBubblesFromHtml(degradedHtml);
      expect(result.ok).toBe(false);
      expect(result.isDegraded).toBe(true);
      expect(result.degradedReason).toContain("missing stable mid identifier");
    });

    it("parses current Facebook message containers without role=row", () => {
      const result = parseMessengerBubblesFromHtml(`
        <div role="main">
          <div aria-label="At 11:27 AM, Sin: nhan chua"
               aria-roledescription="message"
               data-message-id="mid.$liveInbound001"
               data-scope="messages_table">
            <div dir="auto">nhan chua</div>
          </div>
          <div aria-label="At 11:28 AM, You: anh nhận rồi"
               aria-roledescription="message"
               data-message-id="mid.$liveOutbound002"
               data-scope="messages_table">
            <div dir="auto">anh nhận rồi</div>
          </div>
        </div>
      `);

      expect(result.isDegraded).toBe(false);
      expect(result.bubbles).toHaveLength(2);
      expect(result.bubbles[0]).toMatchObject({
        id: "mid.$liveInbound001",
        text: "nhan chua",
        isOutgoing: false,
        senderName: "Sin",
      });
      expect(result.bubbles[1]).toMatchObject({
        id: "mid.$liveOutbound002",
        text: "anh nhận rồi",
        isOutgoing: true,
      });
    });

    it("uses current Messenger header controls to classify direct and group threads", () => {
      const direct = parseMessengerBubblesFromHtml(
        `<div role="main">Sin Sin Active now Profile Mute Search Chat info</div>`,
        { threadTitleHint: "Sin Sin" }
      );
      const group = parseMessengerBubblesFromHtml(
        `<div role="main"><header>Điền trang chó BuDop Club Active now Chat members Media</header></div>`,
        { threadTitleHint: "Khải ngoo" }
      );

      expect(direct.threadClassification).toMatchObject({ kind: "DIRECT", reliability: "VERIFIED" });
      expect(group.threadClassification).toMatchObject({ kind: "GROUP", reliability: "VERIFIED" });
    });

    it("uses a direct thread participant hint as verified sender identity", () => {
      const result = parseMessengerBubblesFromHtml(
        `<div aria-label="At 12:31 PM, Sin: chào" aria-roledescription="message" data-message-id="mid.$liveInbound003"><div dir="auto">chào</div></div>`,
        { senderParticipantIdHint: "100010082286691", threadKindHint: "DIRECT", threadReliabilityHint: "VERIFIED" }
      );

      expect(result.bubbles[0]).toMatchObject({
        text: "chào",
        senderId: "100010082286691",
        senderName: "Sin",
        senderKind: "PERSON",
        senderReliability: "VERIFIED",
      });
    });

    it("parses Vietnamese baseline fixture correctly without regression", () => {
      const result = parseMessengerBubblesFromHtml(viHtml);
      expect(result.ok).toBe(true);
      expect(result.isDegraded).toBe(false);
      expect(result.bubbles.length).toBe(3);
      expect(result.bubbles[0]!.text).toBe("Chào shop!");
      expect(result.bubbles[1]!.isOutgoing).toBe(true);
    });

    it("parses English baseline fixture correctly without regression", () => {
      const result = parseMessengerBubblesFromHtml(enHtml);
      expect(result.ok).toBe(true);
      expect(result.isDegraded).toBe(false);
      expect(result.bubbles.length).toBe(3);
      expect(result.bubbles[0]!.text).toBe("Hi there!");
      expect(result.bubbles[1]!.isOutgoing).toBe(true);
    });
  });

  describe("7. Regression Tests for 10 Hardening Issues", () => {
    const regressionsHtml = fs.readFileSync(
      path.resolve(__dirname, "fixtures/messenger-dom-parser-regressions.html"),
      "utf-8"
    );

    it("Issue 1: Sender identity only from opening row attributes or dedicated author elements, never body links", () => {
      const result = parseMessengerBubblesFromHtml(regressionsHtml, mockBotOptions);
      // Row 1 contains a link to https://www.facebook.com/attacker.profile.99 in message text
      const b1 = result.bubbles.find((b) => b.id === "mid.$regIssue001");
      expect(b1).toBeDefined();
      expect(b1!.senderId).toBeNull();
      expect(b1!.senderKind).toBe("UNKNOWN");
      expect(b1!.senderReliability).toBe("UNVERIFIED");
      expect(b1!.senderProfileUrl).toBeNull();
    });

    it("Issue 2: Group classification only from header/banner structured cues (never body text)", () => {
      // In regressionsHtml, header indicates DIRECT conversation, while Row 2 text mentions '50 members' and 'thông tin nhóm'
      const result = parseThreadClassification(regressionsHtml);
      expect(result.kind).toBe("DIRECT");
      expect(result.reliability).toBe("VERIFIED");

      // Without header, body text with '50 members' must fail closed to UNKNOWN
      const bodyOnly = `<div><span>Câu lạc bộ có 50 members và thông tin nhóm</span></div>`;
      const unverifiedResult = parseThreadClassification(bodyOnly);
      expect(unverifiedResult.kind).toBe("UNKNOWN");
      expect(unverifiedResult.reliability).toBe("UNVERIFIED");
    });

    it("Issue 3: Browser snapshot includes header safely when separate from main", () => {
      // regressionsHtml has header in div[role="banner"] and messages in div[role="main"]
      const result = parseMessengerBubblesFromHtml(regressionsHtml, mockBotOptions);
      expect(result.threadClassification?.kind).toBe("DIRECT");
      expect(result.threadClassification?.reliability).toBe("VERIFIED");
      expect(result.bubbles.length).toBeGreaterThan(0);
    });

    it("Issue 4: Degraded only for actual message rows (system/status rows and date dividers do not degrade)", () => {
      // regressionsHtml contains status notices and date dividers lacking MID
      const result = parseMessengerBubblesFromHtml(regressionsHtml, mockBotOptions);
      expect(result.isDegraded).toBe(false);
      expect(result.ok).toBe(true);
    });

    it("Issue 5: Anchor outgoing aria prefixes (customer aria-labels containing 'Bạn đã gửi' or 'You:' are not outgoing)", () => {
      const result = parseMessengerBubblesFromHtml(regressionsHtml, mockBotOptions);
      // Row 3: aria-label="Khách Hàng: Bạn đã gửi nhầm hàng rồi shop ơi"
      const b3 = result.bubbles.find((b) => b.id === "mid.$regIssue003");
      expect(b3).toBeDefined();
      expect(b3!.isOutgoing).toBe(false);

      // Row 4: aria-label="John Doe: You: I need help immediately"
      const b4 = result.bubbles.find((b) => b.id === "mid.$regIssue004");
      expect(b4).toBeDefined();
      expect(b4!.isOutgoing).toBe(false);
    });

    it("Issue 6: Preserve complete nested bubble text across spans, bold, and mention elements", () => {
      const result = parseMessengerBubblesFromHtml(regressionsHtml, mockBotOptions);
      const b5 = result.bubbles.find((b) => b.id === "mid.$regIssue005");
      expect(b5).toBeDefined();
      expect(b5!.text).toBe("Xin chào shop, @ShopBot tôi muốn hỏi về đơn hàng #98765 nhé!");
    });

    it("Issue 7: Two-pass DST offset handling across standard/daylight transition boundaries", () => {
      // In America/New_York, 2026 spring forward occurs on March 8:
      // 01:30 is EST (UTC-5) -> 06:30 UTC
      const nyBefore = getUtcDateFromZonedParts(
        { year: 2026, month: 3, day: 8, hour: 1, minute: 30 },
        "America/New_York"
      );
      expect(nyBefore.toISOString()).toBe("2026-03-08T06:30:00.000Z");

      // 03:30 is EDT (UTC-4) -> 07:30 UTC
      const nyAfter = getUtcDateFromZonedParts(
        { year: 2026, month: 3, day: 8, hour: 3, minute: 30 },
        "America/New_York"
      );
      expect(nyAfter.toISOString()).toBe("2026-03-08T07:30:00.000Z");
    });

    it("Issue 8: Validate date/time bounds and never use row aria-label as timestamp", () => {
      const fixedObserved = new Date("2026-09-05T12:00:00.000Z");
      const result = parseMessengerBubblesFromHtml(regressionsHtml, {
        ...mockBotOptions,
        observedAt: fixedObserved,
      });

      // Row 6: Time only in row aria-label (10:45 AM) without timestamp element -> must fall back to OBSERVED
      const b6 = result.bubbles.find((b) => b.id === "mid.$regIssue006");
      expect(b6).toBeDefined();
      expect(b6!.timestampProvenance).toBe("OBSERVED");
      expect(b6!.facebookEventTimestamp).toBeNull();

      // Row 7: Datetime with invalid year 1995 -> must fall back to OBSERVED
      const b7 = result.bubbles.find((b) => b.id === "mid.$regIssue007");
      expect(b7).toBeDefined();
      expect(b7!.timestampProvenance).toBe("OBSERVED");
      expect(b7!.facebookEventTimestamp).toBeNull();
    });

    it("Issue 9: Relative hour requires ago/trước marker", () => {
      const fixedObserved = new Date("2026-09-05T12:00:00.000Z"); // 19:00 VN time
      const result = parseMessengerBubblesFromHtml(regressionsHtml, {
        ...mockBotOptions,
        observedAt: fixedObserved,
      });

      // Row 8: <time>10:00</time> is clock time 10:00 VN (03:00 UTC), not 10 hours ago
      const b8 = result.bubbles.find((b) => b.id === "mid.$regIssue008");
      expect(b8).toBeDefined();
      expect(b8!.timestampProvenance).toBe("FACEBOOK_EVENT");
      expect(b8!.facebookEventTimestamp?.toISOString()).toBe("2026-09-05T03:00:00.000Z");

      // Row 9: <time>2 giờ trước</time> has 'trước' -> 2 hours before fixedObserved (10:00 UTC)
      const b9 = result.bubbles.find((b) => b.id === "mid.$regIssue009");
      expect(b9).toBeDefined();
      expect(b9!.timestampProvenance).toBe("FACEBOOK_EVENT");
      expect(b9!.facebookEventTimestamp?.toISOString()).toBe("2026-09-05T10:00:00.000Z");
    });

    it("Issue 10: Mentions must be designated structured elements, dedupe normalized tokens, and never parse thread URLs", () => {
      const result = parseMessengerBubblesFromHtml(regressionsHtml, mockBotOptions);

      // Row 10: Generic role=link anchor without mention class is not verified
      const b10 = result.bubbles.find((b) => b.id === "mid.$regIssue010");
      expect(b10).toBeDefined();
      expect(b10!.mentions?.every((m) => !m.isVerified)).toBe(true);

      // Row 11: @ShopBot, @ShopBot, and @shopbot in same row must be deduped to exactly 1 mention
      const b11 = result.bubbles.find((b) => b.id === "mid.$regIssue011");
      expect(b11).toBeDefined();
      expect(b11!.mentions?.length).toBe(1);
      expect(b11!.mentions![0]!.isVerified).toBe(true);

      // Row 12: Anchor with thread URL /messages/t/123456789 must never extract entity ID
      const b12 = result.bubbles.find((b) => b.id === "mid.$regIssue012");
      expect(b12).toBeDefined();
      expect(b12!.mentions?.length).toBe(1);
      expect(b12!.mentions![0]!.entityId).toBe("");
      expect(b12!.mentions![0]!.isVerified).toBe(false);
    });
  });

  describe("8. PR-02: Messenger Message Pipeline Boundaries & Sibling Panel Isolation", () => {
    const lastRowPanelHtml = fs.readFileSync(
      path.resolve(__dirname, "fixtures/messenger-dom-last-row-sibling-panel.html"),
      "utf-8"
    );

    it("isolates last message row from sibling panels (Enter, Message sent, Active now, Profile, Mute, Search)", () => {
      const result = parseMessengerBubblesFromHtml(lastRowPanelHtml, mockBotOptions);
      expect(result.ok).toBe(true);
      expect(result.isDegraded).toBe(false);

      const lastBubble = result.bubbles.find((b) => b.id === "mid.$lastRow005");
      expect(lastBubble).toBeDefined();
      expect(lastBubble!.text).toBe("Em muốn lấy 1 áo size L màu đen, shop ship giúp em nhé");

      // Verify no sibling panel text leaked into last bubble
      const forbiddenTokens = [
        "Enter",
        "Message sent",
        "Active 12m ago",
        "Profile",
        "Mute",
        "Search",
        "Chat info",
        "Customize chat",
        "Media, files and links",
        "Privacy & support",
        "Thích",
        "Trả lời",
        "Xem thêm",
        "Đã chuyển",
      ];
      for (const token of forbiddenTokens) {
        expect(lastBubble!.text).not.toContain(token);
      }
    });

    it("preserves legitimate customer words 'Search' and 'Enter' when genuinely inside message bubble", () => {
      const result = parseMessengerBubblesFromHtml(lastRowPanelHtml, mockBotOptions);
      const keywordsBubble = result.bubbles.find((b) => b.id === "mid.$validKeywords003");
      expect(keywordsBubble).toBeDefined();
      expect(keywordsBubble!.text).toBe(
        "Em có thể bấm Enter hoặc dùng ô Search để tra mã sản phẩm không?"
      );
      expect(keywordsBubble!.text).toContain("Enter");
      expect(keywordsBubble!.text).toContain("Search");
    });

    it("classifies conversation kind from header only; group share card in direct conversation remains DIRECT", () => {
      const result = parseMessengerBubblesFromHtml(lastRowPanelHtml, mockBotOptions);
      expect(result.threadClassification).toMatchObject({
        kind: "DIRECT",
        reliability: "VERIFIED",
      });

      // Also verify direct classification via parseThreadClassification directly
      const threadClassification = parseThreadClassification(lastRowPanelHtml);
      expect(threadClassification.kind).toBe("DIRECT");
      expect(threadClassification.reliability).toBe("VERIFIED");
    });

    it("tightens native message ID: rejects arbitrary descendant id and removes loose length >= 12 rule", () => {
      // Row with arbitrary descendant ID lacking trusted MID prefix must be marked degraded
      const degradedHtmlWithArbitraryDescendant = `
        <div role="main">
          <div data-scope="messages_table">
            <div role="row">
              <div id="arbitrary_descendant_container_id_12345" dir="auto">
                Tin nhắn không có mid hợp lệ
              </div>
            </div>
          </div>
        </div>
      `;
      const degradedResult = parseMessengerBubblesFromHtml(degradedHtmlWithArbitraryDescendant);
      expect(degradedResult.isDegraded).toBe(true);
      expect(degradedResult.ok).toBe(false);
      expect(degradedResult.bubbles.length).toBe(0);

      // Row with trusted native mid (mid.$... or data-message-id) is accepted
      const validHtml = `
        <div role="main">
          <div data-scope="messages_table">
            <div role="row" id="mid.$validTest001">
              <div dir="auto">Tin nhắn có ID hợp lệ</div>
            </div>
          </div>
        </div>
      `;
      const validResult = parseMessengerBubblesFromHtml(validHtml);
      expect(validResult.ok).toBe(true);
      expect(validResult.isDegraded).toBe(false);
      expect(validResult.bubbles[0]!.id).toBe("mid.$validTest001");
    });

    it("ensures dedupe textHash is completely unaffected by presence, avatar URL, or button control changes", async () => {
      const crypto = await import("crypto");
      const result1 = parseMessengerBubblesFromHtml(lastRowPanelHtml, mockBotOptions);
      const bubble1 = result1.bubbles.find((b) => b.id === "mid.$lastRow005")!;
      const hash1 = crypto.createHash("sha256").update(bubble1.text.trim()).digest("hex");

      // Mutate presence, avatar token, and button text in the sibling panel and row
      const mutatedHtml = lastRowPanelHtml
        .replace("Active 12m ago", "Active now")
        .replace("avatar_sinsin_token_123.jpg", "avatar_sinsin_token_99999_refreshed.jpg")
        .replace("Enter, Message sent 7:26 PM", "Enter, Message sent 8:30 PM");

      const result2 = parseMessengerBubblesFromHtml(mutatedHtml, mockBotOptions);
      const bubble2 = result2.bubbles.find((b) => b.id === "mid.$lastRow005")!;
      const hash2 = crypto.createHash("sha256").update(bubble2.text.trim()).digest("hex");

      expect(bubble1.text).toBe(bubble2.text);
      expect(hash1).toBe(hash2);
    });

    it("separates quote, avatar, receipt, presence, and action controls within a single row", () => {
      const singleRowHtml = `
        <div role="main">
          <div role="row" id="mid.$singleRowMultiPart">
            <div data-testid="avatar" class="avatar"><img src="/avatar.png" alt="Avatar User" /></div>
            <div data-testid="quoted_message" class="quote"><span>Tin nhắn được trích dẫn</span></div>
            <div class="bubble"><div dir="auto">Nội dung thực sự của tin nhắn</div></div>
            <div role="toolbar" class="message-actions"><button aria-label="Bày tỏ cảm xúc">React</button></div>
            <div data-testid="message_receipt" class="receipt"><span>Message sent 10:00 AM by User</span></div>
            <div data-testid="user_presence" class="presence">Active now</div>
          </div>
        </div>
      `;
      const result = parseMessengerBubblesFromHtml(singleRowHtml);
      expect(result.ok).toBe(true);
      expect(result.bubbles.length).toBe(1);
      expect(result.bubbles[0]!.text).toBe("Nội dung thực sự của tin nhắn");
    });
  });
});
