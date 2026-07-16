/**
 * 收口④ verify：统一响应信封 —— 真 API + 真 dev 库，纯 HTTP 断言（无 sandbox）。
 *
 * 跑法：cd /global/backend/apps/api && pnpm build && node --import tsx scripts/verify-envelope.mts
 * 前提：本地 dev 栈（postgres :5432）+ apps/api/.env。脚本自起 API 于测试端口，结束后关掉。
 *
 * 断言面（B 读路径全信封 + 例外/错误模型）：
 *  1. /health 探针**不套**信封（无 data 键）
 *  2. GET /whoami → { data: { userId, workspaceId, roles } }
 *  3. GET /icps → { data: [...] }（无分页列表，无 page 键）
 *  4. GET /leads → { data, page: { next_cursor, has_more } }（snake_case 协议键）
 *  5. GET /events → 分页信封；事件对象本身是 envelope.schema.json 形（snake_case）
 *  6. GET /canonical-companies?limit=1 → 真实数据分页：has_more=true 时 next_cursor 可续拉且不重复
 *  7. 错误模型：404/400 → { error: { code, message } }，无 data 键
 *  8. 契约一致性：以上响应用 openapi.json 里对应操作的 response schema（ajv）校验
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const PORT = 3111;
const BASE = `http://localhost:${PORT}/api/v1`;
const HEALTH = `http://localhost:${PORT}/api/v1/health`;

let passed = 0;
function ok(name: string, cond: boolean, detail?: unknown): void {
  if (!cond) {
    console.error(`✗ ${name}`, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400));
    process.exitCode = 1;
    throw new Error(`assertion failed: ${name}`);
  }
  passed += 1;
  console.log(`✓ ${name}`);
}

function devToken(workspaceId: string): string {
  return Buffer.from(
    JSON.stringify({ sub: 'verify-envelope', workspace_id: workspaceId, roles: ['admin'] }),
    'utf8',
  ).toString('base64url');
}

async function getJson(url: string, token: string): Promise<{ status: number; body: any }> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, body: await res.json() };
}

async function waitForApi(proc: ChildProcess): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    if (proc.exitCode !== null) throw new Error(`api exited early with code ${proc.exitCode}`);
    try {
      const r = await fetch(HEALTH);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('api did not become healthy in 30s');
}

async function main(): Promise<void> {
  // ── 真实 workspace（只读发现一个有 canonical 公司的租户；断言用 HTTP 走 app_user+RLS）──
  const db = new PrismaClient();
  const row = await db.$queryRaw<{ workspace_id: string; n: bigint }[]>`
    SELECT workspace_id, count(*)::bigint AS n FROM canonical_company
    GROUP BY workspace_id ORDER BY n DESC LIMIT 1`;
  await db.$disconnect();
  if (!row.length) throw new Error('dev 库无 canonical_company——先跑一次发现链路');
  const ws = row[0].workspace_id;
  console.log(`workspace=${ws.slice(0, 8)}…（canonical 公司 ${row[0].n} 家）`);
  const token = devToken(ws);

  // ── 起真 API ────────────────────────────────────────────────────────────
  const proc = spawn('node', ['dist/main.js'], {
    cwd: resolve(import.meta.dirname, '..'),
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    await waitForApi(proc);

    // 1. /health 探针不套信封
    const health = await (await fetch(HEALTH)).json();
    ok('/health 不套信封（status=ok，无 data 键）', health.status === 'ok' && !('data' in health), health);

    // 2. /whoami 单资源信封
    const who = await getJson(`${BASE}/whoami`, token);
    ok(
      'GET /whoami → { data: { userId, workspaceId, roles } }',
      who.status === 200 && who.body.data?.workspaceId === ws && Array.isArray(who.body.data?.roles),
      who.body,
    );

    // 3. /icps 无分页列表信封
    const icps = await getJson(`${BASE}/icps`, token);
    ok(
      'GET /icps → { data: [...] } 且无 page 键',
      icps.status === 200 && Array.isArray(icps.body.data) && !('page' in icps.body),
      icps.body,
    );

    // 4. /leads 分页信封（snake_case 协议键）
    const leads = await getJson(`${BASE}/leads?limit=2`, token);
    ok(
      'GET /leads → { data, page: { next_cursor, has_more } }',
      leads.status === 200 &&
        Array.isArray(leads.body.data) &&
        leads.body.page !== undefined &&
        'next_cursor' in leads.body.page &&
        typeof leads.body.page.has_more === 'boolean',
      leads.body.page,
    );

    // 5. /events 分页信封 + 事件对象 snake_case envelope
    const events = await getJson(`${BASE}/events?limit=2`, token);
    ok(
      'GET /events → 分页信封',
      events.status === 200 && Array.isArray(events.body.data) && 'next_cursor' in (events.body.page ?? {}),
      events.body,
    );
    if (events.body.data.length) {
      const ev = events.body.data[0];
      ok(
        'GET /events 事件对象是 snake_case envelope（event_id/event_type/occurred_at）',
        typeof ev.event_id === 'string' && typeof ev.event_type === 'string' && typeof ev.occurred_at === 'string',
        Object.keys(ev),
      );
    } else {
      console.log('· 该 workspace 暂无 pull 交付事件，跳过 envelope 字段断言（分页信封已断言）');
    }

    // 6. /canonical-companies 真数据分页：续拉不重复
    const p1 = await getJson(`${BASE}/canonical-companies?limit=1`, token);
    ok(
      'GET /canonical-companies?limit=1 → 信封 + 真数据',
      p1.status === 200 && p1.body.data.length === 1 && typeof p1.body.page.has_more === 'boolean',
      p1.body.page,
    );
    if (p1.body.page.has_more) {
      const p2 = await getJson(
        `${BASE}/canonical-companies?limit=1&cursor=${encodeURIComponent(p1.body.page.next_cursor)}`,
        token,
      );
      ok(
        '游标续拉：第二页 200 且与第一页不重复',
        p2.status === 200 && p2.body.data.length === 1 && p2.body.data[0].id !== p1.body.data[0].id,
        { first: p1.body.data[0].id, second: p2.body.data?.[0]?.id },
      );
    }

    // 7. 错误模型：404 与 400 都是 { error: { code, message } } 且无 data
    const notFound = await getJson(`${BASE}/leads/00000000-0000-4000-8000-000000000000`, token);
    ok(
      '404 → { error: { code, message } } 无 data',
      notFound.status === 404 && typeof notFound.body.error?.code === 'string' && !('data' in notFound.body),
      notFound.body,
    );
    const badReq = await getJson(`${BASE}/leads/not-a-uuid`, token);
    ok(
      '400（uuid 校验失败）→ { error: { code, message } }',
      badReq.status === 400 && typeof badReq.body.error?.code === 'string',
      badReq.body,
    );

    // 8. 契约一致性：真响应过 openapi.json 的 response schema（ajv）
    const spec = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../../../packages/contracts/openapi/openapi.json'), 'utf8'),
    );
    const ajv = new Ajv({ strict: false });
    addFormats(ajv);
    // 解 $ref 用整份 spec 作为根 schema
    ajv.addSchema(spec, 'spec');
    const check = (path: string, method: string, body: unknown, name: string) => {
      const schema = spec.paths[path]?.[method]?.responses?.['200']?.content?.['application/json']?.schema;
      ok(`${name} 在契约中声明了 200 schema`, schema !== undefined);
      const valid = ajv.validate({ $ref: `spec#/paths/${path.replace(/\//g, '~1')}/${method}/responses/200/content/application~1json/schema` }, body);
      ok(`${name} 真响应通过契约 schema 校验`, valid === true, ajv.errors);
    };
    check('/api/v1/leads', 'get', leads.body, 'GET /leads');
    check('/api/v1/events', 'get', events.body, 'GET /events');
    check('/api/v1/canonical-companies', 'get', p1.body, 'GET /canonical-companies');
    check('/api/v1/whoami', 'get', who.body, 'GET /whoami');

    console.log(`\n全部通过：${passed} 断言 ✓（真 API + 真 dev 库 + 契约 ajv 校验）`);
  } finally {
    proc.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
