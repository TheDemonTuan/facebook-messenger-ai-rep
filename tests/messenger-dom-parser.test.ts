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
      `;
      const threads = parseSidebarThreadsFromHtml(sidebarHtml);
      expect(threads.length).toBe(1);
      expect(threads[0]!.threadKind).toBe("GROUP");
      expect(threads[0]!.threadReliability).toBe("UNVERIFIED");
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
});
