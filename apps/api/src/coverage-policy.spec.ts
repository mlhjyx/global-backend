import { describe, expect, it } from 'vitest';

import apiVitestConfig from '../vitest.config';

type CoveragePolicy = {
  test?: {
    coverage?: {
      exclude?: readonly string[];
    };
  };
};

describe('API coverage policy', () => {
  it('does not count generated dist JavaScript as a second copy of TypeScript source', () => {
    const config = apiVitestConfig as CoveragePolicy;

    expect(config.test?.coverage?.exclude).toContain('dist/**');
  });
});
