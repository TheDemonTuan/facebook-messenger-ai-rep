import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  participants,
  replyPolicyMembers,
  replyEligibilityDecisions,
  conversations,
  messages,
  inboundMessages,
  ParticipantRepository,
  PolicyMemberRepository,
  ReplyPolicyMemberRepository,
  ReplyEligibilityDecisionRepository,
  SettingsRepository,
  ConversationRepository,
  type Database,
} from "../packages/db/src/index.js";
import {
  ParticipantSchema,
  ReplyPolicyMemberSchema,
  ReplyEligibilityDecisionRecordSchema,
  sanitizeReadableSnapshot,
  ConversationSchema,
  InboundMessagePayloadSchema,
} from "../packages/contracts/src/index.js";
import fs from "node:fs";
import path from "node:path";

describe("PR 2: Messenger Identities & Reply Policy Persistence", () => {
  describe("1. Drizzle Schema & Table Definitions", () => {
    it("defines participants table with channel-scoped identity and unique constraint", () => {
      expect(participants).toBeDefined();
      expect(participants.id).toBeDefined();
      expect(participants.channelAccountId).toBeDefined();
      expect(participants.participantId).toBeDefined();
      expect(participants.senderKind).toBeDefined();
      expect(participants.reliability).toBeDefined();
      expect(participants.isVerified).toBeDefined();
      expect(participants.profileUrl).toBeDefined();
      expect(participants.displayName).toBeDefined();
      expect(participants.avatarUrl).toBeDefined();
      expect(participants.verifiedAt).toBeDefined();
    });

    it("defines reply_policy_members table with unique(channel_account_id, participant_id)", () => {
      expect(ReplyPolicyMemberRepository).toBe(PolicyMemberRepository);
      expect(replyPolicyMembers).toBeDefined();
      expect(replyPolicyMembers.id).toBeDefined();
      expect(replyPolicyMembers.channelAccountId).toBeDefined();
      expect(replyPolicyMembers.participantId).toBeDefined();
      expect(replyPolicyMembers.policyMode).toBeDefined();
      expect(replyPolicyMembers.notes).toBeDefined();
      expect(replyPolicyMembers.addedBy).toBeDefined();
    });

    it("defines reply_eligibility_decisions table with unique(inbound_message_id, evaluation_mode)", () => {
      expect(replyEligibilityDecisions).toBeDefined();
      expect(replyEligibilityDecisions.id).toBeDefined();
      expect(replyEligibilityDecisions.channelAccountId).toBeDefined();
      expect(replyEligibilityDecisions.conversationId).toBeDefined();
      expect(replyEligibilityDecisions.inboundMessageId).toBeDefined();
      expect(replyEligibilityDecisions.evaluationMode).toBeDefined();
      expect(replyEligibilityDecisions.decision).toBeDefined();
      expect(replyEligibilityDecisions.eligible).toBeDefined();
      expect(replyEligibilityDecisions.reasonCode).toBeDefined();
      expect(replyEligibilityDecisions.reason).toBeDefined();
      expect(replyEligibilityDecisions.precedenceStep).toBeDefined();
      expect(replyEligibilityDecisions.details).toBeDefined();
      expect(replyEligibilityDecisions.snapshot).toBeDefined();
    });

    it("conversations table supports nullable customer_id, thread_kind, title, and reliability", () => {
      expect(conversations.customerId).toBeDefined();
      expect(conversations.threadKind).toBeDefined();
      expect(conversations.title).toBeDefined();
      expect(conversations.reliability).toBeDefined();
    });

    it("messages and inbound_messages tables support sender attribution and timestamp provenance", () => {
      expect(messages.senderParticipantId).toBeDefined();
      expect(messages.senderKind).toBeDefined();
      expect(messages.senderReliability).toBeDefined();
      expect(messages.eventTimestamp).toBeDefined();
      expect(messages.observedTimestamp).toBeDefined();
      expect(messages.timestampProvenance).toBeDefined();
      expect(messages.timestampPrecision).toBeDefined();
      expect(messages.timestamps).toBeDefined();

      expect(inboundMessages.senderParticipantId).toBeDefined();
      expect(inboundMessages.senderKind).toBeDefined();
      expect(inboundMessages.senderReliability).toBeDefined();
      expect(inboundMessages.eventTimestamp).toBeDefined();
      expect(inboundMessages.observedTimestamp).toBeDefined();
      expect(inboundMessages.timestampProvenance).toBeDefined();
      expect(inboundMessages.timestampPrecision).toBeDefined();
      expect(inboundMessages.timestamps).toBeDefined();
    });
  });

  describe("2. Migration File & Legacy Records Preservation", () => {
    it("contains migration file that is additive and backfills legacy records", () => {
      const migrationPath = path.resolve(__dirname, "../packages/db/migrations/0003_steep_juggernaut.sql");
      expect(fs.existsSync(migrationPath)).toBe(true);

      const migrationSql = fs.readFileSync(migrationPath, "utf-8");
      // Must create tables
      expect(migrationSql).toContain(`CREATE TABLE "participants"`);
      expect(migrationSql).toContain(`CREATE TABLE "reply_policy_members"`);
      expect(migrationSql).toContain(`CREATE TABLE "reply_eligibility_decisions"`);

      // Must make customer_id nullable
      expect(migrationSql).toContain(`ALTER COLUMN "customer_id" DROP NOT NULL`);

      // Must create scoped duplicate index on messages and inbound_messages
      expect(migrationSql).toContain(`messages_conv_sender_hash_time_idx`);
      expect(migrationSql).toContain(`inbound_messages_conv_sender_hash_time_idx`);

      // Must backfill legacy records with UNKNOWN and LEGACY_UNVERIFIED
      expect(migrationSql).toContain(`UPDATE "conversations" SET "thread_kind" = 'UNKNOWN', "reliability" = 'LEGACY_UNVERIFIED'`);
      expect(migrationSql).toContain(`UPDATE "messages" SET "sender_kind" = 'UNKNOWN', "sender_reliability" = 'LEGACY_UNVERIFIED'`);
      expect(migrationSql).toContain(`UPDATE "inbound_messages" SET "sender_kind" = 'UNKNOWN', "sender_reliability" = 'LEGACY_UNVERIFIED'`);
    });
  });

  describe("3. ParticipantRepository", () => {
    it("upserts and retrieves channel-scoped participant", async () => {
      const sampleParticipant = {
        id: randomUUID(),
        channelAccountId: "personal-messenger",
        participantId: "fb-user-123",
        senderKind: "PERSON",
        reliability: "VERIFIED",
        isVerified: true,
        profileUrl: "https://facebook.com/user123",
        displayName: "Nguyen Van A",
        avatarUrl: "https://facebook.com/avatar.jpg",
        verifiedAt: new Date("2026-09-05T10:00:00Z"),
        metadata: { source: "DOM_BADGE" },
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockDb = {
        insert: vi.fn(() => ({
          values: vi.fn(() => ({
            onConflictDoUpdate: vi.fn(() => ({
              returning: vi.fn(() => [sampleParticipant]),
            })),
          })),
        })),
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(() => [sampleParticipant]),
            })),
          })),
        })),
      } as unknown as Database;

      const repo = new ParticipantRepository(mockDb);

      const upserted = await repo.upsertParticipant({
        channelAccountId: "personal-messenger",
        participantId: "fb-user-123",
        senderKind: "PERSON",
        reliability: "VERIFIED",
        isVerified: true,
        displayName: "Nguyen Van A",
      });

      expect(upserted.participantId).toBe("fb-user-123");
      expect(upserted.isVerified).toBe(true);

      const fetched = await repo.getParticipant("personal-messenger", "fb-user-123");
      expect(fetched).not.toBeNull();
      expect(fetched?.displayName).toBe("Nguyen Van A");

      const validated = ParticipantSchema.parse(fetched);
      expect(validated.senderKind).toBe("PERSON");
    });
  });

  describe("4. PolicyMemberRepository", () => {
    it("adds, checks membership, and lists members", async () => {
      const sampleMember = {
        id: randomUUID(),
        channelAccountId: "personal-messenger",
        participantId: "excluded-user-999",
        policyMode: "EXCLUDE",
        notes: "Requested opt-out",
        addedBy: "admin@example.com",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockDb = {
        insert: vi.fn(() => ({
          values: vi.fn(() => ({
            onConflictDoUpdate: vi.fn(() => ({
              returning: vi.fn(() => [sampleMember]),
            })),
          })),
        })),
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(() => [sampleMember]),
              orderBy: vi.fn(() => [sampleMember]),
            })),
          })),
        })),
        delete: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn(() => [sampleMember]),
          })),
        })),
      } as unknown as Database;

      const repo = new PolicyMemberRepository(mockDb);

      const added = await repo.addMember({
        channelAccountId: "personal-messenger",
        participantId: "excluded-user-999",
        policyMode: "EXCLUDE",
        notes: "Requested opt-out",
      });
      expect(added.participantId).toBe("excluded-user-999");

      const isMember = await repo.isMember("personal-messenger", "excluded-user-999");
      expect(isMember).toBe(true);

      const memberIds = await repo.getMemberParticipantIds("personal-messenger");
      expect(memberIds).toContain("excluded-user-999");

      const removed = await repo.removeMember("personal-messenger", "excluded-user-999");
      expect(removed).toBe(true);

      const validated = ReplyPolicyMemberSchema.parse(added);
      expect(validated.policyMode).toBe("EXCLUDE");
    });
  });

  describe("5. ReplyEligibilityDecisionRepository & Sanitized Reason Snapshots", () => {
    it("sanitizes raw UUIDs and internal IDs for normal read models", () => {
      const rawReason = "Conversation 550e8400-e29b-41d4-a716-446655440000 is in manual mode for user 123e4567-e89b-12d3-a456-426614174000";
      const rawDetails = {
        id: "internal-id-1",
        conversationId: "550e8400-e29b-41d4-a716-446655440000",
        threadKind: "DIRECT",
        reliability: "VERIFIED",
        nestedUser: {
          uuid: "123e4567-e89b-12d3-a456-426614174000",
          name: "Test User",
        },
      };

      const { readableReason, sanitizedDetails } = sanitizeReadableSnapshot(rawReason, rawDetails);

      expect(readableReason).not.toContain("550e8400-e29b-41d4-a716-446655440000");
      expect(readableReason).toContain("[id]");
      expect(sanitizedDetails.conversationId).toBeUndefined();
      expect(sanitizedDetails.id).toBeUndefined();
      expect((sanitizedDetails.nestedUser as Record<string, unknown>).uuid).toBe("[id]");
      expect((sanitizedDetails.nestedUser as Record<string, unknown>).name).toBe("Test User");
    });

    it("records and retrieves decisions with unique inbound message constraint", async () => {
      const convId = randomUUID();
      const inboundId = randomUUID();
      const sampleDecision = {
        id: randomUUID(),
        channelAccountId: "personal-messenger",
        conversationId: convId,
        inboundMessageId: inboundId,
        evaluationMode: "LIVE",
        decision: "ELIGIBLE",
        eligible: true,
        reasonCode: "ELIGIBLE",
        reason: "Message is eligible for automated reply",
        precedenceStep: "ELIGIBLE",
        details: { threadKind: "DIRECT" },
        snapshot: { textLength: 12 },
        evaluatedAt: new Date(),
        createdAt: new Date(),
      };

      const mockDb = {
        insert: vi.fn(() => ({
          values: vi.fn(() => ({
            onConflictDoUpdate: vi.fn(() => ({
              returning: vi.fn(() => [sampleDecision]),
            })),
          })),
        })),
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(() => [sampleDecision]),
              orderBy: vi.fn(() => ({
                limit: vi.fn(() => [sampleDecision]),
              })),
            })),
          })),
        })),
      } as unknown as Database;

      const repo = new ReplyEligibilityDecisionRepository(mockDb);

      const recorded = await repo.recordDecision({
        channelAccountId: "personal-messenger",
        conversationId: convId,
        inboundMessageId: inboundId,
        evaluationMode: "LIVE",
        decision: "ELIGIBLE",
        eligible: true,
        reasonCode: "ELIGIBLE",
        reason: "Message is eligible for automated reply",
        precedenceStep: "ELIGIBLE",
      });

      expect(recorded.inboundMessageId).toBe(inboundId);
      expect(recorded.eligible).toBe(true);

      const decision = await repo.getDecisionForInbound(inboundId, "LIVE");
      expect(decision).not.toBeNull();
      expect(decision?.decision).toBe("ELIGIBLE");

      const validated = ReplyEligibilityDecisionRecordSchema.parse(recorded);
      expect(validated.evaluationMode).toBe("LIVE");
    });
  });

  describe("6. SettingsRepository Reply Policy Access", () => {
    it("reads and updates reply policy settings", async () => {
      const mockSettingsRow = {
        channelAccountId: "personal-messenger",
        currentRevision: 3,
        settings: {
          autoReplyEnabled: true,
          pauseIntakeProcessing: false,
          replyMode: "ONLY_SELECTED",
          directRepliesEnabled: true,
          groupRepliesEnabled: false,
          pageRepliesEnabled: false,
          nonPersonRepliesEnabled: false,
          requireGroupMention: true,
          selectedParticipantIds: ["vip-1"],
          excludedParticipantIds: [],
        },
      };

      const mockDb = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(() => [mockSettingsRow]),
            })),
          })),
        })),
      } as unknown as Database;

      const repo = new SettingsRepository(mockDb);
      const policySettings = await repo.getReplyPolicySettings("personal-messenger");

      expect(policySettings.replyMode).toBe("ONLY_SELECTED");
      expect(policySettings.groupRepliesEnabled).toBe(false);
      expect(policySettings.requireGroupMention).toBe(true);
      expect(policySettings.selectedParticipantIds).toEqual(["vip-1"]);
    });
  });

  describe("7. ConversationRepository Ingestion & Scoped Deduplication", () => {
    it("never infers person customer from thread ID in group thread and provides fallback on reads", async () => {
      let insertedConvData: Record<string, unknown> | null = null;

      const mockTx = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(() => Promise.resolve([])),
            })),
          })),
        })),
        insert: vi.fn((table: unknown) => ({
          values: vi.fn((vals: Record<string, unknown>) => {
            if (table === conversations) {
              insertedConvData = vals;
            }
            return {
              returning: vi.fn().mockResolvedValue([{ id: "generated-uuid" }]),
              onConflictDoUpdate: vi.fn().mockResolvedValue([{ id: "generated-uuid" }]),
            };
          }),
        })),
        update: vi.fn(() => ({
          set: vi.fn(() => ({
            where: vi.fn().mockResolvedValue([]),
          })),
        })),
      };

      const mockDb = {
        transaction: vi.fn(async <T>(cb: (tx: unknown) => Promise<T>) => cb(mockTx)),
      } as unknown as Database;

      const repo = new ConversationRepository(mockDb);

      const parsedPayload = InboundMessagePayloadSchema.parse({
        channelAccountId: "personal-messenger",
        externalThreadId: "group-thread-789",
        externalThreadRef: "https://facebook.com/messages/t/group-thread-789",
        externalCustomerId: "group-thread-789", // Thread ID equals customer ID
        customerName: "VIP Customer Group",
        externalMessageId: "mid.group.msg.001",
        text: "Xin chao ca nhom",
        timestamp: new Date(),
        threadKind: "GROUP",
        threadReliability: "VERIFIED",
      });
      const result = await repo.ingestInboundMessage(parsedPayload);

      expect(result.isDuplicate).toBe(false);
      expect(insertedConvData).toBeDefined();
      // For a group thread, customerId must be null (never inferred from thread ID)
      expect((insertedConvData as Record<string, unknown> | null)?.customerId).toBeNull();
      expect((insertedConvData as Record<string, unknown> | null)?.threadKind).toBe("GROUP");
      expect((insertedConvData as Record<string, unknown> | null)?.title).toBe("VIP Customer Group");
    });

    it("safely falls back to group/thread title when reading conversation with null customerId", async () => {
      const convId = randomUUID();
      const convRow = {
        id: convId,
        channelAccountId: "personal-messenger",
        customerId: null,
        externalThreadId: "group-thread-789",
        externalThreadRef: "https://facebook.com/messages/t/group-thread-789",
        status: "WAITING_CUSTOMER",
        threadKind: "GROUP",
        title: "VIP Customer Group",
        reliability: "VERIFIED",
        inboundVersion: 2,
        lastInboundAt: new Date(),
        lastOutboundAt: null,
        unreadCount: 0,
        isBlocked: false,
        manualMode: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockDb = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            leftJoin: vi.fn(() => ({
              where: vi.fn(() => ({
                limit: vi.fn(() => [{ conversation: convRow, customer: null }]),
              })),
            })),
          })),
        })),
      } as unknown as Database;

      const repo = new ConversationRepository(mockDb);
      const detail = await repo.getConversationById(convId);

      expect(detail).not.toBeNull();
      expect(detail?.conversation.id).toBe(convId);
      const validatedConv = ConversationSchema.parse(detail?.conversation);
      expect(validatedConv.threadKind).toBe("GROUP");
      expect(detail?.customer).toBeDefined();
      expect(detail?.customer.name).toBe("VIP Customer Group");
      expect(detail?.customer.externalCustomerId).toBe("group-thread-789");
    });

    it("executes scoped duplicate query matching conversation + nullable sender + text hash", async () => {
      const mockDb = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(() => [
                {
                  id: "msg-duplicate-1",
                  conversationId: "conv-1",
                  inboundVersion: 3,
                },
              ]),
            })),
          })),
        })),
      } as unknown as Database;

      const repo = new ConversationRepository(mockDb);

      const duplicate = await repo.findScopedDuplicateMessage({
        channelAccountId: "personal-messenger",
        conversationId: "conv-1",
        senderParticipantId: "sender-123",
        textHash: "abcdef1234567890",
        since: new Date(Date.now() - 5000),
      });

      expect(duplicate).not.toBeNull();
      expect(duplicate?.id).toBe("msg-duplicate-1");
    });
  });

  describe("8. Regression Tests: PR 2 Review Findings", () => {
    it("finding 1: cross-thread same text does not falsely mark new thread message as duplicate", async () => {
      let insertedConv = false;
      let insertedMsg = false;

      const mockTx = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(() => Promise.resolve([])), // No existing conversation for thread B
            })),
          })),
        })),
        insert: vi.fn((table: unknown) => ({
          values: vi.fn(() => {
            if (table === conversations) insertedConv = true;
            if (table === messages) insertedMsg = true;
            return {
              returning: vi.fn().mockResolvedValue([{ id: randomUUID() }]),
              onConflictDoUpdate: vi.fn().mockResolvedValue([{ id: randomUUID() }]),
            };
          }),
        })),
        update: vi.fn(() => ({
          set: vi.fn(() => ({
            where: vi.fn().mockResolvedValue([]),
          })),
        })),
      };

      const mockDb = {
        transaction: vi.fn(async <T>(cb: (tx: unknown) => Promise<T>) => cb(mockTx)),
      } as unknown as Database;

      const repo = new ConversationRepository(mockDb);

      const payload = InboundMessagePayloadSchema.parse({
        channelAccountId: "personal-messenger",
        externalThreadId: "thread-B-999",
        externalThreadRef: "https://facebook.com/messages/t/thread-B-999",
        externalCustomerId: "cust-B-999",
        customerName: "New Thread User",
        externalMessageId: "mid.new.thread.b.001",
        text: "Same hello text as another thread",
        timestamp: new Date(),
        threadKind: "DIRECT",
        threadReliability: "VERIFIED",
      });

      const result = await repo.ingestInboundMessage(payload);

      expect(result.isDuplicate).toBe(false);
      expect(insertedConv).toBe(true);
      expect(insertedMsg).toBe(true);
    });

    it("finding 2: null sender isolation uses explicit isNull(senderParticipantId) and matches timestamp", async () => {
      let capturedClause: unknown = null;

      const mockDb = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn((clause: unknown) => {
              capturedClause = clause;
              return {
                limit: vi.fn(() => []),
              };
            }),
          })),
        })),
      } as unknown as Database;

      const repo = new ConversationRepository(mockDb);
      const convId = randomUUID();

      function extractSqlChunks(sqlObj: unknown): string[] {
        if (!sqlObj || typeof sqlObj !== "object") return [];
        const chunks = (sqlObj as { queryChunks?: unknown[] }).queryChunks || [];
        return chunks.flatMap((ch: unknown) => {
          if (!ch || typeof ch !== "object") return [];
          if ("value" in ch) {
            const v = (ch as { value: unknown }).value;
            return Array.isArray(v) ? v.map(String) : [String(v)];
          }
          if ("name" in ch) return [String((ch as { name: unknown }).name)];
          if ("queryChunks" in ch) return extractSqlChunks(ch);
          return [];
        });
      }

      // Query with null/undefined senderParticipantId
      await repo.findScopedDuplicateMessage({
        channelAccountId: "personal-messenger",
        conversationId: convId,
        senderParticipantId: null,
        textHash: "hash123",
        since: new Date(Date.now() - 5000),
      });

      expect(capturedClause).not.toBeNull();
      const chunksNull = extractSqlChunks(capturedClause).join(" ");
      expect(chunksNull).toContain("sender_participant_id");
      expect(chunksNull).toContain("is null");
      expect(chunksNull).toContain("timestamp");

      // Query with explicit senderParticipantId
      await repo.findScopedDuplicateMessage({
        channelAccountId: "personal-messenger",
        conversationId: convId,
        senderParticipantId: "sender-known-456",
        textHash: "hash123",
        since: new Date(Date.now() - 5000),
      });

      const chunksSender = extractSqlChunks(capturedClause).join(" ");
      expect(chunksSender).toContain("sender_participant_id");
      expect(chunksSender).not.toContain("is null");
      expect(chunksSender).toContain("sender-known-456");
    });

    it("finding 3: recursively sanitizes nested arrays/objects and globally redacts embedded UUIDs", () => {
      const uuid1 = "550e8400-e29b-41d4-a716-446655440000";
      const uuid2 = "123e4567-e89b-12d3-a456-426614174000";

      const rawReason = `Execution for conversation ${uuid1} failed on inbound ${uuid2} with timeout`;
      const rawDetails = {
        id: uuid1,
        conversationId: uuid1,
        inboundMessageId: uuid2,
        channelAccountId: "chan-1",
        label: `prefix-${uuid1}-suffix`,
        nestedArray: [
          `item-${uuid2}`,
          [
            `deep-${uuid1}`,
            {
              id: uuid2,
              token: `tok-${uuid2}`,
              safeValue: 42,
            },
          ],
        ],
        nestedObject: {
          id: uuid1,
          desc: `Check ${uuid1}`,
          participants: [uuid1, uuid2],
        },
      };

      const { readableReason, sanitizedDetails } = sanitizeReadableSnapshot(rawReason, rawDetails);

      // Verify reason globally redacts embedded UUIDs
      expect(readableReason).toBe("Execution for conversation [id] failed on inbound [id] with timeout");
      expect(readableReason).not.toContain(uuid1);
      expect(readableReason).not.toContain(uuid2);

      // Verify stripped root keys
      expect(sanitizedDetails.id).toBeUndefined();
      expect(sanitizedDetails.conversationId).toBeUndefined();
      expect(sanitizedDetails.inboundMessageId).toBeUndefined();
      expect(sanitizedDetails.channelAccountId).toBeUndefined();

      // Verify embedded UUID in string
      expect(sanitizedDetails.label).toBe("prefix-[id]-suffix");

      // Verify nested arrays
      const arr = sanitizedDetails.nestedArray as unknown[];
      expect(arr[0]).toBe("item-[id]");
      const deepArr = arr[1] as unknown[];
      expect(deepArr[0]).toBe("deep-[id]");
      const deepObj = deepArr[1] as Record<string, unknown>;
      expect(deepObj.id).toBeUndefined();
      expect(deepObj.token).toBe("tok-[id]");
      expect(deepObj.safeValue).toBe(42);

      // Verify nested object and array inside it
      const nestedObj = sanitizedDetails.nestedObject as Record<string, unknown>;
      expect(nestedObj.id).toBeUndefined();
      expect(nestedObj.desc).toBe("Check [id]");
      expect(nestedObj.participants).toEqual(["[id]", "[id]"]);
    });

    it("finding 4: partial settings updates preserve existing customized settings using mergeSystemSettings", async () => {
      let savedSettings: Record<string, unknown> | null = null;

      const existingFullSettings = {
        autoReplyEnabled: true,
        pauseIntakeProcessing: false,
        replyMode: "ONLY_SELECTED" as const,
        directRepliesEnabled: false,
        groupRepliesEnabled: true,
        pageRepliesEnabled: false,
        nonPersonRepliesEnabled: false,
        requireGroupMention: true,
        selectedParticipantIds: ["vip-participant-1", "vip-participant-2"],
        excludedParticipantIds: ["blocked-1"],
        aiModel: "grok-2",
        debounceMs: 5500,
      };

      const mockDb = {
        transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
          const mockTx = {
            select: vi.fn(() => ({
              from: vi.fn(() => ({
                where: vi.fn(() => ({
                  limit: vi.fn(() => [
                    {
                      channelAccountId: "personal-messenger",
                      currentRevision: 4,
                      settings: existingFullSettings,
                    },
                  ]),
                })),
              })),
            })),
            insert: vi.fn(() => ({
              values: vi.fn((vals: Record<string, unknown>) => {
                savedSettings = (vals.settings as Record<string, unknown>) ?? null;
                return {
                  onConflictDoUpdate: vi.fn().mockResolvedValue([]),
                };
              }),
            })),
          };
          return cb(mockTx);
        }),
      } as unknown as Database;

      const repo = new SettingsRepository(mockDb);

      // Apply partial update changing only replyMode to "EVERYONE_EXCEPT"
      const result = await repo.updateReplyPolicySettings(
        "personal-messenger",
        { replyMode: "EVERYONE_EXCEPT" },
        "admin-tester",
        "Switch to EVERYONE_EXCEPT mode"
      );

      expect(result.settings.replyMode).toBe("EVERYONE_EXCEPT");
      // Verify customized settings are completely preserved and not reset or clobbered
      expect(result.settings.directRepliesEnabled).toBe(false);
      expect(result.settings.groupRepliesEnabled).toBe(true);
      expect(result.settings.selectedParticipantIds).toEqual(["vip-participant-1", "vip-participant-2"]);
      expect(result.settings.excludedParticipantIds).toEqual(["blocked-1"]);
      expect(result.settings.debounceMs).toBe(5500);
      expect(savedSettings).toBeDefined();
      expect((savedSettings as Record<string, unknown> | null)?.replyMode).toBe("EVERYONE_EXCEPT");
      expect((savedSettings as Record<string, unknown> | null)?.directRepliesEnabled).toBe(false);
      expect((savedSettings as Record<string, unknown> | null)?.selectedParticipantIds).toEqual(["vip-participant-1", "vip-participant-2"]);
    });
  });
});
