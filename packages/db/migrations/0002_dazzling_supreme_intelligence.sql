ALTER TABLE "ai_runs" ADD COLUMN "request_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD COLUMN "response_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD COLUMN "used_result" jsonb;