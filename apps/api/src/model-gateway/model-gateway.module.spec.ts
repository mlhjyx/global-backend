import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelGatewayModule } from './model-gateway.module';
import { ModelProviderRegistry } from './model-provider.registry';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('ModelGatewayModule production composition boundary', () => {
  it('does not include a test provider in the Nest product module', () => {
    const providers = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      ModelGatewayModule,
    ) as readonly unknown[];

    expect(
      providers.map((provider) =>
        typeof provider === 'function' ? provider.name : provider,
      ),
    ).not.toContain('StubModelProvider');
  });

  it('registers no provider when the real gateway is not configured', () => {
    vi.stubEnv('MODEL_GATEWAY_URL', '');
    vi.stubEnv('MODEL_GATEWAY_KEY', '');
    vi.stubEnv('NODE_ENV', 'development');

    const registry = new ModelProviderRegistry();
    const legacyStub = {
      id: 'stub',
      supports: () => true,
    };
    const module = Reflect.construct(ModelGatewayModule, [
      registry,
      legacyStub,
    ]) as ModelGatewayModule;

    module.onModuleInit();

    expect(registry.all()).toEqual([]);
  });
});
