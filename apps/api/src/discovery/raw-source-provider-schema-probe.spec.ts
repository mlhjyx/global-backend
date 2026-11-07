import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  describeRawProviderSchemaFailure,
  validateRawSourceProviderPayload,
} from './raw-source-provider-schema';

const SHA = 'a'.repeat(64);

function directoryPayload(name: string): Record<string, unknown> {
  return {
    externalId: `directory:example.cn:${SHA}`,
    name,
    attributes: {
      source_kind: 'directory',
      source_directory: 'example.cn',
      source_class: 'industry_data',
    },
    provenance: {
      sourceUrl: 'https://example.cn/list',
      fetchedAt: '2026-11-07T00:00:00.000Z',
      contentHash: SHA,
      parserVersion: 'directory/v1',
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('raw-source schema probe（RAW_SOURCE_SCHEMA_PROBE=1）', () => {
  it('reports failed clause names and shapes but never field values', () => {
    vi.stubEnv('RAW_SOURCE_SCHEMA_PROBE', '1');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const secretName = 'Acme·Pump GmbH';

    const result = validateRawSourceProviderPayload('directory', directoryPayload(secretName));

    expect(result.ok).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]![1]);
    const probe = JSON.parse(line) as {
      stage: string;
      failed: string[];
      shape: { name: { bytes: number; words: number } };
    };
    expect(probe.stage).toBe('checks');
    expect(probe.failed).toContain('companyName');
    expect(probe.shape.name.bytes).toBeGreaterThan(0);
    // 探针绝不携带字段值（名称/URL 等原文不得出现在日志中）。
    expect(line).not.toContain('Acme');
    expect(line).not.toContain(secretName);
  });

  it('stays silent when the probe switch is off', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = validateRawSourceProviderPayload('directory', directoryPayload('Acme·Pump GmbH'));
    expect(result.ok).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('describe() keeps value-free shape summary', () => {
    const probe = describeRawProviderSchemaFailure('directory', 'checks', directoryPayload('Acme·Pump GmbH'), ['companyName']);
    expect(probe.failed).toEqual(['companyName']);
    const serialized = JSON.stringify(probe);
    expect(serialized).not.toContain('Acme');
    expect(probe.shape).toMatchObject({ topKeys: expect.any(Array) });
  });
});
