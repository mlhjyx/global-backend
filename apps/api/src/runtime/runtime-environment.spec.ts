import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveCorsOrigin, resolveRuntimeSettings } from './runtime-environment';

describe('resolveRuntimeSettings', () => {
  it('defaults development to loopback without trusting a wildcard default', () => {
    expect(resolveRuntimeSettings({ NODE_ENV: 'development' })).toEqual({
      mode: 'development',
      bindHost: '127.0.0.1',
      port: 3000,
    });
  });

  it('requires an explicit loopback bind for the controlled pilot', () => {
    expect(() =>
      resolveRuntimeSettings({ APP_ENVIRONMENT: 'pilot', NODE_ENV: 'production' }),
    ).toThrow(
      /API_BIND_HOST.*pilot/i,
    );
    expect(() =>
      resolveRuntimeSettings({
        APP_ENVIRONMENT: 'pilot',
        NODE_ENV: 'production',
        API_BIND_HOST: '0.0.0.0',
      }),
    ).toThrow(/loopback/i);
    expect(() =>
      resolveRuntimeSettings({
        APP_ENVIRONMENT: 'pilot',
        NODE_ENV: 'production',
        API_BIND_HOST: '::',
      }),
    ).toThrow(/loopback/i);

    expect(
      resolveRuntimeSettings({
        APP_ENVIRONMENT: 'pilot',
        NODE_ENV: 'production',
        API_BIND_HOST: '127.0.0.1',
        PORT: '3100',
      }),
    ).toEqual({ mode: 'pilot', bindHost: '127.0.0.1', port: 3100 });
  });

  it('refuses controlled modes unless every legacy production switch sees NODE_ENV=production', () => {
    expect(() =>
      resolveRuntimeSettings({
        APP_ENVIRONMENT: 'pilot',
        NODE_ENV: 'development',
        API_BIND_HOST: '127.0.0.1',
      }),
    ).toThrow(/NODE_ENV.*production/i);
    expect(() =>
      resolveRuntimeSettings({
        APP_ENVIRONMENT: 'production',
        API_BIND_HOST: '127.0.0.1',
      }),
    ).toThrow(/NODE_ENV.*production/i);
  });

  it('runs the production-compiled OCI artifact as a managed development instance', () => {
    expect(
      resolveRuntimeSettings({
        APP_ENVIRONMENT: 'development',
        NODE_ENV: 'production',
      }),
    ).toEqual({ mode: 'development', bindHost: '127.0.0.1', port: 3000 });
  });

  it('requires production to declare a non-wildcard bind explicitly', () => {
    expect(() => resolveRuntimeSettings({ NODE_ENV: 'production' })).toThrow(
      /API_BIND_HOST.*production/i,
    );
    expect(() =>
      resolveRuntimeSettings({ NODE_ENV: 'production', API_BIND_HOST: '0.0.0.0' }),
    ).toThrow(/wildcard/i);
    expect(() =>
      resolveRuntimeSettings({
        NODE_ENV: 'production',
        API_BIND_HOST: '0:0:0:0:0:0:0:0',
      }),
    ).toThrow(/wildcard/i);
    expect(() =>
      resolveRuntimeSettings({
        NODE_ENV: 'production',
        API_BIND_HOST: '::ffff:0.0.0.0',
      }),
    ).toThrow(/wildcard/i);

    expect(
      resolveRuntimeSettings({
        NODE_ENV: 'production',
        API_BIND_HOST: '10.10.0.7',
        PORT: '3000',
      }),
    ).toEqual({ mode: 'production', bindHost: '10.10.0.7', port: 3000 });
  });

  it('uses the resolved runtime mode as the CORS default security boundary', () => {
    expect(resolveCorsOrigin('development', undefined)).toBe(false);
    expect(resolveCorsOrigin('test', '')).toBe(true);
    expect(resolveCorsOrigin('pilot', undefined)).toBe(false);
    expect(resolveCorsOrigin('production', '')).toBe(false);
    expect(resolveCorsOrigin('pilot', 'https://pilot.example, https://ops.example')).toEqual([
      'https://pilot.example',
      'https://ops.example',
    ]);
    expect(() => resolveCorsOrigin('pilot', '*')).toThrow(/CORS_ORIGINS/i);
    expect(() => resolveCorsOrigin('production', 'http://ops.example')).toThrow(
      /HTTPS|secure/i,
    );
    expect(() => resolveCorsOrigin('pilot', 'https://ops.example/path')).toThrow(
      /origin/i,
    );
    expect(resolveCorsOrigin('pilot', 'http://127.0.0.1:5173')).toEqual([
      'http://127.0.0.1:5173',
    ]);

    const source = readFileSync(join(import.meta.dirname, '..', 'main.ts'), 'utf8');
    expect(source).toContain('resolveCorsOrigin(runtimeSettings.mode, process.env.CORS_ORIGINS)');
    expect(source).not.toContain("process.env.NODE_ENV === 'production' ? false : true");
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
