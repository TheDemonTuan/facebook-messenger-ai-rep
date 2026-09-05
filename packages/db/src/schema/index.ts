import {
  pgTable,
  uuid,
  text,
  varchar,
  timestamp,
  boolean,
  integer,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// 1. Users (Cloudflare Identity - no password/TOTP/sessions)
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull().unique(),
    name: text("name"),
    role: varchar("role", { length: 32 }).notNull().default("OPERATOR"), // OWNER | OPERATOR | VIEWER
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  }
);

// 2. Channel Accounts (with runtime fields)
export const channelAccounts = pgTable(
  "channel_accounts",
  {
    id: varchar("id", { length: 64 }).primaryKey(), // "personal-messenger"
    name: text("name").notNull(),
    type: varchar("type", { length: 32 }).notNull().default("PERSONAL_MESSENGER"),
    status: varchar("status", { length: 32 }).notNull().default("RUNNING"), // RUNNING | PAUSED | SUSPENDED | DEGRADED | ERROR
    statusReason: text("status_reason"),
    isSuspended: boolean("is_suspended").notNull().default(false),
    isPaused: boolean("is_paused").notNull().default(false),
    // Runtime fields
    activeTurnId: uuid("active_turn_id"),
    currentOwnerToken: text("current_owner_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    fencingEpoch: integer("fencing_epoch").notNull().default(0),
    lastHealthCheckAt: timestamp("last_health_check_at", { withTimezone: true }),
    lastSeenActiveAt: timestamp("last_seen_active_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  }
);

// 3. Customers
export const customers = pgTable(
  "customers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelAccountId: varchar("channel_account_id", { length: 64 })
      .notNull()
      .references(() => channelAccounts.id, { onDelete: "cascade" }),
    externalCustomerId: text("external_customer_id").notNull(),
    name: text("name"),
    avatarUrl: text("avatar_url"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("customers_channel_ext_id_uniq").on(t.channelAccountId, t.externalCustomerId),
  ]
);

// 3b. Channel Participants (channel-scoped participant identity for sender attribution & classification)
export const participants = pgTable(
  "participants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelAccountId: varchar("channel_account_id", { length: 64 })
      .notNull()
      .references(() => channelAccounts.id, { onDelete: "cascade" }),
    participantId: text("participant_id").notNull(), // Stable external Facebook entity/participant ID
    senderKind: varchar("sender_kind", { length: 32 }).notNull().default("UNKNOWN"), // PERSON | PAGE | NON_PERSON | UNKNOWN
    reliability: varchar("reliability", { length: 32 }).notNull().default("UNVERIFIED"), // VERIFIED | UNVERIFIED | LEGACY_UNVERIFIED
    isVerified: boolean("is_verified").notNull().default(false),
    profileUrl: text("profile_url"),
    displayName: text("display_name"),
    avatarUrl: text("avatar_url"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("participants_channel_participant_uniq").on(t.channelAccountId, t.participantId),
    index("participants_channel_sender_kind_idx").on(t.channelAccountId, t.senderKind),
  ]
);

// 3c. Reply Policy Members (explicit member lists for reply eligibility)
export const replyPolicyMembers = pgTable(
  "reply_policy_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelAccountId: varchar("channel_account_id", { length: 64 })
      .notNull()
      .references(() => channelAccounts.id, { onDelete: "cascade" }),
    participantId: text("participant_id").notNull(),
    policyMode: varchar("policy_mode", { length: 32 }).notNull().default("EXCLUDE"), // EXCLUDE | INCLUDE
    notes: text("notes"),
    addedBy: text("added_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("reply_policy_members_channel_participant_uniq").on(t.channelAccountId, t.participantId),
  ]
);

// 4. Conversations
export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelAccountId: varchar("channel_account_id", { length: 64 })
      .notNull()
      .references(() => channelAccounts.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id")
      .references(() => customers.id, { onDelete: "set null" }),
    externalThreadId: text("external_thread_id").notNull(),
    externalThreadRef: text("external_thread_ref").notNull(),
    status: varchar("status", { length: 32 }).notNull().default("WAITING_CUSTOMER"),
    threadKind: varchar("thread_kind", { length: 32 }).notNull().default("UNKNOWN"), // DIRECT | GROUP | UNKNOWN
    title: text("title"),
    reliability: varchar("reliability", { length: 32 }).notNull().default("UNVERIFIED"), // VERIFIED | UNVERIFIED | LEGACY_UNVERIFIED
    inboundVersion: integer("inbound_version").notNull().default(0),
    lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }),
    lastOutboundAt: timestamp("last_outbound_at", { withTimezone: true }),
    summary: text("summary"),
    summaryVersion: integer("summary_version").notNull().default(0),
    unreadCount: integer("unread_count").notNull().default(0),
    isBlocked: boolean("is_blocked").notNull().default(false),
    manualMode: boolean("manual_mode").notNull().default(false),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    claimToken: text("claim_token"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("conversations_channel_ext_thread_uniq").on(t.channelAccountId, t.externalThreadId),
    index("conversations_status_idx").on(t.status),
    index("conversations_last_inbound_idx").on(t.lastInboundAt),
    index("conversations_thread_kind_idx").on(t.threadKind),
  ]
);

// 5. Inbound Messages (stable uniqueness inbox deduplication)
export const inboundMessages = pgTable(
  "inbound_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelAccountId: varchar("channel_account_id", { length: 64 })
      .notNull()
      .references(() => channelAccounts.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    sourceMessageId: text("source_message_id").notNull(),
    senderExternalId: text("sender_external_id"),
    senderParticipantId: text("sender_participant_id"),
    senderKind: varchar("sender_kind", { length: 32 }).notNull().default("UNKNOWN"),
    senderReliability: varchar("sender_reliability", { length: 32 }).notNull().default("UNVERIFIED"),
    eventTimestamp: timestamp("event_timestamp", { withTimezone: true }),
    observedTimestamp: timestamp("observed_timestamp", { withTimezone: true }),
    timestampProvenance: varchar("timestamp_provenance", { length: 32 }).notNull().default("OBSERVED"),
    timestampPrecision: varchar("timestamp_precision", { length: 32 }).notNull().default("UNKNOWN"),
    timestamps: jsonb("timestamps").$type<Record<string, unknown>>(),
    text: text("text").notNull(),
    textHash: varchar("text_hash", { length: 64 }).notNull(),
    inboundVersion: integer("inbound_version").notNull().default(1),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    rawPayload: jsonb("raw_payload").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("inbound_messages_channel_src_msg_uniq").on(t.channelAccountId, t.sourceMessageId),
    index("inbound_messages_conv_received_idx").on(t.conversationId, t.receivedAt),
    index("inbound_messages_conv_sender_hash_time_idx").on(t.conversationId, t.senderParticipantId, t.textHash, t.receivedAt),
  ]
);

// 6. Messages (timeline messages)
export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelAccountId: varchar("channel_account_id", { length: 64 })
      .notNull()
      .references(() => channelAccounts.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    externalMessageId: text("external_message_id").notNull(),
    direction: varchar("direction", { length: 16 }).notNull(), // INBOUND | OUTBOUND
    actor: varchar("actor", { length: 32 }).notNull().default("SYSTEM"), // AI | MANUAL_OWNER | SYSTEM
    senderParticipantId: text("sender_participant_id"),
    senderKind: varchar("sender_kind", { length: 32 }).notNull().default("UNKNOWN"),
    senderReliability: varchar("sender_reliability", { length: 32 }).notNull().default("UNVERIFIED"),
    eventTimestamp: timestamp("event_timestamp", { withTimezone: true }),
    observedTimestamp: timestamp("observed_timestamp", { withTimezone: true }),
    timestampProvenance: varchar("timestamp_provenance", { length: 32 }).notNull().default("OBSERVED"),
    timestampPrecision: varchar("timestamp_precision", { length: 32 }).notNull().default("UNKNOWN"),
    timestamps: jsonb("timestamps").$type<Record<string, unknown>>(),
    text: text("text").notNull(),
    textHash: varchar("text_hash", { length: 64 }).notNull(),
    inboundVersion: integer("inbound_version").notNull().default(0),
    responseIndex: integer("response_index").notNull().default(0),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("messages_channel_ext_msg_uniq").on(t.channelAccountId, t.externalMessageId),
    index("messages_conv_timestamp_idx").on(t.conversationId, t.timestamp),
    index("messages_conv_sender_hash_time_idx").on(t.conversationId, t.senderParticipantId, t.textHash, t.timestamp),
  ]
);

