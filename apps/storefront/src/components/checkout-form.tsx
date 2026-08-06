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
}: {
  total: number;
  currency: string;
  locale: Locale;
  paymentOptions: PaymentOption[];
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const firstAvailable = paymentOptions.find((option) => option.available);
  const [provider, setProvider] = useState(firstAvailable?.id ?? '');

  function submit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const result = await placeOrder(formData);
      if (!result.ok) {
        setError(result.error ?? 'Something went wrong.');
        return;
      }
      // A redirect gateway hands the shopper to a hosted payment page.
      if (result.redirectUrl) window.location.href = result.redirectUrl;
      // Otherwise the action itself redirects to the confirmation.
    });
  }

  const selected = paymentOptions.find((option) => option.id === provider);

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
          : `Place order · ${formatPrice(total, currency, locale)}`}
      </button>

      <p className="vat-note">
        By placing this order you agree to our terms. Prices include 5% VAT.
      </p>
    </form>
  );
}
