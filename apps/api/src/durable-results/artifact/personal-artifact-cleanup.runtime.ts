import { GetBucketLocationCommand, S3Client } from '@aws-sdk/client-s3';
import { S3PersonalArtifactCleanupAdapter } from './personal-artifact-cleanup.store';

export interface PersonalArtifactCleanupRuntime {
  readonly port: S3PersonalArtifactCleanupAdapter;
  checkReadiness(): Promise<
    | Readonly<{ status: 'ok' }>
    | Readonly<{
        status: 'failed';
        code: 'PERSONAL_ARTIFACT_CLEANUP_STORE_UNAVAILABLE';
      }>
  >;
  destroy(): void;
}

export interface PersonalArtifactCleanupRuntimeClient {
  send(command: object): Promise<unknown>;
  destroy(): void;
}

type CleanupClientFactory = (input: NonNullable<ConstructorParameters<typeof S3Client>[0]>) =>
  PersonalArtifactCleanupRuntimeClient;

function loopback(hostname: string): boolean {
  return (
    hostname === '127.0.0.1' ||
    hostname === 'localhost' ||
    hostname === '[::1]' ||
    hostname === '::1'
  );
}

function required(env: NodeJS.ProcessEnv, name: string, max: number): string {
  const value = env[name]?.trim();
  if (!value || value.length > max) {
    throw new Error('PERSONAL_ARTIFACT_CLEANUP_CONFIG_INVALID');
  }
  return value;
}

export function createPersonalArtifactCleanupRuntime(
  env: NodeJS.ProcessEnv,
  clientFactory: CleanupClientFactory = (input) => new S3Client(input),
): PersonalArtifactCleanupRuntime {
  const endpoint = new URL(
    required(env, 'GENERIC_OPERATION_ARTIFACT_S3_ENDPOINT', 2048),
  );
  const bucket = required(env, 'GENERIC_OPERATION_ARTIFACT_S3_BUCKET', 63);
  const region = required(env, 'GENERIC_OPERATION_ARTIFACT_S3_REGION', 64);
  const accessKeyId = required(
    env,
    'GENERIC_OPERATION_ARTIFACT_CLEANUP_S3_ACCESS_KEY',
    128,
  );
  const secretAccessKey = required(
    env,
    'GENERIC_OPERATION_ARTIFACT_CLEANUP_S3_SECRET_KEY',
    256,
  );
  const forcePathStyle = required(
    env,
    'GENERIC_OPERATION_ARTIFACT_S3_FORCE_PATH_STYLE',
    5,
  );
  if (
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) ||
    !/^[a-z0-9][a-z0-9-]*$/.test(region) ||
    (forcePathStyle !== 'true' && forcePathStyle !== 'false') ||
    accessKeyId === env.GENERIC_OPERATION_ARTIFACT_S3_ACCESS_KEY?.trim() ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    (endpoint.protocol !== 'https:' &&
      !(endpoint.protocol === 'http:' && loopback(endpoint.hostname)))
  ) {
    throw new Error('PERSONAL_ARTIFACT_CLEANUP_CONFIG_INVALID');
  }
  const client = clientFactory({
    endpoint: endpoint.href,
    region,
    forcePathStyle: forcePathStyle === 'true',
    credentials: { accessKeyId, secretAccessKey },
    maxAttempts: 1,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    requestHandler: {
      connectionTimeout: 1_500,
      requestTimeout: 2_500,
    },
  });
  return Object.freeze({
    port: new S3PersonalArtifactCleanupAdapter({ bucket, client }),
    checkReadiness: async () => {
      try {
        await client.send(
          new GetBucketLocationCommand({ Bucket: bucket }),
        );
        return Object.freeze({ status: 'ok' as const });
      } catch {
        return Object.freeze({
          status: 'failed' as const,
          code: 'PERSONAL_ARTIFACT_CLEANUP_STORE_UNAVAILABLE' as const,
        });
      }
    },
    destroy: () => client.destroy(),
  });
}
