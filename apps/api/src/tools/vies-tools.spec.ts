import { describe, expect, it } from 'vitest';
import { ToolRegistry } from './tool-registry';
import { registerSourceTools } from './source-tools';
import { registerViesTools, viesCheckTool } from './vies-tools';

describe('vies.check governed tool registration', () => {
  it('registers vies.check through registerViesTools and registerSourceTools with required ec.europa.eu policy and typed_projection', () => {
    const solo = registerViesTools(new ToolRegistry());
    expect(solo.get('vies.check')).toBe(viesCheckTool);

    const all = registerSourceTools(new ToolRegistry());
    expect(all.get('vies.check')).toBe(viesCheckTool);

    expect(viesCheckTool.id).toBe('vies.check');
    expect(viesCheckTool.cost).toEqual({ unit: 'call', estimatedCents: 0, external: true });
    expect(viesCheckTool.rateLimit).toEqual({ rps: 1, concurrency: 1 });
    expect(viesCheckTool.compliance).toMatchObject({
      sourcePolicy: 'required',
      policyDomain: 'ec.europa.eu',
      personalData: false,
      allowedPurpose: ['discovery', 'enrichment'],
    });
    expect(viesCheckTool.durableResultStrategy).toEqual({
      kind: 'typed_projection',
      schema: 'vies-check/v1',
    });
    expect(viesCheckTool.physicalWireObservation).toBe('before_each_wire');
    expect(viesCheckTool.idempotencyKey({ countryCode: 'it', vatNumber: '0455 365 0989' })).toBe(
      'vies.check:IT:04553650989',
    );
  });
});
