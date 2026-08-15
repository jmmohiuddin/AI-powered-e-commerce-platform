'use client';

import { useState, useTransition } from 'react';
import { formatPrice } from '@voltix/ui';
import { placeOrder } from '@/app/actions';
import type { Locale } from '@/lib/locale';

export interface PaymentOption {
  id: string;
  displayName: string;
  available: boolean;
  reason?: string;
  surcharge?: number;
  advanceRequired?: number;
  isDeferredSettlement: boolean;
}

/**
 * Deposit copy, translated on the server.
 *
 * This is a client component, so it cannot call `translator` — that reads a
 * cookie through `next/headers`. The page resolves the strings and passes them
 * down, which is the same shape the product page uses.
 */
export interface DepositCopy {
  legend: string;
  /** `{amount}` and `{balance}` are substituted with formatted prices. */
  explainer: string;
  refundCondition: string;
  chooseCard: string;
  noCard: string;
}

const EMIRATES = [
  { code: 'DU', name: 'Dubai' },
  { code: 'AZ', name: 'Abu Dhabi' },
  { code: 'SH', name: 'Sharjah' },
  { code: 'AJ', name: 'Ajman' },
  { code: 'UQ', name: 'Umm Al Quwain' },
  { code: 'RK', name: 'Ras Al Khaimah' },
  { code: 'FU', name: 'Fujairah' },
];

/**
 * The checkout form.
 *
 * THE ADDRESS FIELDS ARE THE LOCALISATION, not the labels. There is no postal
 * code, because the UAE has no postal-code system — a required one either
 * blocks the order or trains everyone to type "00000", which then defeats
 * address validation, courier zoning and fraud scoring at once. Emirate is a
 * select rather than free text because it drives the delivery fee and the
 * courier zone, and a typo there is a failed delivery.
 *
 * UNAVAILABLE PAYMENT METHODS ARE SHOWN, DISABLED, WITH THE REASON. Silently
 * omitting cash on delivery from a shopper who expected it produces an
 * abandoned cart and a support ticket; "online payment required for this
 * order" produces a prepaid order.
 */
