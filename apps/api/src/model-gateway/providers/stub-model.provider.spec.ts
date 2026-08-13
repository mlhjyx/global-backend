import { describe, expect, it } from 'vitest';
import { StubModelProvider } from './stub-model.provider';

describe('StubModelProvider deterministic offline boundary', () => {
  const provider = new StubModelProvider();

  it('supports non-vision operations only and reports a key-free healthy state', async () => {
    expect(provider.supports('generateText')).toBe(true);
    expect(provider.supports('generateStructured')).toBe(true);
    expect(provider.supports('embed')).toBe(true);
    expect(provider.supports('reviewVision')).toBe(false);
    await expect(provider.health()).resolves.toEqual({ healthy: true, detail: 'stub' });
  });

  it('returns bounded zero-cost text and schema-shaped structured placeholders', async () => {
    const prompt = 'x'.repeat(120);
    await expect(provider.generateText({ task: 'offline', prompt })).resolves.toEqual({
      data: `[stub:offline] ${'x'.repeat(80)}`,
      provider: 'stub',
      model: 'stub-v0',
      usage: { costUsd: 0 },
    });
    await expect(
      provider.generateStructured({ task: 'offline', prompt: 'p', schema: { required: ['name', 'score'] } }),
    ).resolves.toMatchObject({ data: { name: null, score: null }, usage: { costUsd: 0 } });
    await expect(provider.generateStructured({ task: 'offline', prompt: 'p', schema: {} })).resolves.toMatchObject({ data: {} });
  });

  it('creates one independent zero vector per input and rejects vision review', async () => {
    const result = await provider.embed({ input: ['a', 'b'] });
    expect(result.data).toEqual([Array(8).fill(0), Array(8).fill(0)]);
    expect(result.data[0]).not.toBe(result.data[1]);
    await expect(provider.reviewVision({} as never)).rejects.toThrow('STUB_VISION_REVIEW_FORBIDDEN');
  });
});
