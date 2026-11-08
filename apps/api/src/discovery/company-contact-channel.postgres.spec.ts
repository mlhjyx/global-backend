import { randomInt, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upsertCompanyContactChannels } from './company-contact-channel';

// Explicitly opted-in, disposable and migrated PostgreSQL only（与 company-contact-point.postgres.spec.ts
// 同一套 harness 纪律）：owner 连接（superuser，绕过 RLS）建/删夹具；所有业务断言以 app_user 会话执行，
// 且必须是既非 superuser 也非 BYPASSRLS 的会话。只使用合成的 `.example` 数据。
const ownerUrl = process.env.COMPANY_CONTACT_CHANNEL_TEST_DATABASE_URL;
const appUrl = process.env.COMPANY_CONTACT_CHANNEL_TEST_APP_DATABASE_URL;
if (Boolean(ownerUrl) !== Boolean(appUrl)) {
  throw new Error(
    'company_contact_channel test needs both COMPANY_CONTACT_CHANNEL_TEST_DATABASE_URL and COMPANY_CONTACT_CHANNEL_TEST_APP_DATABASE_URL',
  );
}
for (const value of [ownerUrl, appUrl]) {
  if (!value) continue;
  const url = new URL(value);
  if (
    url.protocol !== 'postgresql:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/global_test' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('company_contact_channel test requires a loopback test database');
  }
}

/** The SQLSTATE PostgreSQL raised through a Prisma raw query, or null. */
function sqlState(error: unknown): string | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2010') return null;
  const code = (error.meta as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : null;
}

/** Lower-case letters only, so no fixture value collides with CHECK regexes by accident. */
function letters(count: number): string {
  return Array.from({ length: count }, () => String.fromCharCode(97 + randomInt(26))).join('');
}

interface ChannelRow {
  channel: string;
  value: string;
  emailType: string | null;
  dataClass: string;
  status: string;
  sourceUrl: string | null;
  updatedBy: string | null;
}

