import { it, expect, vi } from 'vitest';
import { mapPublicWebCompanyToRecord } from './providers/public-web.provider';
import { validateRawSourceProviderPayload } from './raw-source-provider-schema';

vi.mock('@temporalio/activity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@temporalio/activity')>()),
  heartbeat: vi.fn(),
}));

it('debug validation', () => {
  const fetchedAt = new Date().toISOString();
  const suffix = 'abcd1234';
  const record = mapPublicWebCompanyToRecord({
    domain: `cap-pw-0-${suffix}.example`,
    hitUrls: [`https://cap-pw-0-${suffix}.example/produkte`],
    sourceText: `- Pumpen Cap 0 GmbH\n  URL: https://cap-pw-0-${suffix}.example/produkte`,
    extracted: { is_company_site: true, name: 'Pumpen Cap 0 GmbH', country: 'Germany', products: ['pumps'] },
    sourceClass: 'public_intelligence',
    fetchedAt,
  } as never);
  process.stdout.write(`\nRECORD=${JSON.stringify(record)}\n`);
  const v = validateRawSourceProviderPayload('public_web', record);
  process.stdout.write(`VALID=${JSON.stringify(v.ok ? { ok: true } : v)}\n`);
  expect(v.ok).toBe(true);
});
