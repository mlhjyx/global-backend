import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
} from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildRequestHash, normalizeBuildRequest } from './build-request-contract';
import { intakeRequestHash, type IntakeInput } from './intake.service';
import { SiteBuildBudgetGrantVerifier } from './site-build-budget-grant';
import {
  SiteBuildTechnicalBudgetQuoteService,
  type SiteBuildTechnicalBudgetQuote,
  type TechnicalBudgetRoute,
} from './site-build-technical-budget-quote';

type IntakeGoldenRequest = Readonly<{
  readonly operation: 'intake';
  readonly workspaceId: string;
  readonly siteId: null;
  readonly input: IntakeInput;
}>;

type RefurbishGoldenRequest = Readonly<{
  readonly operation: 'refurbish';
  readonly workspaceId: string;
  readonly siteId: string;
  readonly input: Readonly<{
    readonly scope: 'site' | 'page' | 'section';
    readonly targetId?: string;
    readonly options?: Readonly<{
      readonly stylePreset?: string;
      readonly pages?: readonly string[];
      readonly locales?: readonly string[];
    }>;
  }>;
}>;

type GoldenRequest = IntakeGoldenRequest | RefurbishGoldenRequest;

interface GoldenExpected {
  readonly requestSha256: string;
  readonly normalizedRequest: Record<string, unknown> | null;
  readonly quote: SiteBuildTechnicalBudgetQuote;
  readonly protectedHeader: Readonly<{
    readonly alg: 'RS256';
    readonly kid: string;
    readonly typ: 'site-build-budget-grant+jwt';
  }>;
  readonly claims: Readonly<{
    readonly iss: string;
    readonly aud: 'global-backend:site-builder-budget';
    readonly jti: string;
    readonly schema_version: 'site-builder-budget-grant/v1';
    readonly purpose: 'site_builder.build_run';
    readonly operation: 'intake' | 'refurbish';
    readonly workspace_id: string;
    readonly site_id?: string;
    readonly request_sha256: string;
    readonly currency: 'USD';
    readonly unit: 'microusd';
    readonly cap_microusd: string;
    readonly iat: number;
    readonly nbf: number;
    readonly exp: number;
  }>;
}

interface GoldenVector {
  readonly id: string;
  readonly request: GoldenRequest;
  readonly expected: GoldenExpected;
}

interface GoldenDocument {
  readonly schemaVersion: 'site-builder-budget-golden-vectors/v1';
  readonly frozenNow: string;
  readonly vectors: readonly GoldenVector[];
}

const ROUTES: Record<string, TechnicalBudgetRoute> = {
  'site_builder.brand_profile': {
    primary: 'gpt-5.6-terra',
    fallbacks: ['claude-sonnet-5'],
    maxCostCents: 40,
    maxTokens: 12_000,
  },
  'site_builder.copy': {
    primary: 'claude-sonnet-5',
    fallbacks: [],
    maxCostCents: 20,
    maxTokens: 4_000,
  },
};

const FIXTURE_SHA256 =
  '6e1e4df075004639dd81d2e82341306d1adea4c937d350893bc41aecee6152da';

let privateKey: CryptoKey;
let keyResolver: ReturnType<typeof createLocalJWKSet>;

function fixtureBytes(): Buffer {
  return readFileSync(
    resolve(
      process.cwd(),
      '../../packages/contracts/fixtures/site-builder/site-build-budget.v1.json',
    ),
  );
}

function document(): GoldenDocument {
  return JSON.parse(fixtureBytes().toString('utf8')) as GoldenDocument;
}

function exactKeys(value: unknown, expected: readonly string[]): void {
  expect(value).not.toBeNull();
  expect(typeof value).toBe('object');
  expect(Array.isArray(value)).toBe(false);
  expect(Object.keys(value as Record<string, unknown>).sort()).toEqual(
    [...expected].sort(),
  );
}

