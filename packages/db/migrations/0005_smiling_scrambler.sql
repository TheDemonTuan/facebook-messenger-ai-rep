ALTER TABLE "conversations" ADD COLUMN "reply_control_mode" varchar(32) DEFAULT 'AUTO' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "control_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "control_reason" varchar(64);--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "control_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "controlled_by_user_id" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "last_human_outbound_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "last_human_outbound_ref" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "human_session_last_activity_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "draft_lease_id" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "draft_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "last_observed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "observation_checkpoint" jsonb DEFAULT '{}'::jsonb;