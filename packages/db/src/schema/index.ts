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

// 1. Users
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    role: varchar("role", { length: 32 }).notNull().default("OWNER"), // OWNER | OPERATOR
    totpSecret: text("totp_secret"),
    totpEnabled: boolean("totp_enabled").notNull().default(false),
    recoveryCodes: jsonb("recovery_codes").$type<string[]>().default([]),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  }
);

// 2. Sessions
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("sessions_user_id_idx").on(t.userId),
    index("sessions_expires_at_idx").on(t.expiresAt),
  ]
);

// 3. Channel Accounts
export const channelAccounts = pgTable(
  "channel_accounts",
  {
    id: varchar("id", { length: 64 }).primaryKey(), // "personal-messenger"
    name: text("name").notNull(),
    type: varchar("type", { length: 32 }).notNull().default("PERSONAL_MESSENGER"),
    status: varchar("status", { length: 32 }).notNull().default("RUNNING"), // RUNNING | PAUSED | SUSPENDED | ERROR
    statusReason: text("status_reason"),
    isSuspended: boolean("is_suspended").notNull().default(false),
    isPaused: boolean("is_paused").notNull().default(false),
    lastHealthCheckAt: timestamp("last_health_check_at", { withTimezone: true }),
    lastSeenActiveAt: timestamp("last_seen_active_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  }
);

// 4. Customers
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

// 5. Conversations
export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelAccountId: varchar("channel_account_id", { length: 64 })
      .notNull()
      .references(() => channelAccounts.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    externalThreadId: text("external_thread_id").notNull(),
    externalThreadRef: text("external_thread_ref").notNull(),
    status: varchar("status", { length: 32 }).notNull().default("WAITING_CUSTOMER"),
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
  ]
);

// 6. Messages
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
  ]
);

// 7. Conversation Queue
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
    index("conversation_queue_claim_token_idx").on(t.claimToken),
  ]
);

// 8. Conversation Events (append-only)
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

// 9. AI Runs
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
    rawResponse: text("raw_response"),
    parsedOutput: jsonb("parsed_output").$type<Record<string, unknown>>(),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ai_runs_conv_version_idx").on(t.conversationId, t.inboundVersion),
  ]
);

// 10. AI Drafts
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

// 11. Outbound Actions
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
    actionId: varchar("action_id", { length: 128 }).notNull().unique(), // sha256(channelAccountId + conversationId + inboundVersion + responseIndex)
    inboundVersion: integer("inbound_version").notNull(),
    responseIndex: integer("response_index").notNull().default(0),
    text: text("text").notNull(),
    textHash: varchar("text_hash", { length: 64 }).notNull(),
    actor: varchar("actor", { length: 32 }).notNull().default("AI"),
    status: varchar("status", { length: 32 }).notNull().default("PENDING"), // PENDING | TYPING | SENDING | SENT | ABORTED | UNCONFIRMED | FAILED
    claimToken: text("claim_token"),
    fencingToken: integer("fencing_token"),
    retryCount: integer("retry_count").notNull().default(0),
    externalMessageRef: text("external_message_ref"),
    unconfirmedReason: text("unconfirmed_reason"),
    errorMessage: text("error_message"),
    startedTypingAt: timestamp("started_typing_at", { withTimezone: true }),
    startedSendingAt: timestamp("started_sending_at", { withTimezone: true }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("outbound_actions_conv_version_idx").on(t.conversationId, t.inboundVersion),
    index("outbound_actions_status_idx").on(t.status),
  ]
);

// 12. Browser Events
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

// 13. Incidents
export const incidents = pgTable(
  "incidents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelAccountId: varchar("channel_account_id", { length: 64 })
      .notNull()
      .references(() => channelAccounts.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
    outboundActionId: uuid("outbound_action_id").references(() => outboundActions.id, { onDelete: "set null" }),
    type: varchar("type", { length: 64 }).notNull(), // DOM_CHANGED | CHECKPOINT | UNCONFIRMED_SEND | RATE_LIMITED | CHANNEL_SUSPENDED | AI_ERROR | SYSTEM_ERROR
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

// 14. Settings
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

// 15. Setting Revisions
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

// 16. System Metrics
export const systemMetrics = pgTable(
  "system_metrics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelAccountId: varchar("channel_account_id", { length: 64 })
      .notNull()
      .references(() => channelAccounts.id, { onDelete: "cascade" }),
    metricName: varchar("metric_name", { length: 64 }).notNull(),
    value: integer("value").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("system_metrics_name_recorded_idx").on(t.channelAccountId, t.metricName, t.recordedAt),
  ]
);

// Relations
export const customersRelations = relations(customers, ({ one, many }) => ({
  channelAccount: one(channelAccounts, {
    fields: [customers.channelAccountId],
    references: [channelAccounts.id],
  }),
  conversations: many(conversations),
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
  queue: one(conversationQueue),
  events: many(conversationEvents),
  aiRuns: many(aiRuns),
  aiDrafts: many(aiDrafts),
  outboundActions: many(outboundActions),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
}));

export const conversationQueueRelations = relations(conversationQueue, ({ one }) => ({
  conversation: one(conversations, {
    fields: [conversationQueue.conversationId],
    references: [conversations.id],
  }),
}));
