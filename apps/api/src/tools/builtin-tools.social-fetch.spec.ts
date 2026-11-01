import { describe, expect, it, vi } from 'vitest';

const http = vi.hoisted(() => ({ requestPublicHttp: vi.fn() }));
vi.mock('../adapters/guarded-http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../adapters/guarded-http')>()),
  requestPublicHttp: http.requestPublicHttp,
}));

import { socialFetchTool } from './builtin-tools';
import { EgressBlockedError } from '../adapters/url-guard';
import { TypedProjectionRegistry } from '../durable-results/typed-projection.registry';
import { registerCatalogResultProjections } from '../durable-results/catalog-result-projections';
import type { ToolContext } from './tool-contract';

const CTX = {} as ToolContext;

function okResponse(text: string, status = 200) {
  return { status, ok: status >= 200 && status < 300, finalUrl: '', body: Buffer.from(text, 'utf8'), headers: {} };
}

describe('social.fetch (D1 social layer fetch tool)', () => {
  it('allows only Wayback and public social person-profile targets', async () => {
    for (const url of [
      'https://archive.org/wayback/available?url=https%3A%2F%2Fwww.xing.com%2Fprofile%2FX',
      'https://web.archive.org/web/20260101/https://www.linkedin.com/in/max',
      'https://www.linkedin.com/in/max-mustermann',
      'https://de.linkedin.com/pub/erika-musterfrau/12/345',
      'https://www.xing.com/profile/Max_Mustermann',
    ]) {
      http.requestPublicHttp.mockResolvedValueOnce(okResponse('ok'));
      await expect(socialFetchTool.execute({ url }, CTX)).resolves.toMatchObject({
        data: { status: 200, text: 'ok' },
      });
    }
    for (const url of [
      'https://www.linkedin.com/company/pumpen-schmid',
      'https://pumpen-schmid.de/team',
      'https://archive.org/details/some-item',
      'not a url',
    ]) {
      await expect(socialFetchTool.execute({ url }, CTX)).rejects.toThrow(/SOCIAL_FETCH_(URL_INVALID|HOST_NOT_ALLOWED)/);
    }
    expect(socialFetchTool.compliance.personalData).toBe(true);
    expect(socialFetchTool.rateLimit.perDomainCrawlDelayMs).toBe(3000);
  });

  it('bounds text to the projection contract and reports the HTTP status', async () => {
    http.requestPublicHttp.mockResolvedValueOnce(okResponse('x'.repeat(50_000)));
    const result = await socialFetchTool.execute(
      { url: 'https://www.linkedin.com/in/max-mustermann' },
      CTX,
    );
    expect(result.data.text).toHaveLength(36_000);
    expect(result.data.status).toBe(200);
    const registry = registerCatalogResultProjections(new TypedProjectionRegistry());
    expect(() => registry.project('social-fetch/v1', result)).not.toThrow();
  });

  it('returns status 0 for an egress-blocked callback without inventing a target refusal', async () => {
    http.requestPublicHttp.mockRejectedValueOnce(new EgressBlockedError('private_address'));
    const result = await socialFetchTool.execute(
      { url: 'https://www.xing.com/profile/Max_Mustermann' },
      CTX,
    );
    expect(result).toEqual({
      data: { url: 'https://www.xing.com/profile/Max_Mustermann', status: 0, text: '' },
      costCents: 0,
    });
  });

  it('projects and restores through social-fetch/v1', async () => {
    http.requestPublicHttp.mockResolvedValueOnce(okResponse('<html>Max Mustermann</html>'));
    const result = await socialFetchTool.execute(
      { url: 'https://www.linkedin.com/in/max-mustermann' },
      CTX,
    );
    const registry = registerCatalogResultProjections(new TypedProjectionRegistry());
    const projected = registry.project('social-fetch/v1', result) as unknown as {
      data: { data: { url: string; status: number; text: string } };
    };
    expect(projected.data.data).toMatchObject({
      url: 'https://www.linkedin.com/in/max-mustermann',
      status: 200,
      text: '<html>Max Mustermann</html>',
    });
    expect(registry.restore(JSON.parse(JSON.stringify(projected)))).toMatchObject({
      data: { url: 'https://www.linkedin.com/in/max-mustermann', status: 200 },
    });
  });
});
