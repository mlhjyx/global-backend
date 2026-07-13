import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildSyntheticRecords,
  readPatentCache,
  enqueuePatentLookup,
  refreshPatentCache,
  inventorBlindKey,
  inventorErasureKeys,
  PATENT_POLICY_DOMAIN,
  type CacheInventorRow,
  type PatentRefreshDb,
} from './patent-inventor-cache';
import { MAX_INVENTORS_PER_ASSIGNEE, type RefreshScanResult } from './bigquery-patents';
import { encryptPii, decryptPii } from '../compliance/pii-crypto';
import { toReadableName } from '../discovery/providers/bigquery-patents.provider';

// vitest.config.ts 注入固定 PII_ENCRYPTION_KEY，故 encryptPii/decryptPii 直接可用。

const row = (raw: string, norm: string, country: string, inventorPlain: string): CacheInventorRow => ({
  assigneeNameRaw: raw,
  assigneeNorm: norm,
  assigneeCountry: country,
  inventorName: encryptPii(inventorPlain),
});

describe('buildSyntheticRecords（双键分组 · 护栏③/T1）', () => {
  it('DE/US 同名 → 两条独立合成记录，各携己国别 + 各自发明人', () => {
    const rows = [
      row('Acme GmbH', 'acme', 'de', 'SCHMIDT, HANS'),
      row('Acme Inc', 'acme', 'us', 'SMITH, JOHN'),
    ];
    const recs = buildSyntheticRecords(rows);
    expect(recs).toHaveLength(2);
    const de = recs.find((r) => r.applicants[0].country === 'de');
    const us = recs.find((r) => r.applicants[0].country === 'us');
    expect(de?.inventors.map((i) => i.name)).toEqual(['SCHMIDT, HANS']); // 解密回明文
    expect(us?.inventors.map((i) => i.name)).toEqual(['SMITH, JOHN']);
    // applicants 恒单条（缓存只存独家申请人）→ provider 独家门恒过
    expect(de?.applicants).toHaveLength(1);
  });

  it('同组多行去重发明人 + 空国别归入 undefined', () => {
    const rows = [
      row('Bosch', 'bosch', '', 'MUELLER, ANNA'),
      row('Bosch', 'bosch', '', 'MUELLER, ANNA'), // 重复 → 去重
      row('Bosch', 'bosch', '', 'WEBER, KARL'),
    ];
    const recs = buildSyntheticRecords(rows);
    expect(recs).toHaveLength(1);
    expect(recs[0].applicants[0].country).toBeUndefined(); // '' → undefined
    expect(recs[0].inventors.map((i) => i.name).sort()).toEqual(['MUELLER, ANNA', 'WEBER, KARL']);
  });

  it('无发明人的组被丢弃（不产空记录）', () => {
    // 手造一行密文解密为空（'' 加密）→ 该组无发明人
    const rows: CacheInventorRow[] = [
      { assigneeNameRaw: 'Ghost', assigneeNorm: 'ghost', assigneeCountry: 'de', inventorName: encryptPii('') },
    ];
    expect(buildSyntheticRecords(rows)).toEqual([]);
  });
});

describe('readPatentCache（anchor + 过滤 + 分组）', () => {
  it('用 anchor token 做不区分大小写 contains + 未过期 + 窗口重叠谓词', async () => {
    let captured: Record<string, unknown> | undefined;
    const db = {
      patentInventorCache: {
        findMany: async (args: { where: Record<string, unknown> }) => {
          captured = args.where;
          return [row('Acme GmbH', 'acme', 'de', 'SCHMIDT, HANS')];
        },
      },
    };
    const recs = await readPatentCache(db as never, 'Acme GmbH', { fromYear: 2021, toYear: 2026 }, () => 1_700_000_000_000);
    const w = captured as { assigneeNameRaw: { contains: string; mode: string }; windowToYear: { gte: number }; expiresAt: { gt: Date } };
    expect(w.assigneeNameRaw.contains).toBe('ACME'); // anchor 取最长非法人 token（GMBH 停用）
    expect(w.assigneeNameRaw.mode).toBe('insensitive');
    expect(w.windowToYear.gte).toBe(2021);
    expect(w.expiresAt.gt).toBeInstanceOf(Date);
    expect(recs).toHaveLength(1);
    expect(recs[0].inventors[0].name).toBe('SCHMIDT, HANS');
  });

  it('无有效锚（纯法人词）→ 空、不查库', async () => {
    let called = false;
    const db = { patentInventorCache: { findMany: async () => { called = true; return []; } } };
    const recs = await readPatentCache(db as never, 'GmbH AG', { fromYear: 2021, toYear: 2026 });
    expect(recs).toEqual([]);
    expect(called).toBe(false);
  });
});

