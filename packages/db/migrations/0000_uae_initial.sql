CREATE TYPE "public"."tenant_plan" AS ENUM('trial', 'starter', 'growth', 'enterprise');--> statement-breakpoint
CREATE TYPE "public"."tenant_status" AS ENUM('active', 'suspended', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."attribute_type" AS ENUM('text', 'number', 'boolean', 'enum', 'measurement');--> statement-breakpoint
CREATE TYPE "public"."media_kind" AS ENUM('image', 'video', 'model_3d', 'document');--> statement-breakpoint
CREATE TYPE "public"."product_condition" AS ENUM('new', 'refurbished', 'open_box', 'used');--> statement-breakpoint
CREATE TYPE "public"."product_link_type" AS ENUM('related', 'accessory', 'upsell', 'cross_sell', 'compatible_with', 'replacement_for');--> statement-breakpoint
CREATE TYPE "public"."product_status" AS ENUM('draft', 'active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."review_status" AS ENUM('pending', 'published', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."purchase_order_status" AS ENUM('draft', 'submitted', 'confirmed', 'partially_received', 'received', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."reservation_status" AS ENUM('held', 'committed', 'released', 'expired');--> statement-breakpoint
CREATE TYPE "public"."serial_unit_status" AS ENUM('in_stock', 'reserved', 'sold', 'returned', 'defective', 'written_off');--> statement-breakpoint
CREATE TYPE "public"."stock_movement_reason" AS ENUM('purchase_received', 'sale', 'return_restock', 'damage', 'theft', 'transfer_in', 'transfer_out', 'manual_adjustment', 'stocktake');--> statement-breakpoint
CREATE TYPE "public"."warehouse_kind" AS ENUM('warehouse', 'retail_store', 'dropship');--> statement-breakpoint
CREATE TYPE "public"."cart_status" AS ENUM('active', 'converted', 'abandoned', 'merged');--> statement-breakpoint
CREATE TYPE "public"."fulfilment_status" AS ENUM('unfulfilled', 'partially_fulfilled', 'fulfilled', 'partially_returned', 'returned');--> statement-breakpoint
CREATE TYPE "public"."order_channel" AS ENUM('web', 'mobile_app', 'whatsapp', 'phone', 'pos', 'marketplace');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('pending', 'confirmed', 'processing', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('unpaid', 'authorised', 'partially_paid', 'paid', 'partially_refunded', 'refunded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."return_reason" AS ENUM('damaged', 'defective', 'wrong_item', 'not_as_described', 'changed_mind', 'better_price', 'late_delivery', 'other');--> statement-breakpoint
CREATE TYPE "public"."return_resolution" AS ENUM('refund', 'exchange', 'store_credit', 'repair', 'warranty_replacement');--> statement-breakpoint
CREATE TYPE "public"."return_status" AS ENUM('requested', 'approved', 'rejected', 'in_transit', 'received', 'inspected', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."shipment_status" AS ENUM('pending', 'picked', 'packed', 'handed_over', 'in_transit', 'out_for_delivery', 'delivered', 'failed', 'returned_to_sender');--> statement-breakpoint
CREATE TYPE "public"."payment_intent_status" AS ENUM('created', 'requires_action', 'processing', 'succeeded', 'failed', 'cancelled', 'expired');--> statement-breakpoint
CREATE TYPE "public"."payment_provider" AS ENUM('cod', 'paytabs', 'network', 'nagad', 'stripe', 'paypal', 'bank_transfer', 'store_credit', 'gift_card', 'manual');--> statement-breakpoint
CREATE TYPE "public"."transaction_kind" AS ENUM('authorisation', 'capture', 'sale', 'refund', 'void', 'chargeback', 'chargeback_reversal', 'payout');--> statement-breakpoint
CREATE TYPE "public"."transaction_status" AS ENUM('pending', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."campaign_channel" AS ENUM('email', 'sms', 'whatsapp', 'push', 'facebook', 'instagram', 'tiktok', 'linkedin', 'x', 'onsite');--> statement-breakpoint
CREATE TYPE "public"."campaign_status" AS ENUM('draft', 'scheduled', 'sending', 'sent', 'paused', 'cancelled', 'failed');--> statement-breakpoint
CREATE TYPE "public"."content_asset_status" AS ENUM('generated', 'edited', 'approved', 'published', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."discount_scope" AS ENUM('order', 'product', 'category', 'brand', 'shipping');--> statement-breakpoint
CREATE TYPE "public"."discount_type" AS ENUM('percentage', 'fixed_amount', 'free_shipping', 'buy_x_get_y', 'bundle');--> statement-breakpoint
CREATE TYPE "public"."ai_job_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled', 'awaiting_review');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"token_prefix" varchar(12) NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"actor_type" varchar(24) DEFAULT 'user' NOT NULL,
	"actor_label" text,
	"action" varchar(64) NOT NULL,
	"entity_type" varchar(64) NOT NULL,
	"entity_id" uuid,
	"changes" jsonb,
	"metadata" jsonb,
	"ip_address" varchar(45),
	"user_agent" text,
	"request_id" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"store_id" uuid,
	"invited_by_user_id" uuid,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" varchar(64) NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stores" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"domain" varchar(255),
	"currency" varchar(3) DEFAULT 'AED' NOT NULL,
	"locale" varchar(10) DEFAULT 'en-AE' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"theme" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" varchar(63) NOT NULL,
	"name" text NOT NULL,
	"plan" "tenant_plan" DEFAULT 'trial' NOT NULL,
	"status" "tenant_status" DEFAULT 'active' NOT NULL,
	"country_code" varchar(2) DEFAULT 'AE' NOT NULL,
	"default_currency" varchar(3) DEFAULT 'AED' NOT NULL,
	"default_locale" varchar(10) DEFAULT 'en-AE' NOT NULL,
	"supported_locales" jsonb DEFAULT '["en-AE","ar-AE"]'::jsonb NOT NULL,
	"timezone" varchar(64) DEFAULT 'Asia/Dubai' NOT NULL,
	"legal_name" text,
	"tax_registration_number" varchar(20),
	"trade_licence_number" varchar(40),
	"vat_rate_bps" integer DEFAULT 500 NOT NULL,
	"prices_include_vat" boolean DEFAULT true NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" varchar(320) NOT NULL,
	"email_verified_at" timestamp with time zone,
	"name" text NOT NULL,
	"avatar_url" text,
	"password_hash" text,
	"totp_secret" text,
	"mfa_enabled_at" timestamp with time zone,
	"session_epoch" varchar(26) DEFAULT '0' NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "attributes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" varchar(64) NOT NULL,
	"name" text NOT NULL,
	"type" "attribute_type" DEFAULT 'text' NOT NULL,
	"unit" varchar(16),
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_filterable" boolean DEFAULT true NOT NULL,
	"is_comparable" boolean DEFAULT true NOT NULL,
	"is_key_spec" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brands" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"slug" varchar(128) NOT NULL,
	"name" text NOT NULL,
	"logo_url" text,
	"description" text,
	"default_warranty_months" smallint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"parent_id" uuid,
	"slug" varchar(128) NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"image_url" text,
	"path" text NOT NULL,
	"depth" smallint DEFAULT 0 NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"is_visible" boolean DEFAULT true NOT NULL,
	"meta_title" text,
	"meta_description" text,
	"translations" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "media" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"product_id" uuid,
	"variant_id" uuid,
	"kind" "media_kind" DEFAULT 'image' NOT NULL,
	"url" text NOT NULL,
	"width" integer,
	"height" integer,
	"blur_data_url" text,
	"alt_text" text,
	"duration_seconds" integer,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_attribute_values" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"attribute_id" uuid NOT NULL,
	"value_text" text,
	"value_number" integer,
	"value_boolean" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_embeddings" (
	"product_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"model" varchar(64) NOT NULL,
	"source_hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"linked_product_id" uuid NOT NULL,
	"type" "product_link_type" DEFAULT 'related' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"is_automatic" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"store_id" uuid,
	"slug" varchar(200) NOT NULL,
	"title" text NOT NULL,
	"subtitle" text,
	"description" text,
	"highlights" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"brand_id" uuid,
	"category_id" uuid,
	"status" "product_status" DEFAULT 'draft' NOT NULL,
	"condition" "product_condition" DEFAULT 'new' NOT NULL,
	"published_at" timestamp with time zone,
	"warranty_months" smallint,
	"warranty_terms" text,
	"rating_average" smallint,
	"rating_count" integer DEFAULT 0 NOT NULL,
	"price_from" bigint,
	"compare_at_price_from" bigint,
	"currency" varchar(3) DEFAULT 'AED' NOT NULL,
	"meta_title" text,
	"meta_description" text,
	"aeo_facts" jsonb,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"translations" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"search_vector" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "review_summaries" (
	"product_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"summary" text NOT NULL,
	"pros" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"based_on_review_count" integer NOT NULL,
	"model" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid,
	"customer_id" uuid,
	"order_id" uuid,
	"rating" smallint NOT NULL,
	"title" text,
	"body" text,
	"media_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_verified_purchase" boolean DEFAULT false NOT NULL,
	"helpful_count" integer DEFAULT 0 NOT NULL,
	"status" "review_status" DEFAULT 'pending' NOT NULL,
	"moderation_result" jsonb,
	"merchant_reply" text,
	"merchant_replied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "variants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"sku" varchar(64) NOT NULL,
	"barcode" varchar(64),
	"mpn" varchar(64),
	"title" text NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"price" bigint NOT NULL,
	"compare_at_price" bigint,
	"cost_price" bigint,
	"currency" varchar(3) DEFAULT 'AED' NOT NULL,
	"weight_grams" integer,
	"dimensions_mm" jsonb,
	"is_serialised" boolean DEFAULT false NOT NULL,
	"requires_shipping" boolean DEFAULT true NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "purchase_order_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"quantity_ordered" integer NOT NULL,
	"quantity_received" integer DEFAULT 0 NOT NULL,
	"unit_cost" bigint NOT NULL,
	"currency" varchar(3) DEFAULT 'AED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" varchar(32) NOT NULL,
	"supplier_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"status" "purchase_order_status" DEFAULT 'draft' NOT NULL,
	"subtotal" bigint DEFAULT 0 NOT NULL,
	"shipping_cost" bigint DEFAULT 0 NOT NULL,
	"tax_total" bigint DEFAULT 0 NOT NULL,
	"total" bigint DEFAULT 0 NOT NULL,
	"currency" varchar(3) DEFAULT 'AED' NOT NULL,
	"expected_at" timestamp with time zone,
	"received_at" timestamp with time zone,
	"generated_by_forecast_id" uuid,
	"note" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "serial_units" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"warehouse_id" uuid,
	"serial_number" varchar(64) NOT NULL,
	"imei" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" serial_unit_status DEFAULT 'in_stock' NOT NULL,
	"purchase_order_id" uuid,
	"order_item_id" uuid,
	"unit_cost" bigint,
	"currency" varchar(3) DEFAULT 'AED',
	"warranty_starts_at" timestamp with time zone,
	"warranty_ends_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_levels" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"on_hand" integer DEFAULT 0 NOT NULL,
	"reserved" integer DEFAULT 0 NOT NULL,
	"incoming" integer DEFAULT 0 NOT NULL,
	"reorder_point" integer DEFAULT 0 NOT NULL,
	"reorder_quantity" integer DEFAULT 0 NOT NULL,
	"lead_time_days" smallint,
	"allow_backorder" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"delta" integer NOT NULL,
	"balance_after" integer NOT NULL,
	"reason" "stock_movement_reason" NOT NULL,
	"unit_cost" bigint,
	"currency" varchar(3) DEFAULT 'AED',
	"reference_type" varchar(32),
	"reference_id" uuid,
	"note" text,
	"actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_reservations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"cart_id" uuid,
	"order_id" uuid,
	"status" "reservation_status" DEFAULT 'held' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_products" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"supplier_sku" varchar(64),
	"unit_cost" bigint NOT NULL,
	"currency" varchar(3) DEFAULT 'AED' NOT NULL,
	"min_order_quantity" integer DEFAULT 1 NOT NULL,
	"lead_time_days" smallint,
	"is_preferred" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" varchar(32) NOT NULL,
	"name" text NOT NULL,
	"contact_name" text,
	"email" varchar(320),
	"phone" varchar(32),
	"address" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"payment_terms" varchar(32),
	"default_lead_time_days" smallint,
	"currency" varchar(3) DEFAULT 'AED' NOT NULL,
	"scorecard" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "warehouses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" varchar(32) NOT NULL,
	"name" text NOT NULL,
	"kind" "warehouse_kind" DEFAULT 'warehouse' NOT NULL,
	"address" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"latitude" varchar(24),
	"longitude" varchar(24),
	"priority" smallint DEFAULT 100 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "addresses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid,
	"label" varchar(32),
	"recipient_name" text NOT NULL,
	"phone" varchar(32) NOT NULL,
	"emirate" varchar(2),
	"area" text,
	"building_name" text,
	"flat_or_villa" varchar(32),
	"street" text,
	"makani" varchar(10),
	"po_box" varchar(16),
	"landmark" text,
	"line1" text,
	"line2" text,
	"city" text,
	"region" text,
	"postal_code" varchar(16),
	"country_code" varchar(2) DEFAULT 'AE' NOT NULL,
	"latitude" varchar(24),
	"longitude" varchar(24),
	"is_default_shipping" boolean DEFAULT false NOT NULL,
	"is_default_billing" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "cart_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"cart_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_price" bigint NOT NULL,
	"currency" varchar(3) DEFAULT 'AED' NOT NULL,
	"customisations" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "carts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"store_id" uuid,
	"customer_id" uuid,
	"session_token" varchar(64),
	"status" "cart_status" DEFAULT 'active' NOT NULL,
	"currency" varchar(3) DEFAULT 'AED' NOT NULL,
	"subtotal" bigint DEFAULT 0 NOT NULL,
	"discount_total" bigint DEFAULT 0 NOT NULL,
	"shipping_total" bigint DEFAULT 0 NOT NULL,
	"tax_total" bigint DEFAULT 0 NOT NULL,
	"total" bigint DEFAULT 0 NOT NULL,
	"applied_coupons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"shipping_address_id" uuid,
	"attribution" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"abandoned_at" timestamp with time zone,
	"recovery_email_sent_at" timestamp with time zone,
	"converted_order_id" uuid,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" varchar(320),
	"phone" varchar(32),
	"first_name" text,
	"last_name" text,
	"password_hash" text,
	"email_verified_at" timestamp with time zone,
	"phone_verified_at" timestamp with time zone,
	"accepts_marketing_email" boolean DEFAULT false NOT NULL,
	"accepts_marketing_sms" boolean DEFAULT false NOT NULL,
	"accepts_marketing_whatsapp" boolean DEFAULT false NOT NULL,
	"loyalty_points" integer DEFAULT 0 NOT NULL,
	"loyalty_tier" varchar(24) DEFAULT 'bronze' NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"segments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"risk_score" smallint DEFAULT 0 NOT NULL,
	"note" text,
	"last_order_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "order_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"type" varchar(48) NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"message" text,
	"data" jsonb,
	"actor_type" varchar(24) DEFAULT 'system' NOT NULL,
	"actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"variant_id" uuid,
	"product_id" uuid,
	"sku" varchar(64) NOT NULL,
	"title" text NOT NULL,
	"variant_title" text,
	"image_url" text,
	"quantity" integer NOT NULL,
	"unit_price" bigint NOT NULL,
	"unit_cost" bigint,
	"discount_total" bigint DEFAULT 0 NOT NULL,
	"tax_total" bigint DEFAULT 0 NOT NULL,
	"line_total" bigint NOT NULL,
	"currency" varchar(3) DEFAULT 'AED' NOT NULL,
	"quantity_fulfilled" integer DEFAULT 0 NOT NULL,
	"quantity_returned" integer DEFAULT 0 NOT NULL,
	"quantity_refunded" integer DEFAULT 0 NOT NULL,
	"warranty_months" smallint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"store_id" uuid,
	"number" varchar(32) NOT NULL,
	"customer_id" uuid,
	"email" varchar(320),
	"phone" varchar(32),
	"status" "order_status" DEFAULT 'pending' NOT NULL,
	"payment_status" "payment_status" DEFAULT 'unpaid' NOT NULL,
	"fulfilment_status" "fulfilment_status" DEFAULT 'unfulfilled' NOT NULL,
	"channel" "order_channel" DEFAULT 'web' NOT NULL,
	"currency" varchar(3) DEFAULT 'AED' NOT NULL,
	"subtotal" bigint DEFAULT 0 NOT NULL,
	"discount_total" bigint DEFAULT 0 NOT NULL,
	"shipping_total" bigint DEFAULT 0 NOT NULL,
	"tax_total" bigint DEFAULT 0 NOT NULL,
	"total" bigint DEFAULT 0 NOT NULL,
	"paid_total" bigint DEFAULT 0 NOT NULL,
	"refunded_total" bigint DEFAULT 0 NOT NULL,
	"cost_total" bigint DEFAULT 0 NOT NULL,
	"shipping_address" jsonb,
	"billing_address" jsonb,
	"applied_discounts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attribution" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"risk_score" smallint DEFAULT 0 NOT NULL,
	"risk_signals" jsonb,
	"customer_note" text,
	"internal_note" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"placed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "return_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"return_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"serial_unit_id" uuid,
	"condition" varchar(32),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "returns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"number" varchar(32) NOT NULL,
	"customer_id" uuid,
	"status" "return_status" DEFAULT 'requested' NOT NULL,
	"reason" "return_reason" NOT NULL,
	"resolution" "return_resolution" DEFAULT 'refund' NOT NULL,
	"customer_comment" text,
	"evidence_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"inspection_note" text,
	"restockable" boolean,
	"refund_amount" bigint,
	"currency" varchar(3) DEFAULT 'AED',
	"approved_at" timestamp with time zone,
	"received_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipment_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"shipment_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"warehouse_id" uuid,
	"carrier_code" varchar(32),
	"service_level" varchar(32),
	"tracking_number" varchar(64),
	"tracking_url" text,
	"status" "shipment_status" DEFAULT 'pending' NOT NULL,
	"tracking_events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cod_amount" bigint,
	"cod_collected_at" timestamp with time zone,
	"cod_remitted_at" timestamp with time zone,
	"shipping_cost" bigint,
	"currency" varchar(3) DEFAULT 'AED',
	"weight_grams" integer,
	"estimated_delivery_at" timestamp with time zone,
	"shipped_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gift_card_transactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"gift_card_id" uuid NOT NULL,
	"order_id" uuid,
	"amount" bigint NOT NULL,
	"balance_after" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gift_cards" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code_hash" varchar(64) NOT NULL,
	"code_last4" varchar(4) NOT NULL,
	"initial_amount" bigint NOT NULL,
	"balance" bigint NOT NULL,
	"currency" varchar(3) DEFAULT 'AED' NOT NULL,
	"issued_to_customer_id" uuid,
	"issued_by_order_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instalment_plans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"provider" "payment_provider" NOT NULL,
	"term_months" smallint NOT NULL,
	"interest_rate_bps" integer DEFAULT 0 NOT NULL,
	"down_payment" bigint DEFAULT 0 NOT NULL,
	"instalment_amount" bigint NOT NULL,
	"total_payable" bigint NOT NULL,
	"currency" varchar(3) DEFAULT 'AED' NOT NULL,
	"schedule" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_intents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid,
	"customer_id" uuid,
	"provider" "payment_provider" NOT NULL,
	"provider_reference" varchar(128),
	"amount" bigint NOT NULL,
	"currency" varchar(3) DEFAULT 'AED' NOT NULL,
	"status" "payment_intent_status" DEFAULT 'created' NOT NULL,
	"idempotency_key" varchar(64) NOT NULL,
	"redirect_url" text,
	"return_url" text,
	"failure_code" varchar(64),
	"failure_message" text,
	"raw" jsonb,
	"expires_at" timestamp with time zone,
	"succeeded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_method_configs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" "payment_provider" NOT NULL,
	"display_name" text NOT NULL,
	"logo_url" text,
	"is_enabled" boolean DEFAULT false NOT NULL,
	"is_test_mode" boolean DEFAULT true NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"credentials_encrypted" text,
	"rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fee_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_webhook_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" "payment_provider" NOT NULL,
	"provider_event_id" varchar(128) NOT NULL,
	"event_type" varchar(64),
	"signature_verified" boolean DEFAULT false NOT NULL,
	"payload" jsonb NOT NULL,
	"processed_at" timestamp with time zone,
	"processing_error" text,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "store_credit_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"currency" varchar(3) DEFAULT 'AED' NOT NULL,
	"reason" varchar(48) NOT NULL,
	"order_id" uuid,
	"return_id" uuid,
	"note" text,
	"expires_at" timestamp with time zone,
	"actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid,
	"payment_intent_id" uuid,
	"parent_transaction_id" uuid,
	"provider" "payment_provider" NOT NULL,
	"provider_reference" varchar(128),
	"kind" "transaction_kind" NOT NULL,
	"status" "transaction_status" DEFAULT 'pending' NOT NULL,
	"amount" bigint NOT NULL,
	"currency" varchar(3) DEFAULT 'AED' NOT NULL,
	"fee_amount" bigint,
	"reason" text,
	"raw" jsonb,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analytics_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"store_id" uuid,
	"session_id" varchar(64) NOT NULL,
	"customer_id" uuid,
	"type" varchar(32) NOT NULL,
	"product_id" uuid,
	"variant_id" uuid,
	"search_query" text,
	"value" bigint,
	"currency" varchar(3) DEFAULT 'AED',
	"referrer" text,
	"utm" jsonb,
	"device_type" varchar(16),
	"country_code" varchar(2),
	"properties" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"customer_id" uuid,
	"type" varchar(24) NOT NULL,
	"order_id" uuid,
	"revenue" bigint,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"channel" "campaign_channel" NOT NULL,
	"status" "campaign_status" DEFAULT 'draft' NOT NULL,
	"audience" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"audience_size" integer,
	"content" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ai_provenance" jsonb,
	"approved_by_user_id" uuid,
	"approved_at" timestamp with time zone,
	"scheduled_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attributed_revenue" bigint DEFAULT 0 NOT NULL,
	"spend" bigint DEFAULT 0 NOT NULL,
	"currency" varchar(3) DEFAULT 'AED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"campaign_id" uuid,
	"channel" "campaign_channel" NOT NULL,
	"format" varchar(32) NOT NULL,
	"status" "content_asset_status" DEFAULT 'generated' NOT NULL,
	"body" text,
	"headline" text,
	"hashtags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"media_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"product_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ai_provenance" jsonb,
	"edited_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discount_redemptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"discount_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"customer_id" uuid,
	"amount" bigint NOT NULL,
	"currency" varchar(3) DEFAULT 'AED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" varchar(64),
	"name" text NOT NULL,
	"description" text,
	"type" "discount_type" NOT NULL,
	"scope" "discount_scope" DEFAULT 'order' NOT NULL,
	"value" integer NOT NULL,
	"max_discount_amount" bigint,
	"currency" varchar(3) DEFAULT 'AED',
	"conditions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"usage_limit" integer,
	"usage_limit_per_customer" integer,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"is_stackable" boolean DEFAULT false NOT NULL,
	"priority" smallint DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loyalty_transactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"points" integer NOT NULL,
	"balance_after" integer NOT NULL,
	"reason" varchar(48) NOT NULL,
	"order_id" uuid,
	"note" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recently_viewed" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid,
	"session_id" varchar(64),
	"product_id" uuid NOT NULL,
	"view_count" integer DEFAULT 1 NOT NULL,
	"last_viewed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_queries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"session_id" varchar(64),
	"customer_id" uuid,
	"query" text NOT NULL,
	"normalised_query" text NOT NULL,
	"result_count" integer DEFAULT 0 NOT NULL,
	"clicked_product_id" uuid,
	"clicked_position" smallint,
	"converted_order_id" uuid,
	"strategy" varchar(16),
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wishlists" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid,
	"price_at_save" bigint,
	"currency" varchar(3) DEFAULT 'AED',
	"notify_on_price_drop" boolean DEFAULT true NOT NULL,
	"notify_on_restock" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"task" varchar(64) NOT NULL,
	"status" "ai_job_status" DEFAULT 'queued' NOT NULL,
	"entity_type" varchar(32),
	"entity_id" uuid,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output" jsonb,
	"model" varchar(64),
	"prompt_version" varchar(32),
	"input_tokens" integer,
	"output_tokens" integer,
	"cached_tokens" integer,
	"cost_micro_usd" integer,
	"latency_ms" integer,
	"reviewed_by_user_id" uuid,
	"reviewed_at" timestamp with time zone,
	"review_decision" varchar(16),
	"error" text,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"requested_by_user_id" uuid,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_usage" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"day" varchar(10) NOT NULL,
	"task" varchar(64) NOT NULL,
	"model" varchar(64) NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cached_tokens" integer DEFAULT 0 NOT NULL,
	"cost_micro_usd" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assistant_conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"session_id" varchar(64) NOT NULL,
	"customer_id" uuid,
	"kind" varchar(16) DEFAULT 'shopping' NOT NULL,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"escalated" boolean DEFAULT false NOT NULL,
	"resulting_order_id" uuid,
	"satisfaction" smallint,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competitor_prices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"variant_id" uuid,
	"matched_by_mpn" varchar(64),
	"competitor_name" text NOT NULL,
	"source_type" varchar(24) NOT NULL,
	"source_url" text,
	"price" bigint NOT NULL,
	"currency" varchar(3) DEFAULT 'AED' NOT NULL,
	"in_stock" boolean,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "demand_forecasts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"warehouse_id" uuid,
	"horizon_days" smallint NOT NULL,
	"model_kind" varchar(32) NOT NULL,
	"predicted_units" integer NOT NULL,
	"lower_bound" integer,
	"upper_bound" integer,
	"safety_stock" integer,
	"reorder_recommendation" integer,
	"recommended_supplier_id" uuid,
	"backtest_mape_bps" integer,
	"features" jsonb,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_health" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"classification" varchar(24) NOT NULL,
	"days_of_cover" integer,
	"days_since_last_sale" integer,
	"units_on_hand" integer DEFAULT 0 NOT NULL,
	"tied_up_capital" bigint,
	"currency" varchar(3) DEFAULT 'AED',
	"suggested_markdown_bps" integer,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "price_recommendations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"current_price" bigint NOT NULL,
	"recommended_price" bigint NOT NULL,
	"currency" varchar(3) DEFAULT 'AED' NOT NULL,
	"projected_margin_bps" integer,
	"projected_units_delta" integer,
	"rationale" text,
	"signals" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"applied_by_user_id" uuid,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "risk_assessments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"entity_type" varchar(16) NOT NULL,
	"entity_id" uuid NOT NULL,
	"score" smallint NOT NULL,
	"decision" varchar(32) NOT NULL,
	"signals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model_version" varchar(32),
	"overridden_by_user_id" uuid,
	"override_decision" varchar(32),
	"outcome" varchar(32),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_attribute_values" ADD CONSTRAINT "product_attribute_values_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_attribute_values" ADD CONSTRAINT "product_attribute_values_attribute_id_attributes_id_fk" FOREIGN KEY ("attribute_id") REFERENCES "public"."attributes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_embeddings" ADD CONSTRAINT "product_embeddings_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_links" ADD CONSTRAINT "product_links_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_links" ADD CONSTRAINT "product_links_linked_product_id_products_id_fk" FOREIGN KEY ("linked_product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_summaries" ADD CONSTRAINT "review_summaries_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serial_units" ADD CONSTRAINT "serial_units_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serial_units" ADD CONSTRAINT "serial_units_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_cart_id_carts_id_fk" FOREIGN KEY ("cart_id") REFERENCES "public"."carts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carts" ADD CONSTRAINT "carts_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carts" ADD CONSTRAINT "carts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_items" ADD CONSTRAINT "return_items_return_id_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."returns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_items" ADD CONSTRAINT "return_items_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "returns" ADD CONSTRAINT "returns_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "returns" ADD CONSTRAINT "returns_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_items" ADD CONSTRAINT "shipment_items_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_items" ADD CONSTRAINT "shipment_items_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card_transactions" ADD CONSTRAINT "gift_card_transactions_gift_card_id_gift_cards_id_fk" FOREIGN KEY ("gift_card_id") REFERENCES "public"."gift_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card_transactions" ADD CONSTRAINT "gift_card_transactions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instalment_plans" ADD CONSTRAINT "instalment_plans_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_credit_entries" ADD CONSTRAINT "store_credit_entries_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_credit_entries" ADD CONSTRAINT "store_credit_entries_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_payment_intent_id_payment_intents_id_fk" FOREIGN KEY ("payment_intent_id") REFERENCES "public"."payment_intents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_events" ADD CONSTRAINT "campaign_events_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_events" ADD CONSTRAINT "campaign_events_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_events" ADD CONSTRAINT "campaign_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_assets" ADD CONSTRAINT "content_assets_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_redemptions" ADD CONSTRAINT "discount_redemptions_discount_id_discounts_id_fk" FOREIGN KEY ("discount_id") REFERENCES "public"."discounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_redemptions" ADD CONSTRAINT "discount_redemptions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_redemptions" ADD CONSTRAINT "discount_redemptions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wishlists" ADD CONSTRAINT "wishlists_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_token_hash_key" ON "api_keys" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "api_keys_tenant_idx" ON "api_keys" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "audit_logs_tenant_created_idx" ON "audit_logs" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("tenant_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_logs_actor_idx" ON "audit_logs" USING btree ("tenant_id","actor_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_tenant_user_key" ON "memberships" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "roles_tenant_key_key" ON "roles" USING btree ("tenant_id","key");--> statement-breakpoint
CREATE INDEX "stores_tenant_idx" ON "stores" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stores_domain_key" ON "stores" USING btree ("domain");--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "tenants_status_idx" ON "tenants" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "attributes_tenant_key_key" ON "attributes" USING btree ("tenant_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "brands_tenant_slug_key" ON "brands" USING btree ("tenant_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "categories_tenant_slug_key" ON "categories" USING btree ("tenant_id","slug");--> statement-breakpoint
CREATE INDEX "categories_tenant_path_idx" ON "categories" USING btree ("tenant_id","path");--> statement-breakpoint
CREATE INDEX "categories_parent_idx" ON "categories" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "media_product_idx" ON "media" USING btree ("product_id","position");--> statement-breakpoint
CREATE INDEX "media_variant_idx" ON "media" USING btree ("variant_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "pav_product_attribute_key" ON "product_attribute_values" USING btree ("product_id","attribute_id");--> statement-breakpoint
CREATE INDEX "pav_tenant_attr_text_idx" ON "product_attribute_values" USING btree ("tenant_id","attribute_id","value_text");--> statement-breakpoint
CREATE INDEX "pav_tenant_attr_num_idx" ON "product_attribute_values" USING btree ("tenant_id","attribute_id","value_number");--> statement-breakpoint
CREATE INDEX "product_embeddings_hnsw_idx" ON "product_embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "product_embeddings_tenant_idx" ON "product_embeddings" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_links_key" ON "product_links" USING btree ("product_id","linked_product_id","type");--> statement-breakpoint
CREATE INDEX "product_links_lookup_idx" ON "product_links" USING btree ("tenant_id","product_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "products_tenant_slug_key" ON "products" USING btree ("tenant_id","slug");--> statement-breakpoint
CREATE INDEX "products_tenant_status_idx" ON "products" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "products_category_idx" ON "products" USING btree ("tenant_id","category_id");--> statement-breakpoint
CREATE INDEX "products_brand_idx" ON "products" USING btree ("tenant_id","brand_id");--> statement-breakpoint
CREATE INDEX "products_price_idx" ON "products" USING btree ("tenant_id","price_from");--> statement-breakpoint
CREATE INDEX "products_rating_idx" ON "products" USING btree ("tenant_id","rating_average");--> statement-breakpoint
CREATE INDEX "products_title_trgm_idx" ON "products" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "reviews_product_status_idx" ON "reviews" USING btree ("product_id","status");--> statement-breakpoint
CREATE INDEX "reviews_tenant_created_idx" ON "reviews" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_customer_product_key" ON "reviews" USING btree ("customer_id","product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "variants_tenant_sku_key" ON "variants" USING btree ("tenant_id","sku");--> statement-breakpoint
CREATE INDEX "variants_product_idx" ON "variants" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "variants_barcode_idx" ON "variants" USING btree ("tenant_id","barcode");--> statement-breakpoint
CREATE INDEX "purchase_order_items_po_idx" ON "purchase_order_items" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_orders_tenant_number_key" ON "purchase_orders" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE INDEX "purchase_orders_status_idx" ON "purchase_orders" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "purchase_orders_supplier_idx" ON "purchase_orders" USING btree ("supplier_id");--> statement-breakpoint
CREATE UNIQUE INDEX "serial_units_tenant_serial_key" ON "serial_units" USING btree ("tenant_id","serial_number");--> statement-breakpoint
CREATE INDEX "serial_units_variant_status_idx" ON "serial_units" USING btree ("variant_id","status");--> statement-breakpoint
CREATE INDEX "serial_units_order_item_idx" ON "serial_units" USING btree ("order_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_levels_variant_warehouse_key" ON "stock_levels" USING btree ("variant_id","warehouse_id");--> statement-breakpoint
CREATE INDEX "stock_levels_tenant_idx" ON "stock_levels" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "stock_levels_reorder_idx" ON "stock_levels" USING btree ("tenant_id","reorder_point");--> statement-breakpoint
CREATE INDEX "stock_movements_variant_idx" ON "stock_movements" USING btree ("variant_id","created_at");--> statement-breakpoint
CREATE INDEX "stock_movements_tenant_created_idx" ON "stock_movements" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "stock_movements_reference_idx" ON "stock_movements" USING btree ("reference_type","reference_id");--> statement-breakpoint
CREATE INDEX "stock_reservations_sweep_idx" ON "stock_reservations" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "stock_reservations_cart_idx" ON "stock_reservations" USING btree ("cart_id");--> statement-breakpoint
CREATE INDEX "stock_reservations_order_idx" ON "stock_reservations" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_products_key" ON "supplier_products" USING btree ("supplier_id","variant_id");--> statement-breakpoint
CREATE INDEX "supplier_products_variant_idx" ON "supplier_products" USING btree ("variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_tenant_code_key" ON "suppliers" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "warehouses_tenant_code_key" ON "warehouses" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "addresses_customer_idx" ON "addresses" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "addresses_emirate_idx" ON "addresses" USING btree ("tenant_id","emirate");--> statement-breakpoint
CREATE UNIQUE INDEX "cart_items_cart_variant_key" ON "cart_items" USING btree ("cart_id","variant_id");--> statement-breakpoint
CREATE INDEX "cart_items_cart_idx" ON "cart_items" USING btree ("cart_id");--> statement-breakpoint
CREATE INDEX "carts_session_idx" ON "carts" USING btree ("session_token");--> statement-breakpoint
CREATE INDEX "carts_customer_idx" ON "carts" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "carts_abandonment_idx" ON "carts" USING btree ("tenant_id","status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_tenant_email_key" ON "customers" USING btree ("tenant_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_tenant_phone_key" ON "customers" USING btree ("tenant_id","phone");--> statement-breakpoint
CREATE INDEX "customers_tenant_created_idx" ON "customers" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "customers_risk_idx" ON "customers" USING btree ("tenant_id","risk_score");--> statement-breakpoint
CREATE INDEX "order_events_order_idx" ON "order_events" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE INDEX "order_items_order_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_items_variant_idx" ON "order_items" USING btree ("variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_tenant_number_key" ON "orders" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE INDEX "orders_tenant_created_idx" ON "orders" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "orders_customer_idx" ON "orders" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE INDEX "orders_status_idx" ON "orders" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "orders_payment_status_idx" ON "orders" USING btree ("tenant_id","payment_status");--> statement-breakpoint
CREATE INDEX "orders_fulfilment_idx" ON "orders" USING btree ("tenant_id","fulfilment_status");--> statement-breakpoint
CREATE INDEX "return_items_return_idx" ON "return_items" USING btree ("return_id");--> statement-breakpoint
CREATE UNIQUE INDEX "returns_tenant_number_key" ON "returns" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE INDEX "returns_order_idx" ON "returns" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "returns_status_idx" ON "returns" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "shipment_items_shipment_idx" ON "shipment_items" USING btree ("shipment_id");--> statement-breakpoint
CREATE INDEX "shipments_order_idx" ON "shipments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "shipments_tracking_idx" ON "shipments" USING btree ("tracking_number");--> statement-breakpoint
CREATE INDEX "shipments_status_idx" ON "shipments" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "gift_card_transactions_card_idx" ON "gift_card_transactions" USING btree ("gift_card_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "gift_cards_code_hash_key" ON "gift_cards" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "instalment_plans_order_idx" ON "instalment_plans" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_intents_idempotency_key" ON "payment_intents" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "payment_intents_order_idx" ON "payment_intents" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "payment_intents_provider_ref_idx" ON "payment_intents" USING btree ("provider","provider_reference");--> statement-breakpoint
CREATE INDEX "payment_intents_status_idx" ON "payment_intents" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_method_configs_key" ON "payment_method_configs" USING btree ("tenant_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_webhook_events_key" ON "payment_webhook_events" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "payment_webhook_events_unprocessed_idx" ON "payment_webhook_events" USING btree ("processed_at");--> statement-breakpoint
CREATE INDEX "store_credit_entries_customer_idx" ON "store_credit_entries" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE INDEX "transactions_order_idx" ON "transactions" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE INDEX "transactions_intent_idx" ON "transactions" USING btree ("payment_intent_id");--> statement-breakpoint
CREATE INDEX "transactions_tenant_created_idx" ON "transactions" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_provider_ref_key" ON "transactions" USING btree ("provider","provider_reference","kind");--> statement-breakpoint
CREATE INDEX "analytics_events_tenant_type_idx" ON "analytics_events" USING btree ("tenant_id","type","created_at");--> statement-breakpoint
CREATE INDEX "analytics_events_session_idx" ON "analytics_events" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "analytics_events_product_idx" ON "analytics_events" USING btree ("product_id","type");--> statement-breakpoint
CREATE INDEX "campaign_events_campaign_idx" ON "campaign_events" USING btree ("campaign_id","type");--> statement-breakpoint
CREATE INDEX "campaign_events_customer_idx" ON "campaign_events" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "campaigns_tenant_status_idx" ON "campaigns" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "campaigns_scheduled_idx" ON "campaigns" USING btree ("status","scheduled_at");--> statement-breakpoint
CREATE INDEX "content_assets_tenant_status_idx" ON "content_assets" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "discount_redemptions_order_key" ON "discount_redemptions" USING btree ("discount_id","order_id");--> statement-breakpoint
CREATE INDEX "discount_redemptions_customer_idx" ON "discount_redemptions" USING btree ("discount_id","customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "discounts_tenant_code_key" ON "discounts" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "discounts_active_idx" ON "discounts" USING btree ("tenant_id","is_active","starts_at","ends_at");--> statement-breakpoint
CREATE INDEX "loyalty_transactions_customer_idx" ON "loyalty_transactions" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "recently_viewed_customer_key" ON "recently_viewed" USING btree ("customer_id","product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recently_viewed_session_key" ON "recently_viewed" USING btree ("session_id","product_id");--> statement-breakpoint
CREATE INDEX "recently_viewed_lookup_idx" ON "recently_viewed" USING btree ("customer_id","last_viewed_at");--> statement-breakpoint
CREATE INDEX "search_queries_tenant_created_idx" ON "search_queries" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "search_queries_zero_result_idx" ON "search_queries" USING btree ("tenant_id","result_count");--> statement-breakpoint
CREATE INDEX "search_queries_normalised_idx" ON "search_queries" USING btree ("tenant_id","normalised_query");--> statement-breakpoint
CREATE UNIQUE INDEX "wishlists_customer_variant_key" ON "wishlists" USING btree ("customer_id","product_id","variant_id");--> statement-breakpoint
CREATE INDEX "wishlists_product_idx" ON "wishlists" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "ai_jobs_tenant_status_idx" ON "ai_jobs" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "ai_jobs_task_idx" ON "ai_jobs" USING btree ("tenant_id","task","created_at");--> statement-breakpoint
CREATE INDEX "ai_jobs_entity_idx" ON "ai_jobs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_usage_key" ON "ai_usage" USING btree ("tenant_id","day","task","model");--> statement-breakpoint
CREATE INDEX "ai_usage_tenant_day_idx" ON "ai_usage" USING btree ("tenant_id","day");--> statement-breakpoint
CREATE INDEX "assistant_conversations_session_idx" ON "assistant_conversations" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "assistant_conversations_tenant_idx" ON "assistant_conversations" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "competitor_prices_variant_idx" ON "competitor_prices" USING btree ("variant_id","observed_at");--> statement-breakpoint
CREATE INDEX "competitor_prices_tenant_idx" ON "competitor_prices" USING btree ("tenant_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "demand_forecasts_key" ON "demand_forecasts" USING btree ("variant_id","warehouse_id","horizon_days","computed_at");--> statement-breakpoint
CREATE INDEX "demand_forecasts_tenant_idx" ON "demand_forecasts" USING btree ("tenant_id","computed_at");--> statement-breakpoint
CREATE INDEX "demand_forecasts_reorder_idx" ON "demand_forecasts" USING btree ("tenant_id","reorder_recommendation");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_health_variant_key" ON "inventory_health" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "inventory_health_class_idx" ON "inventory_health" USING btree ("tenant_id","classification");--> statement-breakpoint
CREATE INDEX "price_recommendations_tenant_status_idx" ON "price_recommendations" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "risk_assessments_entity_idx" ON "risk_assessments" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "risk_assessments_tenant_created_idx" ON "risk_assessments" USING btree ("tenant_id","created_at");