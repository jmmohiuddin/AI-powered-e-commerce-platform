import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// The form imports its Server Actions, which cannot be loaded outside a Next
// request. Only their identity matters here — nothing is submitted.
vi.mock('./actions', () => ({
  createProductAction: async () => ({ ok: true }),
  updateProductAction: async () => ({ ok: true }),
}));

const { ProductForm } = await import('./product-form');

/**
 * ARABIC PRODUCT COPY IN THE ADMIN — UAE Federal Law 15/2020.
 *
 * Consumer product information must be available in Arabic, so these fields are
 * a compliance surface. Two properties are worth a test rather than a review
 * comment, because both fail silently and both are easy to reintroduce.
 */

function render(values?: Parameters<typeof ProductForm>[0]['values']) {
  return renderToStaticMarkup(
    createElement(ProductForm, {
      mode: values ? ('edit' as const) : ('create' as const),
      options: { brands: [], categories: [] },
      ...(values ? { values } : {}),
    }),
  );
}

/** Every `<tag …>` opening tag carrying a dir attribute, with its name. */
function dirTags(html: string): Array<{ tag: string; attrs: string }> {
  return [...html.matchAll(/<([a-z]+)\b([^>]*\bdir=[^>]*)>/gi)].map((m) => ({
    tag: m[1]!,
    attrs: m[2]!,
  }));
}

function tagFor(html: string, name: string): string | undefined {
  return html.match(new RegExp(`<(?:input|textarea)\\b[^>]*name="${name}"[^>]*>`, 'i'))?.[0];
}

describe('Arabic product fields', () => {
  it('offers Arabic beside every translatable English field', () => {
    const html = render();

    // Beside, not behind a tab: both members of each pair are in the markup at
    // once. A tabbed editor would render only the active panel.
    for (const name of ['title', 'subtitle', 'description', 'highlights']) {
      expect(tagFor(html, name), `English ${name}`).toBeTruthy();
      expect(tagFor(html, `${name}Ar`), `Arabic ${name}`).toBeTruthy();
    }
  });

  /**
   * The detail this kind of form usually gets wrong.
   *
   * `dir` is inherited. Setting it on the row, the section or the form flips the
   * English field sitting beside the Arabic one — the caret jumps to the right
   * and trailing punctuation lands at the wrong end of the line. So it belongs
   * on the Arabic control itself and nowhere above it.
   */
  it('sets dir="rtl" on the Arabic controls only, never on an ancestor', () => {
    const html = render();
    const tagged = dirTags(html);

    // Only form controls carry a direction — no div, section, form or label.
    expect(tagged.length).toBeGreaterThan(0);
    for (const { tag, attrs } of tagged) {
      expect(['input', 'textarea'], `<${tag}> must not carry dir`).toContain(tag);
      expect(attrs).toContain('dir="rtl"');
      expect(attrs).toMatch(/name="[a-zA-Z]+Ar"/);
    }

    // Exactly the four Arabic controls, and each is also marked as Arabic so
    // spellcheck and font fallback pick the right language.
    expect(tagged).toHaveLength(4);
    for (const name of ['titleAr', 'subtitleAr', 'descriptionAr', 'highlightsAr']) {
      expect(tagFor(html, name)).toContain('dir="rtl"');
      expect(tagFor(html, name)).toContain('lang="ar"');
    }

    // And the English fields beside them stay unmarked, so they inherit the
    // page's LTR rather than the neighbour's RTL.
    for (const name of ['title', 'subtitle', 'description', 'highlights']) {
      expect(tagFor(html, name), `English ${name} must not set dir`).not.toContain('dir=');
    }
  });

  it('prefills the Arabic column from the stored translations', () => {
    const html = render({
      id: 'p1',
      slug: 'mx-master-3s',
      title: 'Logitech MX Master 3S',
      subtitle: 'Quiet clicks',
      description: 'A mouse.',
      highlights: ['8K DPI sensor', 'Quiet clicks'],
      translations: {
        'ar-AE': {
          title: 'لوجيتك إم إكس ماستر ٣ إس',
          highlights: ['مستشعر بدقة ٨٠٠٠ نقطة لكل بوصة', 'نقرات هادئة'],
        },
      },
      brandId: null,
      categoryId: null,
      condition: 'new',
      warrantyMonths: 12,
    });

    expect(tagFor(html, 'titleAr')).toContain('لوجيتك إم إكس ماستر ٣ إس');
    // Bullets round-trip as one per line in both columns.
    expect(html).toContain('8K DPI sensor\nQuiet clicks');
    expect(html).toContain('مستشعر بدقة ٨٠٠٠ نقطة لكل بوصة\nنقرات هادئة');
    // An untranslated field is left empty rather than pre-filled with English —
    // English in an Arabic box reads as done and ships untranslated.
    expect(tagFor(html, 'subtitleAr')).toContain('value=""');
  });
});
