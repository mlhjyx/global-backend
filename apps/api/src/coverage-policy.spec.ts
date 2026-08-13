import { describe, expect, it } from 'vitest';

import apiVitestConfig from '../vitest.config';

type CoveragePolicy = {
  test?: {
    coverage?: {
      include?: readonly string[];
      exclude?: readonly string[];
      thresholds?: {
        statements?: number;
        branches?: number;
        functions?: number;
        lines?: number;
      };
    };
  };
};

describe('API coverage policy', () => {
  it('does not count generated dist JavaScript as a second copy of TypeScript source', () => {
    const config = apiVitestConfig as CoveragePolicy;

    expect(config.test?.coverage?.exclude).toContain('dist/**');
  });

  it('counts every API TypeScript source file, including modules no test imports yet', () => {
    const config = apiVitestConfig as CoveragePolicy;

    expect(config.test?.coverage?.include).toContain('src/**/*.ts');
  });

  it('fails the complete source inventory unless every coverage dimension reaches 80 percent', () => {
    const config = apiVitestConfig as CoveragePolicy;

    expect(config.test?.coverage?.thresholds).toEqual({
      statements: 80,
      branches: 80,
      functions: 80,
      lines: 80,
    });
  });
});