// 6b. Reply Eligibility Decisions (evaluated per inbound message with LIVE/SHADOW modes)
export const replyEligibilityDecisions = pgTable(
  "reply_eligibility_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelAccountId: varchar("channel_account_id", { length: 64 })
      .notNull()
      .references(() => channelAccounts.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "cascade" }),
    inboundMessageId: uuid("inbound_message_id")
      .notNull()
      .references(() => inboundMessages.id, { onDelete: "cascade" }),
    evaluationMode: varchar("evaluation_mode", { length: 32 }).notNull().default("LIVE"), // LIVE | SHADOW
    decision: varchar("decision", { length: 32 }).notNull(), // ELIGIBLE | INELIGIBLE
    eligible: boolean("eligible").notNull(),
    reasonCode: varchar("reason_code", { length: 64 }).notNull(),
    reason: text("reason").notNull(),
    precedenceStep: varchar("precedence_step", { length: 64 }).notNull(),
    details: jsonb("details").$type<Record<string, unknown>>().default({}),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().default({}),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("reply_eligibility_decisions_inbound_mode_uniq").on(t.inboundMessageId, t.evaluationMode),
    index("reply_eligibility_decisions_conv_idx").on(t.conversationId, t.evaluatedAt),
    index("reply_eligibility_decisions_channel_idx").on(t.channelAccountId, t.evaluatedAt),
  ]
);

