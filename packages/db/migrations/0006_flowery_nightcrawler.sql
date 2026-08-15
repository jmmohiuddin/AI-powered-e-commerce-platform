CREATE TYPE "public"."invoice_kind" AS ENUM('tax', 'simplified');--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"kind" "invoice_kind" NOT NULL,
	"number" varchar(32) NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"supplied_at" timestamp with time zone,
	"currency" varchar(3) DEFAULT 'AED' NOT NULL,
	"net_total" bigint NOT NULL,
	"vat_total" bigint NOT NULL,
	"gross_total" bigint NOT NULL,
	"recipient_trn" varchar(20),
	"document" jsonb NOT NULL,
	"credit_note_for" uuid,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "legal_address" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "recipient_trn" varchar(20);--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_order_key" ON "invoices" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_tenant_number_key" ON "invoices" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE INDEX "invoices_tenant_issued_idx" ON "invoices" USING btree ("tenant_id","issued_at");