import { ImageResponse } from 'next/og';

/**
 * Site-wide Open Graph fallback.
 *
 * Product pages already set their own `openGraph.images` from real product
 * photography (see products/[slug]/page.tsx). This route only applies where
 * no closer segment overrides it — the homepage, category pages, and the
 * static content pages — none of which had any share preview at all before
 * this. Copy is the same hero line already shown on the homepage, not new
 * marketing text.
 */
export const alt = 'Voltix — Genuine electronics, delivered across the UAE.';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          justifyContent: 'center',
          background: '#1d4ed8',
          color: '#ffffff',
          padding: '80px',
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', fontSize: 72, fontWeight: 700, letterSpacing: -2 }}>
          Voltix
        </div>
        <div style={{ display: 'flex', fontSize: 36, marginTop: 24, opacity: 0.92 }}>
          Genuine electronics, delivered across the UAE.
        </div>
      </div>
    ),
    { ...size },
  );
}
