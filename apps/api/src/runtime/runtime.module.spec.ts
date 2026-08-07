import { describe, expect, it } from 'vitest';
import {
  RUNTIME_ADMISSION,
  RuntimeIdentityService,
  RuntimeModule,
  resolveRuntimeAdmission,
  type RuntimeBootstrapSnapshot,
} from './runtime-admission';

describe('RuntimeModule single-snapshot DI', () => {
  it('provides the exact pre-Nest frozen object without resolving process state again', async () => {
    const snapshot = resolveRuntimeAdmission({
      DEPLOYMENT_STAGE: 'development',
      NODE_ENV: 'test',
    });
    const dynamicModule = RuntimeModule.forRoot(snapshot);
    const provider = dynamicModule.providers?.find(
      (candidate) =>
        typeof candidate === 'object' &&
        candidate !== null &&
        'provide' in candidate &&
        candidate.provide === RUNTIME_ADMISSION,
    ) as { useValue: RuntimeBootstrapSnapshot } | undefined;
    expect(provider?.useValue).toBe(snapshot);

    const service = new RuntimeIdentityService(snapshot);
    expect(service.getBootstrapSnapshot()).toBe(snapshot);
    expect(service.getSnapshot()).toBe(snapshot.admission);
    expect(service.getProcessSnapshot()).toBe(snapshot.process);
  });
});
