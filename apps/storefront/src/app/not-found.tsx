import Link from 'next/link';
import { whatsappHref } from '@/lib/contact';

export default function NotFound() {
  const whatsapp = whatsappHref();

  return (
    <div className="container section">
      <div className="empty-state">
        <h1 className="empty-state__title">We couldn’t find that page</h1>
        <p>The product may have been renamed or discontinued.</p>
        <div className="empty-state__actions">
          <Link className="button button--primary" href="/search">
            Browse all products
          </Link>
          {whatsapp && (
            <a className="button button--whatsapp" href={whatsapp}>
              Ask us on WhatsApp
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
