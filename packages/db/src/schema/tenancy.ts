import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { softDeleteTimestamps, tenantId, timestamps } from './_shared';

/* ────────────────────────────── Tenancy ─────────────────────────────── */

export const tenantPlan = pgEnum('tenant_plan', ['trial', 'starter', 'growth', 'enterprise']);
export const tenantStatus = pgEnum('tenant_status', ['active', 'suspended', 'cancelled']);

/**
 * A tenant is one merchant business. The single-store operator this platform is
 * first built for is simply a tenant with one store — the same code path serves
 * merchant #1 and merchant #5000, which is what makes the SaaS ambition real
 * rather than a rewrite waiting to happen.
 */
export const tenants = pgTable(
  'tenants',
  {
    id: uuid('id').primaryKey(),
    slug: varchar('slug', { length: 63 }).notNull(),
    name: text('name').notNull(),
    plan: tenantPlan('plan').notNull().default('trial'),
    status: tenantStatus('status').notNull().default('active'),

    /** Home country drives tax rules, payment adapters, and address format. */
    countryCode: varchar('country_code', { length: 2 }).notNull().default('AE'),
    defaultCurrency: varchar('default_currency', { length: 3 }).notNull().default('AED'),
    defaultLocale: varchar('default_locale', { length: 10 }).notNull().default('en-AE'),
    /** Locales this tenant publishes. UAE stores typically en-AE and ar-AE. */
    supportedLocales: jsonb('supported_locales').notNull().default(['en-AE', 'ar-AE']),
    timezone: varchar('timezone', { length: 64 }).notNull().default('Asia/Dubai'),

    /**
     * Tax identity. A UAE tax invoice is not valid without the supplier's TRN,
     * and a business customer will reject one that lacks it because they cannot
     * reclaim the input VAT. It lives on the tenant because it appears on every
     * invoice that tenant issues.
     */
    legalName: text('legal_name'),
    /** 15-digit Tax Registration Number issued by the Federal Tax Authority. */
    taxRegistrationNumber: varchar('tax_registration_number', { length: 20 }),
    /** Trade licence number, shown in the footer as a trust signal. */
    tradeLicenceNumber: varchar('trade_licence_number', { length: 40 }),
    /** VAT in basis points. 500 = 5%. Configuration, because rates change. */
    vatRateBps: integer('vat_rate_bps').notNull().default(500),
    /** UAE requires consumer-facing prices to be displayed VAT-inclusive. */
    pricesIncludeVat: boolean('prices_include_vat').notNull().default(true),

    /** Plan limits, feature toggles, AI budget overrides. Shape in ../types.ts. */
    settings: jsonb('settings').notNull().default({}),

    ...softDeleteTimestamps(),
  },
  (t) => [uniqueIndex('tenants_slug_key').on(t.slug), index('tenants_status_idx').on(t.status)],
);

/**
 * A storefront. Separated from `tenants` because a merchant legitimately runs
 * several: a retail brand site, a wholesale portal, and a marketplace channel
 * can share one catalogue and inventory pool but need different domains,
 * pricing, and themes.
 */
export const stores = pgTable(
  'stores',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    domain: varchar('domain', { length: 255 }),
    currency: varchar('currency', { length: 3 }).notNull().default('AED'),
    locale: varchar('locale', { length: 10 }).notNull().default('en-AE'),
    isDefault: boolean('is_default').notNull().default(false),
    /** Theme tokens, hero config, contact numbers, WhatsApp ordering number. */
    theme: jsonb('theme').notNull().default({}),
    ...softDeleteTimestamps(),
  },
  (t) => [
    index('stores_tenant_idx').on(t.tenantId),
    uniqueIndex('stores_domain_key').on(t.domain),
  ],
);

/* ─────────────────────────── Identity & RBAC ────────────────────────── */

/**
 * Staff identity. Customers live in a separate table (`customers`) on purpose:
 * conflating them means every customer row carries admin-permission columns and
 * one authorisation bug turns a shopper into an operator. Different lifecycles,
 * different threat models, different tables.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    email: varchar('email', { length: 320 }).notNull(),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true, mode: 'date' }),
    name: text('name').notNull(),
    avatarUrl: text('avatar_url'),
    /** Argon2id. Null when the account is SSO-only. */
    passwordHash: text('password_hash'),
    /** Encrypted TOTP secret; MFA is mandatory for any role above `staff`. */
    totpSecret: text('totp_secret'),
    mfaEnabledAt: timestamp('mfa_enabled_at', { withTimezone: true, mode: 'date' }),
    /**
     * SHA-256 of each unused recovery code. Consumed codes are removed from the
     * array rather than flagged — a single-use credential that is still
     * readable in the row it was spent from is single-use in name only.
     */
    mfaRecoveryCodes: jsonb('mfa_recovery_codes').notNull().default([]),
    /** Bumped on password change / forced logout; invalidates live sessions. */
    sessionEpoch: varchar('session_epoch', { length: 26 }).notNull().default('0'),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true, mode: 'date' }),
    ...softDeleteTimestamps(),
  },
  (t) => [uniqueIndex('users_email_key').on(t.email)],
);

/**
 * Roles are per-tenant rows, not a hardcoded enum, so an enterprise merchant can
 * define "Warehouse Supervisor — may adjust stock, may not see margins" without
 * a code deploy. `isSystem` marks the built-in roles seeded for every tenant.
 */
