import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('Brazil PNCP matrix claim boundary', () => {
  it('describes validated conditional authority and does not restore the old unvalidated claim', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./verify-brazil-pncp-canary-matrix.mts', import.meta.url)),
      'utf8',
    );

    expect(source).toContain('same ACTIVE br-cnpj authority identifier');
    expect(source).toContain('at least one accepted Raw retained a checksum-valid prefix-matched CNPJ');
    expect(source).toContain('neither a CNPJ claim nor a br-cnpj identifier');
    expect(source).toContain("modelMode: 'stub'");
    expect(source).toContain('real-model fit scoring');
    expect(source).toContain('TSX_TSCONFIG_PATH');
    expect(source).not.toContain('CNPJ remained an unvalidated claim');
  });
});
