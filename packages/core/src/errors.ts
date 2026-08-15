/**
 * Typed domain errors.
 *
 * Two audiences, always separated: `message` is for the engineer reading a log,
 * `publicMessage` is for the customer reading a checkout page. Leaking the
 * former into the latter is how error text ends up saying "constraint
 * stock_levels_reserved_nonneg violated" to someone trying to buy a phone case.
 */

export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'UNAUTHORISED'
  | 'FORBIDDEN'
  | 'CONFLICT'
  | 'OUT_OF_STOCK'
  | 'PRICE_CHANGED'
  | 'PAYMENT_FAILED'
  | 'PAYMENT_DECLINED'
  /** The risk model refused the order outright. Distinct from a declined card. */
  | 'RISK_BLOCKED'
  /**
   * Cash on delivery is available, but only with a deposit paid now.
   *
   * Its own code because the client's response is neither "try again" nor "pick
   * something else" — it is "show a deposit step". `details.advanceDue` carries
   * the amount in minor units.
   */
  | 'ADVANCE_REQUIRED'
  | 'GATEWAY_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'AI_BUDGET_EXCEEDED'
  | 'AI_UNAVAILABLE'
  | 'INTERNAL';

const DEFAULT_STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 422,
  NOT_FOUND: 404,
  UNAUTHORISED: 401,
  FORBIDDEN: 403,
  CONFLICT: 409,
  OUT_OF_STOCK: 409,
  PRICE_CHANGED: 409,
  PAYMENT_FAILED: 402,
  PAYMENT_DECLINED: 402,
  RISK_BLOCKED: 403,
  ADVANCE_REQUIRED: 402,
  GATEWAY_UNAVAILABLE: 503,
  RATE_LIMITED: 429,
  AI_BUDGET_EXCEEDED: 429,
  AI_UNAVAILABLE: 503,
  INTERNAL: 500,
};

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly publicMessage: string;
  readonly details?: Record<string, unknown>;
  /** Whether a client is invited to retry. Drives queue backoff, not just UI. */
  readonly retryable: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      publicMessage?: string;
      details?: Record<string, unknown>;
      retryable?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'DomainError';
    this.code = code;
    this.httpStatus = DEFAULT_STATUS[code];
    this.publicMessage = options.publicMessage ?? genericPublicMessage(code);
    this.details = options.details;
    this.retryable = options.retryable ?? ['GATEWAY_UNAVAILABLE', 'AI_UNAVAILABLE', 'RATE_LIMITED'].includes(code);
  }

  /** Safe to serialise straight to an HTTP response body. */
  toPublicJSON(): { code: ErrorCode; message: string; details?: Record<string, unknown> } {
    return {
      code: this.code,
      message: this.publicMessage,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

function genericPublicMessage(code: ErrorCode): string {
  switch (code) {
    case 'OUT_OF_STOCK':
      return 'Sorry — that item just sold out.';
    case 'PRICE_CHANGED':
      return 'The price changed while you were checking out. Please review your cart.';
    case 'PAYMENT_DECLINED':
      return 'Your payment was declined. Please try another method.';
    case 'PAYMENT_FAILED':
      return 'We could not complete the payment. No money has been taken.';
    case 'GATEWAY_UNAVAILABLE':
      return 'The payment provider is temporarily unavailable. Please try again shortly.';
    case 'NOT_FOUND':
      return 'We could not find what you were looking for.';
    case 'UNAUTHORISED':
      return 'Please sign in to continue.';
    case 'FORBIDDEN':
      return 'You do not have permission to do that.';
    case 'RATE_LIMITED':
      return 'Too many requests. Please slow down and try again.';
    case 'VALIDATION_FAILED':
      return 'Some of the information provided is not valid.';
    case 'CONFLICT':
      return 'That action conflicts with the current state. Please refresh and try again.';
    case 'AI_BUDGET_EXCEEDED':
      return 'The AI assistant has reached today’s usage limit.';
    case 'AI_UNAVAILABLE':
      return 'The AI assistant is temporarily unavailable.';
    default:
      return 'Something went wrong on our side. We have been notified.';
  }
}

export const outOfStock = (variantId: string, requested: number, available: number) =>
  new DomainError('OUT_OF_STOCK', `Variant ${variantId}: requested ${requested}, available ${available}`, {
    publicMessage:
      available > 0
        ? `Only ${available} left — please reduce the quantity.`
        : 'Sorry — that item just sold out.',
    details: { variantId, requested, available },
  });

export const priceChanged = (variantId: string, was: number, now: number) =>
  new DomainError('PRICE_CHANGED', `Variant ${variantId} price moved ${was} → ${now}`, {
    details: { variantId, previousPrice: was, currentPrice: now },
  });

export const notFound = (entity: string, id?: string) =>
  new DomainError('NOT_FOUND', `${entity}${id ? ` ${id}` : ''} not found`);

export const forbidden = (permission: string) =>
  new DomainError('FORBIDDEN', `Missing permission: ${permission}`, {
    details: { permission },
  });

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
