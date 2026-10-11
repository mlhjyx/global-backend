import { describe, expect, it } from 'vitest';
import {
  isReviewedModelSubstitution,
  MODEL_IDENTITY_SUBSTITUTES_ENV,
  parseModelIdentitySubstitutes,
} from './model-identity-substitutes';

describe('MODEL_IDENTITY_SUBSTITUTES deployment setting (D14, 2026-10-11)', () => {
  it('is read from one named environment variable', () => {
    expect(MODEL_IDENTITY_SUBSTITUTES_ENV).toBe('MODEL_IDENTITY_SUBSTITUTES');
  });

  it.each([undefined, '', '   '])(
    'is off by default (%j admits no substitute)',
    (raw) => {
      expect(parseModelIdentitySubstitutes(raw).size).toBe(0);
    },
  );

  it('admits the reviewed pro-to-flash substitution', () => {
    const substitutes = parseModelIdentitySubstitutes(
      'deepseek-v4-pro>deepseek-v4-flash',
    );

    expect([...substitutes.entries()]).toEqual([
      ['deepseek-v4-pro', ['deepseek-v4-flash']],
    ]);
  });

  it('tolerates whitespace around pairs and the separator', () => {
    const substitutes = parseModelIdentitySubstitutes(
      ' deepseek-v4-pro > deepseek-v4-flash ',
    );

    expect(substitutes.get('deepseek-v4-pro')).toEqual(['deepseek-v4-flash']);
  });

  it('returns an immutable snapshot', () => {
    const substitutes = parseModelIdentitySubstitutes(
      'deepseek-v4-pro>deepseek-v4-flash',
    );

    expect(Object.isFrozen(substitutes.get('deepseek-v4-pro'))).toBe(true);
    expect(() =>
      (substitutes as Map<string, readonly string[]>).set('x', ['y']),
    ).toThrow();
    expect(() => Map.prototype.set.call(substitutes, 'x', ['y'])).toThrow(TypeError);
    expect(() => Map.prototype.clear.call(substitutes)).toThrow(TypeError);
    expect(substitutes.size).toBe(1);
  });

  it('reports reviewed substitutions only', () => {
    expect(isReviewedModelSubstitution('deepseek-v4-pro', 'deepseek-v4-flash')).toBe(true);
    expect(isReviewedModelSubstitution('deepseek-v4-flash', 'deepseek-v4-pro')).toBe(false);
    expect(isReviewedModelSubstitution('constructor', 'deepseek-v4-flash')).toBe(false);
  });

  it.each([
    ['a missing separator', 'deepseek-v4-pro'],
    ['two separators', 'deepseek-v4-pro>deepseek-v4-flash>deepseek-v4-pro'],
    ['an empty requested side', '>deepseek-v4-flash'],
    ['an empty accepted side', 'deepseek-v4-pro>'],
    ['an empty pair', 'deepseek-v4-pro>deepseek-v4-flash,'],
    ['an empty pair in the middle', 'deepseek-v4-pro>deepseek-v4-flash,,'],
    ['a self pair', 'deepseek-v4-pro>deepseek-v4-pro'],
    [
      'a duplicate pair',
      'deepseek-v4-pro>deepseek-v4-flash,deepseek-v4-pro>deepseek-v4-flash',
    ],
    ['an identifier with spaces', 'deepseek v4 pro>deepseek-v4-flash'],
    ['an identifier with a control character', 'deepseek-v4-pro>deepseek-v4-flash\u0000'],
    ['an unknown requested model', 'deepseek-v4-pr>deepseek-v4-flash'],
    ['an unknown accepted model', 'deepseek-v4-pro>gpt-9'],
    ['a known but unreviewed substitution', 'deepseek-v4-pro>gemini-3.5-flash'],
    ['the reverse of the reviewed pair', 'deepseek-v4-flash>deepseek-v4-pro'],
    ['an oversized value', `deepseek-v4-pro>deepseek-v4-flash,${'x'.repeat(1100)}`],
  ])('fails fast on %s', (_label, raw) => {
    expect(() => parseModelIdentitySubstitutes(raw)).toThrow(
      /^MODEL_IDENTITY_SUBSTITUTES_INVALID/,
    );
  });

  it('never echoes an oversized value into the startup error', () => {
    const raw = `deepseek-v4-pro>${'x'.repeat(5000)}`;

    let message = '';
    try {
      parseModelIdentitySubstitutes(raw);
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toMatch(/^MODEL_IDENTITY_SUBSTITUTES_INVALID/);
    expect(message.length).toBeLessThan(200);
  });
});
