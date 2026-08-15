/**
 * TAX DOCUMENTS
 *
 * Deliberately a pure package: it builds and renders documents and does no
 * database work at all. Persistence, numbering and the order lookup live in
 * `packages/commerce/src/invoices.ts`, the same split as templates versus the
 * outbox in `packages/notifications`.
 *
 * The point of the split is that the rules with legal consequences — what makes
 * a supply require a full tax invoice, which fields must be present, what the
 * document is allowed to call itself — are pure functions of their inputs, so
 * they can be tested exhaustively without a database and cannot be bypassed by
 * a caller that happens to hold a transaction.
 */
export * from './document';
export * from './render-html';
