CREATE TABLE "ai_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_account_id" varchar(64) NOT NULL,
	"conversation_id" uuid NOT NULL,
	"ai_run_id" uuid NOT NULL,
	"inbound_version" integer NOT NULL,
	"messages" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_account_id" varchar(64) NOT NULL,
	"conversation_id" uuid NOT NULL,
	"inbound_version" integer NOT NULL,
	"model" text NOT NULL,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"status" varchar(32) NOT NULL,
	"raw_response" text,
	"parsed_output" jsonb,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "browser_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_account_id" varchar(64) NOT NULL,
	"conversation_id" uuid,
	"type" varchar(64) NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_accounts" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" varchar(32) DEFAULT 'PERSONAL_MESSENGER' NOT NULL,
	"status" varchar(32) DEFAULT 'RUNNING' NOT NULL,
	"status_reason" text,
	"is_suspended" boolean DEFAULT false NOT NULL,
	"is_paused" boolean DEFAULT false NOT NULL,
	"active_turn_id" uuid,
	"current_owner_token" text,
	"lease_expires_at" timestamp with time zone,
	"fencing_epoch" integer DEFAULT 0 NOT NULL,
	"last_health_check_at" timestamp with time zone,
	"last_seen_active_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_account_id" varchar(64) NOT NULL,
	"conversation_id" uuid,
	"type" varchar(64) NOT NULL,
	"inbound_version" integer,
	"actor" varchar(64) DEFAULT 'SYSTEM' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_account_id" varchar(64) NOT NULL,
	"conversation_id" uuid NOT NULL,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claim_token" text,
	"lease_expires_at" timestamp with time zone,
	"attempt" integer DEFAULT 0 NOT NULL,
	"continuation_eligible_until" timestamp with time zone,
	"sticky_turns" integer DEFAULT 0 NOT NULL,
	"sticky_started_at" timestamp with time zone,
	"yield_required" boolean DEFAULT false NOT NULL,
	"inbound_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_account_id" varchar(64) NOT NULL,
	"customer_id" uuid NOT NULL,
	"external_thread_id" text NOT NULL,
	"external_thread_ref" text NOT NULL,
	"status" varchar(32) DEFAULT 'WAITING_CUSTOMER' NOT NULL,
	"inbound_version" integer DEFAULT 0 NOT NULL,
	"last_inbound_at" timestamp with time zone,
	"last_outbound_at" timestamp with time zone,
	"summary" text,
	"summary_version" integer DEFAULT 0 NOT NULL,
	"unread_count" integer DEFAULT 0 NOT NULL,
	"is_blocked" boolean DEFAULT false NOT NULL,
	"manual_mode" boolean DEFAULT false NOT NULL,
	"claimed_at" timestamp with time zone,
	"claim_token" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_account_id" varchar(64) NOT NULL,
	"external_customer_id" text NOT NULL,
	"name" text,
	"avatar_url" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbound_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_account_id" varchar(64) NOT NULL,
	"conversation_id" uuid NOT NULL,
	"source_message_id" text NOT NULL,
	"sender_external_id" text,
	"text" text NOT NULL,
	"text_hash" varchar(64) NOT NULL,
	"inbound_version" integer DEFAULT 1 NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw_payload" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_account_id" varchar(64) NOT NULL,
	"conversation_id" uuid,
	"outbound_action_id" uuid,
	"type" varchar(64) NOT NULL,
	"status" varchar(32) DEFAULT 'OPEN' NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_account_id" varchar(64) NOT NULL,
	"queue" varchar(64) DEFAULT 'default' NOT NULL,
	"job_type" varchar(64) NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" varchar(32) DEFAULT 'READY' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"owner_token" text,
	"fencing_epoch" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_account_id" varchar(64) NOT NULL,
	"conversation_id" uuid NOT NULL,
	"external_message_id" text NOT NULL,
	"direction" varchar(16) NOT NULL,
	"actor" varchar(32) DEFAULT 'SYSTEM' NOT NULL,
	"text" text NOT NULL,
	"text_hash" varchar(64) NOT NULL,
	"inbound_version" integer DEFAULT 0 NOT NULL,
	"response_index" integer DEFAULT 0 NOT NULL,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbound_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_account_id" varchar(64) NOT NULL,
	"conversation_id" uuid NOT NULL,
	"turn_id" uuid,
	"action_id" varchar(128) NOT NULL,
	"inbound_version" integer NOT NULL,
	"response_index" integer DEFAULT 0 NOT NULL,
	"text" text NOT NULL,
	"text_hash" varchar(64) NOT NULL,
	"actor" varchar(32) DEFAULT 'AI' NOT NULL,
	"status" varchar(32) DEFAULT 'PENDING' NOT NULL,
	"claim_token" text,
	"owner_token" text,
	"fencing_token" integer,
	"fencing_epoch" integer DEFAULT 0 NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"external_message_ref" text,
	"unconfirmed_reason" text,
	"error_message" text,
	"started_typing_at" timestamp with time zone,
	"started_sending_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbound_actions_action_id_unique" UNIQUE("action_id")
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_account_id" varchar(64) NOT NULL,
	"conversation_id" uuid,
	"event_type" varchar(64) NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" varchar(32) DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "setting_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_account_id" varchar(64) NOT NULL,
	"revision" integer NOT NULL,
	"settings" jsonb NOT NULL,
	"changed_by" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_account_id" varchar(64) NOT NULL,
	"current_revision" integer DEFAULT 1 NOT NULL,
	"settings" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settings_channel_account_id_unique" UNIQUE("channel_account_id")
);
--> statement-breakpoint
CREATE TABLE "system_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_account_id" varchar(64) NOT NULL,
	"metric_key" varchar(64) NOT NULL,
	"metric_value" integer NOT NULL,
	"dimensions" jsonb DEFAULT '{}'::jsonb,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_account_id" varchar(64) NOT NULL,
	"conversation_id" uuid NOT NULL,
	"inbound_version" integer NOT NULL,
	"status" varchar(32) DEFAULT 'PENDING' NOT NULL,
	"owner_token" text,
	"fencing_epoch" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error_message" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"role" varchar(32) DEFAULT 'OPERATOR' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "ai_drafts" ADD CONSTRAINT "ai_drafts_channel_account_id_channel_accounts_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_drafts" ADD CONSTRAINT "ai_drafts_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_drafts" ADD CONSTRAINT "ai_drafts_ai_run_id_ai_runs_id_fk" FOREIGN KEY ("ai_run_id") REFERENCES "public"."ai_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_channel_account_id_channel_accounts_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_events" ADD CONSTRAINT "browser_events_channel_account_id_channel_accounts_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_events" ADD CONSTRAINT "browser_events_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_events" ADD CONSTRAINT "conversation_events_channel_account_id_channel_accounts_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_events" ADD CONSTRAINT "conversation_events_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_queue" ADD CONSTRAINT "conversation_queue_channel_account_id_channel_accounts_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_queue" ADD CONSTRAINT "conversation_queue_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_channel_account_id_channel_accounts_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_channel_account_id_channel_accounts_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_channel_account_id_channel_accounts_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_channel_account_id_channel_accounts_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_outbound_action_id_outbound_actions_id_fk" FOREIGN KEY ("outbound_action_id") REFERENCES "public"."outbound_actions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_channel_account_id_channel_accounts_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_channel_account_id_channel_accounts_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_actions" ADD CONSTRAINT "outbound_actions_channel_account_id_channel_accounts_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_actions" ADD CONSTRAINT "outbound_actions_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_actions" ADD CONSTRAINT "outbound_actions_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_channel_account_id_channel_accounts_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setting_revisions" ADD CONSTRAINT "setting_revisions_channel_account_id_channel_accounts_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_channel_account_id_channel_accounts_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_metrics" ADD CONSTRAINT "system_metrics_channel_account_id_channel_accounts_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_channel_account_id_channel_accounts_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_drafts_conv_idx" ON "ai_drafts" USING btree ("conversation_id","inbound_version");--> statement-breakpoint
