ALTER TABLE "conversations" ADD COLUMN "human_session_started_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "conversations_human_hold_until_idx" ON "conversations" USING btree ("human_hold_until");--> statement-breakpoint
CREATE INDEX "conversations_draft_lease_expires_idx" ON "conversations" USING btree ("draft_lease_expires_at");