describe('inventorBlindKey / inventorErasureKeys（Art.17 擦除不变式）', () => {
  it('擦除键集（按可读名）恒含存储盲键（按原始 "Surname, Given" 名）——跨名格式收敛', () => {
    const raw = 'SCHMIDT, HANS';
    const stored = inventorBlindKey(raw);
    expect(stored).toMatch(/^bi:v1:/); // 不可逆盲索引
    const readable = toReadableName(raw); // "Hans Schmidt"
    expect(readable).toBe('Hans Schmidt');
    expect(inventorErasureKeys(readable)).toContain(stored);
  });

  it('umlaut 跨拼写：Müller / Mueller / Muller 擦除键集互相覆盖存储盲键', () => {
    const stored = inventorBlindKey('MÜLLER, HANS');
    // 擦除方即便只拿到 ASCII 转写名，也命中（over-suppress 变体）
    expect(inventorErasureKeys('Hans Mueller')).toContain(stored);
    expect(inventorErasureKeys('Hans Muller')).toContain(stored);
  });

  it('空/纯称谓名 → 擦除键集为空（不误删）', () => {
    expect(inventorErasureKeys('')).toEqual([]);
    expect(inventorErasureKeys('   ')).toEqual([]);
  });
});

// ── refreshPatentCache 内存 fake ──────────────────────────────────────────

interface FakeQueueRow {
  id: string;
  assigneeNorm: string;
  country: string;
  anchor: string;
  status: string;
  firstRequestedAt: number;
  nextRefreshAt: Date | null;
  refreshedAt?: Date | null;
}
interface FakeCacheRow {
  assigneeNorm: string;
  assigneeCountry: string;
  inventorName: string;
  inventorNameKey: string;
  assigneeNameRaw: string;
  windowFromYear: number;
  windowToYear: number;
  license: string;
  refreshedAt: Date;
  expiresAt: Date;
}

type FakeRefreshDb = PatentRefreshDb & {
  _cache: FakeCacheRow[];
  _queue: FakeQueueRow[];
  _audits: Array<Record<string, unknown>>;
  _tombstone: string[];
};

