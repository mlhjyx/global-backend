import 'dotenv/config';
import { Client, Connection, WorkflowNotFoundError } from '@temporalio/client';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  CleanupExecutionStatus,
  queueAssetCleanupRedrive,
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
  const { command, previousStatus: status } = await queueAssetCleanupRedrive({
    prisma,
    workspaceId,
    eventId,
    executionStatus: async () => {
      try {
        const description = await client.workflow.getHandle(eventId).describe();
        return description.status.name as CleanupExecutionStatus;
      } catch (error) {
        if (!(error instanceof WorkflowNotFoundError)) throw error;
        return 'NOT_FOUND';
      }
    },
  });

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
