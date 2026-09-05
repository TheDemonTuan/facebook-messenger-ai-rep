CREATE TABLE "participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_account_id" varchar(64) NOT NULL,
	"participant_id" text NOT NULL,
	"sender_kind" varchar(32) DEFAULT 'UNKNOWN' NOT NULL,
	"reliability" varchar(32) DEFAULT 'UNVERIFIED' NOT NULL,
	"is_verified" boolean DEFAULT false NOT NULL,
	"profile_url" text,
	"display_name" text,
	"avatar_url" text,
	"verified_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reply_eligibility_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_account_id" varchar(64) NOT NULL,
	"conversation_id" uuid,
	"inbound_message_id" uuid NOT NULL,
	"evaluation_mode" varchar(32) DEFAULT 'LIVE' NOT NULL,
	"decision" varchar(32) NOT NULL,
	"eligible" boolean NOT NULL,
	"reason_code" varchar(64) NOT NULL,
	"reason" text NOT NULL,
	"precedence_step" varchar(64) NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb,
	"snapshot" jsonb DEFAULT '{}'::jsonb,
	"evaluated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reply_policy_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_account_id" varchar(64) NOT NULL,
	"participant_id" text NOT NULL,
	"policy_mode" varchar(32) DEFAULT 'EXCLUDE' NOT NULL,
	"notes" text,
	"added_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversations" DROP CONSTRAINT "conversations_customer_id_customers_id_fk";
--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "customer_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "thread_kind" varchar(32) DEFAULT 'UNKNOWN' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "reliability" varchar(32) DEFAULT 'UNVERIFIED' NOT NULL;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD COLUMN "sender_participant_id" text;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD COLUMN "sender_kind" varchar(32) DEFAULT 'UNKNOWN' NOT NULL;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD COLUMN "sender_reliability" varchar(32) DEFAULT 'UNVERIFIED' NOT NULL;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD COLUMN "event_timestamp" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD COLUMN "observed_timestamp" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD COLUMN "timestamp_provenance" varchar(32) DEFAULT 'OBSERVED' NOT NULL;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD COLUMN "timestamp_precision" varchar(32) DEFAULT 'UNKNOWN' NOT NULL;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD COLUMN "timestamps" jsonb;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "sender_participant_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "sender_kind" varchar(32) DEFAULT 'UNKNOWN' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "sender_reliability" varchar(32) DEFAULT 'UNVERIFIED' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "event_timestamp" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "observed_timestamp" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "timestamp_provenance" varchar(32) DEFAULT 'OBSERVED' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "timestamp_precision" varchar(32) DEFAULT 'UNKNOWN' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "timestamps" jsonb;--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "participants_channel_account_id_channel_accounts_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_eligibility_decisions" ADD CONSTRAINT "reply_eligibility_decisions_channel_account_id_channel_accounts_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_eligibility_decisions" ADD CONSTRAINT "reply_eligibility_decisions_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_eligibility_decisions" ADD CONSTRAINT "reply_eligibility_decisions_inbound_message_id_inbound_messages_id_fk" FOREIGN KEY ("inbound_message_id") REFERENCES "public"."inbound_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_policy_members" ADD CONSTRAINT "reply_policy_members_channel_account_id_channel_accounts_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "participants_channel_participant_uniq" ON "participants" USING btree ("channel_account_id","participant_id");--> statement-breakpoint
CREATE INDEX "participants_channel_sender_kind_idx" ON "participants" USING btree ("channel_account_id","sender_kind");--> statement-breakpoint
CREATE UNIQUE INDEX "reply_eligibility_decisions_inbound_mode_uniq" ON "reply_eligibility_decisions" USING btree ("inbound_message_id","evaluation_mode");--> statement-breakpoint
CREATE INDEX "reply_eligibility_decisions_conv_idx" ON "reply_eligibility_decisions" USING btree ("conversation_id","evaluated_at");--> statement-breakpoint
CREATE INDEX "reply_eligibility_decisions_channel_idx" ON "reply_eligibility_decisions" USING btree ("channel_account_id","evaluated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reply_policy_members_channel_participant_uniq" ON "reply_policy_members" USING btree ("channel_account_id","participant_id");--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversations_thread_kind_idx" ON "conversations" USING btree ("thread_kind");--> statement-breakpoint
CREATE INDEX "inbound_messages_conv_sender_hash_time_idx" ON "inbound_messages" USING btree ("conversation_id","sender_participant_id","text_hash","received_at");--> statement-breakpoint
CREATE INDEX "messages_conv_sender_hash_time_idx" ON "messages" USING btree ("conversation_id","sender_participant_id","text_hash","timestamp");--> statement-breakpoint
UPDATE "conversations" SET "thread_kind" = 'UNKNOWN', "reliability" = 'LEGACY_UNVERIFIED' WHERE "reliability" = 'UNVERIFIED' OR "reliability" IS NULL;--> statement-breakpoint
UPDATE "messages" SET "sender_kind" = 'UNKNOWN', "sender_reliability" = 'LEGACY_UNVERIFIED', "timestamp_provenance" = 'OBSERVED', "timestamp_precision" = 'UNKNOWN' WHERE "sender_reliability" = 'UNVERIFIED' OR "sender_reliability" IS NULL;--> statement-breakpoint
UPDATE "inbound_messages" SET "sender_kind" = 'UNKNOWN', "sender_reliability" = 'LEGACY_UNVERIFIED', "timestamp_provenance" = 'OBSERVED', "timestamp_precision" = 'UNKNOWN' WHERE "sender_reliability" = 'UNVERIFIED' OR "sender_reliability" IS NULL;