CREATE INDEX "ai_runs_conv_idx" ON "ai_runs" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_runs_created_idx" ON "ai_runs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "browser_events_created_idx" ON "browser_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "conversation_events_conv_idx" ON "conversation_events" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "conversation_events_created_idx" ON "conversation_events" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_queue_conv_uniq" ON "conversation_queue" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "conversation_queue_ready_at_idx" ON "conversation_queue" USING btree ("channel_account_id","ready_at");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_channel_ext_thread_uniq" ON "conversations" USING btree ("channel_account_id","external_thread_id");--> statement-breakpoint
CREATE INDEX "conversations_status_idx" ON "conversations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "conversations_last_inbound_idx" ON "conversations" USING btree ("last_inbound_at");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_channel_ext_id_uniq" ON "customers" USING btree ("channel_account_id","external_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_messages_channel_src_msg_uniq" ON "inbound_messages" USING btree ("channel_account_id","source_message_id");--> statement-breakpoint
CREATE INDEX "inbound_messages_conv_received_idx" ON "inbound_messages" USING btree ("conversation_id","received_at");--> statement-breakpoint
CREATE INDEX "incidents_channel_status_idx" ON "incidents" USING btree ("channel_account_id","status");--> statement-breakpoint
CREATE INDEX "jobs_queue_status_available_idx" ON "jobs" USING btree ("queue","status","available_at","priority");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_idempotency_key_uniq" ON "jobs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_channel_ext_msg_uniq" ON "messages" USING btree ("channel_account_id","external_message_id");--> statement-breakpoint
CREATE INDEX "messages_conv_timestamp_idx" ON "messages" USING btree ("conversation_id","timestamp");--> statement-breakpoint
CREATE INDEX "outbound_actions_conv_version_idx" ON "outbound_actions" USING btree ("conversation_id","inbound_version");--> statement-breakpoint
CREATE INDEX "outbound_actions_status_idx" ON "outbound_actions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "outbox_status_available_idx" ON "outbox_events" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "outbox_channel_created_idx" ON "outbox_events" USING btree ("channel_account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "setting_revisions_channel_rev_uniq" ON "setting_revisions" USING btree ("channel_account_id","revision");--> statement-breakpoint
CREATE INDEX "system_metrics_key_idx" ON "system_metrics" USING btree ("channel_account_id","metric_key","timestamp");--> statement-breakpoint
CREATE UNIQUE INDEX "turns_conv_version_uniq" ON "turns" USING btree ("conversation_id","inbound_version");--> statement-breakpoint
CREATE INDEX "turns_channel_status_idx" ON "turns" USING btree ("channel_account_id","status");