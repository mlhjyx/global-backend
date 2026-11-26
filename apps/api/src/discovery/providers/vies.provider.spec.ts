import { describe, expect, it, vi } from 'vitest';
import type { ExecutionBroker } from '../../tools/tool-contract';
import type { ViesCheckResult } from '../../adapters/vies';
import { ViesEnrichmentProvider } from './vies.provider';

function brokerReturning(result: ViesCheckResult) {
  const invoke = vi.fn(async () => ({ data: result, costCents: 0 }));
  return {
    checkSourcePolicy: vi.fn(),
    invoke,
  } as unknown as ExecutionBroker & { invoke: typeof invoke };
}

const CTX = { workspaceId: 'ws-1', runId: 'run-1' };

describe('ViesEnrichmentProvider (T1 EU VAT corroboration)', () => {
  it('returns miss without network calls when vatId is missing or invalid', async () => {
    const broker = brokerReturning({} as ViesCheckResult);
    const provider = new ViesEnrichmentProvider({ broker });
    expect((await provider.enrichCompany({ name: 'Effe Energy', domain: 'effeenergy.it' }, CTX)).matched).toBe(false);
    expect((await provider.enrichCompany({ name: 'Effe Energy', domain: 'effeenergy.it', vatId: 'IT00000000000' }, CTX)).matched).toBe(false);
    expect(broker.invoke).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'Effe Energy',
      domain: 'effeenergy.it',
      vatId: 'IT04553650989',
      viesName: 'EFFE ENERGY SRL',
      city: 'GUSSAGO',
    },
    {
      name: 'Italsol',
      domain: 'italsolsrl.it',
      vatId: 'IT02053810517',
      viesName: 'ITALSOL SRL',
      city: 'AREZZO',
    },
    {
      name: 'Solarplace',
      domain: 'solarplace.net',
      vatId: 'IT03899910925',
      viesName: 'SOLARPLACE SRL',
      city: 'CARBONIA',
    },
    {
      name: 'Gruppo HVC',
      domain: 'gruppohvc.it',
      vatId: 'IT05503370289',
      viesName: 'HVC SRL',
      city: 'PADOVA',
    },
    {
      name: 'IMAC Energy',
      domain: 'imac-srl.it',
      vatId: 'IT00204910426',
      viesName: 'IMAC SRL',
      city: 'FALCONARA MARITTIMA',
    },
  ])('matches real Italian buyer $name <-> $viesName and emits address-free T1 attributes', async ({ name, domain, vatId, viesName, city }) => {
    const broker = brokerReturning({
      status: 'VALID',
      countryCode: 'IT',
      isoCountry: 'IT',
      vatNumber: vatId.slice(2),
      vatId,
      requestDate: '2026-11-26',
      legalName: viesName,
      registeredCity: city,
      nameRedacted: false,
    });
    const res = await new ViesEnrichmentProvider({ broker }).enrichCompany(
      { name, domain, country: 'IT', vatId },
      CTX,
    );
    expect(res.matched).toBe(true);
    expect(res.confidence).toBeGreaterThanOrEqual(0.72);
    expect(res.attributes).toEqual({
      vat_id: vatId,
      legal_name: viesName,
      registered_country: 'IT',
      registered_city: city,
      verified_status: 'VALID',
      request_date: '2026-11-26',
      match_confidence: expect.any(Number),
    });
    expect(res.attributes).not.toHaveProperty('address');
    expect(broker.invoke).toHaveBeenCalledWith(
      'vies.check',
      { countryCode: 'IT', vatNumber: vatId.slice(2) },
      expect.objectContaining({ workspaceId: 'ws-1', purpose: ['enrichment'] }),
    );
  });

  it('fails closed on German/Spanish name-redacted responses (name="---") and INVALID responses', async () => {
    const redactedBroker = brokerReturning({
      status: 'VALID',
      countryCode: 'DE',
      isoCountry: 'DE',
      vatNumber: '252368289',
      vatId: 'DE252368289',
      requestDate: '2026-11-26',
      nameRedacted: true,
    });
    const resRedacted = await new ViesEnrichmentProvider({ broker: redactedBroker }).enrichCompany(
      { name: 'Centroplan GmbH', domain: 'centroplan.de', country: 'DE', vatId: 'DE252368289' },
      CTX,
    );
    expect(resRedacted.matched).toBe(false);

    const invalidBroker = brokerReturning({
      status: 'INVALID',
      countryCode: 'IT',
      isoCountry: 'IT',
      vatNumber: '04553650989',
      vatId: 'IT04553650989',
      nameRedacted: true,
    });
    const resInvalid = await new ViesEnrichmentProvider({ broker: invalidBroker }).enrichCompany(
      { name: 'Effe Energy', domain: 'effeenergy.it', country: 'IT', vatId: 'IT04553650989' },
      CTX,
    );
    expect(resInvalid.matched).toBe(false);
  });

  it.each([
    {
      label: 'generic stopword solar',
      name: 'Solar Energy Italia',
      domain: 'solutions.it',
      viesName: 'SOLAR SRL',
    },
    {
      label: '3-char stopword sol vs solutions.it',
      name: 'Sol Energy',
      domain: 'solutions.it',
      viesName: 'SOL SRL',
    },
    {
      label: '3-char non-stopword substring collision',
      name: 'Abc Energy',
      domain: 'abcefg.it',
      viesName: 'ABC SRL',
    },
    {
      label: 'web agency footer P.IVA mismatch',
      name: 'Effe Energy',
      domain: 'effeenergy.it',
      viesName: 'WEB STUDIO MILANO SRL',
    },
  ])('rejects false-positive name match ($label)', async ({ name, domain, viesName }) => {
    const broker = brokerReturning({
      status: 'VALID',
      countryCode: 'IT',
      isoCountry: 'IT',
      vatNumber: '04553650989',
      vatId: 'IT04553650989',
      requestDate: '2026-11-26',
      legalName: viesName,
      registeredCity: 'MILANO',
      nameRedacted: false,
    });
    const res = await new ViesEnrichmentProvider({ broker }).enrichCompany(
      { name, domain, country: 'IT', vatId: 'IT04553650989' },
      CTX,
    );
    expect(res.matched).toBe(false);
  });
});
