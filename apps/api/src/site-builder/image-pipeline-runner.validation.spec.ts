import { describe, expect, it } from 'vitest';
import type { PlannedImageVariant } from './image-pipeline';
import {
  expectedImageOutputMime,
  parseImageChildResult,
  sniffImageOutputMime,
  validateImageChildInspection,
} from './image-pipeline-runner';

function inspection(overrides: Record<string, unknown> = {}) {
  return {
    decodedMime: 'image/jpeg',
    width: 640,
    height: 360,
    hasAlpha: false,
    hasExif: false,
    hasIcc: false,
    orientation: null,
    quality: {
      policyVersion: 'image-qa-m1c.1',
      metrics: { entropy: 1, sharpness: 2, exposure: 0.5, noise: 0.1 },
      warnings: ['blurry'],
    },
    ...overrides,
  };
}

describe('image child receipt validators', () => {
  it('accepts an exact bounded inspection', () => {
    expect(validateImageChildInspection(inspection())).toEqual(inspection());
    expect(validateImageChildInspection(inspection({ decodedMime: 'image/png', orientation: 8 }))).toMatchObject({
      decodedMime: 'image/png',
      orientation: 8,
    });
    expect(validateImageChildInspection(inspection({ decodedMime: 'image/webp', quality: { ...inspection().quality, warnings: [] } }))).toMatchObject({
      decodedMime: 'image/webp',
    });
  });

  it.each([
    ['not an object', null, 'invalid inspection'],
    ['array', [], 'invalid inspection'],
    ['MIME', inspection({ decodedMime: 'image/gif' }), 'decoded MIME'],
    ['width type', inspection({ width: 1.5 }), 'width'],
    ['width zero', inspection({ width: 0 }), 'width'],
    ['height type', inspection({ height: '360' }), 'height'],
    ['height zero', inspection({ height: -1 }), 'height'],
    ['alpha metadata', inspection({ hasAlpha: 1 }), 'metadata'],
    ['exif metadata', inspection({ hasExif: null }), 'metadata'],
    ['icc metadata', inspection({ hasIcc: 'no' }), 'metadata'],
    ['orientation low', inspection({ orientation: 0 }), 'metadata'],
    ['orientation high', inspection({ orientation: 9 }), 'metadata'],
    ['quality missing', inspection({ quality: null }), 'quality report'],
    ['quality version', inspection({ quality: { ...inspection().quality, policyVersion: 'old' } }), 'quality report'],
    ['metrics missing', inspection({ quality: { ...inspection().quality, metrics: null } }), 'quality metrics'],
    [
      'metric non-finite',
      inspection({ quality: { ...inspection().quality, metrics: { entropy: Number.NaN, sharpness: 1, exposure: 1, noise: 1 } } }),
      'quality metrics',
    ],
    [
      'metric type',
      inspection({ quality: { ...inspection().quality, metrics: { entropy: 1, sharpness: '1', exposure: 1, noise: 1 } } }),
      'quality metrics',
    ],
    ['warnings type', inspection({ quality: { ...inspection().quality, warnings: 'blurry' } }), 'quality warnings'],
    ['warnings value', inspection({ quality: { ...inspection().quality, warnings: ['unknown'] } }), 'quality warnings'],
  ])('rejects %s', (_label, value, message) => {
    expect(() => validateImageChildInspection(value)).toThrow(message);
  });

  it('sniffs every supported output signature and rejects lookalikes', () => {
    expect(sniffImageOutputMime(Buffer.from([0xff, 0xd8, 0xff]))).toBe('image/jpeg');
    expect(sniffImageOutputMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    expect(sniffImageOutputMime(Buffer.from('RIFFxxxxWEBP', 'latin1'))).toBe('image/webp');
    expect(sniffImageOutputMime(Buffer.from('xxxxftypavifxxxx', 'latin1'))).toBe('image/avif');
    expect(sniffImageOutputMime(Buffer.from('xxxxftypxxxxxxxxavis', 'latin1'))).toBe('image/avif');
    expect(sniffImageOutputMime(Buffer.from('xxxxftypheicxxxx', 'latin1'))).toBeNull();
    expect(sniffImageOutputMime(Buffer.from([0xff, 0xd8]))).toBeNull();
  });

  it('parses only inspect/render child envelopes', () => {
    expect(parseImageChildResult(Buffer.from('{"kind":"inspect","inspection":{}}'))).toMatchObject({ kind: 'inspect' });
    expect(parseImageChildResult(Buffer.from('{"kind":"render","outputs":[]}'))).toMatchObject({ kind: 'render' });
    expect(() => parseImageChildResult(Buffer.from('{'))).toThrow('malformed JSON');
    expect(() => parseImageChildResult(Buffer.from('null'))).toThrow('invalid result envelope');
    expect(() => parseImageChildResult(Buffer.from('{"kind":"other"}'))).toThrow('invalid result envelope');
  });

  it('maps every planned codec to its exact MIME', () => {
    const plan = (format: string) =>
      ({ recipe: { output: { format } } } as unknown as PlannedImageVariant);
    expect(expectedImageOutputMime(plan('avif'))).toBe('image/avif');
    expect(expectedImageOutputMime(plan('jpeg'))).toBe('image/jpeg');
    expect(expectedImageOutputMime(plan('png'))).toBe('image/png');
    expect(expectedImageOutputMime(plan('webp'))).toBe('image/webp');
  });
});
