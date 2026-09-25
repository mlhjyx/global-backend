import { S3Client } from "@aws-sdk/client-s3";
import type { PrismaService } from "../../prisma/prisma.service";
import type { BudgetStore } from "../../tools/budget-store";
import type { ArtifactExecutionPort } from "../../tools/artifact-execution-port";
import { ArtifactMaterializerRegistry } from "./artifact-materializer.registry";
import { ArtifactSubjectBindingContract } from "./artifact-subject-binding.contract";
import { GenericOperationArtifactExecution } from "./generic-operation-artifact.execution";
import { GenericOperationArtifactRepository } from "./generic-operation-artifact.repository";
import { GenericOperationArtifactService } from "./generic-operation-artifact.service";
import {
  genericArtifactStorageConfig,
  type GenericArtifactStorageConfig,
} from "./generic-operation-artifact.storage-config";
import { S3GenericOperationArtifactStore } from "./generic-operation-artifact.store";
import { crawl4aiMaterializers } from "./materializers/crawl4ai.materializer";
import { httpGetMaterializer } from "./materializers/http-get.materializer";
import { sanctionsDownloadMaterializer } from "./materializers/sanctions-download.materializer";

/** The complete fixed materializer set for the four artifact result schemas. */
export function productArtifactMaterializerRegistry(): ArtifactMaterializerRegistry {
  return new ArtifactMaterializerRegistry([
    ...crawl4aiMaterializers,
    httpGetMaterializer,
    sanctionsDownloadMaterializer,
  ]);
}

const processStores = new Map<string, S3GenericOperationArtifactStore>();

/**
 * One long-lived S3 client/store per storage config per process; every
 * ToolBroker composition (API modules, workers) shares it.
 */
export function sharedGenericOperationArtifactStore(
  config: GenericArtifactStorageConfig,
): S3GenericOperationArtifactStore {
  const key = JSON.stringify([
    config.endpoint, config.bucket, config.region, config.accessKeyId,
    config.secretAccessKey, config.forcePathStyle,
  ]);
  const cached = processStores.get(key);
  if (cached) return cached;
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    // An ambiguous write is recorded as RESULT_UNKNOWN, never retried blindly.
    maxAttempts: 1,
    requestChecksumCalculation: "WHEN_REQUIRED",
    requestHandler: { connectionTimeout: 3_000, requestTimeout: 30_000 },
  });
  const store = new S3GenericOperationArtifactStore({
    bucket: config.bucket,
    client,
  });
  processStores.set(key, store);
  return store;
}

/**
 * Composes the G3 artifact execution port from the same storage env the
 * `generic_artifact_storage` readiness probe validates. Missing or invalid
 * storage config returns undefined: ToolBroker then keeps every
 * subject-bound call held (fail closed) and readiness reports the gap.
 */
export function createGenericOperationArtifactExecutionFromEnv(
  prisma: PrismaService,
  budgetStore: BudgetStore,
  env: NodeJS.ProcessEnv = process.env,
): ArtifactExecutionPort | undefined {
  let config;
  try {
    config = genericArtifactStorageConfig(env);
  } catch {
    return undefined;
  }
  const store = sharedGenericOperationArtifactStore(config);
  return new GenericOperationArtifactExecution({
    withWorkspace: (workspaceId, fn) => prisma.withWorkspace(workspaceId, fn),
    binding: new ArtifactSubjectBindingContract(),
    service: new GenericOperationArtifactService(
      new GenericOperationArtifactRepository(prisma),
      store,
      budgetStore,
    ),
    materializers: productArtifactMaterializerRegistry(),
  });
}
