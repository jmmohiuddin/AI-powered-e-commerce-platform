import { z } from 'zod';

/**
 * Boot-time environment validation.
 *
 * Rationale: the most expensive production incidents in commerce are the quiet
 * ones — a missing webhook secret means payments silently stop reconciling, an
 * unset CDN base URL means every product image 404s. We would rather the process
 * refuse to start than serve a broken store, so this module throws on load.
 *
 * Optional integrations stay optional. An absent NETWORK_API_KEY does not crash
 * the app; it disables that payment adapter and the checkout stops offering it
 * (see packages/payments/registry.ts).
 */

const urlish = z.string().url();
const nonEmpty = z.string().min(1);

const baseSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),

  /** Application role. NOSUPERUSER, NOBYPASSRLS — subject to every RLS policy. */
  DATABASE_URL: nonEmpty,
  /** Owner role, for migrations and cross-tenant jobs. Bypasses RLS. */
  DATABASE_ADMIN_URL: z.string().optional(),
  DATABASE_REPLICA_URL: z.string().optional(),
  REDIS_URL: nonEmpty,

  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be >= 32 chars'),
  AUTH_URL: urlish,
  STOREFRONT_URL: urlish,
  ADMIN_URL: urlish,

  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MODEL_FAST: z.string().default('claude-haiku-4-5-20251001'),
  AI_MODEL_BALANCED: z.string().default('claude-sonnet-5'),
  AI_MODEL_DEEP: z.string().default('claude-opus-5'),
  AI_DAILY_BUDGET_USD: z.coerce.number().positive().default(25),
  VOYAGE_API_KEY: z.string().optional(),

  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('auto'),
  S3_BUCKET: z.string().default('voltix-media'),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  CDN_BASE_URL: z.string().optional(),

  // --- Market ---------------------------------------------------------
  // Regional behaviour is configuration, not a compile-time constant. VAT
  // rates and registration thresholds are set by the tax authority and do
  // change; a rate baked into code is a rate that ships wrong.
  DEFAULT_COUNTRY: z.string().length(2).default('AE'),
  DEFAULT_CURRENCY: z.string().length(3).default('AED'),
  DEFAULT_LOCALE: z.string().default('en-AE'),
  DEFAULT_TIMEZONE: z.string().default('Asia/Dubai'),
  /** UAE VAT, in basis points. 500 = 5%. */
  VAT_RATE_BPS: z.coerce.number().int().nonnegative().default(500),
  /** UAE consumer prices must be displayed VAT-inclusive. */
  VAT_PRICES_INCLUSIVE: z.coerce.boolean().default(true),
  /** 15-digit Tax Registration Number. Required on every tax invoice. */
  MERCHANT_TRN: z.string().optional(),
  MERCHANT_LEGAL_NAME: z.string().optional(),

  // --- Payments -------------------------------------------------------
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

  NETWORK_API_KEY: z.string().optional(),
  NETWORK_OUTLET_REF: z.string().optional(),
  NETWORK_SANDBOX: z.coerce.boolean().default(true),

  TABBY_SECRET_KEY: z.string().optional(),
  TABBY_PUBLIC_KEY: z.string().optional(),
  TABBY_MERCHANT_CODE: z.string().optional(),
  TABBY_WEBHOOK_SECRET: z.string().optional(),

  PAYTABS_PROFILE_ID: z.string().optional(),
  PAYTABS_SERVER_KEY: z.string().optional(),

  /** Cash on delivery policy. Still a real share of UAE orders. */
  COD_ENABLED: z.coerce.boolean().default(true),
  /** Fils. Above this, COD requires an advance payment. */
  COD_MAX_ORDER_AMOUNT: z.coerce.number().int().positive().default(500_000),
  COD_ADVANCE_BPS: z.coerce.number().int().nonnegative().default(0),
  /** Flat COD handling fee in fils. Common practice in the UAE. */
  COD_HANDLING_FEE: z.coerce.number().int().nonnegative().default(0),

  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default('Voltix <orders@example.com>'),
  SMTP_URL: z.string().optional(),

  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  SMS_API_KEY: z.string().optional(),
  SMS_SENDER_ID: z.string().optional(),

  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
  SENTRY_DSN: z.string().optional(),
});