export const roles = pgTable(
  'roles',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    key: varchar('key', { length: 64 }).notNull(),
    name: text('name').notNull(),
    description: text('description'),
    /** Array of permission strings, e.g. ["order:read","order:refund"]. */
    permissions: jsonb('permissions').notNull().default([]),
    isSystem: boolean('is_system').notNull().default(false),
    ...timestamps(),
  },
  (t) => [uniqueIndex('roles_tenant_key_key').on(t.tenantId, t.key)],
);

export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'restrict' }),
    /** Null = access to every store in the tenant. */
    storeId: uuid('store_id').references(() => stores.id, { onDelete: 'cascade' }),
    invitedByUserId: uuid('invited_by_user_id'),
    acceptedAt: timestamp('accepted_at', { withTimezone: true, mode: 'date' }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('memberships_tenant_user_key').on(t.tenantId, t.userId),
    index('memberships_user_idx').on(t.userId),
  ],
);

/** Machine credentials for integrations (POS, ERP, courier webhooks). */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    /** SHA-256 of the token. The plaintext is shown once and never stored. */
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    /** First 8 chars, for "which key is this?" without revealing the secret. */
    tokenPrefix: varchar('token_prefix', { length: 12 }).notNull(),
    scopes: jsonb('scopes').notNull().default([]),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('api_keys_token_hash_key').on(t.tokenHash),
    index('api_keys_tenant_idx').on(t.tenantId),
  ],
);

/**
 * Staff sessions.
 *
 * Server-side sessions rather than stateless JWTs, and the reason is revocation.
 * A JWT is valid until it expires: firing someone, or discovering a stolen
 * laptop, cannot invalidate one without building a denylist — at which point
 * you have a session table with extra steps and worse ergonomics. For an admin
 * that can refund money and read customer PII, "log them out now" has to
 * actually mean now.
 *
 * The cookie carries a random token; only its SHA-256 lands here. A database
 * leak therefore yields no usable sessions, the same reasoning as API keys.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Which tenant this session is acting for. Staff may belong to several. */
    tenantId: uuid('tenant_id').notNull(),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),

    /**
     * Copied from the user at sign-in. A password change bumps the user's
     * epoch, which orphans every session issued before it — one write logs out
     * every device without touching this table.
     */
    sessionEpoch: varchar('session_epoch', { length: 26 }).notNull(),

    /** Set once a second factor is satisfied; roles above staff require it. */
    mfaVerifiedAt: timestamp('mfa_verified_at', { withTimezone: true, mode: 'date' }),

    ipAddress: varchar('ip_address', { length: 45 }),
    userAgent: text('user_agent'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('sessions_token_hash_key').on(t.tokenHash),
    index('sessions_user_idx').on(t.userId),
    index('sessions_sweep_idx').on(t.expiresAt),
  ],
);

/**
 * Failed sign-in attempts, for lockout.
 *
 * Keyed by email *and* by IP, because the two attacks are different: password
 * spraying hits many accounts from one address, credential stuffing hits one
 * account from many. Rate-limiting only one of them leaves the other open.
 */
export const loginAttempts = pgTable(
  'login_attempts',
  {
    id: uuid('id').primaryKey(),
    email: varchar('email', { length: 320 }),
    ipAddress: varchar('ip_address', { length: 45 }),
    succeeded: boolean('succeeded').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('login_attempts_email_idx').on(t.email, t.createdAt),
    index('login_attempts_ip_idx').on(t.ipAddress, t.createdAt),
  ],
);

/* ──────────────────────────── Audit trail ───────────────────────────── */

/**
 * Append-only audit log. No UPDATE or DELETE grant exists on this table for the
 * application role (migration 0002); corrections are new rows. Anything that
 * moves money, changes a price, touches stock, or alters permissions writes here.
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenantId(),
    /** Null for system/automation actors; `actorType` disambiguates. */
    actorUserId: uuid('actor_user_id'),
    actorType: varchar('actor_type', { length: 24 }).notNull().default('user'),
    actorLabel: text('actor_label'),

    action: varchar('action', { length: 64 }).notNull(),
    entityType: varchar('entity_type', { length: 64 }).notNull(),
    entityId: uuid('entity_id'),

    /** Field-level before/after. Redacted for PII per ../redact.ts. */
    changes: jsonb('changes'),
    metadata: jsonb('metadata'),

    ipAddress: varchar('ip_address', { length: 45 }),
    userAgent: text('user_agent'),
    requestId: varchar('request_id', { length: 64 }),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_logs_tenant_created_idx').on(t.tenantId, t.createdAt),
    index('audit_logs_entity_idx').on(t.tenantId, t.entityType, t.entityId),
    index('audit_logs_actor_idx').on(t.tenantId, t.actorUserId),
  ],
);

/* ───────────────────────────── Relations ────────────────────────────── */

export const tenantsRelations = relations(tenants, ({ many }) => ({
  stores: many(stores),
  roles: many(roles),
  memberships: many(memberships),
}));

export const storesRelations = relations(stores, ({ one }) => ({
  tenant: one(tenants, { fields: [stores.tenantId], references: [tenants.id] }),
}));

export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(memberships),
}));

export const membershipsRelations = relations(memberships, ({ one }) => ({
  user: one(users, { fields: [memberships.userId], references: [users.id] }),
  role: one(roles, { fields: [memberships.roleId], references: [roles.id] }),
  store: one(stores, { fields: [memberships.storeId], references: [stores.id] }),
}));
