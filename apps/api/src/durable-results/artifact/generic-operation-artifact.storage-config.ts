import { ExecutionControlError } from "../../execution-budget/execution-control-error";

export type GenericArtifactStorageConfig = Readonly<{
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}>;

function loopback(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

export function genericArtifactStorageConfig(
  env: NodeJS.ProcessEnv,
): GenericArtifactStorageConfig {
  const endpointValue = env.GENERIC_OPERATION_ARTIFACT_S3_ENDPOINT?.trim();
  const bucket = env.GENERIC_OPERATION_ARTIFACT_S3_BUCKET?.trim();
  const region = env.GENERIC_OPERATION_ARTIFACT_S3_REGION?.trim();
  const accessKeyId = env.GENERIC_OPERATION_ARTIFACT_S3_ACCESS_KEY?.trim();
  const secretAccessKey = env.GENERIC_OPERATION_ARTIFACT_S3_SECRET_KEY?.trim();
  const forcePathStyleValue =
    env.GENERIC_OPERATION_ARTIFACT_S3_FORCE_PATH_STYLE?.trim();
  if (
    !endpointValue ||
    !bucket ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) ||
    !region ||
    region.length > 64 ||
    !/^[a-z0-9][a-z0-9-]*$/.test(region) ||
    !accessKeyId ||
    accessKeyId.length > 128 ||
    !secretAccessKey ||
    secretAccessKey.length > 256 ||
    (forcePathStyleValue !== "true" && forcePathStyleValue !== "false")
  ) {
    throw new ExecutionControlError(
      "GENERIC_OPERATION_ARTIFACT_STORAGE_CONFIG_INVALID",
    );
  }
  const endpoint = new URL(endpointValue);
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    (endpoint.protocol !== "https:" &&
      !(endpoint.protocol === "http:" && loopback(endpoint.hostname)))
  ) {
    throw new ExecutionControlError(
      "GENERIC_OPERATION_ARTIFACT_STORAGE_CONFIG_INVALID",
    );
  }
  return Object.freeze({
    endpoint: endpoint.href,
    bucket,
    region,
    accessKeyId,
    secretAccessKey,
    forcePathStyle: forcePathStyleValue === "true",
  });
}

