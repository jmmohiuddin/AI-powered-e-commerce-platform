import { ImageResponse } from 'next/og';

/**
 * Apple touch icon — same mark as icon.tsx, at the size iOS actually asks
 * for. A missing apple-icon falls back to a screenshot of the page as the
 * home-screen icon, which is illegible at icon size.
 */
export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#ffffff',
          fontFamily: 'sans-serif',
        }}
      >
        <span style={{ fontSize: 120, fontWeight: 700, color: '#1d4ed8' }}>V</span>
      </div>
    ),
    { ...size },
  );
}
