import { ImageResponse } from 'next/og';

/**
 * Generated favicon.
 *
 * There was no favicon at all before this — every browser tab, bookmark and
 * "add to home screen" prompt showed the generic globe icon. This reuses the
 * same wordmark styling as the header logo (`.logo span { color:
 * var(--colour-accent) }`, packages/ui/src/tokens.css) rather than
 * introducing a new mark: a single accent-blue "V" on white, the same accent
 * colour the site already uses everywhere else.
 */
export const size = { width: 32, height: 32 };
export const contentType = 'image/png';

export default function Icon() {
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
          borderRadius: 6,
          fontFamily: 'sans-serif',
        }}
      >
        <span style={{ fontSize: 22, fontWeight: 700, color: '#1d4ed8' }}>V</span>
      </div>
    ),
    { ...size },
  );
}
