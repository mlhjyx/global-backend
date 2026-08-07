import { Injectable } from '@nestjs/common';
import { resolve } from 'node:path';
import {
  type BuildIdentity,
  type RuntimeEnvironment,
  type RuntimeIdentityField,
} from './build-identity';
import { loadRuntimeBuildIdentity } from './build-receipt';

export const DEPLOYMENT_STAGES = [
  'development',
  'pilot',
  'production',
] as const;
export type DeploymentStage = (typeof DEPLOYMENT_STAGES)[number];

export type {
  BuildIdentity,
  RuntimeEnvironment,
  RuntimeIdentityField,
} from './build-identity';

export interface RuntimeAdmission {
  readonly deploymentStage: DeploymentStage;
  readonly apiBindHost: '127.0.0.1';
  readonly port: number;
  readonly corsOrigins: readonly string[];
  readonly buildIdentity: BuildIdentity;
}

export interface RuntimeAdmissionOptions {
  readonly artifactRoot?: string;
  readonly receiptPath?: string;
}

export interface BuildHealthResponse {
  readonly status: BuildIdentity['status'];
  readonly service: 'global-api';
  readonly deploymentStage: DeploymentStage;
  readonly identity: Readonly<{
    buildSha: string | null;
    buildTime: string | null;
    artifactDigest: string | null;
    migrationRevision: string | null;
  }>;
  readonly missingFields: readonly RuntimeIdentityField[];
}

const APPROVED_API_BIND_HOST = '127.0.0.1' as const;
const DEFAULT_API_PORT = 3000;
const PORT_PATTERN = /^[1-9][0-9]{0,4}$/u;

function invalid(name: string, expectation: string): never {
  throw new Error(`${name} is invalid; ${expectation}`);
}

export function resolveDeploymentStage(
  env: RuntimeEnvironment,
): DeploymentStage {
  const explicitStage = env.DEPLOYMENT_STAGE;
  if (explicitStage !== undefined) {
    if (!(DEPLOYMENT_STAGES as readonly string[]).includes(explicitStage)) {
      return invalid(
        'DEPLOYMENT_STAGE',
        `expected one of ${DEPLOYMENT_STAGES.join(', ')}`,
      );
    }
    if (env.NODE_ENV === 'production' && explicitStage === 'development') {
      throw new Error(
        'DEPLOYMENT_STAGE cannot downgrade a NODE_ENV=production process to development',
      );
    }
    return explicitStage as DeploymentStage;
  }

  return env.NODE_ENV === 'production' ? 'production' : 'development';
}

export function resolveApiBindHost(
  deploymentStage: DeploymentStage,
  env: RuntimeEnvironment,
): '127.0.0.1' {
  const configuredHost = env.API_BIND_HOST;
  if (configuredHost === undefined) {
    if (deploymentStage === 'development') return APPROVED_API_BIND_HOST;
    throw new Error(
      `API_BIND_HOST is required for ${deploymentStage}; current Ubuntu admission accepts only ${APPROVED_API_BIND_HOST}`,
    );
  }
  if (configuredHost !== APPROVED_API_BIND_HOST) {
    return invalid(
      'API_BIND_HOST',
      `current Ubuntu admission accepts only ${APPROVED_API_BIND_HOST}`,
    );
  }
  return APPROVED_API_BIND_HOST;
}

export function resolveApiPort(env: RuntimeEnvironment): number {
  const configuredPort = env.PORT;
  if (configuredPort === undefined) return DEFAULT_API_PORT;
  if (!PORT_PATTERN.test(configuredPort)) {
    return invalid('PORT', 'expected a canonical integer from 1 through 65535');
  }
  const port = Number(configuredPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    return invalid('PORT', 'expected a canonical integer from 1 through 65535');
  }
  return port;
}

function canonicalCorsOrigin(value: string): string {
  if (value.length === 0)
    return invalid('CORS_ORIGINS', 'blank entries are not allowed');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return invalid(
      'CORS_ORIGINS',
      'each entry must be a canonical HTTP origin',
    );
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.origin !== value
  ) {
    return invalid(
      'CORS_ORIGINS',
      'each entry must be a canonical HTTP origin',
    );
  }
  return parsed.origin;
}

export function resolveCorsOrigins(
  deploymentStage: DeploymentStage,
  env: RuntimeEnvironment,
): readonly string[] {
  const configuredOrigins = env.CORS_ORIGINS;
  if (configuredOrigins === undefined) {
    if (deploymentStage === 'development') return Object.freeze([]);
    throw new Error(`CORS_ORIGINS is required for ${deploymentStage}`);
  }
  if (configuredOrigins.trim() === '') {
    throw new Error(`CORS_ORIGINS is required for ${deploymentStage}`);
  }
  const entries = configuredOrigins
    .split(',')
    .map((entry) => canonicalCorsOrigin(entry.trim()));
  return Object.freeze(Array.from(new Set(entries)));
}

export function resolveRuntimeAdmission(
  env: RuntimeEnvironment,
  options: RuntimeAdmissionOptions = {},
): RuntimeAdmission {
  const deploymentStage = resolveDeploymentStage(env);
  const apiBindHost = resolveApiBindHost(deploymentStage, env);
  const port = resolveApiPort(env);
  const corsOrigins = resolveCorsOrigins(deploymentStage, env);
  const artifactRoot = resolve(
    options.artifactRoot ?? resolve(__dirname, '..'),
  );
  const buildIdentity = loadRuntimeBuildIdentity({
    artifactRoot,
    receiptPath: options.receiptPath,
    env,
    required: deploymentStage !== 'development',
  });

  return Object.freeze({
    deploymentStage,
    apiBindHost,
    port,
    corsOrigins,
    buildIdentity,
  });
}

@Injectable()
export class RuntimeIdentityService {
  private readonly snapshot = resolveRuntimeAdmission(process.env);

  getSnapshot(): RuntimeAdmission {
    return this.snapshot;
  }

  getBuildHealth(): BuildHealthResponse {
    const { deploymentStage, buildIdentity } = this.snapshot;
    return Object.freeze({
      status: buildIdentity.status,
      service: 'global-api',
      deploymentStage,
      identity: Object.freeze({
        buildSha: buildIdentity.buildSha,
        buildTime: buildIdentity.buildTime,
        artifactDigest: buildIdentity.artifactDigest,
        migrationRevision: buildIdentity.migrationRevision,
      }),
      missingFields: buildIdentity.missingFields,
    });
  }
}