/**
 * Production tightens the screws: secrets that are merely "nice to have" in
 * development become mandatory once real money and real customer data are on
 * the line.
 */
const schema = baseSchema.superRefine((env, ctx) => {
  if (env.NODE_ENV !== 'production') return;

  const requiredInProd: Array<keyof typeof env> = [
    'CDN_BASE_URL',
    'ANTHROPIC_API_KEY',
    // A UAE store issuing invoices without a TRN is issuing non-compliant tax
    // invoices, which a business customer will reject and the FTA will not
    // accept. Better to refuse to boot than to discover it at the first audit.
    'MERCHANT_TRN',
    'MERCHANT_LEGAL_NAME',
  ];
  for (const key of requiredInProd) {
    if (!env[key]) {
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: `${String(key)} is required when NODE_ENV=production`,
      });
    }
  }

  if (env.AUTH_SECRET.includes('replace-me')) {
    ctx.addIssue({
      code: 'custom',
      path: ['AUTH_SECRET'],
      message: 'Refusing to boot production with the placeholder auth secret',
    });
  }

  if (env.STRIPE_SECRET_KEY && !env.STRIPE_WEBHOOK_SECRET) {
    ctx.addIssue({
      code: 'custom',
      path: ['STRIPE_WEBHOOK_SECRET'],
      message: 'Stripe is configured but the webhook secret is missing — payment state would drift',
    });
  }

  // The check that keeps row-level security from being decorative. If the app
  // connects as the owner, every policy is bypassed and tenant isolation is off
  // — silently, with the policies still listed in pg_policies.
  if (env.DATABASE_ADMIN_URL && env.DATABASE_ADMIN_URL === env.DATABASE_URL) {
    ctx.addIssue({
      code: 'custom',
      path: ['DATABASE_URL'],
      message:
        'DATABASE_URL must use the restricted application role, not the owner — ' +
        'connecting as the owner bypasses row-level security and disables tenant isolation',
    });
  }

  if (env.MERCHANT_TRN && !/^\d{15}$/.test(env.MERCHANT_TRN.replace(/[\s-]/g, ''))) {
    ctx.addIssue({
      code: 'custom',
      path: ['MERCHANT_TRN'],
      message: 'A UAE Tax Registration Number is 15 digits',
    });
  }

  if (env.NETWORK_API_KEY && !env.NETWORK_OUTLET_REF) {
    ctx.addIssue({
      code: 'custom',
      path: ['NETWORK_OUTLET_REF'],
      message: 'Network International needs an outlet reference to route transactions',
    });
  }
});

export type Env = z.infer<typeof baseSchema>;

function loadEnv(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  • ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}\n\nSee .env.example.`);
  }
  return parsed.data;
}

let cached: Env | undefined;

/** Lazily validated singleton. Safe to call from anywhere, including edge runtimes. */
export function env(): Env {
  cached ??= loadEnv();
  return cached;
}

/** Test helper — lets suites inject a fixture environment without touching process.env. */
export function __setEnvForTests(value: Env | undefined): void {
  cached = value;
}

/**
 * Feature availability derived from configuration rather than hardcoded flags.
 * The UI asks these questions instead of guessing.
 */
export function capabilities(e: Env = env()) {
  return {
    ai: Boolean(e.ANTHROPIC_API_KEY),
    semanticSearch: Boolean(e.VOYAGE_API_KEY),
    stripe: Boolean(e.STRIPE_SECRET_KEY),
    network: Boolean(e.NETWORK_API_KEY && e.NETWORK_OUTLET_REF),
    tabby: Boolean(e.TABBY_SECRET_KEY && e.TABBY_MERCHANT_CODE),
    paytabs: Boolean(e.PAYTABS_PROFILE_ID && e.PAYTABS_SERVER_KEY),
    cod: e.COD_ENABLED,
    vatRegistered: Boolean(e.MERCHANT_TRN),
    email: Boolean(e.RESEND_API_KEY || e.SMTP_URL),
    whatsapp: Boolean(e.WHATSAPP_PHONE_NUMBER_ID && e.WHATSAPP_ACCESS_TOKEN),
    sms: Boolean(e.SMS_API_KEY),
    tracing: Boolean(e.OTEL_EXPORTER_OTLP_ENDPOINT),
  } as const;
}

export type Capabilities = ReturnType<typeof capabilities>;
