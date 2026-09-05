import { describe, it, expect } from "vitest";
import {
  SystemSettingsSchema,
  isValidTimeZone,
  ReplyModeSchema,
  ThreadKindSchema,
  SenderKindSchema,
  ChannelAccountTypeSchema,
  ClassificationReliabilitySchema,
  TimestampProvenanceSchema,
  TimestampPrecisionSchema,
  ReplyEligibilityDecisionSchema,
  ReplyEligibilityReasonCodeSchema,
  ReplyPrecedenceStepSchema,
  MessageSchema,
  InboundMessageSchema,
  InboundMessagePayloadSchema,
  VerifiedParticipantIdentitySchema,
  MentionEvidenceSchema,
  TimestampDetailSchema,
  MessageTimestampsSchema,
  createMessageTimestamps,
  formatChannelScopedParticipantId,
  matchesParticipantList,
  evaluateReplyEligibility,
  type ReplyEligibilityInput,
} from "../packages/contracts/src/index.js";

describe("PR 1: Messenger Reply Eligibility Contracts & Pure Policy", () => {
  describe("1. Settings & IANA Time Zone Contract", () => {
    it("SystemSettingsSchema defines default businessTimeZone as Asia/Ho_Chi_Minh and default replyMode as EVERYONE_EXCEPT", () => {
      const defaults = SystemSettingsSchema.parse({});
      expect(defaults.businessTimeZone).toBe("Asia/Ho_Chi_Minh");
      expect(defaults.replyMode).toBe("EVERYONE_EXCEPT");
      expect(defaults.directRepliesEnabled).toBe(true);
      expect(defaults.groupRepliesEnabled).toBe(false);
      expect(defaults.pageRepliesEnabled).toBe(false);
      expect(defaults.nonPersonRepliesEnabled).toBe(false);
      expect(defaults.requireGroupMention).toBe(true);
      expect(defaults.selectedParticipantIds).toEqual([]);
      expect(defaults.excludedParticipantIds).toEqual([]);
    });

    it("isValidTimeZone validates valid IANA time zone identifiers and rejects invalid ones", () => {
      expect(isValidTimeZone("Asia/Ho_Chi_Minh")).toBe(true);
      expect(isValidTimeZone("UTC")).toBe(true);
      expect(isValidTimeZone("America/New_York")).toBe(true);
      expect(isValidTimeZone("Europe/London")).toBe(true);
      expect(isValidTimeZone("Asia/Tokyo")).toBe(true);

      expect(isValidTimeZone("")).toBe(false);
      expect(isValidTimeZone("   ")).toBe(false);
      expect(isValidTimeZone("Invalid/TimeZone_Name")).toBe(false);
      expect(isValidTimeZone("Mars/Base_Alpha")).toBe(false);
      expect(isValidTimeZone("Vietnam/Hanoi")).toBe(false);
    });

    it("SystemSettingsSchema validates businessTimeZone with refine and rejects invalid timezones", () => {
      const valid = SystemSettingsSchema.safeParse({
        businessTimeZone: "America/Los_Angeles",
      });
      expect(valid.success).toBe(true);

      const invalid = SystemSettingsSchema.safeParse({
        businessTimeZone: "Invalid/Zone",
      });
      expect(invalid.success).toBe(false);
    });

    it("verifies no unknown-enable switch exists on SystemSettingsSchema", () => {
      const keys = Object.keys(SystemSettingsSchema.shape);
      const unknownSwitches = keys.filter((k) => k.toLowerCase().includes("unknown"));
      expect(unknownSwitches).toEqual([]);
    });
  });

  describe("2. Enums and Extended Schemas", () => {
    it("exports all required enums with exact specifications", () => {
      expect(ReplyModeSchema.options).toEqual(["EVERYONE_EXCEPT", "ONLY_SELECTED"]);
      expect(ThreadKindSchema.options).toEqual(["DIRECT", "GROUP", "UNKNOWN"]);
      expect(SenderKindSchema.options).toEqual(["PERSON", "PAGE", "NON_PERSON", "UNKNOWN"]);
      expect(ChannelAccountTypeSchema.options).toEqual(["PERSONAL_MESSENGER", "FACEBOOK_PAGE"]);
      expect(ClassificationReliabilitySchema.options).toEqual(["VERIFIED", "UNVERIFIED"]);
      expect(TimestampProvenanceSchema.options).toEqual([
        "FACEBOOK_EVENT",
        "OBSERVED",
        "SYSTEM",
        "UNKNOWN",
      ]);
      expect(TimestampPrecisionSchema.options).toEqual([
        "MILLISECOND",
        "SECOND",
        "MINUTE",
        "APPROXIMATE",
        "UNKNOWN",
      ]);
      expect(ReplyEligibilityDecisionSchema.options).toEqual(["ELIGIBLE", "INELIGIBLE"]);
      expect(ReplyPrecedenceStepSchema.options).toEqual([
        "HARD_GATES",
        "VERIFIED_CLASSIFICATION",
        "SOURCE_CONTROLS",
        "PERSON_LIST_MODE",
        "PAGE_NON_PERSON_CONTROLS",
        "GROUP_MENTION_REQUIREMENT",
        "ELIGIBLE",
      ]);
      expect(ReplyEligibilityReasonCodeSchema.options).toContain("AUTO_REPLY_DISABLED");
      expect(ReplyEligibilityReasonCodeSchema.options).toContain("UNKNOWN_THREAD_KIND");
      expect(ReplyEligibilityReasonCodeSchema.options).toContain("GROUP_MENTION_REQUIRED");
    });

    it("creates timestamps with provenance, precision, and event vs observed distinction", () => {
      const eventDate = new Date("2026-09-05T08:00:00.000Z");
      const observedDate = new Date("2026-09-05T08:00:02.123Z");

      const timestamps = createMessageTimestamps({
        facebookEventAt: eventDate,
        observedAt: observedDate,
        facebookPrecision: "MINUTE",
        observedPrecision: "MILLISECOND",
      });

      const parsed = MessageTimestampsSchema.parse(timestamps);
      expect(parsed.facebookEvent?.provenance).toBe("FACEBOOK_EVENT");
      expect(parsed.facebookEvent?.precision).toBe("MINUTE");
      expect(parsed.facebookEvent?.timestamp.toISOString()).toBe(eventDate.toISOString());

      expect(parsed.observed.provenance).toBe("OBSERVED");
      expect(parsed.observed.precision).toBe("MILLISECOND");
      expect(parsed.observed.timestamp.toISOString()).toBe(observedDate.toISOString());
    });

    it("supports null facebookEvent when only ingestion observation is available", () => {
      const timestamps = createMessageTimestamps({
        facebookEventAt: null,
      });
      const parsed = MessageTimestampsSchema.parse(timestamps);
      expect(parsed.facebookEvent).toBeNull();
      expect(parsed.observed.provenance).toBe("OBSERVED");
    });

    it("formats and validates channel-scoped participant identity", () => {
      const scopedId = formatChannelScopedParticipantId("chan-100", "user-456");
      expect(scopedId).toBe("chan-100:user-456");

      const identity = VerifiedParticipantIdentitySchema.parse({
        channelAccountId: "chan-100",
        participantId: "user-456",
        senderKind: "PERSON",
        isVerified: true,
        displayName: "Nguyen Van A",
        profileUrl: "https://www.facebook.com/user456",
      });
      expect(identity.channelAccountId).toBe("chan-100");
      expect(identity.isVerified).toBe(true);
    });

    it("validates structured mention evidence with stable entity ID and profile URL", () => {
      const mention = MentionEvidenceSchema.parse({
        entityId: "bot-entity-777",
        profileUrl: "https://www.facebook.com/mybotpage",
        mentionText: "@CustomerBot",
        offset: 0,
        length: 12,
        isVerified: true,
        evidenceType: "DOM_ANCHOR",
      });
      expect(mention.entityId).toBe("bot-entity-777");
      expect(mention.isVerified).toBe(true);
      expect(mention.evidenceType).toBe("DOM_ANCHOR");
    });

    it("preserves backward compatibility when parsing legacy InboundMessagePayload", () => {
      const legacy = InboundMessagePayloadSchema.parse({
        channelAccountId: "chan-1",
        externalThreadId: "thread-1",
        externalThreadRef: "https://facebook.com/messages/t/thread-1",
        externalCustomerId: "cust-1",
        customerName: "Customer",
        externalMessageId: "mid-1",
        text: "Xin chào",
        timestamp: new Date(),
      });

      expect(legacy.channelAccountId).toBe("chan-1");
      expect(legacy.text).toBe("Xin chào");
      expect(legacy.threadKind).toBeUndefined();
      expect(legacy.senderKind).toBeUndefined();

      const legacyInboundMessage = InboundMessageSchema.parse({
        id: "11111111-1111-4111-8111-111111111111",
        channelAccountId: "chan-1",
        conversationId: "22222222-2222-4222-8222-222222222222",
        sourceMessageId: "mid-1",
        text: "Xin chào",
        textHash: "hash-1",
        receivedAt: new Date(),
        createdAt: new Date(),
      });
      expect(legacyInboundMessage.threadKind).toBeUndefined();

      const legacyMessage = MessageSchema.parse({
        id: "33333333-3333-4333-8333-333333333333",
        channelAccountId: "chan-1",
        conversationId: "22222222-2222-4222-8222-222222222222",
        externalMessageId: "mid-1",
        direction: "INBOUND",
        actor: "SYSTEM",
        text: "Xin chào",
        textHash: "hash-1",
        inboundVersion: 1,
        timestamp: new Date(),
        createdAt: new Date(),
      });
      expect(legacyMessage.direction).toBe("INBOUND");

      const timestampDetail = TimestampDetailSchema.parse({
        timestamp: new Date(),
        provenance: "FACEBOOK_EVENT",
        precision: "MINUTE",
      });
      expect(timestampDetail.provenance).toBe("FACEBOOK_EVENT");

      expect(matchesParticipantList(["cust-1"], "chan-1", "cust-1")).toBe(true);
      expect(matchesParticipantList(["chan-1:cust-1"], "chan-1", "cust-1")).toBe(true);
      expect(matchesParticipantList(["chan-2:cust-1"], "chan-1", "cust-1")).toBe(false);
    });
  });

  describe("3. Policy Precedence: Hard Gates", () => {
    function createBaseInput(): ReplyEligibilityInput {
      return {
        channel: {
          id: "chan-01",
          accountType: "PERSONAL_MESSENGER",
          isSuspended: false,
          isPaused: false,
          botParticipantId: "bot-self-01",
          botProfileUrl: "https://facebook.com/bot-self",
        },
        thread: {
          id: "11111111-1111-4111-8111-111111111111",
          externalThreadId: "thread-101",
          kind: "DIRECT",
          reliability: "VERIFIED",
          isBlocked: false,
          manualMode: false,
        },
        sender: {
          id: "cust-202",
          kind: "PERSON",
          reliability: "VERIFIED",
          participantIdentity: {
            channelAccountId: "chan-01",
            participantId: "cust-202",
            senderKind: "PERSON",
            isVerified: true,
          },
        },
        message: {
          id: "msg-303",
          direction: "INBOUND",
          actor: "SYSTEM",
          text: "Xin chao shop",
        },
        settings: SystemSettingsSchema.parse({
          autoReplyEnabled: true,
          pauseIntakeProcessing: false,
          directRepliesEnabled: true,
          groupRepliesEnabled: false,
          replyMode: "EVERYONE_EXCEPT",
        }),
      };
    }

    it("fails when autoReplyEnabled is false", () => {
      const input = createBaseInput();
      input.settings.autoReplyEnabled = false;

      const result = evaluateReplyEligibility(input);
      expect(result.eligible).toBe(false);
      expect(result.decision).toBe("INELIGIBLE");
      expect(result.reasonCode).toBe("AUTO_REPLY_DISABLED");
      expect(result.precedenceStep).toBe("HARD_GATES");
    });

    it("fails when pauseIntakeProcessing is true", () => {
      const input = createBaseInput();
      input.settings.pauseIntakeProcessing = true;

      const result = evaluateReplyEligibility(input);
      expect(result.eligible).toBe(false);
      expect(result.reasonCode).toBe("INTAKE_PAUSED");
      expect(result.precedenceStep).toBe("HARD_GATES");
    });

    it("fails when channel is suspended", () => {
      const input = createBaseInput();
      input.channel.isSuspended = true;

      const result = evaluateReplyEligibility(input);
      expect(result.eligible).toBe(false);
      expect(result.reasonCode).toBe("CHANNEL_SUSPENDED");
      expect(result.precedenceStep).toBe("HARD_GATES");
    });

    it("fails when channel is paused", () => {
      const input = createBaseInput();
      input.channel.isPaused = true;

      const result = evaluateReplyEligibility(input);
      expect(result.eligible).toBe(false);
      expect(result.reasonCode).toBe("CHANNEL_PAUSED");
      expect(result.precedenceStep).toBe("HARD_GATES");
    });

    it("fails when conversation is blocked", () => {
      const input = createBaseInput();
      input.thread.isBlocked = true;

      const result = evaluateReplyEligibility(input);
      expect(result.eligible).toBe(false);
      expect(result.reasonCode).toBe("CONVERSATION_BLOCKED");
      expect(result.precedenceStep).toBe("HARD_GATES");
    });

    it("fails when conversation is in manual operator mode", () => {
      const input = createBaseInput();
      input.thread.manualMode = true;

      const result = evaluateReplyEligibility(input);
      expect(result.eligible).toBe(false);
      expect(result.reasonCode).toBe("CONVERSATION_MANUAL_MODE");
      expect(result.precedenceStep).toBe("HARD_GATES");
    });

    it("fails when message direction is OUTBOUND", () => {
      const input = createBaseInput();
      input.message.direction = "OUTBOUND";

      const result = evaluateReplyEligibility(input);
      expect(result.eligible).toBe(false);
      expect(result.reasonCode).toBe("DIRECTION_NOT_INBOUND");
      expect(result.precedenceStep).toBe("HARD_GATES");
    });

    it("fails when message actor is AI or MANUAL_OWNER (self-authored)", () => {
      const inputAi = createBaseInput();
      inputAi.message.actor = "AI";
      expect(evaluateReplyEligibility(inputAi).reasonCode).toBe("SELF_MESSAGE");

      const inputOwner = createBaseInput();
      inputOwner.message.actor = "MANUAL_OWNER";
      expect(evaluateReplyEligibility(inputOwner).reasonCode).toBe("SELF_MESSAGE");
    });

    it("fails when sender ID matches channel ID or botParticipantId (self-message)", () => {
      const inputChannelId = createBaseInput();
      inputChannelId.sender.id = "chan-01";
      expect(evaluateReplyEligibility(inputChannelId).reasonCode).toBe("SELF_MESSAGE");

      const inputBotId = createBaseInput();
      inputBotId.sender.id = "bot-self-01";
      expect(evaluateReplyEligibility(inputBotId).reasonCode).toBe("SELF_MESSAGE");
    });
  });

  describe("4. Policy Precedence: Verified Classification (Fail-Closed)", () => {
    function createValidBase(): ReplyEligibilityInput {
      return {
        channel: {
          id: "chan-01",
          accountType: "PERSONAL_MESSENGER",
        },
        thread: {
          kind: "DIRECT",
          reliability: "VERIFIED",
        },
        sender: {
          id: "cust-202",
          kind: "PERSON",
          reliability: "VERIFIED",
          participantIdentity: {
            channelAccountId: "chan-01",
            participantId: "cust-202",
            senderKind: "PERSON",
            isVerified: true,
          },
        },
        message: {
          direction: "INBOUND",
          text: "Tu van giup toi",
        },
        settings: SystemSettingsSchema.parse({}),
      };
    }

    it("fails closed when thread kind is UNKNOWN", () => {
      const input = createValidBase();
      input.thread.kind = "UNKNOWN";

      const result = evaluateReplyEligibility(input);
      expect(result.eligible).toBe(false);
      expect(result.reasonCode).toBe("UNKNOWN_THREAD_KIND");
      expect(result.precedenceStep).toBe("VERIFIED_CLASSIFICATION");
    });

    it("fails closed when thread classification is UNVERIFIED", () => {
      const input = createValidBase();
      input.thread.reliability = "UNVERIFIED";

      const result = evaluateReplyEligibility(input);
      expect(result.eligible).toBe(false);
      expect(result.reasonCode).toBe("UNVERIFIED_THREAD_CLASSIFICATION");
      expect(result.precedenceStep).toBe("VERIFIED_CLASSIFICATION");
    });

    it("fails closed when sender kind is UNKNOWN", () => {
      const input = createValidBase();
      input.sender.kind = "UNKNOWN";

      const result = evaluateReplyEligibility(input);
      expect(result.eligible).toBe(false);
      expect(result.reasonCode).toBe("UNKNOWN_SENDER_KIND");
      expect(result.precedenceStep).toBe("VERIFIED_CLASSIFICATION");
    });

    it("fails closed when sender classification is UNVERIFIED", () => {
      const input = createValidBase();
      input.sender.reliability = "UNVERIFIED";

      const result = evaluateReplyEligibility(input);
      expect(result.eligible).toBe(false);
      expect(result.reasonCode).toBe("UNVERIFIED_SENDER_CLASSIFICATION");
      expect(result.precedenceStep).toBe("VERIFIED_CLASSIFICATION");
    });

    it("fails closed when sender has no participant ID", () => {
      const input = createValidBase();
      input.sender.id = "";
      input.sender.participantIdentity = null;

      const result = evaluateReplyEligibility(input);
      expect(result.eligible).toBe(false);
      expect(result.reasonCode).toBe("UNVERIFIED_PARTICIPANT_IDENTITY");
      expect(result.precedenceStep).toBe("VERIFIED_CLASSIFICATION");
    });

    it("fails closed when participant identity is scoped to a different channel account", () => {
      const input = createValidBase();
      input.sender.participantIdentity = {
        channelAccountId: "different-channel-999",
        participantId: "cust-202",
        senderKind: "PERSON",
        isVerified: true,
      };

      const result = evaluateReplyEligibility(input);
      expect(result.eligible).toBe(false);
      expect(result.reasonCode).toBe("UNVERIFIED_PARTICIPANT_IDENTITY");
      expect(result.precedenceStep).toBe("VERIFIED_CLASSIFICATION");
    });

    it("fails closed when participant identity is unverified (isVerified: false)", () => {
      const input = createValidBase();
      input.sender.participantIdentity = {
        channelAccountId: "chan-01",
        participantId: "cust-202",
        senderKind: "PERSON",
        isVerified: false,
      };

      const result = evaluateReplyEligibility(input);
      expect(result.eligible).toBe(false);
      expect(result.reasonCode).toBe("UNVERIFIED_PARTICIPANT_IDENTITY");
      expect(result.precedenceStep).toBe("VERIFIED_CLASSIFICATION");
    });
  });

  describe("5. Policy Precedence: Source Controls (Direct vs Group)", () => {
    function createVerifiedInput(kind: "DIRECT" | "GROUP"): ReplyEligibilityInput {
      return {
        channel: {
          id: "chan-01",
          accountType: "PERSONAL_MESSENGER",
          botParticipantId: "bot-01",
        },
        thread: {
          kind,
          reliability: "VERIFIED",
        },
        sender: {
          id: "cust-01",
          kind: "PERSON",
          reliability: "VERIFIED",
        },
        message: {
          direction: "INBOUND",
          text: "Hello",
          mentions: [
            {
              entityId: "bot-01",
              isVerified: true,
            },
          ],
        },
        settings: SystemSettingsSchema.parse({
          directRepliesEnabled: true,
          groupRepliesEnabled: true,
        }),
      };
    }

    it("rejects direct messages when directRepliesEnabled is false", () => {
      const input = createVerifiedInput("DIRECT");
      input.settings.directRepliesEnabled = false;

      const result = evaluateReplyEligibility(input);
      expect(result.eligible).toBe(false);
      expect(result.reasonCode).toBe("DIRECT_REPLIES_DISABLED");
      expect(result.precedenceStep).toBe("SOURCE_CONTROLS");
    });

    it("rejects group messages when groupRepliesEnabled is false", () => {
      const input = createVerifiedInput("GROUP");
      input.settings.groupRepliesEnabled = false;

      const result = evaluateReplyEligibility(input);
      expect(result.eligible).toBe(false);
      expect(result.reasonCode).toBe("GROUP_REPLIES_DISABLED");
      expect(result.precedenceStep).toBe("SOURCE_CONTROLS");
    });
  });

  describe("6. Policy Precedence: PERSON List Mode (EVERYONE_EXCEPT and ONLY_SELECTED)", () => {
    function createPersonInput(): ReplyEligibilityInput {
      return {
        channel: {
          id: "chan-01",
          accountType: "PERSONAL_MESSENGER",
        },
        thread: {
          kind: "DIRECT",
          reliability: "VERIFIED",
        },
        sender: {
          id: "user-100",
          kind: "PERSON",
          reliability: "VERIFIED",
        },
        message: {
          direction: "INBOUND",
          text: "Bao gia giup minh",
        },
        settings: SystemSettingsSchema.parse({
          replyMode: "EVERYONE_EXCEPT",
          excludedParticipantIds: [],
          selectedParticipantIds: [],
        }),
      };
    }

    it("EVERYONE_EXCEPT: allows unlisted person", () => {
      const input = createPersonInput();
      input.settings.replyMode = "EVERYONE_EXCEPT";
      input.settings.excludedParticipantIds = ["user-999"];

      const result = evaluateReplyEligibility(input);
      expect(result.eligible).toBe(true);
      expect(result.reasonCode).toBe("ELIGIBLE");
    });

    it("EVERYONE_EXCEPT: rejects person when exact participant ID is in excludedParticipantIds", () => {
      const input = createPersonInput();
      input.settings.replyMode = "EVERYONE_EXCEPT";
      input.settings.excludedParticipantIds = ["user-100"];

      const result = evaluateReplyEligibility(input);
      expect(result.eligible).toBe(false);
      expect(result.reasonCode).toBe("PERSON_EXCLUDED");
      expect(result.precedenceStep).toBe("PERSON_LIST_MODE");
    });

    it("EVERYONE_EXCEPT: rejects person when channel-scoped ID (chan:user) is in excludedParticipantIds", () => {
      const input = createPersonInput();
      input.settings.replyMode = "EVERYONE_EXCEPT";
      input.settings.excludedParticipantIds = ["chan-01:user-100"];

      const result = evaluateReplyEligibility(input);
      expect(result.eligible).toBe(false);
      expect(result.reasonCode).toBe("PERSON_EXCLUDED");
      expect(result.precedenceStep).toBe("PERSON_LIST_MODE");
    });

    it("EVERYONE_EXCEPT: does not exclude person when exclusion is scoped to another channel", () => {
      const input = createPersonInput();
      input.settings.replyMode = "EVERYONE_EXCEPT";
      input.settings.excludedParticipantIds = ["other-channel:user-100"];

      const result = evaluateReplyEligibility(input);
      expect(result.eligible).toBe(true);
      expect(result.reasonCode).toBe("ELIGIBLE");
    });

    it("ONLY_SELECTED: rejects person when not in selectedParticipantIds", () => {
      const input = createPersonInput();
      input.settings.replyMode = "ONLY_SELECTED";
      input.settings.selectedParticipantIds = ["user-VIP"];

      const result = evaluateReplyEligibility(input);
      expect(result.eligible).toBe(false);
      expect(result.reasonCode).toBe("PERSON_NOT_SELECTED");
      expect(result.precedenceStep).toBe("PERSON_LIST_MODE");
    });

    it("ONLY_SELECTED: allows person when exact ID is in selectedParticipantIds", () => {
      const input = createPersonInput();
      input.settings.replyMode = "ONLY_SELECTED";
      input.settings.selectedParticipantIds = ["user-100"];

      const result = evaluateReplyEligibility(input);
      expect(result.eligible).toBe(true);
      expect(result.reasonCode).toBe("ELIGIBLE");
    });

    it("ONLY_SELECTED: allows person when channel-scoped ID is in selectedParticipantIds", () => {
      const input = createPersonInput();
      input.settings.replyMode = "ONLY_SELECTED";
      input.settings.selectedParticipantIds = ["chan-01:user-100"];

      const result = evaluateReplyEligibility(input);
      expect(result.eligible).toBe(true);
      expect(result.reasonCode).toBe("ELIGIBLE");
    });
  });

  describe("7. Policy Precedence: Page & Non-Person Controls (Channel Account Type Separate from Sender Kind)", () => {
    function createNonPersonInput(senderKind: "PAGE" | "NON_PERSON"): ReplyEligibilityInput {
      return {
        channel: {
          id: "chan-page-01",
          accountType: "FACEBOOK_PAGE", // Channel is a Facebook Page!
        },
        thread: {
          kind: "DIRECT",
          reliability: "VERIFIED",
        },
        sender: {
          id: "sender-entity-555",
          kind: senderKind,
          reliability: "VERIFIED",
        },
        message: {
          direction: "INBOUND",
          text: "Message from external sender",
        },
        settings: SystemSettingsSchema.parse({
          pageRepliesEnabled: false,
          nonPersonRepliesEnabled: false,
        }),
      };
    }

    it("rejects PAGE senders by default when pageRepliesEnabled is false", () => {
      const input = createNonPersonInput("PAGE");
      const result = evaluateReplyEligibility(input);

      expect(result.eligible).toBe(false);
      expect(result.reasonCode).toBe("PAGE_REPLIES_DISABLED");
      expect(result.precedenceStep).toBe("PAGE_NON_PERSON_CONTROLS");
    });

    it("allows PAGE senders when pageRepliesEnabled is explicitly true", () => {
      const input = createNonPersonInput("PAGE");
      input.settings.pageRepliesEnabled = true;

      const result = evaluateReplyEligibility(input);
      expect(result.eligible).toBe(true);
      expect(result.reasonCode).toBe("ELIGIBLE");
    });

    it("rejects NON_PERSON senders by default when nonPersonRepliesEnabled is false", () => {
      const input = createNonPersonInput("NON_PERSON");
      const result = evaluateReplyEligibility(input);

      expect(result.eligible).toBe(false);
      expect(result.reasonCode).toBe("NON_PERSON_REPLIES_DISABLED");
      expect(result.precedenceStep).toBe("PAGE_NON_PERSON_CONTROLS");
    });

    it("allows NON_PERSON senders when nonPersonRepliesEnabled is explicitly true", () => {
      const input = createNonPersonInput("NON_PERSON");
      input.settings.nonPersonRepliesEnabled = true;

      const result = evaluateReplyEligibility(input);
      expect(result.eligible).toBe(true);
      expect(result.reasonCode).toBe("ELIGIBLE");
    });

    it("verifies channel account type FACEBOOK_PAGE does NOT trigger page sender controls for PERSON senders", () => {
      const input: ReplyEligibilityInput = {
        channel: {
          id: "page-chan-888",
          accountType: "FACEBOOK_PAGE",
        },
        thread: {
          kind: "DIRECT",
          reliability: "VERIFIED",
        },
        sender: {
          id: "human-customer",
          kind: "PERSON",
          reliability: "VERIFIED",
        },
        message: {
          direction: "INBOUND",
          text: "Toi muon mua san pham",
        },
        settings: SystemSettingsSchema.parse({
          pageRepliesEnabled: false, // Remains disabled!
        }),
      };

      const result = evaluateReplyEligibility(input);
      expect(result.eligible).toBe(true);
      expect(result.reasonCode).toBe("ELIGIBLE");
    });
  });

  describe("8. Policy Precedence: Group Verified-Mention Requirement", () => {
    function createGroupInput(): ReplyEligibilityInput {
      return {
        channel: {
          id: "chan-01",
          accountType: "PERSONAL_MESSENGER",
          botParticipantId: "bot-entity-123",
          botProfileUrl: "https://facebook.com/mybotprofile",
        },
        thread: {
          kind: "GROUP",
          reliability: "VERIFIED",
        },
        sender: {
          id: "group-member-01",
          kind: "PERSON",
          reliability: "VERIFIED",
        },
        message: {
          direction: "INBOUND",
          text: "Xin chao ca nhom",
          mentions: [],
        },
        settings: SystemSettingsSchema.parse({
          groupRepliesEnabled: true,
          requireGroupMention: true,
        }),
      };
    }

    it("rejects group messages when no mentions are present", () => {
      const input = createGroupInput();
      input.message.mentions = [];

      const result = evaluateReplyEligibility(input);
      expect(result.eligible).toBe(false);
      expect(result.reasonCode).toBe("GROUP_MENTION_REQUIRED");
      expect(result.precedenceStep).toBe("GROUP_MENTION_REQUIREMENT");
    });

    it("rejects group messages when mentions target another user, not the bot", () => {
      const input = createGroupInput();
      input.message.mentions = [
        {
          entityId: "other-user-999",
          isVerified: true,
        },
      ];

      const result = evaluateReplyEligibility(input);
      expect(result.eligible).toBe(false);
      expect(result.reasonCode).toBe("GROUP_MENTION_REQUIRED");
      expect(result.precedenceStep).toBe("GROUP_MENTION_REQUIREMENT");
    });

    it("rejects group messages when bot is mentioned but mention evidence is unverified (isVerified: false)", () => {
      const input = createGroupInput();
      input.message.mentions = [
        {
          entityId: "bot-entity-123",
          isVerified: false,
        },
      ];

      const result = evaluateReplyEligibility(input);
      expect(result.eligible).toBe(false);
      expect(result.reasonCode).toBe("GROUP_MENTION_UNVERIFIED");
      expect(result.precedenceStep).toBe("GROUP_MENTION_REQUIREMENT");
    });

    it("allows group messages when bot is mentioned by botParticipantId with verified evidence", () => {
      const input = createGroupInput();
      input.message.mentions = [
        {
          entityId: "bot-entity-123",
          isVerified: true,
        },
      ];

      const result = evaluateReplyEligibility(input);
      expect(result.eligible).toBe(true);
      expect(result.reasonCode).toBe("ELIGIBLE");
    });

    it("allows group messages when bot is mentioned by matching profileUrl with verified evidence", () => {
      const input = createGroupInput();
      input.message.mentions = [
        {
          entityId: "unknown-dom-entity",
          profileUrl: "https://facebook.com/mybotprofile",
          isVerified: true,
        },
      ];

      const result = evaluateReplyEligibility(input);
      expect(result.eligible).toBe(true);
      expect(result.reasonCode).toBe("ELIGIBLE");
    });

    it("allows group messages without mention when requireGroupMention is explicitly false", () => {
      const input = createGroupInput();
      input.settings.requireGroupMention = false;
      input.message.mentions = [];

      const result = evaluateReplyEligibility(input);
      expect(result.eligible).toBe(true);
      expect(result.reasonCode).toBe("ELIGIBLE");
    });
  });

  describe("9. Strict Precedence Hierarchy Enforcement", () => {
    it("HARD_GATES takes precedence over VERIFIED_CLASSIFICATION", () => {
      const input: ReplyEligibilityInput = {
        channel: { id: "chan-1", accountType: "PERSONAL_MESSENGER" },
        thread: { kind: "UNKNOWN", reliability: "UNVERIFIED" },
        sender: { kind: "UNKNOWN", reliability: "UNVERIFIED" },
        message: { direction: "OUTBOUND", text: "" },
        settings: SystemSettingsSchema.parse({ autoReplyEnabled: false }),
      };

      const result = evaluateReplyEligibility(input);
      // Fails at HARD_GATES before checking classification
      expect(result.precedenceStep).toBe("HARD_GATES");
      expect(result.reasonCode).toBe("AUTO_REPLY_DISABLED");
    });

    it("VERIFIED_CLASSIFICATION takes precedence over SOURCE_CONTROLS", () => {
      const input: ReplyEligibilityInput = {
        channel: { id: "chan-1", accountType: "PERSONAL_MESSENGER" },
        thread: { kind: "DIRECT", reliability: "UNVERIFIED" },
        sender: { id: "cust-1", kind: "PERSON", reliability: "VERIFIED" },
        message: { direction: "INBOUND", text: "Hi" },
        settings: SystemSettingsSchema.parse({ directRepliesEnabled: false }),
      };

      const result = evaluateReplyEligibility(input);
      // Fails at VERIFIED_CLASSIFICATION before checking source controls
      expect(result.precedenceStep).toBe("VERIFIED_CLASSIFICATION");
      expect(result.reasonCode).toBe("UNVERIFIED_THREAD_CLASSIFICATION");
    });

    it("SOURCE_CONTROLS takes precedence over PERSON_LIST_MODE", () => {
      const input: ReplyEligibilityInput = {
        channel: { id: "chan-1", accountType: "PERSONAL_MESSENGER" },
        thread: { kind: "DIRECT", reliability: "VERIFIED" },
        sender: { id: "excluded-user", kind: "PERSON", reliability: "VERIFIED" },
        message: { direction: "INBOUND", text: "Hi" },
        settings: SystemSettingsSchema.parse({
          directRepliesEnabled: false,
          replyMode: "EVERYONE_EXCEPT",
          excludedParticipantIds: ["excluded-user"],
        }),
      };

      const result = evaluateReplyEligibility(input);
      // Fails at SOURCE_CONTROLS before checking person exclusion list
      expect(result.precedenceStep).toBe("SOURCE_CONTROLS");
      expect(result.reasonCode).toBe("DIRECT_REPLIES_DISABLED");
    });

    it("PERSON_LIST_MODE takes precedence over GROUP_MENTION_REQUIREMENT", () => {
      const input: ReplyEligibilityInput = {
        channel: { id: "chan-1", accountType: "PERSONAL_MESSENGER", botParticipantId: "bot-1" },
        thread: { kind: "GROUP", reliability: "VERIFIED" },
        sender: { id: "excluded-user", kind: "PERSON", reliability: "VERIFIED" },
        message: { direction: "INBOUND", text: "Hi all", mentions: [] }, // Missing mention
        settings: SystemSettingsSchema.parse({
          groupRepliesEnabled: true,
          replyMode: "EVERYONE_EXCEPT",
          excludedParticipantIds: ["excluded-user"],
        }),
      };

      const result = evaluateReplyEligibility(input);
      // Fails at PERSON_LIST_MODE before checking group mention requirement
      expect(result.precedenceStep).toBe("PERSON_LIST_MODE");
      expect(result.reasonCode).toBe("PERSON_EXCLUDED");
    });
  });
});
