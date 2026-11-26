import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isExecutionControlError } from '../execution-budget/execution-control-error';
import {
  ViesTransientError,
  checkViesVat,
  extractRegisteredCityFromViesAddress,
  viesTransientErrorCountry,
} from './vies';

let clock = 1_700_000_000_000;

beforeEach(() => {
  clock += 120_000;
});

describe('EU VIES REST adapter (adapters/vies)', () => {
  it('parses a valid Italian VIES response, extracts registeredCity, and never exposes raw address', async () => {
    const httpClient = vi.fn(async (url: string) => {
      expect(url).toBe('https://ec.europa.eu/taxation_customs/vies/rest-api/ms/IT/vat/04553650989');
      return {
        status: 200,
        ok: true,
        text: JSON.stringify({
          isValid: true,
          requestDate: '2026-11-26T05:10:00.000Z',
          userError: 'VALID',
          name: 'EFFE ENERGY SRL',
          address: 'VIA BENEDETTO CASTELLI 9/11 \n25064 GUSSAGO BS\n',
          vatNumber: '04553650989',
        }),
      };
    });

    const result = await checkViesVat(
      { countryCode: 'IT', vatNumber: '04553650989' },
      { httpClient, nowMs: () => clock },
    );
    expect(result).toEqual({
      status: 'VALID',
      countryCode: 'IT',
      isoCountry: 'IT',
      vatNumber: '04553650989',
      vatId: 'IT04553650989',
      requestDate: '2026-11-26',
      legalName: 'EFFE ENERGY SRL',
      registeredCity: 'GUSSAGO',
      nameRedacted: false,
    });
    expect(result).not.toHaveProperty('address');
  });

  it('extracts registeredCity conservatively across real Italian and EU addresses and drops streets', () => {
    expect(extractRegisteredCityFromViesAddress('VIA BENEDETTO CASTELLI 9/11 \n25064 GUSSAGO BS\n')).toBe('GUSSAGO');
    expect(extractRegisteredCityFromViesAddress('VIA DEL MASPINO N 9 , 52100 AREZZO AR,')).toBe('AREZZO');
    expect(extractRegisteredCityFromViesAddress('VIA TRAMONTANA 1 , 09013 CARBONIA SU,')).toBe('CARBONIA');
    expect(extractRegisteredCityFromViesAddress('VIA VENEZUELA 15/A , 35127 PADOVA PD,')).toBe('PADOVA');
    expect(extractRegisteredCityFromViesAddress('VIA DELLA TECNICA 16-16/A , 60015 FALCONARA MARITTIMA AN,')).toBe('FALCONARA MARITTIMA');
    expect(extractRegisteredCityFromViesAddress('---')).toBeUndefined();
    expect(extractRegisteredCityFromViesAddress('VIA ROMA 12')).toBeUndefined();
  });

  it('marks German redacted responses (name="---") with nameRedacted=true and omits legalName/registeredCity', async () => {
    const httpClient = vi.fn(async () => ({
      status: 200,
      ok: true,
      text: JSON.stringify({
        isValid: true,
        requestDate: '2026-11-26T05:10:00.000Z',
        userError: 'VALID',
        name: '---',
        address: '---',
      }),
    }));

    const result = await checkViesVat(
      { countryCode: 'DE', vatNumber: '252368289' },
      { httpClient, nowMs: () => clock },
    );
    expect(result).toEqual({
      status: 'VALID',
      countryCode: 'DE',
      isoCountry: 'DE',
      vatNumber: '252368289',
      vatId: 'DE252368289',
      requestDate: '2026-11-26',
      nameRedacted: true,
    });
    expect(result.legalName).toBeUndefined();
    expect(result.registeredCity).toBeUndefined();
  });

  it('maps Greece GR -> VIES EL path while returning isoCountry=GR', async () => {
    const httpClient = vi.fn(async (url: string) => {
      expect(url).toContain('/ms/EL/vat/094014201');
      return {
        status: 200,
        ok: true,
        text: JSON.stringify({
          isValid: true,
          userError: 'VALID',
          name: 'HELLAS SOLAR AE',
          address: '10563 ATHINA',
        }),
      };
    });

    const result = await checkViesVat(
      { countryCode: 'GR', vatNumber: '094014201' },
      { httpClient, nowMs: () => clock },
    );
    expect(result.countryCode).toBe('EL');
    expect(result.isoCountry).toBe('GR');
    expect(result.vatId).toBe('EL094014201');
  });

  it('returns INVALID only for HTTP 200 with isValid=false and userError=INVALID', async () => {
    const httpClient = vi.fn(async () => ({
      status: 200,
      ok: true,
      text: JSON.stringify({
        isValid: false,
        userError: 'INVALID',
        name: '---',
        address: '---',
      }),
    }));

    const result = await checkViesVat(
      { countryCode: 'IT', vatNumber: '04553650989' },
      { httpClient, nowMs: () => clock },
    );
    expect(result.status).toBe('INVALID');
    expect(result.nameRedacted).toBe(true);
  });

  it('classifies HTTP 429/500 errorWrappers and HTTP 200 userError rate-limit/outage as ViesTransientError (never INVALID) and cools down that country', async () => {
    const rateLimitedClient = vi.fn(async () => ({
      status: 500,
      ok: false,
      text: JSON.stringify({
        actionSucceed: false,
        errorWrappers: [{ error: 'MS_MAX_CONCURRENT_REQ' }],
      }),
    }));

    const firstErr = await checkViesVat(
      { countryCode: 'IT', vatNumber: '04553650989' },
      { httpClient: rateLimitedClient, nowMs: () => clock },
    ).catch((e: unknown) => e);
    expect(firstErr).toBeInstanceOf(ViesTransientError);
    expect(firstErr).toMatchObject({ name: 'ViesTransientError', code: 'VIES_RATE_LIMITED' });
    expect(viesTransientErrorCountry(firstErr as ViesTransientError)).toBe('IT');
    expect(isExecutionControlError(firstErr)).toBe(false);

    // Immediate retry for IT hits process-local cooldown without hitting network
    const secondErr = await checkViesVat(
      { countryCode: 'IT', vatNumber: '02053810517' },
      { httpClient: rateLimitedClient, nowMs: () => clock },
    ).catch((e: unknown) => e);
    expect(secondErr).toMatchObject({ name: 'ViesTransientError', code: 'VIES_RATE_LIMITED_COOLDOWN' });
    expect(viesTransientErrorCountry(secondErr as ViesTransientError)).toBe('IT');
    expect(isExecutionControlError(secondErr)).toBe(false);
    expect(rateLimitedClient).toHaveBeenCalledTimes(1);

    // A different country is NOT blocked by IT's cooldown
    const frUnavailableClient = vi.fn(async () => ({
      status: 200,
      ok: true,
      text: JSON.stringify({
        isValid: false,
        userError: 'MS_UNAVAILABLE',
      }),
    }));
    const frErr = await checkViesVat(
      { countryCode: 'FR', vatNumber: '44732829320' },
      { httpClient: frUnavailableClient, nowMs: () => clock },
    ).catch((e: unknown) => e);
    expect(frErr).toBeInstanceOf(ViesTransientError);
    expect(frErr).toMatchObject({ code: 'VIES_UNAVAILABLE' });
    expect(isExecutionControlError(frErr)).toBe(false);
    await expect(
      checkViesVat({ countryCode: 'FR', vatNumber: '44732829320' }, { httpClient: frUnavailableClient, nowMs: () => clock }),
    ).rejects.toMatchObject({ code: 'VIES_RATE_LIMITED_COOLDOWN' });
    expect(frUnavailableClient).toHaveBeenCalledTimes(1);
  });

  it('does NOT poison member-state cooldown on HTTP 400 INVALID_INPUT for a single request', async () => {
    const httpClient = vi
      .fn()
      .mockResolvedValueOnce({
        status: 400,
        ok: false,
        text: JSON.stringify({
          actionSucceed: false,
          errorWrappers: [{ error: 'INVALID_INPUT' }],
        }),
      })
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        text: JSON.stringify({
          isValid: true,
          requestDate: '2026-11-26T05:10:00.000Z',
          userError: 'VALID',
          name: 'EFFE ENERGY SRL',
          address: 'VIA BENEDETTO CASTELLI 9/11 \n25064 GUSSAGO BS\n',
        }),
      });

    const err = await checkViesVat(
      { countryCode: 'IT', vatNumber: '04553650989' },
      { httpClient, nowMs: () => clock },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ViesTransientError);
    expect(err).toMatchObject({ code: 'VIES_UNAVAILABLE' });

    // Immediate next IT request is NOT blocked by cooldown and succeeds normally.
    const next = await checkViesVat(
      { countryCode: 'IT', vatNumber: '04553650989' },
      { httpClient, nowMs: () => clock },
    );
    expect(next.status).toBe('VALID');
    expect(next.legalName).toBe('EFFE ENERGY SRL');
    expect(httpClient).toHaveBeenCalledTimes(2);
  });
});
