import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';
import { DomainError } from '@voltix/core';
import { costMicroUsd, resolveModel, type ModelTier, type TokenUsage } from './models';

/**
 * THE AI GATEWAY
 *
 * Every LLM call in the platform goes through this class. Nothing imports the
 * Anthropic SDK directly. That single choke point is what makes the following
 * possible without touching feature code:
 *
 *   • **Budget enforcement.** A tenant that has spent its daily allowance gets a
 *     typed refusal, not a surprise invoice.
 *   • **Cost attribution.** Every call is metered per tenant, per task, per
 *     model — the data the SaaS needs to price plans honestly.
 *   • **Prompt caching.** Task system prompts are long and static; user input is
 *     short and variable. Caching the former cuts input cost by ~90% on the
 *     repeated portion. Getting the ordering right is worth more than any
 *     amount of prompt golf.
 *   • **Structured output.** Feature code receives a validated object, never a
 *     string it has to hope parses. A description generator that returns
 *     malformed JSON one time in fifty is a data-corruption bug, not a
 *     "sometimes retry" annoyance.
 *   • **Graceful degradation.** No API key, a refusal, or an outage returns a
 *     typed error the UI can render — the storefront must never 500 because a
 *     recommendation model was slow.
 */

export interface AiUsageRecord {
  tenantId: string;
  task: string;
  model: string;
  usage: TokenUsage;
  costMicroUsd: number;
  latencyMs: number;
}

export interface BudgetStore {
  /** Micro-USD already spent by this tenant today, in the tenant's timezone. */
  spentTodayMicroUsd(tenantId: string): Promise<number>;
  record(entry: AiUsageRecord): Promise<void>;
}

/** In-memory default so the package is usable in tests and local dev. */
export class InMemoryBudgetStore implements BudgetStore {
  private readonly spend = new Map<string, number>();
  readonly records: AiUsageRecord[] = [];

  spentTodayMicroUsd(tenantId: string): Promise<number> {
    return Promise.resolve(this.spend.get(tenantId) ?? 0);
  }

  record(entry: AiUsageRecord): Promise<void> {
    this.spend.set(entry.tenantId, (this.spend.get(entry.tenantId) ?? 0) + entry.costMicroUsd);
    this.records.push(entry);
    return Promise.resolve();
  }
}

export interface AiClientOptions {
  readonly apiKey?: string;
  readonly budgetStore?: BudgetStore;
  /** Per-tenant daily ceiling in USD. */
  readonly dailyBudgetUsd?: number;
  /** Merchant overrides mapping a tier to a specific model id. */
  readonly modelOverrides?: Partial<Record<ModelTier, string>>;
  readonly anthropic?: Anthropic;
}

export interface RunOptions<TSchema extends z.ZodTypeAny> {
  readonly tenantId: string;
  /** Registry key, e.g. 'product.describe'. Used for metering and audit. */
  readonly task: string;
  readonly tier: ModelTier;
  /** Long, stable, cached. Everything variable belongs in `input`. */
  readonly systemPrompt: string;
  readonly input: string;
  readonly schema: TSchema;
  readonly maxTokens?: number;
  /** 'low' for mechanical work, 'high' for judgement. Controls spend directly. */
  readonly effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  readonly promptVersion?: string;
}

export interface RunResult<T> {
  readonly output: T;
  readonly model: string;
  readonly usage: TokenUsage;
  readonly costMicroUsd: number;
  readonly latencyMs: number;
}

export class AiClient {
  private readonly anthropic: Anthropic | undefined;
  private readonly budgetStore: BudgetStore;
  private readonly dailyBudgetMicroUsd: number;
  private readonly modelOverrides: Partial<Record<ModelTier, string>>;

  constructor(options: AiClientOptions = {}) {
    const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    // No key is a valid state, not a crash: the platform runs fine with AI
    // features disabled, and `isAvailable` lets the UI hide them cleanly.
    this.anthropic = options.anthropic ?? (apiKey ? new Anthropic({ apiKey }) : undefined);
    this.budgetStore = options.budgetStore ?? new InMemoryBudgetStore();
    this.dailyBudgetMicroUsd = Math.round((options.dailyBudgetUsd ?? 25) * 1_000_000);
    this.modelOverrides = options.modelOverrides ?? {};
  }

  get isAvailable(): boolean {
    return this.anthropic !== undefined;
  }

