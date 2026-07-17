import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { previewStaticOptions } from './preview-static';

describe('previewStaticOptions', () => {
  it('serves atomic active pointers before the legacy root and lets misses fall through', () => {
    const root = path.join('/srv', 'preview');
    const options = previewStaticOptions(root);
    expect(options).toHaveLength(2);
    expect(options.map((option) => option.rootPath)).toEqual([
      path.join(root, '.active'),
      root,
    ]);
    expect(
      options.every(
        (option) =>
          option.serveRoot === '/preview' &&
          option.renderPath === '/__no_preview_spa_fallback__' &&
          option.serveStaticOptions?.fallthrough === true,
      ),
    ).toBe(true);
  });
});
