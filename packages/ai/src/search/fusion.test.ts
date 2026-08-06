import { describe, expect, it } from 'vitest';
import { applyBoosts, classifyQuery, reciprocalRankFusion, type BoostSignals } from './fusion';

const list = (...ids: string[]) => ids.map((id, i) => ({ id, score: 100 - i }));

describe('reciprocalRankFusion', () => {
  it('rewards agreement between retrievers over a single first place', () => {
    const fused = reciprocalRankFusion([
      { label: 'lexical', results: list('a', 'b', 'c') },
      { label: 'semantic', results: list('d', 'b', 'e') },
    ]);
    // 'b' is 2nd in both; 'a' and 'd' are 1st in one and absent from the other.
    expect(fused[0]?.id).toBe('b');
  });

  it('ignores incomparable raw scores', () => {
    // BM25 scores in the thousands vs cosine similarities under 1 — rank only.
    const fused = reciprocalRankFusion([
      { label: 'lexical', results: [{ id: 'a', score: 9999 }, { id: 'b', score: 8000 }] },
      { label: 'semantic', results: [{ id: 'b', score: 0.91 }, { id: 'a', score: 0.9 }] },
    ]);
    expect(fused.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });

  it('honours retriever weights', () => {
    const lexicalHeavy = reciprocalRankFusion([
      { label: 'lexical', results: list('a', 'z'), weight: 1 },
      { label: 'semantic', results: list('z', 'a'), weight: 0.1 },
    ]);
    expect(lexicalHeavy[0]?.id).toBe('a');
  });

  it('records which retrievers matched, for diagnostics', () => {
    const fused = reciprocalRankFusion([
      { label: 'lexical', results: list('a') },
      { label: 'semantic', results: list('a') },
    ]);
    expect(fused[0]?.sources.map((s) => s.label)).toEqual(['lexical', 'semantic']);
  });

  it('is stable across identical queries', () => {
    const inputs = [
      { label: 'lexical', results: list('a', 'b') },
      { label: 'semantic', results: list('b', 'a') },
    ];
    expect(reciprocalRankFusion(inputs)).toEqual(reciprocalRankFusion(inputs));
  });

  it('handles an empty retriever without collapsing', () => {
    const fused = reciprocalRankFusion([
      { label: 'lexical', results: [] },
      { label: 'semantic', results: list('a', 'b') },
    ]);
    expect(fused.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('respects the limit', () => {
    const fused = reciprocalRankFusion([{ label: 'l', results: list('a', 'b', 'c', 'd') }], {
      limit: 2,
    });
    expect(fused).toHaveLength(2);
  });
});

describe('applyBoosts', () => {
  const base = reciprocalRankFusion([{ label: 'l', results: list('a', 'b') }]);

  it('demotes out-of-stock products below in-stock ones', () => {
    const signals = new Map<string, BoostSignals>([
      ['a', { inStock: false }],
      ['b', { inStock: true }],
    ]);
    expect(applyBoosts(base, signals)[0]?.id).toBe('b');
  });

  it('does not let margin outweigh relevance', () => {
    // 'a' ranks well above 'b'; a maximal margin boost must not flip them.
    const wide = reciprocalRankFusion([{ label: 'l', results: list('a', 'x', 'y', 'z', 'b') }]);
    const signals = new Map<string, BoostSignals>([['b', { marginBps: 9000 }]]);
    expect(applyBoosts(wide, signals)[0]?.id).toBe('a');
  });

  it('ignores ratings below the review-count floor', () => {
    const signals = new Map<string, BoostSignals>([['b', { ratingAverage: 500, ratingCount: 2 }]]);
    expect(applyBoosts(base, signals)[0]?.id).toBe('a');
  });

  it('applies a rating boost once there are enough reviews', () => {
    const boosted = applyBoosts(
      base,
      new Map<string, BoostSignals>([['b', { ratingAverage: 500, ratingCount: 200 }]]),
    );
    const b = boosted.find((r) => r.id === 'b')!;
    const originalB = base.find((r) => r.id === 'b')!;
    expect(b.score).toBeGreaterThan(originalB.score);
  });

  it('leaves results without signals untouched', () => {
    expect(applyBoosts(base, new Map())).toEqual(base);
  });
});

describe('classifyQuery', () => {
  it('treats model numbers as identifier queries', () => {
    for (const q of ['SM-S928B', 'A2846', '356938035643809']) {
      const result = classifyQuery(q);
      expect(result.intent).toBe('identifier');
      expect(result.lexicalWeight).toBeGreaterThan(result.semanticWeight);
    }
  });

  it('treats natural language as exploratory', () => {
    const result = classifyQuery('best phone with a good camera under 40000');
    expect(result.intent).toBe('exploratory');
    expect(result.semanticWeight).toBeGreaterThan(result.lexicalWeight);
  });

  it('treats short brand phrases as navigational and blends both signals', () => {
    const result = classifyQuery('redmi note 13');
    expect(result.intent).toBe('navigational');
    expect(result.lexicalWeight).toBeGreaterThan(0);
    expect(result.semanticWeight).toBeGreaterThan(0);
  });
});
