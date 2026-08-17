CREATE TYPE "public"."noon_listing_status" AS ENUM('draft', 'pending_approval', 'live', 'rejected', 'archived');--> statement-breakpoint
CREATE TABLE "noon_listings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"partner_sku" varchar(64) NOT NULL,
	"sku_parent" varchar(64),
	"nsku" varchar(64),
	"psku_code" varchar(64),
	"category_code" varchar(64),
	"brand_code" varchar(128),
	"status" "noon_listing_status" DEFAULT 'draft' NOT NULL,
	"sync_enabled" boolean DEFAULT true NOT NULL,
	"pushed_qty" integer,
	"pushed_qty_at" timestamp with time zone,
	"pushed_price" bigint,
	"pushed_msrp" bigint,
	"pushed_price_currency" varchar(3),
	"pushed_price_at" timestamp with time zone,
	"pushed_content_hash" varchar(64),
	"pushed_content_at" timestamp with time zone,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "noon_order_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"fbpi_order_nr" varchar(64) NOT NULL,
	"mp_order_nr" varchar(64) NOT NULL,
	"mp_code" varchar(16) DEFAULT 'noon' NOT NULL,
	"warehouse_code" varchar(64) NOT NULL,
	"order_id" uuid,
	"payload" jsonb NOT NULL,
	"imported_at" timestamp with time zone,
	"shipment_confirmed_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "noon_warehouse_map" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"warehouse_code" varchar(64) NOT NULL,
	"display_name" varchar(255),
	"fulfillment_system_code" varchar(64),
	"country_code" varchar(2) DEFAULT 'ae' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "noon_listings" ADD CONSTRAINT "noon_listings_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "noon_order_links" ADD CONSTRAINT "noon_order_links_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "noon_warehouse_map" ADD CONSTRAINT "noon_warehouse_map_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "noon_listings_tenant_variant_key" ON "noon_listings" USING btree ("tenant_id","variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "noon_listings_tenant_partner_sku_key" ON "noon_listings" USING btree ("tenant_id","partner_sku");--> statement-breakpoint
CREATE INDEX "noon_listings_status_idx" ON "noon_listings" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "noon_listings_sync_idx" ON "noon_listings" USING btree ("tenant_id","sync_enabled","pushed_qty_at");--> statement-breakpoint
CREATE UNIQUE INDEX "noon_order_links_tenant_fbpi_key" ON "noon_order_links" USING btree ("tenant_id","fbpi_order_nr");--> statement-breakpoint
CREATE INDEX "noon_order_links_order_idx" ON "noon_order_links" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "noon_order_links_pending_shipment_idx" ON "noon_order_links" USING btree ("tenant_id","shipment_confirmed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "noon_warehouse_map_tenant_warehouse_key" ON "noon_warehouse_map" USING btree ("tenant_id","warehouse_id");--> statement-breakpoint
CREATE UNIQUE INDEX "noon_warehouse_map_tenant_code_key" ON "noon_warehouse_map" USING btree ("tenant_id","warehouse_code");