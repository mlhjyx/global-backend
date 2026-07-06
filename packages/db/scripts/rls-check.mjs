// Proves tenant isolation end-to-end:
//   - seed two workspaces + one outbox event each (as owner, which is exempt)
//   - as the non-superuser app_user, a WS-A-scoped tx sees only WS-A's rows
//   - a WS-B-scoped tx sees only WS-B's rows
//   - with no workspace context, nothing is visible
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const OWNER_URL = process.env.DATABASE_URL;
const APP_URL = process.env.APP_DATABASE_URL;

const scoped = (client, workspaceId, fn) =>
  client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`;
    return fn(tx);
  });

async function main() {
  const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  const app = new PrismaClient({ datasources: { db: { url: APP_URL } } });

  const wsAId = randomUUID();
  const wsBId = randomUUID();

  // Seed as owner (RLS-exempt).
  await owner.workspace.create({ data: { id: wsAId, name: 'WS-A' } });
  await owner.workspace.create({ data: { id: wsBId, name: 'WS-B' } });
  await owner.outboxEvent.create({
    data: { workspaceId: wsAId, eventType: 'Seed', aggregateType: 'Test', aggregateId: 'a', payload: {} },
  });
  await owner.outboxEvent.create({
    data: { workspaceId: wsBId, eventType: 'Seed', aggregateType: 'Test', aggregateId: 'b', payload: {} },
  });

  // Read as app_user (subject to RLS).
  const seenA = await scoped(app, wsAId, (tx) => tx.outboxEvent.findMany());
  const seenB = await scoped(app, wsBId, (tx) => tx.outboxEvent.findMany());
  const seenNone = await app.outboxEvent.findMany(); // no tenant context

  console.log('WS-A context sees workspace_ids:', seenA.map((e) => e.workspaceId));
  console.log('WS-B context sees workspace_ids:', seenB.map((e) => e.workspaceId));
  console.log('no-context sees:', seenNone.length, 'rows');

  const pass =
    seenA.length === 1 && seenA[0].workspaceId === wsAId &&
    seenB.length === 1 && seenB[0].workspaceId === wsBId &&
    seenNone.length === 0;

  // Cleanup (cascade removes outbox events).
  await owner.workspace.delete({ where: { id: wsAId } });
  await owner.workspace.delete({ where: { id: wsBId } });
  await owner.$disconnect();
  await app.$disconnect();

  console.log(pass ? '\nRLS ISOLATION: PASS ✅' : '\nRLS ISOLATION: FAIL ❌');
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
