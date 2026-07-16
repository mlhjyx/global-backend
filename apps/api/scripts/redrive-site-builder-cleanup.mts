import 'dotenv/config';
import { Client, Connection, WorkflowNotFoundError } from '@temporalio/client';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  CleanupExecutionStatus,
  assertAssetCleanupRedrivable,
  validateAssetCleanupRedriveEvent,
} from '../src/temporal/asset-cleanup.redrive';

const [workspaceId, eventId] = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
if (!workspaceId || !eventId) {
  throw new Error(
    'usage: node --import tsx scripts/redrive-site-builder-cleanup.mts <workspaceId> <eventId>',
  );
}
const temporalAddress = process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233';
const prisma = new PrismaService();
const connection = await Connection.connect({ address: temporalAddress });
const client = new Client({
  connection,
  namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
});

await prisma.$connect();
try {
  const event = await prisma.withWorkspace(workspaceId, (tx) =>
    tx.outboxEvent.findUnique({
      where: { eventId },
      select: {
        eventId: true,
        workspaceId: true,
        eventType: true,
        schemaVersion: true,
        aggregateType: true,
        aggregateId: true,
        payload: true,
        publishedAt: true,
        parkedAt: true,
      },
    }),
  );
  if (!event) throw new Error('cleanup event is not visible in the requested workspace');
  const command = validateAssetCleanupRedriveEvent(event);

  let status: CleanupExecutionStatus;
  try {
    const description = await client.workflow.getHandle(eventId).describe();
    status = description.status.name as CleanupExecutionStatus;
  } catch (error) {
    if (!(error instanceof WorkflowNotFoundError)) throw error;
    status = 'NOT_FOUND';
  }
  assertAssetCleanupRedrivable(status);

  const moved = await prisma.withWorkspace(workspaceId, (tx) =>
    tx.outboxEvent.updateMany({
      where: {
        eventId,
        workspaceId,
        eventType: 'AssetObjectCleanupRequested',
      },
      data: { publishedAt: null, parkedAt: null },
    }),
  );
  if (moved.count !== 1) throw new Error('cleanup event changed before redrive');

  console.log(
    JSON.stringify({
      action: 'asset_cleanup_redrive_queued',
      eventId: command.eventId,
      workspaceId: command.workspaceId,
      objectClass: command.objectClass,
      previousStatus: status,
    }),
  );
} finally {
  await prisma.$disconnect();
  await connection.close();
}
