import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '../../../..');

async function repositoryFile(relativePath: string): Promise<string> {
  return readFile(path.join(repositoryRoot, relativePath), 'utf8');
}

describe('AI observability deployment contract', () => {
  it('keeps the stack isolated and its internal endpoints reachable', async () => {
    const compose = await repositoryFile('infra/ai-observability.compose.yml');

    expect(compose).toContain('ai-observability:\n    internal: true');
    expect(compose.match(/networks: \[ai-observability\]/g)).toHaveLength(7);
    expect(compose).toContain('LANGFUSE_S3_MEDIA_UPLOAD_ENDPOINT: http://langfuse-minio:9000');
    expect(compose).not.toContain('LANGFUSE_S3_MEDIA_UPLOAD_ENDPOINT: http://localhost:9092');
    expect(compose).toContain('redis-cli -a \\"$${REDIS_AUTH}\\" ping');
  });

  it('documents URL-safe database credentials and worker exporter activation', async () => {
    const example = await repositoryFile('infra/ai-observability.env.example');
    const runbook = await repositoryFile('docs/backend/ai-observability.md');

    expect(example).toContain('LANGFUSE_POSTGRES_PASSWORD=replace-with-64-lowercase-hex');
    expect(example).toContain('LANGFUSE_PUBLIC_KEY=pk-lf-');
    expect(example).toContain('LANGFUSE_SECRET_KEY=sk-lf-');
    expect(example).toContain('LANGFUSE_BASE_URL=http://127.0.0.1:3002');
    expect(runbook).toContain('set -a');
    expect(runbook).toContain('pnpm --filter @global/api start:dev');
    expect(runbook).toContain('pnpm --filter @global/api worker');
    expect(runbook).toContain('openssl rand -hex 32');
    expect(runbook).toContain('pk-lf-$(openssl rand -hex 16)');
    expect(runbook).toContain('sk-lf-$(openssl rand -hex 16)');
  });

  it('shares one Nest telemetry lifecycle with every API runtime consumer', async () => {
    const appModule = await repositoryFile('apps/api/src/app.module.ts');
    const runtimeModule = await repositoryFile(
      'apps/api/src/model-runtime/model-runtime.module.ts',
    );
    const discoveryModule = await repositoryFile(
      'apps/api/src/discovery/discovery.module.ts',
    );

    expect(appModule).toContain('ModelRuntimeModule');
    expect(runtimeModule).toContain('@Global()');
    expect(runtimeModule).toContain('exports: [LangfuseRuntimeTelemetryService]');
    expect(discoveryModule).toContain(
      'inject: [ModelGateway, PrismaService, LangfuseRuntimeTelemetryService]',
    );
    expect(discoveryModule).toContain('runtimeTelemetry,');
  });
});
