import { HttpException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  buildRequestHash,
  normalizeBuildRequest,
} from './build-request-contract';
import { normalizeIdempotencyKey } from './idempotency-key';

function contract(error: unknown) {
  if (!(error instanceof HttpException)) return {};
  return {
    status: error.getStatus(),
    body: error.getResponse(),
  };
}

describe('normalizeBuildRequest', () => {
  it('accepts only options implemented by the current full-site assembler', () => {
    expect(
      normalizeBuildRequest({
        scope: 'site',
        options: {
          stylePreset: 'precision-light',
          locales: ['en'],
        },
      }),
    ).toEqual({
      scope: 'site',
      options: { stylePreset: 'precision-light', locales: ['en'] },
    });
  });

  it('rejects malformed scope/target and unknown options as validation errors', () => {
    const cases = [
      { scope: 'site', targetId: 'home' },
      { scope: 'page' },
      { scope: 'section', targetId: 'bad id' },
      { scope: 'site', options: { unexpected: true } },
      { scope: 'site', options: { stylePreset: 'not-real' } },
    ];
    for (const input of cases) {
      const error = (() => {
        try {
          normalizeBuildRequest(input as never);
        } catch (caught) {
          return caught;
        }
      })();
      expect(contract(error)).toMatchObject({
        status: 400,
        body: { error: { code: 'VALIDATION_ERROR' } },
      });
    }
  });

  it('accepts valid page/section scope for the active SiteSpec consumer', () => {
    for (const scope of ['page', 'section'] as const) {
      expect(normalizeBuildRequest({ scope, targetId: 'home:hero-1' })).toEqual(
        {
          scope,
          targetId: 'home:hero-1',
        },
      );
    }
  });

  it('rejects option combinations that would escape the requested scope', () => {
    const cases = [
      { scope: 'page', targetId: 'home', options: { pages: ['home'] } },
      {
        scope: 'section',
        targetId: 'hero',
        options: { stylePreset: 'modern-industrial' },
      },
      {
        scope: 'site',
        options: { pages: ['home'], stylePreset: 'precision-light' },
      },
    ];
    for (const input of cases) {
      const error = (() => {
        try {
          normalizeBuildRequest(input as never);
        } catch (caught) {
          return caught;
        }
      })();
      expect(contract(error)).toMatchObject({
        status: 422,
        body: {
          error: { code: 'BUILD_OPTION_UNAVAILABLE' },
        },
      });
    }
  });

  it('validates and accepts pages for deterministic partial rebuilding', () => {
    for (const pages of [[], ['home', 'home'], ['bad id']]) {
      const error = (() => {
        try {
          normalizeBuildRequest({ scope: 'site', options: { pages } });
        } catch (caught) {
          return caught;
        }
      })();
      expect(contract(error)).toMatchObject({
        status: 400,
        body: { error: { code: 'VALIDATION_ERROR' } },
      });
    }

    expect(
      normalizeBuildRequest({
        scope: 'site',
        options: { pages: ['home', 'products'] },
      }),
    ).toEqual({
      scope: 'site',
      options: { pages: ['home', 'products'] },
    });
  });

  it('canonicalizes locales and rejects invalid, duplicate, or unsupported locale sets', () => {
    for (const locales of [['not_a_tag'], ['en-US', 'en-us']]) {
      const error = (() => {
        try {
          normalizeBuildRequest({ scope: 'site', options: { locales } });
        } catch (caught) {
          return caught;
        }
      })();
      expect(contract(error)).toMatchObject({
        status: 400,
        body: { error: { code: 'VALIDATION_ERROR' } },
      });
    }

    const unavailable = (() => {
      try {
        normalizeBuildRequest({ scope: 'site', options: { locales: ['de'] } });
      } catch (caught) {
        return caught;
      }
    })();
    expect(contract(unavailable)).toMatchObject({
      status: 422,
      body: { error: { code: 'BUILD_OPTION_UNAVAILABLE' } },
    });
  });

  it('produces a stable request fingerprint after normalization', () => {
    const first = normalizeBuildRequest({
      scope: 'site',
      options: { stylePreset: 'modern-industrial', locales: ['EN'] },
    });
    const second = normalizeBuildRequest({
      scope: 'site',
      options: { stylePreset: 'modern-industrial', locales: ['en'] },
    });
    expect(buildRequestHash('site-1', first)).toBe(
      buildRequestHash('site-1', second),
    );
    expect(buildRequestHash('site-1', first)).not.toBe(
      buildRequestHash('site-2', second),
    );
  });
});

describe('normalizeIdempotencyKey', () => {
  it('normalizes bounded safe keys and rejects ambiguous keys', () => {
    expect(normalizeIdempotencyKey('build:customer_1-42')).toBe(
      'build:customer_1-42',
    );
    for (const key of ['', 'has space', ' padded-key ', 'x'.repeat(129)]) {
      const error = (() => {
        try {
          normalizeIdempotencyKey(key);
        } catch (caught) {
          return caught;
        }
      })();
      expect(contract(error)).toMatchObject({
        status: 400,
        body: { error: { code: 'INVALID_IDEMPOTENCY_KEY' } },
      });
    }
  });
});
