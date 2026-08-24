import type { PersonalArtifactCleanupService } from '../durable-results/artifact/personal-artifact-cleanup.contract';

export interface PersonalArtifactCleanupActivityService {
  cleanup: PersonalArtifactCleanupService['cleanup'];
}

const TRANSIENT_PRISMA_NAMES = new Set([
  'PrismaClientInitializationError',
  'PrismaClientRustPanicError',
  'PrismaClientUnknownRequestError',
]);
const TRANSIENT_PRISMA_CODES = new Set([
  'P1001',
  'P1002',
  'P1008',
  'P1017',
  'P2024',
  'P2034',
]);

function transientPersistenceFailure(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const source = error as Readonly<{ name?: unknown; code?: unknown }>;
  return (
    (typeof source.name === 'string' && TRANSIENT_PRISMA_NAMES.has(source.name)) ||
    (typeof source.code === 'string' && TRANSIENT_PRISMA_CODES.has(source.code))
  );
}

export function createPersonalArtifactCleanupActivities(deps: {
  readonly service: PersonalArtifactCleanupActivityService;
}) {
  return {
    async cleanupPersonalArtifact(input: Readonly<{
      workspaceId: string;
      deletionRequestId: string;
    }>) {
      let result: Awaited<ReturnType<PersonalArtifactCleanupService['cleanup']>>;
      try {
        result = await deps.service.cleanup(input);
      } catch (error) {
        if (transientPersistenceFailure(error)) {
          throw new Error('PERSONAL_ARTIFACT_CLEANUP_STORE_UNAVAILABLE', {
            cause: error,
          });
        }
        throw error;
      }
      if (result.status === 'RETRY_SCHEDULED') {
        throw new Error('PERSONAL_ARTIFACT_CLEANUP_STORE_UNAVAILABLE');
      }
      return result;
    },
  };
}

export type PersonalArtifactCleanupActivities = ReturnType<
  typeof createPersonalArtifactCleanupActivities
>;
