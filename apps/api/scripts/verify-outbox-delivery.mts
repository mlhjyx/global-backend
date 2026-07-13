/**
 * 收口③ 真库 sanity（非单测）：用 dev 库验证
 * 1) integration 事件 routeEvent → outbox_delivery(saas) + published；
 * 2) 重跑幂等（skipDuplicates，不重复建行）；
 * 3) 未注册类型 → parkedAt 停靠不发布；
 * 4) EventsService（app_user + RLS）list/ack 闭环（游标=交付账本行 id）+ 跨租户 ACK 被挡；
 * 5) 端到端：LeadService.decide(accept)（app_user）→ 快照 payload（分级 RESTRICTED）→ routeEvent →
 *    GET /events 拉到 envelope → ajv 按 contracts 真契约校验（Consumer Test 的真库面）；
 *    重复 decide 幂等（不发第二条 LeadQualified）。
 * 结束后清理测试 workspace（级联删事件与交付行）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { OutboxRelayService } from '../src/relay/outbox-relay.service';
import { EventsService } from '../src/events/events.service';
import { LeadService } from '../src/lead/lead.service';
import { DataRightsService } from '../src/compliance/data-rights.service';
import { seedJurisdictionPolicy } from '../src/compliance/jurisdiction-policy.seed';

const OWNER_URL = process.env.DATABASE_URL ?? 'postgresql://global:global@localhost:5432/global_dev';
const APP_URL = process.env.APP_DATABASE_URL ?? 'postgresql://app_user:app_pw@localhost:5432/global_dev';
const WS = '99999999-9999-4999-8999-999999999999';
const WS_OTHER = '88888888-8888-4888-8888-888888888888';

const owner = new PrismaClient({ datasourceUrl: OWNER_URL });
const appDb = new PrismaClient({ datasourceUrl: APP_URL });

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
  console.log(`  ok - ${msg}`);
}

/** RLS 验证硬规矩：app 连接若是 superuser 会静默绕 RLS，全部隔离断言失效 → 直接拒跑。 */
async function guardNotSuperuser(): Promise<void> {
  const rows = await appDb.$queryRaw<Array<{ is_super: boolean }>>`
    SELECT usesuper AS is_super FROM pg_user WHERE usename = current_user`;
  if (rows[0]?.is_super) throw new Error('APP_DATABASE_URL 是 superuser——RLS 证明无效，拒跑');
}

async function cleanup(): Promise<void> {
  // canonical_company 无 workspace FK（租户隔离靠 RLS）——删 workspace 级联不到它，须显式清
  //（company 级联带走 contact/contact_point/lead/lead_decision）。outbox_event/delivery 有
  // workspace FK，随 workspace 级联删。
  await owner.canonicalCompany.deleteMany({ where: { workspaceId: { in: [WS, WS_OTHER] } } });
  await owner.workspace.deleteMany({ where: { id: { in: [WS, WS_OTHER] } } });
}

