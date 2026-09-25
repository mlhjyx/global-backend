import { describe, expect, it } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service';
import type { BudgetStore } from '../../tools/budget-store';
import { GenericOperationArtifactExecution } from './generic-operation-artifact.execution';
import {
  createGenericOperationArtifactExecutionFromEnv,
  productArtifactMaterializerRegistry,
} from './generic-operation-artifact.runtime';

const STORAGE_ENV = {
  GENERIC_OPERATION_ARTIFACT_S3_ENDPOINT: 'http://127.0.0.1:9000',
  GENERIC_OPERATION_ARTIFACT_S3_BUCKET: 'generic-operation-artifacts',
  GENERIC_OPERATION_ARTIFACT_S3_REGION: 'us-east-1',
  GENERIC_OPERATION_ARTIFACT_S3_ACCESS_KEY: 'artifact-writer',
  GENERIC_OPERATION_ARTIFACT_S3_SECRET_KEY: 'artifact-writer-secret',
  GENERIC_OPERATION_ARTIFACT_S3_FORCE_PATH_STYLE: 'true',
};

describe('generic operation artifact runtime composition', () => {
  const prisma = {} as PrismaService;
  const budgetStore = {} as BudgetStore;

  it('composes the execution port from the readiness-validated storage env', () => {
    expect(
      createGenericOperationArtifactExecutionFromEnv(prisma, budgetStore, STORAGE_ENV),
    ).toBeInstanceOf(GenericOperationArtifactExecution);
  });

  it.each([
    {},
    { ...STORAGE_ENV, GENERIC_OPERATION_ARTIFACT_S3_ENDPOINT: 'http://minio.example:9000' },
    { ...STORAGE_ENV, GENERIC_OPERATION_ARTIFACT_S3_FORCE_PATH_STYLE: 'yes' },
  ])('stays uncomposed (fail closed) for missing or invalid storage env %#', (env) => {
    expect(createGenericOperationArtifactExecutionFromEnv(prisma, budgetStore, env)).toBeUndefined();
  });

  it('registers the complete fixed materializer set', () => {
    expect(productArtifactMaterializerRegistry().resultSchemas()).toEqual([
      'sanctions-download/v1', 'http-get/v1', 'crawl4ai-fetch/v1', 'crawl4ai-render/v1',
    ]);
  });
});
