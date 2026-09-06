import type { MetadataRoute } from 'next';

/**
 * Web app manifest. Nothing existed before this — no "Add to Home Screen"
 * name, no theme colour for the OS task switcher. Colours match the
 * `viewport.themeColor` pair already declared in layout.tsx.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Phoyev — Electronics & mobile retail in the UAE',
    short_name: 'Phoyev',
    description:
      'Genuine smartphones, mobile accessories and computer gear with official UAE warranty, delivered across the Emirates.',
    start_url: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#ffffff',
    icons: [
      { src: '/icon', sizes: '32x32', type: 'image/png' },
      { src: '/apple-icon', sizes: '180x180', type: 'image/png' },
    ],
  };
}
