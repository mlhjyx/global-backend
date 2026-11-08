import { randomInt, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// P1：contact_point 四态与验证事件账（迁移 20261109120000）在迁移后的真库上验证。
// 与 company-contact-channel.postgres.spec.ts 同一套 harness 纪律：owner 连接建/删夹具；
// 业务断言以 app_user 会话执行（既非 superuser 也非 BYPASSRLS），每次尝试回滚。
const ownerUrl = process.env.CONTACT_POINT_FOUR_STATE_TEST_DATABASE_URL;
const appUrl = process.env.CONTACT_POINT_FOUR_STATE_TEST_APP_DATABASE_URL;
if (Boolean(ownerUrl) !== Boolean(appUrl)) {
  throw new Error(
    'contact_point four-state test needs both CONTACT_POINT_FOUR_STATE_TEST_DATABASE_URL and CONTACT_POINT_FOUR_STATE_TEST_APP_DATABASE_URL',
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
    throw new Error('contact_point four-state test requires a loopback test database');
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

describe.runIf(Boolean(ownerUrl && appUrl))('contact_point four-state on PostgreSQL (P1)', { timeout: 60_000 }, () => {
  let owner: PrismaClient;
  let app: PrismaClient;
  const suffix = letters(6);
  const workspaceA = randomUUID();
  const workspaceB = randomUUID();
  const companyA = randomUUID();
  const companyB = randomUUID();
  const contactA = randomUUID();
  const contactB = randomUUID();
  /** 常驻的 email 点（事件账 FK 目标；隔离/幂等测试都写它）。 */
  const pointA = randomUUID();

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

  interface RawPoint {
    workspaceId?: string;
    contactId?: string;
    type?: string;
    value?: string;
    status?: string;
    sourceType?: string | null;
    verificationState?: string;
    validSince?: Date | null;
    verificationMethod?: string | null;
    verificationProvider?: string | null;
    catchAllClass?: string | null;
    confidence?: number | null;
    domainBlindKey?: string | null;
    phoneType?: string | null;
    omitSourceType?: boolean;
  }

  const insertPoint = (tx: Prisma.TransactionClient, row: RawPoint) => {
    const sourceType = row.omitSourceType ? null : (row.sourceType === undefined ? 'impressum' : row.sourceType);
    return tx.$executeRaw`
      INSERT INTO contact_point (id, workspace_id, contact_id, type, value, status, source_type,
        verification_state, valid_since, verification_method, verification_provider, catch_all_class,
        confidence, domain_blind_key, phone_type)
      VALUES (${randomUUID()}::uuid, ${row.workspaceId ?? workspaceA}::uuid, ${row.contactId ?? contactA}::uuid,
        ${row.type ?? 'email'}, ${row.value ?? `info@${suffix}.example`}, ${row.status ?? 'UNVERIFIED'},
        ${sourceType}, ${row.verificationState ?? 'UNKNOWN'}, ${row.validSince ?? null},
        ${row.verificationMethod ?? null}, ${row.verificationProvider ?? null}, ${row.catchAllClass ?? null},
        ${row.confidence ?? null}, ${row.domainBlindKey ?? null}, ${row.phoneType ?? null})`;
  };

  interface RawEvent {
    workspaceId?: string;
    pointId?: string;
    providerKey?: string;
    method?: string;
    verdict?: string;
    requestHash?: string;
    costMicrousd?: number;
  }

  const insertEvent = (tx: Prisma.TransactionClient, row: RawEvent) =>
    tx.$executeRaw`
      INSERT INTO contact_point_verification_event (id, workspace_id, contact_point_id, attempt_no,
        provider_key, method, verdict, cost_microusd, actor_id, request_hash)
      VALUES (${randomUUID()}::uuid, ${row.workspaceId ?? workspaceA}::uuid, ${row.pointId ?? pointA}::uuid,
        1, ${row.providerKey ?? 'millionverifier'}, ${row.method ?? 'third_party_api'},
        ${row.verdict ?? 'valid'}, ${row.costMicrousd ?? 1780}, ${'reverify-sweep:test'},
        ${row.requestHash ?? 'a'.repeat(64)})`;

  beforeAll(async () => {
    owner = new PrismaClient({ datasourceUrl: ownerUrl });
    app = new PrismaClient({ datasourceUrl: appUrl });
    const [identity] = await app.$queryRaw<{ current: string; superuser: string; bypassrls: boolean }[]>`
      SELECT current_user::text AS current, current_setting('is_superuser') AS superuser,
        (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypassrls`;
    // RLS is only proven by a principal it applies to: a superuser or BYPASSRLS session passes silently.
    if (identity?.current !== 'app_user' || identity.superuser !== 'off' || identity.bypassrls !== false) {
      throw new Error('contact_point four-state test must connect the app side as app_user without RLS bypass');
    }
    await owner.$executeRaw`
      INSERT INTO canonical_company (id, workspace_id, name, domain, status, dedupe_key, updated_at) VALUES
        (${companyA}::uuid, ${workspaceA}::uuid, ${`Pumpen ${suffix} GmbH`}, ${`pumpen-${suffix}.example`},
          'NEW', ${`domain:pumpen-${suffix}.example`}, now()),
        (${companyB}::uuid, ${workspaceB}::uuid, ${`Ventile ${suffix} GmbH`}, ${`ventile-${suffix}.example`},
          'NEW', ${`domain:ventile-${suffix}.example`}, now())`;
    await owner.$executeRaw`
      INSERT INTO canonical_contact (id, workspace_id, company_id, full_name, dedupe_key) VALUES
        (${contactA}::uuid, ${workspaceA}::uuid, ${companyA}::uuid, ${`Max ${suffix}`}, ${`c:${suffix}`}),
        (${contactB}::uuid, ${workspaceB}::uuid, ${companyB}::uuid, ${`Erika ${suffix}`}, ${`c:b-${suffix}`})`;
    await owner.$executeRaw`
      INSERT INTO contact_point (id, workspace_id, contact_id, type, value, status, source_type)
      VALUES (${pointA}::uuid, ${workspaceA}::uuid, ${contactA}::uuid, 'email',
        ${`fixture@${suffix}.example`}, 'UNVERIFIED', 'impressum')`;
  });

  afterAll(async () => {
    if (!owner) return;
    try {
      // Deleting the companies removes contacts → contact points → verification events.
      await owner.$executeRaw`DELETE FROM canonical_company WHERE id IN (${companyA}::uuid, ${companyB}::uuid)`;
    } finally {
      await Promise.all([owner.$disconnect(), app?.$disconnect()]);
    }
  });

  it('四态 CHECK 与 valid_since 等价约束', async () => {
    // BLOCKED 不是四态：合规处置只能进事件账。
    expect(await failure(workspaceA, (tx) => insertPoint(tx, { verificationState: 'BLOCKED' }))).toBe('23514');
    expect(await failure(workspaceA, (tx) => insertPoint(tx, { verificationState: 'valid' }))).toBe('23514');
    // VALID ⇔ valid_since。
    expect(await failure(workspaceA, (tx) => insertPoint(tx, { verificationState: 'VALID' }))).toBe('23514');
    expect(
      await failure(workspaceA, (tx) =>
        insertPoint(tx, { verificationState: 'UNKNOWN', validSince: new Date() }),
      ),
    ).toBe('23514');
    expect(
      await failure(workspaceA, (tx) =>
        insertPoint(tx, {
          verificationState: 'VALID',
          validSince: new Date(),
          verificationMethod: 'smtp_rcpt',
          verificationProvider: 'smtp_self',
          status: 'VALID',
        }),
      ),
    ).toBeNull();
    // confidence 0–100、域盲键形状、phone_type 词表。
    expect(await failure(workspaceA, (tx) => insertPoint(tx, { confidence: 101 }))).toBe('23514');
    expect(await failure(workspaceA, (tx) => insertPoint(tx, { domainBlindKey: `acme-${suffix}.example` }))).toBe('23514');
    expect(await failure(workspaceA, (tx) => insertPoint(tx, { phoneType: 'fax' }))).toBe('23514');
    expect(
      await failure(workspaceA, (tx) =>
        insertPoint(tx, { domainBlindKey: `bi:v1:${'0'.repeat(64)}`, phoneType: 'mobile', type: 'phone', value: '+49 89 1234567' }),
      ),
    ).toBeNull();
  });

  it('source_type NOT NULL：迁移收紧后漏写即拒绝，legacy_unclassified 是合法回填值', async () => {
    expect(await failure(workspaceA, (tx) => insertPoint(tx, { omitSourceType: true }))).toBe('23502');
    expect(await failure(workspaceA, (tx) => insertPoint(tx, { sourceType: null }))).toBe('23502');
    expect(await failure(workspaceA, (tx) => insertPoint(tx, { sourceType: 'legacy_unclassified' }))).toBeNull();
    expect(await failure(workspaceA, (tx) => insertPoint(tx, { sourceType: 'made_up' }))).toBe('23514');
  });

  it('state evidence：非 UNKNOWN 态必须有 verification_method + verification_provider', async () => {
    expect(
      await failure(workspaceA, (tx) =>
        insertPoint(tx, { verificationState: 'CATCH_ALL_RISKY', catchAllClass: 'true_catch_all' }),
      ),
    ).toBe('23514');
    expect(
      await failure(workspaceA, (tx) =>
        insertPoint(tx, {
          verificationState: 'CATCH_ALL_RISKY',
          catchAllClass: 'true_catch_all',
          verificationMethod: 'smtp_rcpt',
          verificationProvider: 'smtp_self',
          status: 'RISKY',
        }),
      ),
    ).toBeNull();
    // verification_method 词表已含 third_party_api。
    expect(
      await failure(workspaceA, (tx) =>
        insertPoint(tx, {
          verificationState: 'INVALID',
          verificationMethod: 'third_party_api',
          verificationProvider: 'millionverifier',
          status: 'INVALID',
        }),
      ),
    ).toBeNull();
  });

  it('事件账：唯一幂等键 + verdict/method/cost 值域', async () => {
    // 每个 failure() 都会回滚，唯一键冲突要在**跨会话**观察：owner 先落一行（同 run 唯一 hash），
    // 再用 app_user 重复同键。hash 带随机后缀，保证同库重跑不撞上一轮的夹具。
    const hashB = `b-${suffix}-${'0'.repeat(32)}`;
    const hashC = `c-${suffix}-${'0'.repeat(32)}`;
    await owner.$executeRaw`
      INSERT INTO contact_point_verification_event (id, workspace_id, contact_point_id, attempt_no,
        provider_key, method, verdict, actor_id, request_hash)
      VALUES (${randomUUID()}::uuid, ${workspaceA}::uuid, ${pointA}::uuid, 1, 'millionverifier',
        'third_party_api', 'valid', 'reverify-sweep:test', ${hashB})`;
    expect(
      await failure(workspaceA, (tx) => insertEvent(tx, { requestHash: hashB })),
    ).toBe('23505');
    // 不同 request_hash 允许（下一次验证尝试）。
    expect(
      await failure(workspaceA, (tx) => insertEvent(tx, { requestHash: hashC })),
    ).toBeNull();
    expect(await failure(workspaceA, (tx) => insertEvent(tx, { verdict: 'maybe' }))).toBe('23514');
    expect(await failure(workspaceA, (tx) => insertEvent(tx, { method: 'sms' }))).toBe('23514');
    expect(await failure(workspaceA, (tx) => insertEvent(tx, { costMicrousd: -1 }))).toBe('23514');
  });

  it('RLS：租户隔离 + append-only（app_user 不能 UPDATE/DELETE）', async () => {
    // 本用例自己提交一行（不依赖其它用例的 owner 行）：app_user 以 A 的租户写入自己的点。
    await inWorkspace(workspaceA, (tx) => insertEvent(tx, { requestHash: `rls-${suffix}` }));
    // 事件账 RLS：以 A 的租户写 B 的 workspace_id → WITH CHECK 拒绝。
    expect(await failure(workspaceB, (tx) => insertEvent(tx, { workspaceId: workspaceA }))).toBe('42501');
    // 以 A 的租户能读到自己插入的事件。
    const visible = await inWorkspace(workspaceA, (tx) =>
      tx.$queryRaw<{ count: bigint }[]>`
        SELECT count(*)::bigint AS count FROM contact_point_verification_event
        WHERE contact_point_id = ${pointA}::uuid`,
    );
    expect(Number(visible[0]?.count ?? 0)).toBeGreaterThan(0);
    // B 看不到 A 的事件（同一 SQL，租户切到 B）。
    const hidden = await inWorkspace(workspaceB, (tx) =>
      tx.$queryRaw<{ count: bigint }[]>`
        SELECT count(*)::bigint AS count FROM contact_point_verification_event
        WHERE contact_point_id = ${pointA}::uuid`,
    );
    expect(Number(hidden[0]?.count ?? 0)).toBe(0);
    // append-only：app_user 对事件账没有 UPDATE/DELETE 权限。
    expect(
      await failure(workspaceA, (tx) =>
        tx.$executeRaw`UPDATE contact_point_verification_event SET verdict = 'invalid'`,
      ),
    ).toBe('42501');
    expect(
      await failure(workspaceA, (tx) => tx.$executeRaw`DELETE FROM contact_point_verification_event`),
    ).toBe('42501');
  });

  it('删除联系人级联清空事件账（DSR 路径）', async () => {
    const cascadeContact = randomUUID();
    const cascadePoint = randomUUID();
    await owner.$executeRaw`
      INSERT INTO canonical_contact (id, workspace_id, company_id, full_name, dedupe_key)
      VALUES (${cascadeContact}::uuid, ${workspaceA}::uuid, ${companyA}::uuid, ${`Klaus ${suffix}`}, ${`c:k-${suffix}`})`;
    await owner.$executeRaw`
      INSERT INTO contact_point (id, workspace_id, contact_id, type, value, status, source_type)
      VALUES (${cascadePoint}::uuid, ${workspaceA}::uuid, ${cascadeContact}::uuid, 'email',
        ${`k@${suffix}.example`}, 'UNVERIFIED', 'impressum')`;
    await owner.$executeRaw`
      INSERT INTO contact_point_verification_event (id, workspace_id, contact_point_id, attempt_no,
        provider_key, method, verdict, actor_id, request_hash)
      VALUES (${randomUUID()}::uuid, ${workspaceA}::uuid, ${cascadePoint}::uuid, 1, 'millionverifier',
        'third_party_api', 'valid', 'reverify-sweep:test', ${'d'.repeat(64)})`;
    await owner.$executeRaw`DELETE FROM canonical_contact WHERE id = ${cascadeContact}::uuid`;
    const [remaining] = await owner.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count FROM contact_point_verification_event
      WHERE contact_point_id = ${cascadePoint}::uuid`;
    expect(Number(remaining?.count ?? 0)).toBe(0);
  });
});