async function main() {
  delete process.env.SAAS_WEBHOOK_URL; // 只验 pull sink
  await guardNotSuperuser();
  await cleanup(); // 上次失败的残留
  await owner.workspace.create({ data: { id: WS, name: 'outbox-verify' } });
  await owner.workspace.create({ data: { id: WS_OTHER, name: 'outbox-verify-other' } });

  const svc = new OutboxRelayService({ client: { workflow: { start: async () => ({}) } } } as never, owner);

  // 1) integration 事件路由
  const ev = await owner.outboxEvent.create({
    data: { workspaceId: WS, eventType: 'LeadQualified', aggregateType: 'Lead', aggregateId: 'lead-x', payload: { snapshot_version: 1 } },
  });
  await svc.routeEvent(ev as never);
  const deliveries = await owner.outboxDelivery.findMany({ where: { eventId: ev.eventId } });
  assert(deliveries.length === 1 && deliveries[0].sink === 'saas' && deliveries[0].status === 'PENDING', 'route → 1 条 saas PENDING 交付行');
  const evAfter = await owner.outboxEvent.findUnique({ where: { id: ev.id } });
  assert(evAfter?.publishedAt instanceof Date, 'published 置位');

  // 2) 幂等重跑
  await svc.routeEvent(ev as never);
  const again = await owner.outboxDelivery.findMany({ where: { eventId: ev.eventId } });
  assert(again.length === 1, '重跑 skipDuplicates 幂等（仍 1 行）');

  // 3) 未注册类型停靠
  const bad = await owner.outboxEvent.create({
    data: { workspaceId: WS, eventType: 'NotRegisteredEvent', aggregateType: 'X', aggregateId: 'x', payload: {} },
  });
  await svc.routeEvent(bad as never);
  const badAfter = await owner.outboxEvent.findUnique({ where: { id: bad.id } });
  assert(badAfter?.parkedAt instanceof Date && badAfter.publishedAt === null, '未注册类型 parked 且未发布');

  // 4) app_user + RLS：GET /events + ACK
  const withWorkspace = async <T>(ws: string, fn: (tx: never) => Promise<T>): Promise<T> =>
    appDb.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${ws}, true)`;
      return fn(tx as never);
    });
  const events = new EventsService({ withWorkspace } as never);
  const ctx = { workspaceId: WS, userId: 'verify' } as never;
  const page = await events.list(ctx, { limit: 50 });
  assert(page.data.some((e) => e.event_id === ev.eventId), 'GET /events 可见集成事件 envelope');
  assert(!page.data.some((e) => e.event_type === 'NotRegisteredEvent'), 'parked 事件不可见');
  const ack1 = await events.ack(ctx, [ev.eventId]); // sink 缺省锁死 'saas'（F）
  assert(ack1.acked === 1, 'ACK PENDING → acked:1');
  const ack2 = await events.ack(ctx, [ev.eventId]);
  assert(ack2.acked === 0, '重复 ACK → acked:0（幂等）');
  // 跨租户 ACK/list 必须为空（RLS）
  const otherCtx = { workspaceId: WS_OTHER, userId: 'verify' } as never;
  const evB = await owner.outboxEvent.create({
    data: { workspaceId: WS, eventType: 'LeadsScored', aggregateType: 'ICP', aggregateId: 'icp-x', payload: {} },
  });
  await svc.routeEvent(evB as never);
  // 账本游标翻页（A）：nextCursor = outbox_delivery.id，limit=1 两页取全两事件、不漏不重
  const p1 = await events.list(ctx, { limit: 1 });
  assert(p1.data.length === 1 && p1.hasMore && p1.nextCursor !== null, '账本游标 page1：1 条 + hasMore + nextCursor');
  const d1 = await owner.outboxDelivery.findFirst({ where: { eventId: p1.data[0].event_id, sink: 'saas' } });
  assert(String(d1?.id) === p1.nextCursor, 'nextCursor = 交付账本行 id（非 outbox_event.id）');
  const p2 = await events.list(ctx, { limit: 50, cursor: p1.nextCursor! });
  const gotIds = [...p1.data, ...p2.data].map((e) => e.event_id);
  assert(gotIds.includes(ev.eventId) && gotIds.includes(evB.eventId) && !p2.data.some((e) => e.event_id === p1.data[0].event_id), '两页取全 ev+evB，游标后页不重复');
  const crossAck = await events.ack(otherCtx, [evB.eventId]);
  assert(crossAck.acked === 0, '跨租户 ACK 被 RLS 挡住（acked:0）');
  const crossList = await events.list(otherCtx, { limit: 50 });
  assert(!crossList.data.some((e) => e.workspace_id === WS), '跨租户 list 看不到别家事件（RLS）');

  // 5) 端到端：真 decide(accept) → 快照 payload → 契约校验（生产代码路径，app_user 连接）
  const company = await owner.canonicalCompany.create({
    data: {
      workspaceId: WS,
      name: 'Verify Pumpen GmbH',
      domain: 'verify-pumpen.example',
      country: 'DE',
      dedupeKey: 'verify-pumpen.example',
      attributes: { gleif: { lei: '529900VERIFY00000001' } },
      contacts: {
        create: [{
          workspaceId: WS,
          fullName: 'Max Verifier', // 🔴 库里有具名人，但快照 contact_refs 绝不该带出 full_name
          title: 'Head of Procurement',
          seniority: 'director',
          dedupeKey: 'max-verifier',
          contactPoints: { create: [{ workspaceId: WS, type: 'email', value: 'proc@verify-pumpen.example', status: 'VALID' }] },
        }],
      },
    },
  });
  const lead = await owner.lead.create({
    data: {
      workspaceId: WS,
      icpId: '77777777-7777-4777-8777-777777777777', // 无 ICP 行 → icp_version null（契约允许）
      canonicalCompanyId: company.id,
      fitVerdict: 'match',
      fitReasons: { reasons: ['verify'] },
      totalScore: 0.61,
      scores: { fit: 0.9, role: 0.5, intent: 0.4, dataQuality: 0.7, reachability: 0.6, engagement: 0 },
      scoreDetail: { verify: true },
      queue: 'recommended',
    },
  });
  // #72 P2：LeadService 构造现需 DataRightsService（decide 存储权利判定+审计留痕）。播种法域规则 + loadRules，
  // 否则规则空 → 引擎对 red 数据 fail-closed（DENY）令 decide(accept) 被挡。appDb 供 loadRules；logDecision 走 decide 事务 tx。
  await seedJurisdictionPolicy(owner);
  const dataRights = new DataRightsService(appDb as never);
  await dataRights.loadRules();
  const leadSvc = new LeadService({ withWorkspace } as never, dataRights);
  await leadSvc.decide(ctx, lead.id, 'accept');
  const lq = await owner.outboxEvent.findFirst({
    where: { workspaceId: WS, eventType: 'LeadQualified', aggregateId: lead.id },
  });
  assert(lq && lq.schemaVersion === 1, 'decide(accept) → LeadQualified 事件 schemaVersion=1');
  assert(lq!.privacyClassification === 'RESTRICTED', '含具名人 refs → privacyClassification=RESTRICTED（H）');
  // C：重复 accept 幂等短路——不建第二条 decision、不发第二条 LeadQualified
  await leadSvc.decide(ctx, lead.id, 'accept');
  const lqCount = await owner.outboxEvent.count({
    where: { workspaceId: WS, eventType: 'LeadQualified', aggregateId: lead.id },
  });
  const decisionCount = await owner.leadDecision.count({ where: { leadId: lead.id } });
  assert(lqCount === 1 && decisionCount === 1, '重复 decide(accept) 幂等：仍 1 事件 + 1 decision（C）');
  await svc.routeEvent(lq as never);
  const page2 = await events.list(ctx, { limit: 50, type: 'LeadQualified' });
  const envelope = page2.data.find((e) => e.aggregate_id === lead.id);
  assert(envelope, 'GET /events 拉到 decide 产出的 LeadQualified envelope');

  const schemaPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../packages/contracts/events/payloads/lead-qualified.v1.schema.json',
  );
  const ajv = new Ajv2020({ strict: false });
  addFormats(ajv as never);
  const validate = ajv.compile(JSON.parse(readFileSync(schemaPath, 'utf8')));
  assert(validate(envelope!.payload), `快照 payload 过 contracts 契约校验：${JSON.stringify(validate.errors ?? [])}`);
  const snap = envelope!.payload as {
    company_ref: { identifiers: { lei: string | null } };
    contact_refs: Array<Record<string, unknown>>;
    scores: { demand_proof: number | null; total: number | null };
    icp_version: number | null;
  };
  assert(snap.company_ref.identifiers.lei === '529900VERIFY00000001', 'LEI 从 attributes.gleif 提取');
  assert(snap.contact_refs.length === 1 && snap.contact_refs[0].has_verified_contact_point === true, 'contact_ref 带 VALID 联系点标记');
  assert(!('full_name' in snap.contact_refs[0]) && !('email' in snap.contact_refs[0]) && !Object.values(snap.contact_refs[0]).includes('Max Verifier'), '🔴 快照不含人名/邮箱（GDPR 最小化）');
  assert(snap.scores.demand_proof === null && snap.scores.total === 0.61, 'demand_proof 恒 null、total 保真');
  assert(snap.icp_version === null, 'ICP 行不存在 → icp_version null（契约允许）');

  console.log('\nALL GREEN — 真库 sanity 通过');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup().catch(() => undefined);
    await owner.$disconnect();
    await appDb.$disconnect();
  });
