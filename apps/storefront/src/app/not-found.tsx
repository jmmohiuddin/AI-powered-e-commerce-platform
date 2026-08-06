import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="container section">
      <div className="empty-state">
        <h1 style={{ fontSize: 'var(--text-2xl)', marginBottom: 'var(--space-3)' }}>
          We couldn’t find that page
        </h1>
        <p style={{ marginBottom: 'var(--space-5)' }}>
          The product may have been renamed or discontinued.
        </p>
        <div
          style={{
            display: 'flex',
            gap: 'var(--space-3)',
            justifyContent: 'center',
            flexWrap: 'wrap',
          }}
        >
          <Link className="button button--primary" href="/search">
            Browse all products
          </Link>
          <a className="button button--whatsapp" href="https://wa.me/971500000000">
            Ask us on WhatsApp
          </a>
        </div>
      </div>
    </div>
  );
}
