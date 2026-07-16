import { describe, expect, it, vi } from 'vitest';
import { ProfileVersionConflictException } from './profile-contract';
import { SitesController } from './sites.controller';

const CTX = {
  userId: 'u1',
  workspaceId: '11111111-1111-4111-8111-111111111111',
  roles: [],
};
const SITE_ID = '22222222-2222-4222-8222-222222222222';
const V0 = '33333333-3333-4333-8333-333333333333';
const V1 = '44444444-4444-4444-8444-444444444444';

function fakeResponse() {
  return { setHeader: vi.fn() };
}

describe('R2-A3 Profile HTTP headers', () => {
  it('GET and successful PATCH return body versionId, matching strong ETag, and private cache policy', async () => {
    const sites = {
      getProfile: vi
        .fn()
        .mockResolvedValue({ versionId: V0, brand: { slogan: 'A' } }),
      patchProfile: vi
        .fn()
        .mockResolvedValue({ versionId: V1, brand: { slogan: 'B' } }),
    };
    const controller = new SitesController(sites as never);
    const getResponse = fakeResponse();
    const get = await controller.getProfile(CTX, SITE_ID, getResponse as never);
    expect(get).toEqual({ data: { versionId: V0, brand: { slogan: 'A' } } });
    expect(getResponse.setHeader).toHaveBeenCalledWith(
      'ETag',
      `"profile:${V0}"`,
    );
    expect(getResponse.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'private, no-cache',
    );

    const patchResponse = fakeResponse();
    const patched = await controller.patchProfile(
      CTX,
      SITE_ID,
      `"profile:${V0}"`,
      { baseVersionId: V0, groups: { brand: { slogan: 'B' } } },
      patchResponse as never,
    );
    expect(patched.data.versionId).toBe(V1);
    expect(sites.patchProfile).toHaveBeenCalledWith(
      CTX,
      SITE_ID,
      { brand: { slogan: 'B' } },
      { expectedVersionId: V0, source: 'if-match' },
    );
    expect(patchResponse.setHeader).toHaveBeenCalledWith(
      'ETag',
      `"profile:${V1}"`,
    );
  });

  it('stale PATCH exposes the current ETag without returning current Profile data', async () => {
    const conflict = new ProfileVersionConflictException(V1, SITE_ID, {
      expectedVersionId: V0,
      source: 'if-match',
    });
    const sites = { patchProfile: vi.fn().mockRejectedValue(conflict) };
    const controller = new SitesController(sites as never);
    const response = fakeResponse();
    await expect(
      controller.patchProfile(
        CTX,
        SITE_ID,
        `"profile:${V0}"`,
        { groups: { brand: {} } },
        response as never,
      ),
    ).rejects.toBe(conflict);
    expect(response.setHeader).toHaveBeenCalledWith('ETag', `"profile:${V1}"`);
  });
});
