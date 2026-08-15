-- ===========================================================================
-- Row-level security: tenant isolation enforced by the database.
--
-- WHY THIS EXISTS
-- Application-level `WHERE tenant_id = ?` is correct until the one query where
-- somebody forgets. In a multi-tenant commerce product that single omission is
-- a cross-merchant data breach — one store reading another's customers, orders
-- and margins. RLS makes the database refuse those rows regardless of what the
-- application asked for, so a forgotten filter becomes an empty result set
-- instead of an incident report.
--
-- HOW IT WORKS
-- `withTenant()` in src/client.ts sets `app.tenant_id` as a transaction-local
-- setting. Every policy below compares `tenant_id` against it. Transaction-local
-- scope is essential with connection pooling: a session-level setting would
-- survive the connection being handed to the next request, for a different
-- tenant.
--
-- The migration/admin role gets an explicit `admin_bypass` policy (created in
-- the loop below) so that background jobs which legitimately operate across
-- tenants — nightly forecasting, platform analytics — can do so explicitly
-- rather than by accident. A policy rather than the BYPASSRLS attribute,
-- because granting BYPASSRLS requires a superuser and managed Postgres
-- (Neon, RDS, Cloud SQL) never hands one out.
--
-- Idempotent: safe to re-run on every deploy.
-- ===========================================================================


-- ===========================================================================
-- THE APPLICATION ROLE
--
-- This block is the reason the RLS policies below are worth anything.
--
-- Postgres superusers bypass row-level security entirely, and the default role
-- created by the Postgres container image is a superuser. An application
-- connecting as that role gets every policy silently ignored — the policies
-- exist, `pg_policies` lists them, and they protect nothing. That failure is
-- invisible unless you specifically test for it, which is exactly what makes it
-- dangerous.
--
-- So: two roles, two connection strings.
--
--   voltix       owner. Runs migrations and the seed. Bypasses RLS by design.
--                Never used by the running application.
--   voltix_app   NOSUPERUSER, NOBYPASSRLS. What the storefront, admin and job
--                runner connect as. Subject to every policy.
--
-- `DATABASE_URL` points at voltix_app. `DATABASE_ADMIN_URL` points at voltix.
-- If they are ever the same value in production, tenant isolation is off.
-- ===========================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'voltix_app') THEN
    -- Password is overridden per environment; this default exists so a local
    -- `npm run db:migrate` produces a working role with no extra step.
    CREATE ROLE voltix_app LOGIN PASSWORD 'voltix_app_dev_password'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO voltix_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO voltix_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO voltix_app;

-- Tables created by future migrations inherit the same grants, so a new table
-- is not silently unreachable by the application until someone notices.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO voltix_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO voltix_app;

DO $$
DECLARE
  tbl text;
  -- Every table carrying a tenant_id column.
  tenant_tables text[] := ARRAY[
    'stores', 'roles', 'memberships', 'api_keys', 'audit_logs',
    'brands', 'categories', 'attributes', 'products', 'variants',
    'product_attribute_values', 'media', 'product_embeddings', 'reviews',
    'review_summaries', 'product_links',
    'warehouses', 'stock_levels', 'stock_reservations', 'stock_movements',
    'serial_units', 'suppliers', 'supplier_products', 'purchase_orders',
    'purchase_order_items',
    'customers', 'addresses', 'carts', 'cart_items', 'orders', 'order_items',
    'order_events', 'invoices', 'shipments', 'shipment_items', 'returns', 'return_items',
    'payment_method_configs', 'payment_intents', 'transactions',
    'payment_webhook_events', 'store_credit_entries', 'gift_cards',
    'gift_card_transactions', 'instalment_plans',
    'discounts', 'discount_redemptions', 'loyalty_transactions',
    'campaigns', 'campaign_events', 'content_assets',
    'analytics_events', 'search_queries', 'recently_viewed', 'wishlists',
    'ai_jobs', 'ai_usage', 'demand_forecasts', 'inventory_health',
    'risk_assessments', 'competitor_prices', 'price_recommendations',
    'assistant_conversations',
    'counters', 'idempotency_keys', 'notifications'
  ];
