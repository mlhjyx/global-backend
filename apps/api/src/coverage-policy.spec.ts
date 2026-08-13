import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

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

    expect(config.test?.coverage?.exclude).toEqual(['dist/**']);
  });

  it('counts every API TypeScript source file, including modules no test imports yet', () => {
    const config = apiVitestConfig as CoveragePolicy;

    expect(config.test?.coverage?.include).toEqual(['src/**/*.ts']);
  });

  it('forbids source-level coverage ignore pragmas from shrinking the complete inventory', () => {
    const sourceRoot = path.resolve(__dirname);
    const pending = [sourceRoot];
    const productionFiles: string[] = [];
    while (pending.length > 0) {
      const directory = pending.pop();
      if (!directory) continue;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) pending.push(absolute);
        else if (entry.name.endsWith('.ts') && !entry.name.includes('.spec.') && !entry.name.includes('.test.')) {
          productionFiles.push(absolute);
        }
      }
    }

    const violations = productionFiles.filter((file) =>
      /(?:v8|c8|istanbul)\s+ignore/i.test(readFileSync(file, 'utf8')),
    );
    expect(violations).toEqual([]);
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

  it('wires the complete-source coverage command into the required CI job', () => {
    const packageJson = JSON.parse(
      readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };
    const workflow = readFileSync(
      path.resolve(__dirname, '../../../.github/workflows/ci.yml'),
      'utf8',
    );

    expect(packageJson.scripts?.['test:coverage']).toBe('vitest run --coverage');
    expect(workflow).toContain('pnpm --filter @global/api test:coverage');
  });
});