function assertClosedVector(vector: GoldenVector): void {
  exactKeys(vector, ['id', 'request', 'expected']);
  exactKeys(vector.expected, [
    'claims',
    'normalizedRequest',
    'protectedHeader',
    'quote',
    'requestSha256',
  ]);
  exactKeys(vector.expected.protectedHeader, ['alg', 'kid', 'typ']);
  exactKeys(
    vector.expected.claims,
    vector.request.operation === 'intake'
      ? [
          'aud',
          'cap_microusd',
          'currency',
          'exp',
          'iat',
          'iss',
          'jti',
          'nbf',
          'operation',
          'purpose',
          'request_sha256',
          'schema_version',
          'unit',
          'workspace_id',
        ]
      : [
          'aud',
          'cap_microusd',
          'currency',
          'exp',
          'iat',
          'iss',
          'jti',
          'nbf',
          'operation',
          'purpose',
          'request_sha256',
          'schema_version',
          'site_id',
          'unit',
          'workspace_id',
        ],
  );
  exactKeys(vector.expected.quote, [
    'currency',
    'expiresAt',
    'operation',
    'policyRevision',
    'requestSha256',
    'requiredCapMicrousd',
    'schemaVersion',
    'siteId',
    'unit',
  ]);
  expect(vector.id).toMatch(/^[a-z][a-z0-9-]{0,79}$/);
  expect(vector.expected.requestSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(vector.expected.quote.requiredCapMicrousd).toMatch(/^[1-9][0-9]*$/);
  expect(vector.expected.quote.policyRevision).toMatch(/^[0-9a-f]{64}$/);
  expect(vector.expected.protectedHeader.kid).toMatch(/^[-A-Za-z0-9._]{1,191}$/);
  expect(vector.expected.claims.iat).toBeLessThanOrEqual(
    vector.expected.claims.nbf,
  );
  expect(vector.expected.claims.nbf).toBeLessThanOrEqual(
    vector.expected.claims.exp,
  );
  expect(vector.expected.claims.exp - vector.expected.claims.iat).toBe(300);
  if (vector.request.operation === 'intake') {
    exactKeys(vector.request, ['input', 'operation', 'siteId', 'workspaceId']);
    expect(vector.expected.normalizedRequest).toBeNull();
    expect(vector.expected.quote.siteId).toBeNull();
    expect(vector.expected.claims.site_id).toBeUndefined();
  } else {
    exactKeys(vector.request, ['input', 'operation', 'siteId', 'workspaceId']);
    expect(vector.request.siteId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(vector.expected.normalizedRequest).not.toBeNull();
    expect(vector.expected.quote.siteId).toBe(vector.request.siteId);
    expect(vector.expected.claims.site_id).toBe(vector.request.siteId);
  }
}

function quoteService(now: Date): SiteBuildTechnicalBudgetQuoteService {
  return new SiteBuildTechnicalBudgetQuoteService({}, {
    now: () => now,
    resolveRoute: (taskId) => ROUTES[taskId]!,
  });
}

function expectedScope(vector: GoldenVector): {
  readonly workspaceId: string;
  readonly operation: 'intake' | 'refurbish';
  readonly requestSha256: string;
  readonly siteId?: string;
} {
  return {
    workspaceId: vector.request.workspaceId,
    operation: vector.request.operation,
    requestSha256: vector.expected.requestSha256,
    ...(vector.request.siteId === null ? {} : { siteId: vector.request.siteId }),
  };
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  keyResolver = createLocalJWKSet({
    keys: [{ ...jwk, kid: 'site-builder-golden-v1', alg: 'RS256' }],
  });
});

describe('Site Builder cross-repository budget golden vectors', () => {
  it('pins the raw fixture bytes for cross-repository replay', () => {
    expect(createHash('sha256').update(fixtureBytes()).digest('hex')).toBe(
      FIXTURE_SHA256,
    );
  });

  it('locks a closed, versioned fixture containing no compact JWS or credential material', () => {
    const fixture = document();
    exactKeys(fixture, ['frozenNow', 'schemaVersion', 'vectors']);
    expect(fixture.schemaVersion).toBe('site-builder-budget-golden-vectors/v1');
    expect(fixture.vectors).toHaveLength(2);
    expect(new Set(fixture.vectors.map((vector) => vector.id)).size).toBe(2);
    expect(fixture.vectors.map((vector) => vector.request.operation)).toEqual([
      'intake',
      'refurbish',
    ]);
    expect(JSON.stringify(fixture)).toContain('泵');
    expect(JSON.stringify(fixture)).not.toMatch(/(?:private[_-]?key|access[_-]?token|cookie|eyJ[A-Za-z0-9_-]*\.)/i);
    fixture.vectors.forEach(assertClosedVector);
  });

  it.each(document().vectors)(
    'recomputes $id request, quote, and technical cap byte-exactly',
    (vector) => {
      const now = new Date(document().frozenNow);
      const expectedRequestHash =
        vector.request.operation === 'intake'
          ? intakeRequestHash(vector.request.input)
          : buildRequestHash(
              vector.request.siteId,
              normalizeBuildRequest(vector.request.input),
            );
      const normalizedRequest =
        vector.request.operation === 'intake'
          ? null
          : normalizeBuildRequest(vector.request.input);
      const quote =
        vector.request.operation === 'intake'
          ? quoteService(now).quoteIntake(expectedRequestHash)
          : quoteService(now).quoteRefurbish(
              vector.request.siteId,
              expectedRequestHash,
            );

      expect(expectedRequestHash).toBe(vector.expected.requestSha256);
      expect(normalizedRequest).toEqual(vector.expected.normalizedRequest);
      expect(quote).toEqual(vector.expected.quote);
      expect(vector.expected.claims.request_sha256).toBe(expectedRequestHash);
      expect(vector.expected.claims.cap_microusd).toBe(
        vector.expected.quote.requiredCapMicrousd,
      );
      expect(vector.expected.claims.operation).toBe(vector.request.operation);
    },
  );

  it.each(document().vectors)(
    'signs $id fixture claims that the production verifier accepts',
    async (vector) => {
      const claims = vector.expected.claims;
      const raw = await new SignJWT({
        schema_version: claims.schema_version,
        purpose: claims.purpose,
        operation: claims.operation,
        workspace_id: claims.workspace_id,
        ...(claims.site_id === undefined ? {} : { site_id: claims.site_id }),
        request_sha256: claims.request_sha256,
        currency: claims.currency,
        unit: claims.unit,
        cap_microusd: claims.cap_microusd,
      })
        .setProtectedHeader(vector.expected.protectedHeader)
        .setIssuer(claims.iss)
        .setAudience(claims.aud)
        .setJti(claims.jti)
        .setIssuedAt(claims.iat)
        .setNotBefore(claims.nbf)
        .setExpirationTime(claims.exp)
        .sign(privateKey);
      const verifier = new SiteBuildBudgetGrantVerifier(
        {
          SITE_BUILD_BUDGET_GRANT_JWKS_URI:
            'https://saas.example.test/.well-known/jwks.json',
          SITE_BUILD_BUDGET_GRANT_ISSUER: claims.iss,
          SITE_BUILD_BUDGET_GRANT_AUDIENCE: claims.aud,
          SITE_BUILD_BUDGET_GRANT_ALGORITHMS: 'RS256',
        },
        { keyResolver, now: () => new Date(document().frozenNow) },
      );

      await expect(verifier.verify(raw, expectedScope(vector))).resolves.toMatchObject({
        issuer: claims.iss,
        audience: claims.aud,
        jti: claims.jti,
        purpose: claims.purpose,
        operation: claims.operation,
        workspaceId: claims.workspace_id,
        siteId: vector.request.siteId,
        requestSha256: claims.request_sha256,
        currency: claims.currency,
        unit: claims.unit,
        capMicrousd: BigInt(claims.cap_microusd),
        issuedAt: new Date(claims.iat * 1_000),
        notBefore: new Date(claims.nbf * 1_000),
        expiresAt: new Date(claims.exp * 1_000),
      });
    },
  );
});