BEGIN
  FOREACH tbl IN ARRAY tenant_tables LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = tbl
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
      -- FORCE applies the policy to the table owner too; without it, the owner
      -- role silently bypasses isolation and the protection is theatre.
      EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', tbl);

      EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', tbl);
      -- `nullif(..., '')` is load-bearing, not defensive noise.
      --
      -- On a pooled connection that has previously run inside withTenant(),
      -- `current_setting('app.tenant_id', true)` returns an EMPTY STRING rather
      -- than NULL once the transaction-local setting is unwound. Casting '' to
      -- uuid raises `invalid input syntax for type uuid`, so a query that
      -- forgot its tenant context would fail with a cryptic 500 instead of
      -- returning zero rows.
      --
      -- Both are safe — neither leaks — but only one is debuggable. Coercing
      -- the empty string to NULL makes the comparison simply false, which is
      -- the documented behaviour: a missing tenant context sees nothing.
      EXECUTE format($f$
        CREATE POLICY tenant_isolation ON public.%I
        USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
        WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
      $f$, tbl);

      -- Explicit full access for the admin/migration role (the role running
      -- this file — locally `voltix`, on Neon `neondb_owner`).
      --
      -- Locally the admin is a superuser, so this policy is redundant. On
      -- managed Postgres it is load-bearing: BYPASSRLS can only be granted by
      -- a superuser, which Neon/RDS/Cloud SQL never give you, and FORCE ROW
      -- LEVEL SECURITY above deliberately subjects even the table owner to
      -- policies. Without this, the seed cannot insert a single row, the job
      -- runner sees an empty queue, and the notification dispatcher goes
      -- silent — all with no error, just zero rows. Policies are permissive
      -- (OR-combined), so this grants the admin everything while leaving
      -- voltix_app exactly as constrained as before.
      EXECUTE format('DROP POLICY IF EXISTS admin_bypass ON public.%I', tbl);
      EXECUTE format(
        'CREATE POLICY admin_bypass ON public.%I TO %I USING (true) WITH CHECK (true)',
        tbl, current_user);
    END IF;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- Append-only enforcement for the audit trail.
--
-- An audit log that the application can rewrite is not evidence. Revoking
-- UPDATE and DELETE at the grant level means even a fully compromised
-- application credential cannot erase its own tracks.
-- ---------------------------------------------------------------------------
REVOKE UPDATE, DELETE ON public.audit_logs           FROM voltix_app;
REVOKE UPDATE, DELETE ON public.stock_movements      FROM voltix_app;
REVOKE UPDATE, DELETE ON public.transactions         FROM voltix_app;
REVOKE UPDATE, DELETE ON public.loyalty_transactions FROM voltix_app;
REVOKE UPDATE, DELETE ON public.store_credit_entries FROM voltix_app;

-- An issued tax invoice can be voided but never deleted. A missing invoice
-- number is a gap in a sequence the Federal Tax Authority expects to be
-- continuous, and "the row was removed" is not an explanation an auditor
-- accepts. UPDATE is deliberately left granted: voiding writes `voided_at`,
-- which is how a document is withdrawn without breaking the sequence.
REVOKE DELETE ON public.invoices FROM voltix_app;

-- ---------------------------------------------------------------------------
-- Credential tables are invisible to the application role entirely.
--
-- `sessions` holds bearer-token hashes and `login_attempts` holds a list of
-- every staff email address. Neither is reachable through any tenant-scoped
-- query, so neither needs a tenant policy — it needs *no grant at all*.
--
-- This is deliberately stronger than RLS. Session resolution is the step that
-- decides which tenant the caller is, so it cannot run inside a tenant-scoped
-- transaction without circularity; it runs on the owner connection instead.
-- Revoking the app role's access means a SQL-injection foothold in any
-- storefront query cannot read a session token or enumerate the staff
-- directory, even with the tenant context set correctly.
REVOKE ALL ON public.sessions       FROM voltix_app;
REVOKE ALL ON public.login_attempts FROM voltix_app;

