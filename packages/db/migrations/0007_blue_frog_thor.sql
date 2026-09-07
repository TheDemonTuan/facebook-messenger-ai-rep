CREATE TABLE "message_media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_account_id" varchar(64) NOT NULL,
	"conversation_id" uuid NOT NULL,
	"message_id" uuid,
	"media_ref_id" text NOT NULL,
	"role" varchar(32) DEFAULT 'ATTACHMENT' NOT NULL,
	"mime_type" varchar(64),
	"byte_size" integer,
	"width" integer,
	"height" integer,
	"duration_ms" integer,
	"source_url" text,
	"storage_path" text,
	"status" varchar(32) DEFAULT 'READY' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD COLUMN "content_schema_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD COLUMN "content" jsonb;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD COLUMN "content_status" varchar(32) DEFAULT 'READY' NOT NULL;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD COLUMN "content_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD COLUMN "content_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD COLUMN "event_kind" varchar(32) DEFAULT 'MESSAGE_CREATED' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "content_schema_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "content" jsonb;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "content_status" varchar(32) DEFAULT 'READY' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "content_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "content_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "parser_version" varchar(32);--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "content_quality" varchar(32) DEFAULT 'TRUSTED' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "event_kind" varchar(32) DEFAULT 'MESSAGE_CREATED' NOT NULL;--> statement-breakpoint
ALTER TABLE "message_media" ADD CONSTRAINT "message_media_channel_account_id_channel_accounts_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_media" ADD CONSTRAINT "message_media_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_media" ADD CONSTRAINT "message_media_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "message_media_channel_msg_media_uniq" ON "message_media" USING btree ("channel_account_id","message_id","media_ref_id");--> statement-breakpoint
CREATE INDEX "message_media_conv_media_idx" ON "message_media" USING btree ("conversation_id","media_ref_id");--> statement-breakpoint
CREATE INDEX "messages_conv_time_id_idx" ON "messages" USING btree ("conversation_id","timestamp","id");