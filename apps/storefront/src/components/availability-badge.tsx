/**
 * Availability badge.
 *
 * In its own module, and taking plain strings rather than a translator
 * function, for a specific reason: it is rendered by both a server component
 * (the product card) and a client component (the buy box). A function cannot
 * cross the server/client boundary — React refuses to serialise it — and
 * importing this from a module the server uses would drag that whole module
 * into the client bundle.
 *
 * Plain strings in, markup out. That keeps the component usable from either
 * side and keeps the client bundle to the one component that genuinely needs
 * state.
 */

export interface AvailabilityLabels {
  readonly inStock: string;
  readonly out: string;
  readonly preorder: string;
  readonly backorder: string;
  /** Contains "{n}" — substituted with the localised count. */
  readonly only: string;
}

export function AvailabilityBadge({
  label,
  available,
  labels,
  formattedCount,
}: {
  label: string;
  available: number;
  labels: AvailabilityLabels;
  /** Pre-formatted for the locale, so this component needs no Intl call. */
  formattedCount?: string;
}) {
  const text =
    label === 'out_of_stock'
      ? labels.out
      : label === 'low_stock'
        ? labels.only.replace('{n}', formattedCount ?? String(available))
        : label === 'preorder'
          ? labels.preorder
          : label === 'backorder'
            ? labels.backorder
            : labels.inStock;

  return <span className={`availability availability--${label}`}>{text}</span>;
}