-- `jobs` carries a nullable tenant_id (platform-wide jobs like the nightly
-- forecast have none), so a blanket tenant policy would make those rows
-- invisible to the worker that must process them. Isolation is enforced in the
-- claim query instead, and the table holds no customer data.
ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS jobs_tenant_or_platform ON public.jobs;
CREATE POLICY jobs_tenant_or_platform ON public.jobs
  USING (tenant_id IS NULL OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id IS NULL OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- The worker claims jobs across every tenant on the admin connection — same
-- managed-Postgres reasoning as the per-table admin_bypass above.
DO $$
BEGIN
  EXECUTE 'DROP POLICY IF EXISTS admin_bypass ON public.jobs';
  EXECUTE format(
    'CREATE POLICY admin_bypass ON public.jobs TO %I USING (true) WITH CHECK (true)',
    current_user);
END
$$;

-- ---------------------------------------------------------------------------
-- Search vector maintenance.
--
-- Kept as a trigger rather than a generated column because the vector blends
-- columns from `products` *and* the related brand name, which a generated
-- column cannot reference. The trigger is the narrowest correct tool here.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION voltix_products_search_vector() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('voltix_search', coalesce(NEW.title, '')), 'A') ||
    setweight(to_tsvector('voltix_search', coalesce(NEW.subtitle, '')), 'B') ||
    setweight(to_tsvector('voltix_search', coalesce(NEW.tags::text, '')), 'C') ||
    setweight(to_tsvector('voltix_search', coalesce(NEW.description, '')), 'D');
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'products') THEN
    -- Promote the column to a real tsvector if the initial migration created it as text.
    BEGIN
      ALTER TABLE public.products
        ALTER COLUMN search_vector TYPE tsvector USING search_vector::tsvector;
    EXCEPTION WHEN others THEN
      NULL; -- already tsvector
    END;

    DROP TRIGGER IF EXISTS products_search_vector_trg ON public.products;
    CREATE TRIGGER products_search_vector_trg
      BEFORE INSERT OR UPDATE OF title, subtitle, description, tags
      ON public.products
      FOR EACH ROW EXECUTE FUNCTION voltix_products_search_vector();

    CREATE INDEX IF NOT EXISTS products_search_vector_idx
      ON public.products USING gin (search_vector);
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Data integrity constraints that Drizzle cannot express.
-- These are the invariants that protect money.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  -- Stock can be committed but never negative-reserved.
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='stock_levels') THEN
    ALTER TABLE public.stock_levels DROP CONSTRAINT IF EXISTS stock_levels_reserved_nonneg;
    ALTER TABLE public.stock_levels ADD CONSTRAINT stock_levels_reserved_nonneg
      CHECK (reserved >= 0);
  END IF;

  -- A store must never record more money collected than the order is worth.
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='orders') THEN
    ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_totals_sane;
    ALTER TABLE public.orders ADD CONSTRAINT orders_totals_sane
      CHECK (total >= 0 AND paid_total >= 0 AND refunded_total >= 0 AND refunded_total <= paid_total);
  END IF;

  -- Ratings are 1–5. A 0 or 6 star review is a bug, not user input.
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='reviews') THEN
    ALTER TABLE public.reviews DROP CONSTRAINT IF EXISTS reviews_rating_range;
    ALTER TABLE public.reviews ADD CONSTRAINT reviews_rating_range
      CHECK (rating BETWEEN 1 AND 5);
  END IF;

  -- Quantities on a line item are positive; refunds cannot exceed what was sold.
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='order_items') THEN
    ALTER TABLE public.order_items DROP CONSTRAINT IF EXISTS order_items_quantities_sane;
    ALTER TABLE public.order_items ADD CONSTRAINT order_items_quantities_sane
      CHECK (
        quantity > 0
        AND quantity_fulfilled BETWEEN 0 AND quantity
        AND quantity_returned  BETWEEN 0 AND quantity
        AND quantity_refunded  BETWEEN 0 AND quantity
      );
  END IF;

  -- A gift card can never go negative, and never exceed what was loaded.
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='gift_cards') THEN
    ALTER TABLE public.gift_cards DROP CONSTRAINT IF EXISTS gift_cards_balance_sane;
    ALTER TABLE public.gift_cards ADD CONSTRAINT gift_cards_balance_sane
      CHECK (balance >= 0 AND balance <= initial_amount);
  END IF;
END
$$;