// 7. Turns (explicit turn lifecycle)
export const turns = pgTable(
  "turns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelAccountId: varchar("channel_account_id", { length: 64 })
      .notNull()
      .references(() => channelAccounts.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    inboundVersion: integer("inbound_version").notNull(),
    status: varchar("status", { length: 32 }).notNull().default("PENDING"), // PENDING | THINKING | DRAFT_READY | COMPLETED | FAILED | CANCELLED
    ownerToken: text("owner_token"),
    fencingEpoch: integer("fencing_epoch").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    errorMessage: text("error_message"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("turns_conv_version_uniq").on(t.conversationId, t.inboundVersion),
    index("turns_channel_status_idx").on(t.channelAccountId, t.status),
  ]
);

// 8. Jobs (PostgreSQL durable jobs with FOR UPDATE SKIP LOCKED)
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelAccountId: varchar("channel_account_id", { length: 64 })
      .notNull()
      .references(() => channelAccounts.id, { onDelete: "cascade" }),
    queue: varchar("queue", { length: 64 }).notNull().default("default"),
    jobType: varchar("job_type", { length: 64 }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: varchar("status", { length: 32 }).notNull().default("READY"), // READY | RUNNING | RETRY_WAIT | SUCCEEDED | FAILED | CANCELLED
    priority: integer("priority").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    ownerToken: text("owner_token"),
    fencingEpoch: integer("fencing_epoch").notNull().default(0),
    idempotencyKey: text("idempotency_key"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("jobs_queue_status_available_idx").on(t.queue, t.status, t.availableAt, t.priority),
    uniqueIndex("jobs_idempotency_key_uniq").on(t.idempotencyKey),
  ]
);

// 9. Conversation Queue (legacy queue compatibility)
export const conversationQueue = pgTable(
  "conversation_queue",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelAccountId: varchar("channel_account_id", { length: 64 })
      .notNull()
      .references(() => channelAccounts.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
    readyAt: timestamp("ready_at", { withTimezone: true }).notNull().defaultNow(),
    claimToken: text("claim_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    attempt: integer("attempt").notNull().default(0),
    continuationEligibleUntil: timestamp("continuation_eligible_until", { withTimezone: true }),
    stickyTurns: integer("sticky_turns").notNull().default(0),
    stickyStartedAt: timestamp("sticky_started_at", { withTimezone: true }),
    yieldRequired: boolean("yield_required").notNull().default(false),
    inboundVersion: integer("inbound_version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("conversation_queue_conv_uniq").on(t.conversationId),
    index("conversation_queue_ready_at_idx").on(t.channelAccountId, t.readyAt),
  ]
);

// 10. Conversation Events (append-only audit log)
export const conversationEvents = pgTable(
  "conversation_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelAccountId: varchar("channel_account_id", { length: 64 })
      .notNull()
      .references(() => channelAccounts.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
    type: varchar("type", { length: 64 }).notNull(),
    inboundVersion: integer("inbound_version"),
    actor: varchar("actor", { length: 64 }).notNull().default("SYSTEM"),
    payload: jsonb("payload").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("conversation_events_conv_idx").on(t.conversationId, t.createdAt),
    index("conversation_events_created_idx").on(t.createdAt),
  ]
);

// 11. AI Runs
export const aiRuns = pgTable(
  "ai_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelAccountId: varchar("channel_account_id", { length: 64 })
      .notNull()
      .references(() => channelAccounts.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    inboundVersion: integer("inbound_version").notNull(),
    model: text("model").notNull(),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    latencyMs: integer("latency_ms").notNull().default(0),
    status: varchar("status", { length: 32 }).notNull(), // SUCCESS | STALE_ABORTED | GUARD_REJECTED | ERROR
    promptHash: varchar("prompt_hash", { length: 64 }),
    responseHash: varchar("response_hash", { length: 64 }),
    requestSnapshot: jsonb("request_snapshot").$type<Record<string, unknown>>(),
    responseSnapshot: jsonb("response_snapshot").$type<Record<string, unknown>>(),
    usedResult: jsonb("used_result").$type<Record<string, unknown>>(),
    parsedOutput: jsonb("parsed_output").$type<Record<string, unknown>>(),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ai_runs_conv_idx").on(t.conversationId, t.createdAt),
    index("ai_runs_created_idx").on(t.createdAt),
  ]
);

// 12. AI Drafts
export const aiDrafts = pgTable(
  "ai_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelAccountId: varchar("channel_account_id", { length: 64 })
      .notNull()
      .references(() => channelAccounts.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    aiRunId: uuid("ai_run_id")
      .notNull()
      .references(() => aiRuns.id, { onDelete: "cascade" }),
    inboundVersion: integer("inbound_version").notNull(),
    messages: jsonb("messages").$type<string[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ai_drafts_conv_idx").on(t.conversationId, t.inboundVersion),
  ]
);

// 13. Outbound Actions (explicit state machine including SEND_UNCERTAIN)
export const outboundActions = pgTable(
  "outbound_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelAccountId: varchar("channel_account_id", { length: 64 })
      .notNull()
      .references(() => channelAccounts.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    turnId: uuid("turn_id").references(() => turns.id, { onDelete: "set null" }),
    actionId: varchar("action_id", { length: 128 }).notNull().unique(), // sha256(channelAccountId + conversationId + inboundVersion + responseIndex)
    inboundVersion: integer("inbound_version").notNull(),
    responseIndex: integer("response_index").notNull().default(0),
    text: text("text").notNull(),
    textHash: varchar("text_hash", { length: 64 }).notNull(),
    actor: varchar("actor", { length: 32 }).notNull().default("AI"),
    status: varchar("status", { length: 32 }).notNull().default("PENDING"), // PENDING | TYPING | SEND_INTENT | CONFIRMED | SEND_UNCERTAIN | RETRY_APPROVED | CANCELLED | FAILED
    claimToken: text("claim_token"),
    ownerToken: text("owner_token"),
    fencingToken: integer("fencing_token"),
    fencingEpoch: integer("fencing_epoch").notNull().default(0),
    retryCount: integer("retry_count").notNull().default(0),
    externalMessageRef: text("external_message_ref"),
    unconfirmedReason: text("unconfirmed_reason"),
    errorMessage: text("error_message"),
    startedTypingAt: timestamp("started_typing_at", { withTimezone: true }),
    startedSendingAt: timestamp("started_sending_at", { withTimezone: true }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("outbound_actions_conv_version_idx").on(t.conversationId, t.inboundVersion),
    index("outbound_actions_status_idx").on(t.status),
  ]
);

// 14. Browser Events
export const browserEvents = pgTable(
  "browser_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelAccountId: varchar("channel_account_id", { length: 64 })
      .notNull()
      .references(() => channelAccounts.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
    type: varchar("type", { length: 64 }).notNull(),
    details: jsonb("details").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("browser_events_created_idx").on(t.createdAt),
  ]
);

// 15. Incidents (no secrets/API keys stored)
export const incidents = pgTable(
  "incidents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelAccountId: varchar("channel_account_id", { length: 64 })
      .notNull()
      .references(() => channelAccounts.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
    outboundActionId: uuid("outbound_action_id").references(() => outboundActions.id, { onDelete: "set null" }),
    type: varchar("type", { length: 64 }).notNull(),
    status: varchar("status", { length: 32 }).notNull().default("OPEN"), // OPEN | ACKNOWLEDGED | RESOLVED
    title: text("title").notNull(),
    description: text("description").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: text("resolved_by"),
    resolutionNote: text("resolution_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("incidents_channel_status_idx").on(t.channelAccountId, t.status),
  ]
);

// 16. Settings (no API keys)
export const settings = pgTable(
  "settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelAccountId: varchar("channel_account_id", { length: 64 })
      .notNull()
      .references(() => channelAccounts.id, { onDelete: "cascade" })
      .unique(),
    currentRevision: integer("current_revision").notNull().default(1),
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  }
);

// 17. Encrypted AI provider configuration
export const aiProviderConfigs = pgTable(
  "ai_provider_configs",
  {
    channelAccountId: varchar("channel_account_id", { length: 64 })
      .primaryKey()
      .references(() => channelAccounts.id, { onDelete: "cascade" }),
    apiFormat: varchar("api_format", { length: 32 }).notNull().default("OPENAI_COMPATIBLE"),
    baseUrl: text("base_url").notNull(),
    model: text("model").notNull(),
    encryptedApiKey: text("encrypted_api_key").notNull(),
    changedBy: text("changed_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  }
);

// 18. Setting Revisions (no API keys)
export const settingRevisions = pgTable(
  "setting_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelAccountId: varchar("channel_account_id", { length: 64 })
      .notNull()
      .references(() => channelAccounts.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull(),
    changedBy: text("changed_by").notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("setting_revisions_channel_rev_uniq").on(t.channelAccountId, t.revision),
  ]
);

// 18. System Metrics
export const systemMetrics = pgTable(
  "system_metrics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelAccountId: varchar("channel_account_id", { length: 64 })
      .notNull()
      .references(() => channelAccounts.id, { onDelete: "cascade" }),
    metricKey: varchar("metric_key", { length: 64 }).notNull(),
    metricValue: integer("metric_value").notNull(),
    dimensions: jsonb("dimensions").$type<Record<string, string>>().default({}),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("system_metrics_key_idx").on(t.channelAccountId, t.metricKey, t.timestamp),
  ]
);

// 19. Outbox Events (transactional outbox)
export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelAccountId: varchar("channel_account_id", { length: 64 })
      .notNull()
      .references(() => channelAccounts.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
    eventType: varchar("event_type", { length: 64 }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: varchar("status", { length: 32 }).notNull().default("PENDING"), // PENDING | PROCESSED | FAILED
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("outbox_status_available_idx").on(t.status, t.availableAt),
    index("outbox_channel_created_idx").on(t.channelAccountId, t.createdAt),
  ]
);

// Relations
export const channelAccountsRelations = relations(channelAccounts, ({ many }) => ({
  customers: many(customers),
  participants: many(participants),
  replyPolicyMembers: many(replyPolicyMembers),
  conversations: many(conversations),
  messages: many(messages),
  inboundMessages: many(inboundMessages),
  replyEligibilityDecisions: many(replyEligibilityDecisions),
  turns: many(turns),
  jobs: many(jobs),
  outboundActions: many(outboundActions),
  incidents: many(incidents),
  outboxEvents: many(outboxEvents),
}));

export const customersRelations = relations(customers, ({ one, many }) => ({
  channelAccount: one(channelAccounts, {
    fields: [customers.channelAccountId],
    references: [channelAccounts.id],
  }),
  conversations: many(conversations),
}));

export const participantsRelations = relations(participants, ({ one }) => ({
  channelAccount: one(channelAccounts, {
    fields: [participants.channelAccountId],
    references: [channelAccounts.id],
  }),
}));

export const replyPolicyMembersRelations = relations(replyPolicyMembers, ({ one }) => ({
  channelAccount: one(channelAccounts, {
    fields: [replyPolicyMembers.channelAccountId],
    references: [channelAccounts.id],
  }),
}));

export const replyEligibilityDecisionsRelations = relations(replyEligibilityDecisions, ({ one }) => ({
  channelAccount: one(channelAccounts, {
    fields: [replyEligibilityDecisions.channelAccountId],
    references: [channelAccounts.id],
  }),
  conversation: one(conversations, {
    fields: [replyEligibilityDecisions.conversationId],
    references: [conversations.id],
  }),
  inboundMessage: one(inboundMessages, {
    fields: [replyEligibilityDecisions.inboundMessageId],
    references: [inboundMessages.id],
  }),
}));

export const inboundMessagesRelations = relations(inboundMessages, ({ one, many }) => ({
  conversation: one(conversations, {
    fields: [inboundMessages.conversationId],
    references: [conversations.id],
  }),
  channelAccount: one(channelAccounts, {
    fields: [inboundMessages.channelAccountId],
    references: [channelAccounts.id],
  }),
  replyEligibilityDecisions: many(replyEligibilityDecisions),
}));

export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  channelAccount: one(channelAccounts, {
    fields: [conversations.channelAccountId],
    references: [channelAccounts.id],
  }),
  customer: one(customers, {
    fields: [conversations.customerId],
    references: [customers.id],
  }),
  messages: many(messages),
  inboundMessages: many(inboundMessages),
  replyEligibilityDecisions: many(replyEligibilityDecisions),
  turns: many(turns),
  outboundActions: many(outboundActions),
  events: many(conversationEvents),
  aiRuns: many(aiRuns),
}));

export const turnsRelations = relations(turns, ({ one, many }) => ({
  conversation: one(conversations, {
    fields: [turns.conversationId],
    references: [conversations.id],
  }),
  outboundActions: many(outboundActions),
}));

export const outboundActionsRelations = relations(outboundActions, ({ one }) => ({
  conversation: one(conversations, {
    fields: [outboundActions.conversationId],
    references: [conversations.id],
  }),
  turn: one(turns, {
    fields: [outboundActions.turnId],
    references: [turns.id],
  }),
}));
