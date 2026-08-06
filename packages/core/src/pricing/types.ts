import type { Money } from '../money';

export interface PricingLineInput {
  readonly id: string;
  readonly variantId: string;
  readonly productId: string;
  readonly categoryIds: readonly string[];
  readonly brandId?: string;
  readonly quantity: number;
  readonly unitPrice: Money;
  readonly unitCost?: Money;
  /** Digital goods and services skip shipping and often have a different tax rate. */
  readonly requiresShipping: boolean;
}

export type DiscountType =
  | 'percentage'
  | 'fixed_amount'
  | 'free_shipping'
  | 'buy_x_get_y'
  | 'bundle';

export type DiscountScope = 'order' | 'product' | 'category' | 'brand' | 'shipping';

export interface DiscountConditions {
  readonly minSubtotal?: number;
  readonly minQuantity?: number;
  readonly productIds?: readonly string[];
  readonly variantIds?: readonly string[];
  readonly categoryIds?: readonly string[];
  readonly brandIds?: readonly string[];
  readonly customerSegments?: readonly string[];
  readonly firstOrderOnly?: boolean;
  readonly channels?: readonly string[];
  readonly paymentProviders?: readonly string[];
  /** buy_x_get_y: buy `buyQuantity`, get `getQuantity` at `getDiscountBps` off. */
  readonly buyQuantity?: number;
  readonly getQuantity?: number;
  readonly getDiscountBps?: number;
}

export interface DiscountInput {
  readonly id: string;
  readonly code?: string | null;
  readonly name: string;
  readonly type: DiscountType;
  readonly scope: DiscountScope;
  /** Basis points for percentage, minor units for fixed_amount. */
  readonly value: number;
  readonly maxDiscountAmount?: number | null;
  readonly conditions: DiscountConditions;
  readonly isStackable: boolean;
  readonly priority: number;
  readonly startsAt?: Date | null;
  readonly endsAt?: Date | null;
  readonly usageLimit?: number | null;
  readonly usageCount?: number;
}

export interface TaxRule {
  readonly id: string;
  readonly name: string;
  readonly rateBps: number;
  /**
   * true  → the listed price already contains tax (VAT-inclusive markets)
   * false → tax is added at checkout (US sales-tax style)
   *
   * Getting this wrong is a silent 15% margin error, so it is a required field
   * rather than a defaulted one.
   */
  readonly isInclusive: boolean;
  readonly appliesToShipping: boolean;
  readonly categoryIds?: readonly string[];
}

export interface PricingContext {
  readonly currency: string;
  readonly now: Date;
  readonly channel: string;
  readonly customerId?: string;
  readonly customerSegments: readonly string[];
  readonly isFirstOrder: boolean;
  readonly paymentProvider?: string;
  readonly shippingCost: Money;
  readonly taxRules: readonly TaxRule[];
  /** Loyalty points the customer is redeeming, already validated for balance. */
  readonly loyaltyPointsRedeemed?: number;
  readonly loyaltyPointValue?: Money;
  readonly storeCreditApplied?: Money;
  readonly giftCardApplied?: Money;
}

export interface AppliedDiscount {
  readonly discountId: string;
  readonly code?: string | null;
  readonly name: string;
  readonly amount: Money;
  readonly scope: DiscountScope;
  /** Per-line breakdown, needed for partial refunds and per-line margin. */
  readonly lineAllocations: ReadonlyMap<string, Money>;
}

export interface RejectedDiscount {
  readonly discountId: string;
  readonly code?: string | null;
  readonly reason: string;
}

export interface PricedLine {
  readonly id: string;
  readonly quantity: number;
  readonly unitPrice: Money;
  readonly lineSubtotal: Money;
  readonly discountTotal: Money;
  readonly taxTotal: Money;
  readonly lineTotal: Money;
  readonly costTotal: Money;
  readonly marginBps: number | null;
}

export interface PricingResult {
  readonly currency: string;
  readonly lines: readonly PricedLine[];
  readonly subtotal: Money;
  readonly discountTotal: Money;
  readonly shippingTotal: Money;
  readonly taxTotal: Money;
  readonly total: Money;
  /** Total minus stored-value tender; what the gateway actually collects. */
  readonly amountDue: Money;
  readonly costTotal: Money;
  readonly marginBps: number | null;
  readonly appliedDiscounts: readonly AppliedDiscount[];
  readonly rejectedDiscounts: readonly RejectedDiscount[];
}
