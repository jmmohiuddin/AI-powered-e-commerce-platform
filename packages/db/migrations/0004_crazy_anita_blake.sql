CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid,
	"channel" varchar(16) NOT NULL,
	"recipient" text NOT NULL,
	"locale" varchar(8) DEFAULT 'en-AE' NOT NULL,
	"template" varchar(48) NOT NULL,
	"subject" text,
	"body_text" text NOT NULL,
	"body_html" text,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"max_attempts" smallint DEFAULT 3 NOT NULL,
	"provider" varchar(32),
	"provider_message_id" text,
	"last_error" text,
	"reference_type" varchar(24),
	"reference_id" uuid,
	"dedupe_key" varchar(160),
	"locked_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "notifications_dispatch_idx" ON "notifications" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_dedupe_key" ON "notifications" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "notifications_reference_idx" ON "notifications" USING btree ("reference_type","reference_id");--> statement-breakpoint
CREATE INDEX "notifications_tenant_idx" ON "notifications" USING btree ("tenant_id","status");