function makeFakeRefreshDb(opts?: {
  policy?: unknown;
  queue?: FakeQueueRow[];
  cache?: FakeCacheRow[];
  providerStatus?: string; // P1-1 kill-switch：默认 ENABLED（不破坏既有 refresh 测试）
  tombstone?: string[]; // P2-5：已擦除盲键集
}): FakeRefreshDb {
  const cache: FakeCacheRow[] = opts?.cache ?? [];
  const queue: FakeQueueRow[] = opts?.queue ?? [];
  const audits: Array<Record<string, unknown>> = [];
  const tombstone: string[] = opts?.tombstone ?? [];
  const providerStatus = opts?.providerStatus ?? 'ENABLED';
  const policy: unknown =
    opts?.policy === undefined
      ? { domain: PATENT_POLICY_DOMAIN, reviewStatus: 'APPROVED', allowedPurpose: ['discovery', 'enrichment'] }
      : opts.policy;
  let seq = 0;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const db: any = {
    _cache: cache,
    _queue: queue,
    _audits: audits,
    _tombstone: tombstone,
    patentInventorCache: {
      upsert: async ({ where, update, create }: any) => {
        const w = where.assigneeNorm_assigneeCountry_inventorName;
        const found = cache.find(
          (r) => r.assigneeNorm === w.assigneeNorm && r.assigneeCountry === w.assigneeCountry && r.inventorName === w.inventorName,
        );
        if (found) Object.assign(found, update);
        else cache.push({ ...w, ...create } as FakeCacheRow);
        return {};
      },
      deleteMany: async ({ where }: any) => {
        let count = 0;
        const notInKeep = where.inventorName?.notIn ? new Set<string>(where.inventorName.notIn) : null;
        for (let i = cache.length - 1; i >= 0; i--) {
          const r = cache[i];
          if (where.expiresAt?.lte && r.expiresAt <= where.expiresAt.lte) { cache.splice(i, 1); count++; continue; }
          if (where.windowToYear?.lt != null && r.windowToYear < where.windowToYear.lt) { cache.splice(i, 1); count++; continue; }
          // over-cap 清除：assigneeNorm+country 组内、密文不在 kept 集 → 删（复审 Thread3）。
          if (notInKeep && r.assigneeNorm === where.assigneeNorm && r.assigneeCountry === where.assigneeCountry && !notInKeep.has(r.inventorName)) {
            cache.splice(i, 1); count++;
          }
        }
        return { count };
      },
    },
    patentLookupRequest: {
      findMany: async ({ where }: any) => {
        const conds = where.OR as Array<Record<string, unknown>>;
        const rows = queue.filter((qr) =>
          conds.some((c) => {
            if ('status' in c) return qr.status === c.status;
            if ('nextRefreshAt' in c) {
              const lte = (c.nextRefreshAt as { lte: Date }).lte;
              return qr.nextRefreshAt != null && qr.nextRefreshAt <= lte;
            }
            return false;
          }),
        );
        return [...rows].sort((a, b) => a.firstRequestedAt - b.firstRequestedAt);
      },
      update: async ({ where, data }: any) => {
        const r = queue.find((qr) => qr.id === where.id);
        if (r) Object.assign(r, data);
        return {};
      },
    },
    patentCacheRefreshAudit: {
      create: async ({ data }: any) => {
        const a = { id: `audit-${seq++}`, ...data };
        audits.push(a);
        return a;
      },
      update: async ({ where, data }: any) => {
        const a = audits.find((x) => x.id === where.id);
        if (a) Object.assign(a, data);
        return a ?? {};
      },
    },
    sourcePolicy: {
      findUnique: async ({ where }: any) => {
        const p = policy as { domain?: string } | null;
        return p && p.domain === where.domain ? p : null;
      },
    },
    // P1-1 kill-switch：google_patents 运行状态（默认 ENABLED）。
    dataProvider: {
      findUnique: async () => ({ status: providerStatus }),
    },
    // P2-5 墓碑：按盲键返回已擦除集与请求集的交集。
    patentInventorTombstone: {
      findMany: async ({ where }: any) => {
        const wanted: string[] = where?.inventorNameKey?.in ?? [];
        return tombstone.filter((k) => wanted.includes(k)).map((inventorNameKey) => ({ inventorNameKey }));
      },
    },
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return db as FakeRefreshDb;
}

function fakeScanner(
  rows: RefreshScanResult['rows'],
  bytesScanned: number | null = 4242,
  throwErr?: Error,
): { searchInventorsForAnchorsWithStats: () => Promise<RefreshScanResult> } {
  return {
    searchInventorsForAnchorsWithStats: async () => {
      if (throwErr) throw throwErr;
      return { rows, bytesScanned };
    },
  };
}

const NOW = 1_700_000_000_000;
const q = (id: string, norm: string, country: string, anchor: string): FakeQueueRow => ({
  id,
  assigneeNorm: norm,
  country,
  anchor,
  status: 'PENDING',
  firstRequestedAt: NOW - 1000,
  nextRefreshAt: null,
});

describe('refreshPatentCache（Step 2c 编排）', () => {
  it('空队列 → SKIPPED_EMPTY，不扫 BQ，但保留期清理照跑', async () => {
    const expired: FakeCacheRow = {
      assigneeNorm: 'old', assigneeCountry: 'de', inventorName: encryptPii('X'), inventorNameKey: 'k',
      assigneeNameRaw: 'Old', windowFromYear: 2015, windowToYear: 2019, license: 'CC-BY-4.0',
      refreshedAt: new Date(NOW - 10 * 86400000), expiresAt: new Date(NOW - 86400000), // 已过期
    };
    const db = makeFakeRefreshDb({ queue: [], cache: [expired] });
    let scanned = false;
    const bq = { searchInventorsForAnchorsWithStats: async () => { scanned = true; return { rows: [], bytesScanned: 0 }; } };
    const res = await refreshPatentCache({ db, bq, now: () => NOW });
    expect(res.status).toBe('SKIPPED_EMPTY');
    expect(scanned).toBe(false); // 零 BQ 成本
    expect(res.purged).toBe(1); // 过期行被清
    expect(db._cache).toHaveLength(0);
    expect(db._audits[0].status).toBe('SKIPPED_EMPTY');
  });

  it('§8.8 未登记 → DENIED，不扫 BQ', async () => {
    const db = makeFakeRefreshDb({ policy: null, queue: [q('1', 'acme', 'de', '%ACME%')] });
    let scanned = false;
    const bq = { searchInventorsForAnchorsWithStats: async () => { scanned = true; return { rows: [], bytesScanned: 0 }; } };
    const res = await refreshPatentCache({ db, bq, now: () => NOW });
    expect(res.status).toBe('DENIED');
    expect(scanned).toBe(false);
    expect(db._audits[0].status).toBe('DENIED');
  });

  it('§8.8 SUSPENDED → DENIED，不扫 BQ', async () => {
    const db = makeFakeRefreshDb({
      policy: { domain: PATENT_POLICY_DOMAIN, reviewStatus: 'SUSPENDED', allowedPurpose: ['discovery'] },
      queue: [q('1', 'acme', 'de', '%ACME%')],
    });
    const bq = fakeScanner([]);
    const res = await refreshPatentCache({ db, bq, now: () => NOW });
    expect(res.status).toBe('DENIED');
  });

  it('allowedPurpose 不含 discovery → DENIED', async () => {
    const db = makeFakeRefreshDb({
      policy: { domain: PATENT_POLICY_DOMAIN, reviewStatus: 'APPROVED', allowedPurpose: ['enrichment'] },
      queue: [q('1', 'acme', 'de', '%ACME%')],
    });
    const res = await refreshPatentCache({ db, bq: fakeScanner([]), now: () => NOW });
    expect(res.status).toBe('DENIED');
  });

  it('happy：扫→加密 upsert→队列 CACHED/EMPTY→audit OK+bytesScanned', async () => {
    const db = makeFakeRefreshDb({
      queue: [q('1', 'acme', 'de', '%ACME%'), q('2', 'ghostco', 'us', '%GHOSTCO%')],
    });
    const bq = fakeScanner(
      [{ assigneeName: 'Acme GmbH', assigneeCountry: 'de', inventorName: 'SCHMIDT, HANS' }],
      99999,
    );
    const res = await refreshPatentCache({ db, bq, now: () => NOW });
    expect(res.status).toBe('OK');
    expect(res.rowCount).toBe(1);
    expect(res.cached).toBe(1); // acme 有结果
    expect(res.empty).toBe(1); // ghostco 无结果
    expect(res.bytesScanned).toBe(99999);
    // 落库：inventorName 加密、盲键非空
    expect(db._cache).toHaveLength(1);
    expect(db._cache[0].inventorName).toMatch(/^enc:v1:/);
    expect(decryptPii(db._cache[0].inventorName)).toBe('SCHMIDT, HANS');
    expect(db._cache[0].inventorNameKey).toMatch(/^bi:v1:/);
    expect(db._cache[0].assigneeCountry).toBe('de');
    // 队列状态机
    expect(db._queue.find((x) => x.id === '1')?.status).toBe('CACHED');
    expect(db._queue.find((x) => x.id === '2')?.status).toBe('EMPTY');
    // audit
    const ok = db._audits.find((a) => a.status === 'OK');
    expect(ok?.bytesScanned).toBe(BigInt(99999));
    expect(ok?.rowCount).toBe(1);
  });

  it('DE/US 同名 → 两行各携己国别（唯一键 country 分流）', async () => {
    const db = makeFakeRefreshDb({ queue: [q('1', 'acme', 'de', '%ACME%'), q('2', 'acme', 'us', '%ACME%')] });
    const bq = fakeScanner([
      { assigneeName: 'Acme GmbH', assigneeCountry: 'de', inventorName: 'SCHMIDT, HANS' },
      { assigneeName: 'Acme Inc', assigneeCountry: 'us', inventorName: 'SMITH, JOHN' },
    ]);
    const res = await refreshPatentCache({ db, bq, now: () => NOW });
    expect(res.status).toBe('OK');
    expect(res.rowCount).toBe(2);
    expect(db._cache.map((r) => r.assigneeCountry).sort()).toEqual(['de', 'us']);
    // 两个队列行都 CACHED（各自国别命中）
    expect(db._queue.every((x) => x.status === 'CACHED')).toBe(true);
  });

  it('幂等重跑：确定性密文 → 同唯一键 upsert，不产重复行', async () => {
    const db = makeFakeRefreshDb({ queue: [q('1', 'acme', 'de', '%ACME%')] });
    const rows = [{ assigneeName: 'Acme GmbH', assigneeCountry: 'de', inventorName: 'SCHMIDT, HANS' }];
    await refreshPatentCache({ db, bq: fakeScanner(rows), now: () => NOW });
    // 队列复位为 PENDING 模拟再次触发
    db._queue[0].status = 'PENDING';
    await refreshPatentCache({ db, bq: fakeScanner(rows), now: () => NOW });
    expect(db._cache).toHaveLength(1); // 无重复
  });

  it('BQ 扫描抛错 → audit FAILED，不穿透', async () => {
    const db = makeFakeRefreshDb({ queue: [q('1', 'acme', 'de', '%ACME%')] });
    const bq = fakeScanner([], null, new Error('quota exceeded'));
    const res = await refreshPatentCache({ db, bq, now: () => NOW });
    expect(res.status).toBe('FAILED');
    expect(db._audits.some((a) => a.status === 'FAILED')).toBe(true);
  });
});

// ── Codex PR #93 复审 7 findings 回归 ──────────────────────────────────────
describe('refreshPatentCache · Codex PR #93 复审加固', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('P1-1 kill-switch：provider DISABLED → DISABLED，绝不扫 BQ，但保留期清理照跑、队列不动', async () => {
    const expired: FakeCacheRow = {
      assigneeNorm: 'old', assigneeCountry: 'de', inventorName: encryptPii('X'), inventorNameKey: 'k',
      assigneeNameRaw: 'Old', windowFromYear: 2015, windowToYear: 2019, license: 'CC-BY-4.0',
      refreshedAt: new Date(NOW - 10 * 86400000), expiresAt: new Date(NOW - 86400000), // 已过期
    };
    const db = makeFakeRefreshDb({ queue: [q('1', 'acme', 'de', '%ACME%')], cache: [expired], providerStatus: 'DISABLED' });
    let scanned = false;
    const bq = { searchInventorsForAnchorsWithStats: async () => { scanned = true; return { rows: [], bytesScanned: 0, scanned: true }; } };
    const res = await refreshPatentCache({ db, bq, now: () => NOW });
    expect(res.status).toBe('DISABLED');
    expect(scanned).toBe(false); // 🔴 未签 LIA/DPIA 绝不物化 PII
    expect(res.purged).toBe(1); // 保留期清理不受 kill-switch 影响（GDPR 存储限制）
    expect(db._queue[0].status).toBe('PENDING'); // 队列状态不动
    expect(db._audits.some((a) => a.status === 'DISABLED')).toBe(true);
  });

  it('P1-2：宽锚 %APPLE% 溜进的无关 assignee（Pineapple/Applegate）不落库，只存排队身份 apple', async () => {
    const db = makeFakeRefreshDb({ queue: [q('1', 'apple', 'us', '%APPLE%')] });
    const bq = fakeScanner([
      { assigneeName: 'Apple Inc', assigneeCountry: 'us', inventorName: 'SMITH, JOHN' },
      { assigneeName: 'Pineapple Foods Ltd', assigneeCountry: 'us', inventorName: 'DOE, JANE' },
      { assigneeName: 'Applegate LLC', assigneeCountry: 'us', inventorName: 'ROE, RICH' },
    ]);
    const res = await refreshPatentCache({ db, bq, now: () => NOW });
    expect(res.status).toBe('OK');
    expect(res.rowCount).toBe(1);
    expect(db._cache).toHaveLength(1);
    expect(db._cache[0].assigneeNorm).toBe('apple');
    expect(decryptPii(db._cache[0].inventorName)).toBe('SMITH, JOHN');
  });

  it('P2-3：PATENT_CACHE_TTL_DAYS>180 → expiresAt 夹到 180d 硬顶（不超期保留 PII）', async () => {
    vi.stubEnv('PATENT_CACHE_TTL_DAYS', '365');
    const db = makeFakeRefreshDb({ queue: [q('1', 'acme', 'de', '%ACME%')] });
    const bq = fakeScanner([{ assigneeName: 'Acme GmbH', assigneeCountry: 'de', inventorName: 'SCHMIDT, HANS' }]);
    const res = await refreshPatentCache({ db, bq, now: () => NOW });
    expect(res.status).toBe('OK');
    expect(db._cache[0].expiresAt.getTime()).toBe(NOW + 180 * 86400000); // 180d，非 365d
  });

  it('P2-4：BQ 未扫（scanned:false）→ SKIPPED_NOSCAN，队列留 PENDING（不误标 EMPTY 冷冻数月）', async () => {
    const db = makeFakeRefreshDb({ queue: [q('1', 'acme', 'de', '%ACME%')] });
    const bq = { searchInventorsForAnchorsWithStats: async () => ({ rows: [], bytesScanned: null, scanned: false }) };
    const res = await refreshPatentCache({ db, bq, now: () => NOW });
    expect(res.status).toBe('SKIPPED_NOSCAN');
    expect(db._queue[0].status).toBe('PENDING'); // 🔴 不标 EMPTY
    expect(db._cache).toHaveLength(0);
    expect(db._audits.some((a) => a.status === 'SKIPPED_NOSCAN')).toBe(true);
  });

  it('P2-5 Art.17 墓碑：被擦除人（墓碑命中）绝不重物化，同 assignee 其余发明人照落', async () => {
    const erasedKey = inventorBlindKey('MUELLER, ANNA'); // 被擦除人盲键
    const db = makeFakeRefreshDb({ queue: [q('1', 'acme', 'de', '%ACME%')], tombstone: [erasedKey] });
    const bq = fakeScanner([
      { assigneeName: 'Acme GmbH', assigneeCountry: 'de', inventorName: 'MUELLER, ANNA' }, // 被擦除 → 跳过
      { assigneeName: 'Acme GmbH', assigneeCountry: 'de', inventorName: 'SCHMIDT, HANS' }, // 正常 → 落
    ]);
    const res = await refreshPatentCache({ db, bq, now: () => NOW });
    expect(res.status).toBe('OK');
    expect(res.rowCount).toBe(1);
    expect(db._cache).toHaveLength(1);
    expect(decryptPii(db._cache[0].inventorName)).toBe('SCHMIDT, HANS');
    expect(db._cache.some((r) => r.inventorNameKey === erasedKey)).toBe(false);
  });

  it('P2-6：每 (assigneeNorm,country) cap 到 MAX_INVENTORS_PER_ASSIGNEE（多产 assignee 不超存 PII）', async () => {
    const db = makeFakeRefreshDb({ queue: [q('1', 'acme', 'de', '%ACME%')] });
    const rows = Array.from({ length: MAX_INVENTORS_PER_ASSIGNEE + 10 }, (_, i) => ({
      assigneeName: 'Acme GmbH', assigneeCountry: 'de', inventorName: `INV, NR${String(i).padStart(3, '0')}`,
    }));
    const res = await refreshPatentCache({ db, bq: fakeScanner(rows), now: () => NOW });
    expect(res.status).toBe('OK');
    expect(res.rowCount).toBe(MAX_INVENTORS_PER_ASSIGNEE);
    expect(db._cache).toHaveLength(MAX_INVENTORS_PER_ASSIGNEE);
  });

  it('P2-7 preflight：PII_ENCRYPTION_KEY 缺 → FAILED，扫描前拦下（绝不扫 BQ 烧配额）', async () => {
    vi.stubEnv('PII_ENCRYPTION_KEY', '');
    const db = makeFakeRefreshDb({ queue: [q('1', 'acme', 'de', '%ACME%')] });
    let scanned = false;
    const bq = { searchInventorsForAnchorsWithStats: async () => { scanned = true; return { rows: [], bytesScanned: 0, scanned: true }; } };
    const res = await refreshPatentCache({ db, bq, now: () => NOW });
    expect(res.status).toBe('FAILED');
    expect(scanned).toBe(false);
    expect(db._audits.some((a) => a.status === 'FAILED')).toBe(true);
  });

  it('P2-7 wrap：扫描成功但 upsert 抛错 → audit FAILED（不卡 RUNNING、不留悬挂）', async () => {
    const db = makeFakeRefreshDb({ queue: [q('1', 'acme', 'de', '%ACME%')] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).patentInventorCache.upsert = async () => { throw new Error('boom'); };
    const bq = fakeScanner([{ assigneeName: 'Acme GmbH', assigneeCountry: 'de', inventorName: 'SCHMIDT, HANS' }]);
    const res = await refreshPatentCache({ db, bq, now: () => NOW });
    expect(res.status).toBe('FAILED');
    expect(db._audits.some((a) => a.status === 'FAILED')).toBe(true);
    expect(db._audits.some((a) => a.status === 'RUNNING' && !a.finishedAt)).toBe(false); // 无悬挂 RUNNING
  });

  it('P2-7 wrap（复审 HIGH）：墓碑 findMany 抛错（如 rolling deploy 表未及应用）→ audit FAILED，不卡 RUNNING、不重扫', async () => {
    const db = makeFakeRefreshDb({ queue: [q('1', 'acme', 'de', '%ACME%')] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).patentInventorTombstone.findMany = async () => { throw new Error('relation "patent_inventor_tombstone" does not exist'); };
    const bq = fakeScanner([{ assigneeName: 'Acme GmbH', assigneeCountry: 'de', inventorName: 'SCHMIDT, HANS' }]);
    const res = await refreshPatentCache({ db, bq, now: () => NOW });
    expect(res.status).toBe('FAILED'); // 🔴 扫描后下游抛错也 graceful FAILED（不逃逸令 Temporal 重扫）
    expect(db._audits.some((a) => a.status === 'FAILED')).toBe(true);
    expect(db._audits.some((a) => a.status === 'RUNNING' && !a.finishedAt)).toBe(false);
    expect(db._cache).toHaveLength(0);
  });

  it('复审 Thread0（国别作用域）：queued Acme/de → 同归一名冲突国别 Acme/us 不落库', async () => {
    const db = makeFakeRefreshDb({ queue: [q('1', 'acme', 'de', '%ACME%')] });
    const bq = fakeScanner([
      { assigneeName: 'Acme GmbH', assigneeCountry: 'de', inventorName: 'SCHMIDT, HANS' },
      { assigneeName: 'Acme Inc', assigneeCountry: 'us', inventorName: 'SMITH, JOHN' }, // 冲突国别、从未排队 → 不落
    ]);
    const res = await refreshPatentCache({ db, bq, now: () => NOW });
    expect(res.status).toBe('OK');
    expect(db._cache).toHaveLength(1);
    expect(db._cache[0].assigneeCountry).toBe('de');
    expect(decryptPii(db._cache[0].inventorName)).toBe('SCHMIDT, HANS');
  });

  it('复审 Thread3（over-cap 清除）：刷新用当前 capped 集替换该组缓存，陈旧/超额行不驻留 TTL', async () => {
    const stale = (inv: string): FakeCacheRow => ({
      assigneeNorm: 'acme', assigneeCountry: 'de', inventorName: encryptPii(inv), inventorNameKey: inventorBlindKey(inv),
      assigneeNameRaw: 'Acme GmbH', windowFromYear: 2021, windowToYear: 2025, license: 'CC-BY-4.0',
      refreshedAt: new Date(NOW - 86400000), expiresAt: new Date(NOW + 90 * 86400000), // 未过期
    });
    const db = makeFakeRefreshDb({ queue: [q('1', 'acme', 'de', '%ACME%')], cache: [stale('OLD, ONE'), stale('OLD, TWO')] });
    const bq = fakeScanner([{ assigneeName: 'Acme GmbH', assigneeCountry: 'de', inventorName: 'FRESH, ONLY' }]);
    const res = await refreshPatentCache({ db, bq, now: () => NOW });
    expect(res.status).toBe('OK');
    const names = db._cache.filter((r) => r.assigneeNorm === 'acme').map((r) => decryptPii(r.inventorName)).sort();
    expect(names).toEqual(['FRESH, ONLY']); // 🔴 旧两行被清，只余当前刷新集（cap 真正约束存量 PII）
  });
});

describe('enqueuePatentLookup（Step 6 队列）', () => {
  it('有效公司 → upsert PENDING（anchor + 归一名 + 国别）', async () => {
    const rows: Array<Record<string, unknown>> = [];
    const db = {
      patentLookupRequest: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        upsert: async ({ create }: any) => { rows.push(create); return {}; },
      },
    };
    const r = await enqueuePatentLookup(db as never, { companyName: 'Acme GmbH', country: 'DE' });
    expect(r.enqueued).toBe(true);
    expect(rows[0].assigneeNorm).toBe('acme');
    expect(rows[0].country).toBe('de');
    expect(rows[0].anchor).toBe('%ACME%');
    expect(rows[0].status).toBe('PENDING');
  });

  it('无有效锚（纯法人词）→ no-op', async () => {
    let called = false;
    const db = { patentLookupRequest: { upsert: async () => { called = true; return {}; } } };
    const r = await enqueuePatentLookup(db as never, { companyName: 'GmbH' });
    expect(r.enqueued).toBe(false);
    expect(called).toBe(false);
  });
});