  /**
   * Runs a task and returns a schema-validated object.
   *
   * PROMPT LAYOUT is load-bearing, not stylistic. Caching is a *prefix* match:
   * the system prompt is marked cacheable and the variable input goes in the
   * user turn, after the breakpoint. Interpolating anything per-request into
   * the system prompt — a timestamp, a product id, a tenant name — invalidates
   * the cache on every single call and silently triples the input bill.
   */
  async run<TSchema extends z.ZodTypeAny>(
    options: RunOptions<TSchema>,
  ): Promise<RunResult<z.infer<TSchema>>> {
    const client = this.anthropic;
    if (!client) {
      throw new DomainError('AI_UNAVAILABLE', 'ANTHROPIC_API_KEY is not configured');
    }

    await this.assertWithinBudget(options.tenantId, options.task);

    const model = resolveModel(options.tier, this.modelOverrides);
    const startedAt = Date.now();

    let response: Awaited<ReturnType<typeof client.messages.parse>>;
    try {
      response = await client.messages.parse({
        model,
        max_tokens: options.maxTokens ?? 8_000,
        system: [
          {
            type: 'text',
            text: options.systemPrompt,
            // The only breakpoint. Everything before it is identical across
            // every call for this task, so every call after the first reads it
            // at ~10% of input price.
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [{ role: 'user', content: options.input }],
        output_config: {
          format: zodOutputFormat(options.schema),
          ...(options.effort ? { effort: options.effort } : {}),
        },
      });
    } catch (error) {
      throw translateSdkError(error);
    }

    const latencyMs = Date.now() - startedAt;

    // Safety classifiers can decline a request and still return HTTP 200.
    // Reading content[0] without this check throws on an empty array.
    if (response.stop_reason === 'refusal') {
      throw new DomainError('AI_UNAVAILABLE', `Model declined the request for task ${options.task}`, {
        publicMessage: 'The AI assistant could not process that request.',
        details: { task: options.task },
      });
    }
    if (response.stop_reason === 'max_tokens') {
      throw new DomainError('AI_UNAVAILABLE', `Output truncated for task ${options.task}`, {
        retryable: true,
      });
    }

    const parsed = response.parsed_output as z.infer<TSchema> | null;
    if (parsed == null) {
      throw new DomainError('AI_UNAVAILABLE', `Task ${options.task} returned unparseable output`, {
        retryable: true,
      });
    }

    const usage: TokenUsage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheCreationInputTokens: response.usage.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: response.usage.cache_read_input_tokens ?? 0,
    };
    const cost = costMicroUsd(model, usage);

    await this.budgetStore.record({
      tenantId: options.tenantId,
      task: options.task,
      model,
      usage,
      costMicroUsd: cost,
      latencyMs,
    });

    return { output: parsed, model, usage, costMicroUsd: cost, latencyMs };
  }

  private async assertWithinBudget(tenantId: string, task: string): Promise<void> {
    const spent = await this.budgetStore.spentTodayMicroUsd(tenantId);
    if (spent >= this.dailyBudgetMicroUsd) {
      throw new DomainError(
        'AI_BUDGET_EXCEEDED',
        `Tenant ${tenantId} exceeded the daily AI budget (task ${task})`,
        {
          publicMessage:
            'Today’s AI usage limit has been reached. It resets at midnight, or you can raise it in Settings.',
          details: { spentMicroUsd: spent, limitMicroUsd: this.dailyBudgetMicroUsd },
        },
      );
    }
  }
}

/**
 * Maps SDK errors onto the platform's typed error space.
 *
 * The distinction that matters downstream is retryable vs not: a 429 or 529
 * should go back on the queue with backoff; a 400 means the prompt is wrong and
 * retrying it a hundred times just burns the budget faster.
 */
function translateSdkError(error: unknown): DomainError {
  if (error instanceof Anthropic.RateLimitError) {
    return new DomainError('RATE_LIMITED', 'Anthropic rate limit reached', {
      retryable: true,
      cause: error,
    });
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return new DomainError('AI_UNAVAILABLE', 'Anthropic API key is invalid', { cause: error });
  }
  if (error instanceof Anthropic.BadRequestError) {
    return new DomainError('VALIDATION_FAILED', `Malformed AI request: ${error.message}`, {
      cause: error,
    });
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new DomainError('AI_UNAVAILABLE', 'Could not reach the Anthropic API', {
      retryable: true,
      cause: error,
    });
  }
  if (error instanceof Anthropic.APIError) {
    return new DomainError('AI_UNAVAILABLE', `Anthropic API error: ${error.message}`, {
      retryable: (error.status ?? 500) >= 500,
      cause: error,
    });
  }
  return new DomainError('INTERNAL', 'Unexpected AI failure', { cause: error });
}
