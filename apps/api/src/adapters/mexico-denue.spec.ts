import { describe, expect, it, vi } from 'vitest';
import {
  isValidPublishedClee,
  parseMexicoDenueResponse,
  searchMexicoDenue,
} from './mexico-denue';
import type { PublicHttpRequestOptions, PublicHttpResponse } from './guarded-http';

const legalEntity = {
  CLEE: '25012713120003411000000000U6',
  Id: '1234567890',
  Nombre: 'NISSAN MEXICANA',
  Razon_social: 'NISSAN MEXICANA, S.A. DE C.V.',
  Clase_actividad: 'Fabricacion de automoviles',
  Estrato: '251 y mas personas',
  Entidad: 'AGUASCALIENTES',
  Municipio: 'AGUASCALIENTES',
  Localidad: 'AGUASCALIENTES',
  Tipo: 'Fijo',
  Sitio_internet: 'https://www.nissan.com.mx/?email=person@example.test&token=secret#private',
  Telefono: '4490000000',
  Correo_e: 'private@example.test',
  Calle: 'MUST_NOT_SURVIVE',
  Num_Exterior: '10',
  CP: '01000',
  Latitud: '21.8',
  Longitud: '-102.3',
  Unknown: 'SECRET_UNKNOWN_FIELD',
};

function response(value: unknown, finalUrl: string): PublicHttpResponse {
  const body = Buffer.from(JSON.stringify(value));
  return { status: 200, ok: true, headers: { 'content-type': 'application/json' }, body, text: body.toString(), finalUrl };
}

describe('Mexico DENUE official adapter', () => {
  it('validates only the published CLEE structure without claiming its unpublished checksum algorithm', () => {
    expect(isValidPublishedClee('25012713120003411000000000U6')).toBe(true);
    expect(isValidPublishedClee('00000000000000000000000000U6')).toBe(false);
    expect(isValidPublishedClee('25012713120003411000000000X6')).toBe(false);
    expect(isValidPublishedClee('25012713120003411000000000U')).toBe(false);
  });

  it('admits legal organizations and structurally drops every contact and precise-location field', () => {
    const records = parseMexicoDenueResponse([
      legalEntity,
      { ...legalEntity, Id: '1234567891', Razon_social: '' },
      { ...legalEntity, Id: '1234567892', Razon_social: 'JUAN PEREZ LOPEZ' },
      { ...legalEntity, Id: '1234567893', CLEE: 'bad-clee' },
      { ...legalEntity, Id: '1234567894', Razon_social: 'JUAN S C PEREZ' },
      { ...legalEntity, Id: '1234567895', Razon_social: 'JUAN DEL MUNICIPIO PEREZ' },
      { ...legalEntity, Id: '12345678901' },
    ]);
    expect(records).toEqual([{
      clee: legalEntity.CLEE,
      denueId: legalEntity.Id,
      name: legalEntity.Nombre,
      legalName: legalEntity.Razon_social,
      economicActivity: legalEntity.Clase_actividad,
      size: legalEntity.Estrato,
      state: legalEntity.Entidad,
      municipality: legalEntity.Municipio,
      locality: legalEntity.Localidad,
      establishmentType: legalEntity.Tipo,
      website: 'https://www.nissan.com.mx/',
    }]);
    expect(JSON.stringify(records)).not.toMatch(/private|person@example|token|telefono|correo|calle|num_exterior|cp|latitud|longitud|SECRET_UNKNOWN_FIELD|MUST_NOT_SURVIVE/iu);
  });

  it('uses Nombre with a bounded state page and never returns the path token', async () => {
    const token = 'secret-denue-token';
    const request = vi.fn(async (raw: string, options?: PublicHttpRequestOptions) => {
      expect(raw).toContain('/Nombre/NISSAN%20MEXICANA/01/1/2/');
      expect(raw).toContain(token);
      expect(options).toMatchObject({ maxRedirects: 0, maxBytes: 2 * 1024 * 1024 });
      return response([legalEntity], raw);
    });
    const page = await searchMexicoDenue(
      { query: 'NISSAN MEXICANA', stateCode: '01', start: 1, limit: 2 },
      undefined,
      { request: request as never, env: { MEXICO_DENUE_TOKEN: token } },
    );
    expect(page.records).toHaveLength(1);
    expect(page.provenance.sourceUrl).toContain('REDACTED_TOKEN');
    expect(JSON.stringify(page)).not.toContain(token);
  });

  it('hashes only the sanitized allowlist so discarded PII changes do not create drift', async () => {
    const token = 'secret-denue-token';
    const makeRequest = (phone: string) => vi.fn(async (raw: string) => response([{ ...legalEntity, Telefono: phone }], raw));
    const first = await searchMexicoDenue(
      { query: 'NISSAN MEXICANA', stateCode: '01', start: 1, limit: 2 }, undefined,
      { request: makeRequest('111') as never, env: { MEXICO_DENUE_TOKEN: token } },
    );
    const second = await searchMexicoDenue(
      { query: 'NISSAN MEXICANA', stateCode: '01', start: 1, limit: 2 }, undefined,
      { request: makeRequest('999') as never, env: { MEXICO_DENUE_TOKEN: token } },
    );
    expect(first.provenance.contentHash).toBe(second.provenance.contentHash);
  });

  it('fails before egress for missing credentials, national scope, bulk terms and invalid bounds', async () => {
    const request = vi.fn();
    const valid = { query: 'NISSAN MEXICANA', stateCode: '01', start: 1, limit: 2 };
    await expect(searchMexicoDenue(valid, undefined, { request, env: {} })).rejects.toThrow('DENUE_TOKEN_REQUIRED');
    await expect(searchMexicoDenue({ ...valid, stateCode: '00' }, undefined, { request, env: { MEXICO_DENUE_TOKEN: 'token' } }))
      .rejects.toThrow('DENUE_STATE_CODE_INVALID');
    await expect(searchMexicoDenue({ ...valid, query: 'todos' }, undefined, { request, env: { MEXICO_DENUE_TOKEN: 'token' } }))
      .rejects.toThrow('DENUE_EXACT_QUERY_REQUIRED');
    await expect(searchMexicoDenue({ ...valid, query: 'pump, valve' }, undefined, { request, env: { MEXICO_DENUE_TOKEN: 'token' } }))
      .rejects.toThrow('DENUE_EXACT_QUERY_REQUIRED');
    await expect(searchMexicoDenue({ ...valid, limit: 21 }, undefined, { request, env: { MEXICO_DENUE_TOKEN: 'token' } }))
      .rejects.toThrow('DENUE_LIMIT_INVALID');
    expect(request).not.toHaveBeenCalled();
  });

  it('rethrows stable errors without leaking a token from transport failures', async () => {
    const token = 'secret-denue-token';
    const request = vi.fn(async () => { throw new Error(`failed URL containing ${token}`); });
    let captured: unknown;
    try {
      await searchMexicoDenue(
        { query: 'NISSAN MEXICANA', stateCode: '01', start: 1, limit: 2 }, undefined,
        { request: request as never, env: { MEXICO_DENUE_TOKEN: token } },
      );
    } catch (error) {
      captured = error;
    }
    expect(String(captured)).toContain('DENUE_REQUEST_FAILED');
    expect(String(captured)).not.toContain(token);
  });
});