export function CheckoutForm({
  total,
  currency,
  locale,
  paymentOptions,
  deposit,
}: {
  total: number;
  currency: string;
  locale: Locale;
  paymentOptions: PaymentOption[];
  deposit: DepositCopy;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const firstAvailable = paymentOptions.find((option) => option.available);
  const [provider, setProvider] = useState(firstAvailable?.id ?? '');

  /**
   * A deposit the server demanded that the page did not know about.
   *
   * The standing policy is visible when the options are built, but a deposit
   * triggered by *this order's* risk score can only be known once the address
   * and phone have been submitted. Rather than dead-ending on an error, the
   * refusal carries the amount back and opens the deposit step in place.
   */
  const [serverAdvance, setServerAdvance] = useState(0);

  const selected = paymentOptions.find((option) => option.id === provider);
  const prepaidOptions = paymentOptions.filter(
    (option) => option.available && !option.isDeferredSettlement,
  );

  const advanceDue = selected?.isDeferredSettlement
    ? Math.max(selected.advanceRequired ?? 0, serverAdvance)
    : 0;
  const [advanceProvider, setAdvanceProvider] = useState(prepaidOptions[0]?.id ?? '');

  function submit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const result = await placeOrder(formData);
      if (!result.ok) {
        setError(result.error ?? 'Something went wrong.');
        if (result.advanceDue) setServerAdvance(result.advanceDue);
        return;
      }
      // A redirect gateway hands the shopper to a hosted payment page.
      if (result.redirectUrl) window.location.href = result.redirectUrl;
      // Otherwise the action itself redirects to the confirmation.
    });
  }

  const price = (amount: number) => formatPrice(amount, currency, locale);

  return (
    <form action={submit} className="checkout-form">
      <fieldset>
        <legend>Delivery details</legend>

        <label>
          <span>Full name</span>
          <input name="recipientName" required autoComplete="name" />
        </label>

        <label>
          <span>Mobile number</span>
          <input
            name="phone"
            required
            type="tel"
            inputMode="tel"
            dir="ltr"
            placeholder="050 123 4567"
            autoComplete="tel"
          />
          <small>We send order updates here, and the courier calls before delivery.</small>
        </label>

        <label>
          <span>Email (optional)</span>
          <input name="email" type="email" autoComplete="email" />
        </label>

        <label>
          <span>Emirate</span>
          <select name="emirate" required defaultValue="DU">
            {EMIRATES.map((emirate) => (
              <option key={emirate.code} value={emirate.code}>
                {emirate.name}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Area or community</span>
          <input name="area" required placeholder="Dubai Marina" autoComplete="address-level2" />
        </label>

        <div className="checkout-form__row">
          <label>
            <span>Building name</span>
            <input name="buildingName" placeholder="Marina Heights Tower" />
          </label>
          <label>
            <span>Flat / villa</span>
            <input name="flatOrVilla" placeholder="2104" />
          </label>
        </div>

        <label>
          <span>Makani number (optional)</span>
          <input name="makani" inputMode="numeric" dir="ltr" placeholder="2648 870219" />
          {/* Not decoration: a Makani resolves to a building entrance, and
              including one measurably reduces failed first-attempt deliveries. */}
          <small>Ten digits from Google Maps or your building sign. Speeds up delivery.</small>
        </label>

        <label>
          <span>Delivery note (optional)</span>
          <input name="customerNote" placeholder="Leave with security if I'm out" />
        </label>

        {/*
          BUYING FOR A BUSINESS

          Behind a <details> on purpose. Most shoppers here are consumers, and a
          visible tax field on a consumer checkout is a question they cannot
          answer and a reason to hesitate — it costs conversion for no benefit.
          A business buyer, by contrast, is specifically looking for this and
          knows the words.

          It is not cosmetic once opened: a TRN turns the sale into a B2B supply
          that legally requires a full tax invoice carrying the buyer's number,
          and without it on the document they cannot reclaim the input VAT.
          Validated server-side and refused if malformed rather than dropped.
        */}
        <details className="checkout-form__disclosure">
          <summary>Buying for a business?</summary>
          <label>
            <span>Tax Registration Number (optional)</span>
            <input
              name="recipientTrn"
              inputMode="numeric"
              dir="ltr"
              maxLength={20}
              pattern="[0-9\s-]{15,20}"
              placeholder="100 234 567 800 003"
              autoComplete="off"
            />
            <small>
              Add your 15-digit TRN and we will issue a full tax invoice in your company&rsquo;s
              name, so you can reclaim the VAT.
            </small>
          </label>
        </details>
      </fieldset>

      <fieldset>
        <legend>Payment</legend>

        <div className="payment-options">
          {paymentOptions.map((option) => (
            <label
              key={option.id}
              className={`payment-option${option.available ? '' : ' payment-option--disabled'}`}
            >
              <input
                type="radio"
                name="paymentProvider"
                value={option.id}
                checked={provider === option.id}
                disabled={!option.available}
                onChange={() => setProvider(option.id)}
              />
              <span className="payment-option__body">
                <strong>{option.displayName}</strong>
                {option.available ? (
                  <>
                    {option.surcharge ? (
                      <small>+{formatPrice(option.surcharge, currency, locale)} handling fee</small>
                    ) : null}
                    {option.advanceRequired ? (
                      <small>
                        {formatPrice(option.advanceRequired, currency, locale)} payable in advance
                      </small>
                    ) : null}
                    {option.isDeferredSettlement ? <small>Pay the courier on delivery</small> : null}
                  </>
                ) : (
                  <small className="payment-option__reason">{option.reason}</small>
                )}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {/*
        THE DEPOSIT STEP.
        Three things have to be said before a shopper will hand over money on a
        cash-on-delivery order, and leaving any of them out is where this
        converts badly: what the deposit is, that it comes off the total rather
        than being added to it, and what happens to it if the delivery does not
        go ahead. The last one is the one shoppers actually stall on.
      */}
      {advanceDue > 0 && (
        <fieldset className="deposit">
          <legend>{deposit.legend}</legend>

          <p>
            {deposit.explainer
              .replace('{amount}', price(advanceDue))
              .replace('{balance}', price(Math.max(total - advanceDue, 0)))}
          </p>
          <p className="vat-note">{deposit.refundCondition}</p>

          {prepaidOptions.length === 0 ? (
            <p className="cart-error" role="alert">
              {deposit.noCard}
            </p>
          ) : (
            <label>
              <span>{deposit.chooseCard}</span>
              <select
                name="advancePaymentProvider"
                value={advanceProvider}
                onChange={(event) => setAdvanceProvider(event.target.value)}
                required
              >
                {prepaidOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.displayName}
                  </option>
                ))}
              </select>
            </label>
          )}
        </fieldset>
      )}

      {error && (
        <p className="cart-error" role="alert">
          {error}
        </p>
      )}

      <button
        className="button button--primary button--block"
        type="submit"
        disabled={pending || !selected}
      >
        {pending
          ? 'Placing your order…'
          : advanceDue > 0
            ? // Naming the charge on the button, not just in the section above:
              // the amount taken now is not the order total, and a button that
              // says otherwise is the last thing they read before paying.
              `Pay ${price(advanceDue)} deposit · order ${price(total)}`
            : `Place order · ${price(total)}`}
      </button>

      <p className="vat-note">
        By placing this order you agree to our terms. Prices include 5% VAT.
      </p>
    </form>
  );
}
