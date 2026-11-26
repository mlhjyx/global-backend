import { createHash, createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseRehashArgs,
  rehashOutreachGlobalSuppression,
} from '../../scripts/rehash-outreach-global-suppression.mts';

const PEPPER_NEW = '1'.repeat(64);
const PEPPER_OLD = '2'.repeat(64);

const sha256 = (email: string) => createHash('sha256').update(email).digest('hex');
const hmacDnc = (pepperHex: string, email: string) =>
  createHmac('sha256', Buffer.from(pepperHex, 'hex'))
    .update('outreach-dnc:v1:')
    .update(email, 'utf8')
    .digest('hex');

describe('parseRehashArgs', () => {
  it('parses dry-run, prune-legacy, and emails-file flags', () => {
    expect(parseRehashArgs([])).toEqual({
      dryRun: false,
      pruneLegacy: false,
      emailsFile: null,
    });
    expect(parseRehashArgs(['--dry-run', '--prune-legacy', '--emails-file', 'fixtures/dnc-emails.txt'])).toEqual({
      dryRun: true,
      pruneLegacy: true,
      emailsFile: 'fixtures/dnc-emails.txt',
    });
    expect(() => parseRehashArgs(['--emails-file'])).toThrow(/--emails-file/u);
  });
});

describe('rehashOutreachGlobalSuppression', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('migrates legacy unsalted and retired-pepper rows to active pepper and prunes legacy hashes only when requested', async () => {
    vi.stubEnv('OUTREACH_DNC_HMAC_PEPPER', PEPPER_NEW);
    vi.stubEnv('OUTREACH_DNC_HMAC_RETIRED_PEPPERS', PEPPER_OLD);

    const existing = new Set<string>([
      sha256('legacy@acme.example'),
      hmacDnc(PEPPER_OLD, 'rotated@acme.example'),
      hmacDnc(PEPPER_NEW, 'current@acme.example'),
    ]);
    const created: Array<{ emailHash: string; reason: string | null; source: string }> = [];
    const deleted: string[] = [];

    const writer = {
      outreachGlobalSuppression: {
        findUnique: vi.fn(async ({ where }: { where: { emailHash: string } }) =>
          existing.has(where.emailHash) ? { id: where.emailHash } : null,
        ),
        findFirst: vi.fn(async ({ where }: { where: { emailHash: { in: string[] } } }) => {
          const hit = where.emailHash.in.find((h) => existing.has(h));
          return hit ? { id: hit, reason: 'hard_bounce', source: 'smtp', emailHash: hit } : null;
        }),
        createMany: vi.fn(async ({ data }: { data: Array<{ emailHash: string; reason: string | null; source: string }> }) => {
          for (const row of data) {
            existing.add(row.emailHash);
            created.push(row);
          }
          return { count: data.length };
        }),
        deleteMany: vi.fn(async ({ where }: { where: { emailHash: { in: string[] } } }) => {
          let count = 0;
          for (const h of where.emailHash.in) {
            if (existing.delete(h)) {
              deleted.push(h);
              count += 1;
            }
          }
          return { count };
        }),
      },
    };

    const dry = await rehashOutreachGlobalSuppression(
      writer as never,
      [' Legacy@Acme.example ', 'rotated@acme.example', 'current@acme.example', 'absent@acme.example'],
      { dryRun: true, pruneLegacy: true },
    );
    expect(dry).toEqual({
      dryRun: true,
      candidatesChecked: 4,
      migrated: 2,
      alreadyCurrent: 1,
      prunedLegacy: 0,
    });
    expect(created).toHaveLength(0);
    expect(deleted).toHaveLength(0);

    const applied = await rehashOutreachGlobalSuppression(
      writer as never,
      [' Legacy@Acme.example ', 'rotated@acme.example', 'current@acme.example'],
      { dryRun: false, pruneLegacy: true },
    );
    expect(applied).toEqual({
      dryRun: false,
      candidatesChecked: 3,
      migrated: 2,
      alreadyCurrent: 1,
      prunedLegacy: 2,
    });
    expect(created.map((c) => c.emailHash).sort()).toEqual(
      [hmacDnc(PEPPER_NEW, 'legacy@acme.example'), hmacDnc(PEPPER_NEW, 'rotated@acme.example')].sort(),
    );
    expect(deleted.sort()).toEqual(
      [sha256('legacy@acme.example'), hmacDnc(PEPPER_OLD, 'rotated@acme.example')].sort(),
    );
  });

  it('delegates legacy deletion to optional pruneWriter so append-only platformWriter never needs DELETE privilege', async () => {
    vi.stubEnv('OUTREACH_DNC_HMAC_PEPPER', PEPPER_NEW);
    vi.stubEnv('OUTREACH_DNC_HMAC_RETIRED_PEPPERS', PEPPER_OLD);

    const existing = new Set<string>([hmacDnc(PEPPER_OLD, 'appendonly@acme.example')]);
    const appendOnlyDelete = vi.fn(async () => {
      throw new Error('42501 permission denied');
    });
    const ownerDelete = vi.fn(async ({ where }: { where: { emailHash: { in: string[] } } }) => {
      let count = 0;
      for (const h of where.emailHash.in) {
        if (existing.delete(h)) count += 1;
      }
      return { count };
    });

    const appendOnlyWriter = {
      outreachGlobalSuppression: {
        findUnique: vi.fn(async ({ where }: { where: { emailHash: string } }) =>
          existing.has(where.emailHash) ? { id: where.emailHash } : null,
        ),
        findFirst: vi.fn(async ({ where }: { where: { emailHash: { in: string[] } } }) => {
          const hit = where.emailHash.in.find((h) => existing.has(h));
          return hit ? { id: hit, reason: 'bounce', source: 'smtp', emailHash: hit } : null;
        }),
        createMany: vi.fn(async ({ data }: { data: Array<{ emailHash: string }> }) => {
          for (const row of data) existing.add(row.emailHash);
          return { count: data.length };
        }),
        deleteMany: appendOnlyDelete,
      },
    };
    const ownerPruner = {
      outreachGlobalSuppression: { deleteMany: ownerDelete },
    };

    const rehashed = await rehashOutreachGlobalSuppression(
      appendOnlyWriter as never,
      ['appendonly@acme.example'],
      { dryRun: false, pruneLegacy: false },
    );
    expect(rehashed).toMatchObject({ migrated: 1, prunedLegacy: 0 });
    expect(appendOnlyDelete).not.toHaveBeenCalled();

    const pruned = await rehashOutreachGlobalSuppression(
      appendOnlyWriter as never,
      ['appendonly@acme.example'],
      { dryRun: false, pruneLegacy: true, pruneWriter: ownerPruner as never },
    );
    expect(pruned).toMatchObject({ alreadyCurrent: 1, prunedLegacy: 1 });
    expect(appendOnlyDelete).not.toHaveBeenCalled();
    expect(ownerDelete).toHaveBeenCalledOnce();
  });
});
