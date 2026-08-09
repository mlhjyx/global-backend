import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveRuntimeSettings } from './runtime-environment';

describe('resolveRuntimeSettings', () => {
  it('defaults development to loopback without trusting a wildcard default', () => {
    expect(resolveRuntimeSettings({ NODE_ENV: 'development' })).toEqual({
      mode: 'development',
      bindHost: '127.0.0.1',
      port: 3000,
    });
  });

  it('requires an explicit loopback bind for the controlled pilot', () => {
    expect(() => resolveRuntimeSettings({ APP_ENVIRONMENT: 'pilot' })).toThrow(
      /API_BIND_HOST.*pilot/i,
    );
    expect(() =>
      resolveRuntimeSettings({ APP_ENVIRONMENT: 'pilot', API_BIND_HOST: '0.0.0.0' }),
    ).toThrow(/loopback/i);
    expect(() =>
      resolveRuntimeSettings({ APP_ENVIRONMENT: 'pilot', API_BIND_HOST: '::' }),
    ).toThrow(/loopback/i);

    expect(
      resolveRuntimeSettings({
        APP_ENVIRONMENT: 'pilot',
        API_BIND_HOST: '127.0.0.1',
        PORT: '3100',
      }),
    ).toEqual({ mode: 'pilot', bindHost: '127.0.0.1', port: 3100 });
  });

  it('requires production to declare a non-wildcard bind explicitly', () => {
    expect(() => resolveRuntimeSettings({ NODE_ENV: 'production' })).toThrow(
      /API_BIND_HOST.*production/i,
    );
    expect(() =>
      resolveRuntimeSettings({ NODE_ENV: 'production', API_BIND_HOST: '0.0.0.0' }),
    ).toThrow(/wildcard/i);

    expect(
      resolveRuntimeSettings({
        NODE_ENV: 'production',
        API_BIND_HOST: '10.10.0.7',
        PORT: '3000',
      }),
    ).toEqual({ mode: 'production', bindHost: '10.10.0.7', port: 3000 });
  });

  it('rejects unknown modes and invalid ports before Nest starts', () => {
    expect(() => resolveRuntimeSettings({ APP_ENVIRONMENT: 'staging' })).toThrow(
      /APP_ENVIRONMENT/i,
    );
    expect(() =>
      resolveRuntimeSettings({ APP_ENVIRONMENT: 'development', PORT: '0' }),
    ).toThrow(/PORT/i);
    expect(() =>
      resolveRuntimeSettings({ APP_ENVIRONMENT: 'development', PORT: 'not-a-number' }),
    ).toThrow(/PORT/i);
  });

  it('wires the resolved host into the real Nest listen call', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'main.ts'), 'utf8');
    expect(source).toContain('resolveRuntimeSettings(process.env)');
    expect(source).toMatch(/app\.listen\(runtimeSettings\.port,\s*runtimeSettings\.bindHost\)/);
    expect(source).not.toMatch(/app\.listen\(port\)/);
  });
});
