import { describe, expect, it } from 'vitest';
import { TypedProjectionRegistry } from './typed-projection.registry';
import { viesCheckResultProjection } from './vies-result-projection';

describe('vies-check/v1 typed projection', () => {
  it('projects and restores a valid redacted-address VIES tool result', () => {
    const registry = new TypedProjectionRegistry().register(viesCheckResultProjection);
    const raw = {
      data: {
        status: 'VALID',
        countryCode: 'IT',
        isoCountry: 'IT',
        vatNumber: '04553650989',
        vatId: 'IT04553650989',
        requestDate: '2026-11-26',
        legalName: 'EFFE ENERGY SRL',
        registeredCity: 'GUSSAGO',
        nameRedacted: false,
      },
      costCents: 0,
    };
    const envelope = registry.project('vies-check/v1', raw);
    expect(envelope.schema).toBe('vies-check/v1');
    expect(registry.restore(envelope)).toEqual(raw);
  });

  it('rejects raw address fields and invalid VAT identifiers', () => {
    const registry = new TypedProjectionRegistry().register(viesCheckResultProjection);
    expect(() =>
      registry.project('vies-check/v1', {
        data: {
          status: 'VALID',
          countryCode: 'IT',
          isoCountry: 'IT',
          vatNumber: '04553650989',
          vatId: 'IT04553650989',
          address: 'VIA BENEDETTO CASTELLI 9/11',
          nameRedacted: false,
        },
        costCents: 0,
      }),
    ).toThrow('TYPED_PROJECTION_INVALID');

    expect(() =>
      registry.project('vies-check/v1', {
        data: {
          status: 'VALID',
          countryCode: 'IT',
          isoCountry: 'IT',
          vatNumber: '00000000000',
          vatId: 'IT00000000000',
          nameRedacted: true,
        },
        costCents: 0,
      }),
    ).toThrow('TYPED_PROJECTION_INVALID');
  });
});