describe.runIf(Boolean(ownerUrl && appUrl))('company_contact_channel on PostgreSQL (A4)', { timeout: 60_000 }, () => {
  // Created only when the suite runs: collecting a skipped suite still executes this body.
  let owner: PrismaClient;
  let app: PrismaClient;
  const suffix = letters(6);
  const workspaceA = randomUUID();
  const workspaceB = randomUUID();
  const companyA = randomUUID();
  const companyB = randomUUID();
  const cascadeCompany = randomUUID();
  const seenAt = new Date('2026-11-08T09:00:00.000Z');
  const laterAt = new Date('2026-11-09T09:00:00.000Z');

  interface RawChannel {
    workspaceId: string;
    companyId: string;
    channel?: string;
    value?: string;
    emailType?: string | null;
    status?: string;
    dataClass?: string;
    sourceType?: string;
    sourceUrl?: string | null;
    updatedBy?: string | null;
  }

  const insertRaw = (tx: Prisma.TransactionClient, row: RawChannel) => tx.$executeRaw`
    INSERT INTO company_contact_channel (id, workspace_id, company_id, channel, value, email_type, status,
      data_class, source_type, source_url, updated_by, last_seen_at)
    VALUES (${randomUUID()}::uuid, ${row.workspaceId}::uuid, ${row.companyId}::uuid,
      ${row.channel ?? 'email'}, ${row.value ?? `info@${suffix}.example`}, ${row.emailType === undefined ? 'role' : row.emailType},
      ${row.status ?? 'UNVERIFIED'}, ${row.dataClass ?? 'amber'}, ${row.sourceType ?? 'impressum'},
      ${row.sourceUrl ?? null}, ${row.updatedBy ?? null}, now())`;

  const inWorkspace = <T>(workspace: string | null, work: (tx: Prisma.TransactionClient) => Promise<T>) =>
    app.$transaction(
      async (tx) => {
        if (workspace) await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspace}, true)`;
        return work(tx);
      },
      { timeout: 20_000 },
    );

  class RolledBack extends Error {}
  /** Runs `work` as app_user in `workspace`, always rolls it back, and returns the SQLSTATE it raised. */
  const failure = async (
    workspace: string | null,
    work: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ): Promise<string | null> => {
    try {
      await inWorkspace(workspace, async (tx) => {
        await work(tx);
        throw new RolledBack();
      });
    } catch (error) {
      return error instanceof RolledBack ? null : sqlState(error) ?? 'other error';
    }
    return null;
  };

  const channels = (workspace: string, companyId: string): Promise<ChannelRow[]> =>
    inWorkspace(workspace, (tx) =>
      tx.companyContactChannel.findMany({
        where: { companyId },
        orderBy: [{ channel: 'asc' }, { value: 'asc' }],
        select: { channel: true, value: true, emailType: true, dataClass: true, status: true, sourceUrl: true, updatedBy: true },
      }),
    );

  beforeAll(async () => {
    owner = new PrismaClient({ datasourceUrl: ownerUrl });
    app = new PrismaClient({ datasourceUrl: appUrl });
    const [identity] = await app.$queryRaw<{ current: string; superuser: string; bypassrls: boolean }[]>`
      SELECT current_user::text AS current, current_setting('is_superuser') AS superuser,
        (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypassrls`;
    // RLS is only proven by a principal it applies to: a superuser or BYPASSRLS session passes silently.
    if (identity?.current !== 'app_user' || identity.superuser !== 'off' || identity.bypassrls !== false) {
      throw new Error('company_contact_channel test must connect the app side as app_user without RLS bypass');
    }
    await owner.$executeRaw`
      INSERT INTO canonical_company (id, workspace_id, name, domain, status, dedupe_key, updated_at) VALUES
        (${companyA}::uuid, ${workspaceA}::uuid, ${`Pumpen ${suffix} GmbH`}, ${`pumpen-${suffix}.example`},
          'NEW', ${`domain:pumpen-${suffix}.example`}, now()),
        (${companyB}::uuid, ${workspaceB}::uuid, ${`Ventile ${suffix} GmbH`}, ${`ventile-${suffix}.example`},
          'NEW', ${`domain:ventile-${suffix}.example`}, now()),
        (${cascadeCompany}::uuid, ${workspaceA}::uuid, ${`Armaturen ${suffix} GmbH`}, ${`armaturen-${suffix}.example`},
          'NEW', ${`domain:armaturen-${suffix}.example`}, now())`;
  });

  afterAll(async () => {
    if (!owner) return;
    try {
      // Deleting the companies removes their channels through the composite foreign key.
      await owner.$executeRaw`
        DELETE FROM canonical_company WHERE id IN (${companyA}::uuid, ${companyB}::uuid, ${cascadeCompany}::uuid)`;
    } finally {
      await Promise.all([owner.$disconnect(), app?.$disconnect()]);
    }
  });

  it('production writer persists role email/phone/form as UNVERIFIED and only advances last_seen on re-observation', async () => {
    const channelsInput = [
      { channel: 'email' as const, value: `Info@Pumpen-${suffix}.example`, emailType: 'role' as const, sourceType: 'impressum' as const, sourceUrl: `https://pumpen-${suffix}.example/impressum`, robotsStatus: 'allowed' as const },
      { channel: 'phone' as const, value: '+49 89 1234567', sourceType: 'impressum' as const },
      { channel: 'form_url' as const, value: `https://pumpen-${suffix}.example/kontakt`, sourceType: 'contact_page' as const },
    ];
    await inWorkspace(workspaceA, (tx) =>
      upsertCompanyContactChannels(tx, { workspaceId: workspaceA, companyId: companyA, seenAt, channels: channelsInput }),
    );
    const rows = await channels(workspaceA, companyA);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ channel: 'email', value: `info@pumpen-${suffix}.example`, emailType: 'role', dataClass: 'amber', status: 'UNVERIFIED' });
    expect(rows[1]).toMatchObject({ channel: 'form_url', dataClass: 'green', emailType: null });
    expect(rows[2]).toMatchObject({ channel: 'phone', dataClass: 'green', emailType: null });

    // 重复观测：写同值 + 新 sourceUrl → 仍 3 行，last_seen 前进、状态不被自动化改写。
    await inWorkspace(workspaceA, (tx) =>
      upsertCompanyContactChannels(tx, { workspaceId: workspaceA, companyId: companyA, seenAt: laterAt, channels: channelsInput }),
    );
    const again = await inWorkspace(workspaceA, (tx) =>
      tx.companyContactChannel.findMany({ where: { companyId: companyA }, select: { status: true, firstSeenAt: true, lastSeenAt: true } }),
    );
    expect(again).toHaveLength(3);
    for (const row of again) {
      expect(row.status).toBe('UNVERIFIED');
      expect(row.firstSeenAt.getTime()).toBe(seenAt.getTime());
      expect(row.lastSeenAt.getTime()).toBe(laterAt.getTime());
    }
  });

  it('CHECK constraints reject the forbidden shapes as app_user', async () => {
    // personal 邮箱不得进公司层（具名人只属于联系人层）。
    expect(await failure(workspaceA, (tx) => insertRaw(tx, { workspaceId: workspaceA, companyId: companyA, value: `max@${suffix}.example`, emailType: 'personal' }))).toBe('23514');
    // email 不得标 green；phone/form_url 不得 amber。
    expect(await failure(workspaceA, (tx) => insertRaw(tx, { workspaceId: workspaceA, companyId: companyA, dataClass: 'green' }))).toBe('23514');
    expect(await failure(workspaceA, (tx) => insertRaw(tx, { workspaceId: workspaceA, companyId: companyA, channel: 'phone', value: '+49 89 1234567', emailType: null, dataClass: 'amber' }))).toBe('23514');
    // 形状：非法电话 / 带查询串的表单 URL / 带空白的 source_url。
    expect(await failure(workspaceA, (tx) => insertRaw(tx, { workspaceId: workspaceA, companyId: companyA, channel: 'phone', value: 'call-us!', emailType: null, dataClass: 'green' }))).toBe('23514');
    expect(await failure(workspaceA, (tx) => insertRaw(tx, { workspaceId: workspaceA, companyId: companyA, channel: 'form_url', value: `https://pumpen-${suffix}.example/k?x=1`, emailType: null, dataClass: 'green' }))).toBe('23514');
    expect(await failure(workspaceA, (tx) => insertRaw(tx, { workspaceId: workspaceA, companyId: companyA, sourceUrl: 'https://a.example/imp ress' }))).toBe('23514');
    // VALID 只能人工确认：缺 updated_by 拒绝，带 updated_by 放行。
    expect(await failure(workspaceA, (tx) => insertRaw(tx, { workspaceId: workspaceA, companyId: companyA, status: 'VALID' }))).toBe('23514');
    expect(await failure(workspaceA, (tx) => insertRaw(tx, { workspaceId: workspaceA, companyId: companyA, status: 'VALID', updatedBy: 'ops@example' }))).toBeNull();
  });

  it('identity key makes (workspace, company, channel, value) unique', async () => {
    await inWorkspace(workspaceA, (tx) => insertRaw(tx, { workspaceId: workspaceA, companyId: companyA, value: `dup@${suffix}.example` }));
    expect(await failure(workspaceA, (tx) => insertRaw(tx, { workspaceId: workspaceA, companyId: companyA, value: `dup@${suffix}.example` }))).toBe('23505');
  });

  it('RLS isolates tenants for reads and rejects cross-workspace rows', async () => {
    // workspace B 看不到 A 的公司渠道。
    expect(await channels(workspaceB, companyA)).toHaveLength(0);
    // 以 workspace A 的租户写 B 公司的渠道：复合 FK (A, companyB) 不存在，插入必须失败
    // （Prisma 模型层为 P2003，无 SQLSTATE；只要不是 RolledBack 成功即证明被拒）。
    const crossWrite = await failure(workspaceA, (tx) =>
      upsertCompanyContactChannels(tx, {
        workspaceId: workspaceA,
        companyId: companyB,
        channels: [{ channel: 'email', value: `info@ventile-${suffix}.example`, emailType: 'role', sourceType: 'impressum' }],
      }),
    );
    expect(crossWrite).not.toBeNull();
    // 直接 SQL 以 B 的租户写 A 的 workspace_id：WITH CHECK 拒绝（42501）。
    expect(await failure(workspaceB, (tx) => insertRaw(tx, { workspaceId: workspaceA, companyId: companyA, value: `evil@${suffix}.example` }))).toBe('42501');
  });

  it('deleting the company cascades its channels', async () => {
    await inWorkspace(workspaceA, (tx) =>
      upsertCompanyContactChannels(tx, {
        workspaceId: workspaceA,
        companyId: cascadeCompany,
        seenAt,
        channels: [{ channel: 'email', value: `info@armaturen-${suffix}.example`, emailType: 'role', sourceType: 'impressum' }],
      }),
    );
    expect(await channels(workspaceA, cascadeCompany)).toHaveLength(1);
    await owner.$executeRaw`DELETE FROM canonical_company WHERE id = ${cascadeCompany}::uuid`;
    expect(await channels(workspaceA, cascadeCompany)).toHaveLength(0);
  });
});
