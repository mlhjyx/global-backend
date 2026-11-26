import { describe, expect, it, vi } from 'vitest';
import {
  DomainCooldownService,
  PostgresDomainCooldownBackend,
  PostgresSharedFactRepository,
  SharedGreenFactStore,
  type PlatformSharedSqlClient,
} from './index';

describe('PostgresSharedFactRepository & PostgresDomainCooldownBackend unit tests', () => {
  it('separates reader/writer roles and round-trips sanitized green company facts', async () => {
    const stored = new Map<string, Record<string, unknown>>();
    const sqlClient: PlatformSharedSqlClient = {
      $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sqlText = strings.join('?');
        if (sqlText.includes('FROM platform_shared.company_fact')) {
          const domain = String(values[0]);
          const row = stored.get(domain);
          return row ? [row] : [];
        }
        return [];
      }) as PlatformSharedSqlClient['$queryRaw'],
      $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sqlText = strings.join('?');
        if (sqlText.includes('INSERT INTO platform_shared.company_fact')) {
          const domain = String(values[0]);
          stored.set(domain, {
            domain,
            schema_version: values[1],
            homepage_url: values[2],
            legal_name: values[3],
            country: values[4],
            trade_role: values[5],
            website_summary: values[6],
            role_emails: JSON.parse(String(values[7])),
            switchboard_phones: JSON.parse(String(values[8])),
            inquiry_form_url: values[9],
            contact_page_url: values[10],
            impressum_url: values[11],
            linkedin_company_url: values[12],
            product_categories: JSON.parse(String(values[13])),
            source_kind: values[14],
            observed_at: values[15],
            expires_at: values[16],
            ttl_days: values[17],
          });
          return 1;
        }
        if (sqlText.includes('DELETE FROM platform_shared.company_fact')) {
          return stored.delete(String(values[0])) ? 1 : 0;
        }
        return 0;
      }) as PlatformSharedSqlClient['$executeRaw'],
    };

    // Reader-only repository fails closed on write
    const readOnlyRepo = new PostgresSharedFactRepository(sqlClient);
    const rwRepo = new PostgresSharedFactRepository(sqlClient, sqlClient);
    const store = new SharedGreenFactStore(rwRepo);

    const outcome = await store.putFromRaw({
      domain: 'acme-pumps.example',
      sourceKind: 'public_web',
      legalName: 'Acme Pumps GmbH',
      country: 'DE',
      tradeRole: 'manufacturer',
      emails: ['info@acme-pumps.example', 'john.doe@acme-pumps.example'],
    });
    expect(outcome.stored).toBe(true);
    if (outcome.stored) {
      expect(outcome.fact.roleEmails).toEqual(['info@acme-pumps.example']);
      expect(outcome.strippedPiiCount).toBeGreaterThanOrEqual(1);
    }

    const fetched = await readOnlyRepo.getByDomain('acme-pumps.example');
    expect(fetched).toMatchObject({
      domain: 'acme-pumps.example',
      legalName: 'Acme Pumps GmbH',
      country: 'DE',
      tradeRole: 'manufacturer',
      roleEmails: ['info@acme-pumps.example'],
    });

    await expect(readOnlyRepo.deleteByDomain('acme-pumps.example')).rejects.toThrow(
      'ADR003_PLATFORM_WRITER_REQUIRED',
    );
    await expect(rwRepo.deleteByDomain('acme-pumps.example')).resolves.toBe(true);
    expect(await readOnlyRepo.getByDomain('acme-pumps.example')).toBeNull();
  });

  it('prunes and inspects HMAC cooldown touches via platform_shared.domain_cooldown_touch', async () => {
    const rows: Array<{ domainHmac: string; touchHmac: string; touchedAt: number }> = [];
    const sqlClient: PlatformSharedSqlClient = {
      $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sqlText = strings.join('?');
        if (sqlText.includes('DELETE FROM platform_shared.domain_cooldown_touch')) {
          const domainHmac = String(values[0]);
          const cutoff = (values[1] as Date).getTime();
          for (let i = rows.length - 1; i >= 0; i -= 1) {
            if (rows[i]!.domainHmac === domainHmac && rows[i]!.touchedAt <= cutoff) {
              rows.splice(i, 1);
            }
          }
          return 1;
        }
        if (sqlText.includes('INSERT INTO platform_shared.domain_cooldown_touch')) {
          const domainHmac = String(values[0]);
          const touchHmac = String(values[1]);
          const touchedAt = (values[2] as Date).getTime();
          const existing = rows.find(
            (r) => r.domainHmac === domainHmac && r.touchHmac === touchHmac,
          );
          if (existing) existing.touchedAt = touchedAt;
          else rows.push({ domainHmac, touchHmac, touchedAt });
          return 1;
        }
        return 0;
      }) as PlatformSharedSqlClient['$executeRaw'],
      $queryRaw: vi.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
        const domainHmac = String(values[0]);
        const windowStart = (values[1] as Date).getTime();
        return rows
          .filter((r) => r.domainHmac === domainHmac && r.touchedAt > windowStart)
          .sort((a, b) => a.touchedAt - b.touchedAt)
          .map((r) => ({ touched_at: new Date(r.touchedAt) }));
      }) as PlatformSharedSqlClient['$queryRaw'],
    };

    const service = new DomainCooldownService({
      backend: new PostgresDomainCooldownBackend(sqlClient, sqlClient),
      pepper: 'unit-test-pepper-at-least-16-bytes',
      maxDistinctWorkspaces30d: 2,
      windowDays: 30,
    });
    const now = Date.UTC(2026, 10, 26, 12, 0, 0);
    const s1 = await service.recordTouch('acme-pumps.example', 'ws-1', { nowMs: now });
    expect(s1.cooledDown).toBe(false);
    expect(s1.distinctWorkspaces30d).toBe(1);

    const s2 = await service.recordTouch('acme-pumps.example', 'ws-2', { nowMs: now + 1000 });
    expect(s2.cooledDown).toBe(true);
    expect(s2.distinctWorkspaces30d).toBe(2);
    expect(s2.retryAfterDays).toBeGreaterThan(0);
  });
});
