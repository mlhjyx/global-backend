import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const CANONICAL_COMPANY_CREATORS = [
  'src/temporal/discovery.activities.ts',
  'src/acquisition/tenant-projection.service.ts',
  'src/intent/ted-intent-projection.service.ts',
  'src/intent/sam-intent-projection.service.ts',
  'src/intent/openfda-intent-projection.service.ts',
] as const;

describe('canonical company writer identity guard coverage', () => {
  it.each(CANONICAL_COMPANY_CREATORS)('%s records an append-only guarded identity decision', async (path) => {
    const source = await readFile(resolve(__dirname, '../../', path), 'utf8');
    expect(source).toMatch(/resolveCompanyIdentity|provisionalReviewCanonicalKey/);
    expect(source).toContain('appendCompanyIdentityDecisionEvidence');
  });

  it('enumerates every production canonicalCompany create/upsert consumer', async () => {
    const expected = new Set(CANONICAL_COMPANY_CREATORS);
    const sourceRoots = ['src'];
    const discovered = new Set<string>();
    for (const root of sourceRoots) {
      const files = await collectTypeScriptFiles(resolve(__dirname, '../../', root));
      for (const file of files) {
        const source = await readFile(file, 'utf8');
        if (/canonicalCompany\.(?:create|upsert)\s*\(/.test(source) && !file.endsWith('.spec.ts')) {
          discovered.add(file.slice(resolve(__dirname, '../..').length + 1));
        }
      }
    }
    expect(discovered).toEqual(expected);
  });
});

async function collectTypeScriptFiles(directory: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return collectTypeScriptFiles(path);
      return entry.isFile() && path.endsWith('.ts') ? [path] : [];
    }),
  );
  return nested.flat();
}
