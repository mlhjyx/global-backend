import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  PipeTransform,
} from '@nestjs/common';
import Ajv, { ErrorObject } from 'ajv';
import addFormats from 'ajv-formats';
import { PROFILE_GROUPS, Profile } from './profile-merge';

export const PROFILE_MAX_BYTES = 64 * 1024;

const GROUP_MAX_BYTES: Record<(typeof PROFILE_GROUPS)[number], number> = {
  companyProfile: 8 * 1024,
  trustAssets: 24 * 1024,
  onlineAssets: 12 * 1024,
  brand: 8 * 1024,
  contact: 8 * 1024,
};

const UUID_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';
const SAFE_TEXT_PATTERN = '^[^\\u0000-\\u001F\\u007F-\\u009F]*$';
const currentYear = new Date().getUTCFullYear();

const text = (maxLength: number, minLength = 1): Record<string, unknown> => ({
  type: 'string',
  minLength,
  maxLength,
  pattern: SAFE_TEXT_PATTERN,
});
const uuid = { type: 'string', pattern: UUID_PATTERN } as const;
const url = {
  type: 'string',
  format: 'uri',
  pattern: '^https?://',
  maxLength: 2048,
} as const;
const email = { type: 'string', format: 'email', maxLength: 254 } as const;
const country = { type: 'string', pattern: '^[A-Z]{2}$' } as const;
const nullable = (
  schema: Record<string, unknown>,
): Record<string, unknown> => ({ ...schema, nullable: true });
const strictObject = (
  properties: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  type: 'object',
  additionalProperties: false,
  properties,
  ...extra,
});
const boundedArray = (
  items: Record<string, unknown>,
  maxItems: number,
): Record<string, unknown> => ({
  type: 'array',
  maxItems,
  uniqueItems: true,
  items,
});

const employeeRange = strictObject({
  min: { type: 'integer', minimum: 0, maximum: 10_000_000 },
  max: { type: 'integer', minimum: 0, maximum: 10_000_000 },
});
const revenueRange = strictObject(
  {
    currency: { type: 'string', pattern: '^[A-Z]{3}$' },
    min: { type: 'number', minimum: 0 },
    max: { type: 'number', minimum: 0 },
  },
  { required: ['currency'] },
);

export const PROFILE_GROUP_SCHEMAS = {
  companyProfile: strictObject({
    foundedYear: { type: 'integer', minimum: 1800, maximum: currentYear },
    employeeCountRange: employeeRange,
    businessType: {
      enum: ['manufacturer', 'trading_company', 'manufacturer_and_trader'],
    },
    city: text(120),
    annualExportRevenue: revenueRange,
    exportMarkets: boundedArray(country, 30),
    capacityDescription: text(500),
    productionLines: boundedArray(text(120), 20),
    moq: text(120),
    leadTime: text(120),
  }),
  trustAssets: strictObject({
    certifications: boundedArray(
      strictObject(
        {
          name: text(100),
          certificateAssetIds: boundedArray(uuid, 5),
        },
        { required: ['name'] },
      ),
      20,
    ),
    patents: boundedArray(
      strictObject(
        { title: text(200), number: text(120), jurisdiction: text(16) },
        { anyOf: [{ required: ['title'] }, { required: ['number'] }] },
      ),
      50,
    ),
    customerCases: boundedArray(
      strictObject(
        {
          displayLabel: text(120),
          industry: text(120),
          country,
          summary: text(500),
          anonymized: { type: 'boolean' },
          assetIds: boundedArray(uuid, 10),
        },
        {
          anyOf: [
            { required: ['displayLabel'] },
            { required: ['industry'] },
            { required: ['summary'] },
          ],
        },
      ),
      20,
    ),
    exhibitions: boundedArray(
      strictObject(
        {
          name: text(120),
          year: { type: 'integer', minimum: 1900, maximum: currentYear + 1 },
          country,
        },
        { required: ['name', 'year'] },
      ),
      30,
    ),
  }),
  onlineAssets: strictObject({
    storefronts: boundedArray(
      strictObject(
        {
          platform: {
            enum: ['alibaba', 'made_in_china', 'global_sources', 'other'],
          },
          url,
          importAuthorized: { type: 'boolean' },
        },
        { required: ['platform', 'url', 'importAuthorized'] },
      ),
      10,
    ),
    socialProfiles: boundedArray(
      strictObject(
        {
          platform: { enum: ['linkedin', 'facebook', 'youtube', 'other'] },
          url,
        },
        { required: ['platform', 'url'] },
      ),
      20,
    ),
    googleBusinessProfiles: boundedArray(url, 5),
  }),
  brand: strictObject({
    logoAssetId: uuid,
    colors: boundedArray({ type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' }, 5),
    referenceSites: boundedArray(url, 3),
    slogan: text(240),
  }),
  contact: strictObject({
    publicEmails: boundedArray(email, 10),
    whatsappNumbers: boundedArray(
      { type: 'string', pattern: '^\\+[1-9][0-9]{7,14}$' },
      5,
    ),
    phoneNumbers: boundedArray(
      { type: 'string', pattern: '^\\+[1-9][0-9]{7,14}$' },
      10,
    ),
    inquiryRecipientEmails: boundedArray(email, 10),
    displaySocialLinks: boundedArray(
      strictObject(
        {
          platform: {
            enum: [
              'linkedin',
              'facebook',
              'youtube',
              'instagram',
              'x',
              'other',
            ],
          },
          url,
          label: text(80),
        },
        { required: ['platform', 'url'] },
      ),
      20,
    ),
  }),
} as const;

export const PROFILE_PATCH_SCHEMA: Record<string, unknown> = strictObject(
  {
    baseVersionId: uuid,
    companyProfile: nullable(PROFILE_GROUP_SCHEMAS.companyProfile),
    trustAssets: nullable(PROFILE_GROUP_SCHEMAS.trustAssets),
    onlineAssets: nullable(PROFILE_GROUP_SCHEMAS.onlineAssets),
    brand: nullable(PROFILE_GROUP_SCHEMAS.brand),
    contact: nullable(PROFILE_GROUP_SCHEMAS.contact),
  },
  { anyOf: PROFILE_GROUPS.map((group) => ({ required: [group] })) },
);

const PROFILE_STATE_SCHEMA: Record<string, unknown> = strictObject({
  ...PROFILE_GROUP_SCHEMAS,
});

export const PROFILE_RESPONSE_SCHEMA: Record<string, unknown> = strictObject(
  {
    versionId: uuid,
    ...PROFILE_GROUP_SCHEMAS,
  },
  { required: ['versionId'] },
);

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validatePatchSchema = ajv.compile(PROFILE_PATCH_SCHEMA);
const validateProfileStateSchema = ajv.compile(PROFILE_STATE_SCHEMA);

export interface ValidatedProfilePatch {
  baseVersionId?: string;
  groups: Profile;
}

export interface ProfilePrecondition {
  expectedVersionId: string;
  source: 'if-match' | 'baseVersionId';
}

export type ProfileResult = Profile & { versionId: string };

function errorBody(
  code: string,
  message: string,
  details?: Record<string, unknown>,
) {
  return { error: { code, message, ...(details ? { details } : {}) } };
}

function profileValidation(
  message: string,
  details?: Record<string, unknown>,
): never {
  throw new HttpException(
    errorBody('PROFILE_VALIDATION_FAILED', message, details),
    422,
  );
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function canonicalUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    profileValidation('invalid profile URL', { reason: 'INVALID_URL' });
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password
  ) {
    profileValidation('invalid profile URL', { reason: 'UNSAFE_URL' });
  }
  parsed.hash = '';
  return parsed.toString();
}

function mapStrings(
  value: unknown,
  mapper: (value: string) => string,
): unknown {
  return Array.isArray(value)
    ? value.map((item) => (typeof item === 'string' ? mapper(item) : item))
    : value;
}

function normalizePatch(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const out = structuredClone(input);
  const company = out.companyProfile;
  if (company && typeof company === 'object' && !Array.isArray(company)) {
    const c = company as Record<string, unknown>;
    for (const key of ['city', 'capacityDescription', 'moq', 'leadTime']) {
      if (typeof c[key] === 'string') c[key] = c[key].trim();
    }
    c.productionLines = mapStrings(c.productionLines, (value) => value.trim());
    c.exportMarkets = mapStrings(c.exportMarkets, (value) =>
      value.trim().toUpperCase(),
    );
    const revenue = c.annualExportRevenue;
    if (revenue && typeof revenue === 'object' && !Array.isArray(revenue)) {
      const r = revenue as Record<string, unknown>;
      if (typeof r.currency === 'string')
        r.currency = r.currency.trim().toUpperCase();
    }
  }

  const trust = out.trustAssets;
  if (trust && typeof trust === 'object' && !Array.isArray(trust)) {
    const t = trust as Record<string, unknown>;
    for (const listName of [
      'certifications',
      'patents',
      'customerCases',
      'exhibitions',
    ]) {
      const list = t[listName];
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const row = item as Record<string, unknown>;
        for (const [key, value] of Object.entries(row)) {
          if (typeof value === 'string')
            row[key] =
              key === 'country' ? value.trim().toUpperCase() : value.trim();
        }
      }
    }
  }

  const online = out.onlineAssets;
  if (online && typeof online === 'object' && !Array.isArray(online)) {
    const o = online as Record<string, unknown>;
    for (const listName of ['storefronts', 'socialProfiles']) {
      const list = o[listName];
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          const row = item as Record<string, unknown>;
          if (typeof row.url === 'string') row.url = canonicalUrl(row.url);
        }
      }
    }
    o.googleBusinessProfiles = mapStrings(
      o.googleBusinessProfiles,
      canonicalUrl,
    );
  }

  const brand = out.brand;
  if (brand && typeof brand === 'object' && !Array.isArray(brand)) {
    const b = brand as Record<string, unknown>;
    b.referenceSites = mapStrings(b.referenceSites, canonicalUrl);
    if (typeof b.slogan === 'string') b.slogan = b.slogan.trim();
  }

  const contact = out.contact;
  if (contact && typeof contact === 'object' && !Array.isArray(contact)) {
    const c = contact as Record<string, unknown>;
    for (const key of ['publicEmails', 'inquiryRecipientEmails']) {
      c[key] = mapStrings(c[key], (value) => value.trim().toLowerCase());
    }
    for (const key of ['whatsappNumbers', 'phoneNumbers'])
      c[key] = mapStrings(c[key], (value) => value.trim());
    const links = c.displaySocialLinks;
    if (Array.isArray(links)) {
      for (const item of links) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const row = item as Record<string, unknown>;
        if (typeof row.url === 'string') row.url = canonicalUrl(row.url);
        if (typeof row.label === 'string') row.label = row.label.trim();
      }
    }
  }
  return out;
}

function firstError(
  errors: ErrorObject[] | null | undefined,
): Record<string, unknown> {
  const first = errors?.[0];
  return first
    ? {
        path: first.instancePath || '/',
        keyword: first.keyword,
        params: first.params,
      }
    : { path: '/' };
}

function assertNoNormalizedDuplicates(value: unknown, path = ''): void {
  if (Array.isArray(value)) {
    const scalarKeys = value
      .filter((item) => typeof item === 'string')
      .map((item) => (item as string).toLowerCase());
    if (new Set(scalarKeys).size !== scalarKeys.length) {
      profileValidation('duplicate profile values', { path });
    }
    const urlKeys = value
      .filter(
        (item) =>
          item &&
          typeof item === 'object' &&
          !Array.isArray(item) &&
          typeof (item as Record<string, unknown>).url === 'string',
      )
      .map((item) =>
        String((item as Record<string, unknown>).url).toLowerCase(),
      );
    if (new Set(urlKeys).size !== urlKeys.length)
      profileValidation('duplicate profile URLs', { path });
    value.forEach((item, index) =>
      assertNoNormalizedDuplicates(item, `${path}/${index}`),
    );
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>,
    )) {
      assertNoNormalizedDuplicates(child, `${path}/${key}`);
    }
  }
}

function assertRanges(groups: Profile): void {
  const company = groups.companyProfile as Record<string, unknown> | undefined;
  for (const key of ['employeeCountRange', 'annualExportRevenue']) {
    const range = company?.[key] as { min?: number; max?: number } | undefined;
    if (
      range?.min !== undefined &&
      range.max !== undefined &&
      range.min > range.max
    ) {
      profileValidation('profile range minimum exceeds maximum', {
        path: `/companyProfile/${key}`,
      });
    }
  }
}

export function assertProfileSize(profile: Profile): void {
  const size = byteLength(profile);
  if (size > PROFILE_MAX_BYTES) {
    profileValidation('profile exceeds 64 KiB', {
      bytes: size,
      maxBytes: PROFILE_MAX_BYTES,
    });
  }
  for (const group of PROFILE_GROUPS) {
    if (!(group in profile) || profile[group] === undefined) continue;
    const groupBytes = byteLength(profile[group]);
    if (groupBytes > GROUP_MAX_BYTES[group]) {
      profileValidation(`${group} exceeds its size limit`, {
        group,
        bytes: groupBytes,
        maxBytes: GROUP_MAX_BYTES[group],
      });
    }
  }
}

/** A successful write must leave the whole resource valid, not merely validate changed groups. */
export function assertValidProfileState(profile: Profile): void {
  if (!validateProfileStateSchema(profile)) {
    profileValidation(
      'stored profile contains invalid fields',
      firstError(validateProfileStateSchema.errors),
    );
  }
  assertNoNormalizedDuplicates(profile);
  assertRanges(profile);
  assertProfileSize(profile);
}

export function validateProfilePatch(input: unknown): ValidatedProfilePatch {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    profileValidation('profile patch must be an object');
  }
  const rawBytes = byteLength(input);
  if (rawBytes > PROFILE_MAX_BYTES) {
    profileValidation('profile patch exceeds 64 KiB', {
      bytes: rawBytes,
      maxBytes: PROFILE_MAX_BYTES,
    });
  }
  const normalized = normalizePatch(input as Record<string, unknown>);
  if (!validatePatchSchema(normalized)) {
    profileValidation(
      'invalid profile fields',
      firstError(validatePatchSchema.errors),
    );
  }
  const record = normalized as Record<string, unknown>;
  const groups: Profile = {};
  for (const group of PROFILE_GROUPS) {
    if (group in record) groups[group] = record[group];
  }
  if (Object.keys(groups).length === 0)
    profileValidation('profile patch must include at least one group');
  assertNoNormalizedDuplicates(groups);
  assertRanges(groups);
  assertProfileSize(groups);
  return {
    ...(typeof record.baseVersionId === 'string'
      ? { baseVersionId: record.baseVersionId.toLowerCase() }
      : {}),
    groups,
  };
}

@Injectable()
export class ProfilePatchPipe implements PipeTransform<
  unknown,
  ValidatedProfilePatch
> {
  transform(value: unknown): ValidatedProfilePatch {
    return validateProfilePatch(value);
  }
}

export function profileEtag(versionId: string): string {
  return `"profile:${versionId}"`;
}

export function resolveProfilePrecondition(
  rawIfMatch: string | undefined,
  baseVersionId: string | undefined,
): ProfilePrecondition {
  const ifMatch = rawIfMatch?.trim();
  let headerVersionId: string | undefined;
  if (rawIfMatch !== undefined) {
    const match =
      /^"profile:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})"$/.exec(
        ifMatch ?? '',
      );
    if (!match) {
      throw new BadRequestException(
        errorBody('VALIDATION_ERROR', 'invalid If-Match header', {
          field: 'If-Match',
          reason: 'MALFORMED_PROFILE_ETAG',
        }),
      );
    }
    headerVersionId = match[1].toLowerCase();
  }
  const bodyVersionId = baseVersionId?.toLowerCase();
  if (!headerVersionId && !bodyVersionId) {
    throw new HttpException(
      errorBody(
        'PRECONDITION_REQUIRED',
        'profile update requires If-Match or baseVersionId',
        {
          requiredOneOf: ['If-Match', 'baseVersionId'],
        },
      ),
      HttpStatus.PRECONDITION_REQUIRED,
    );
  }
  if (headerVersionId && bodyVersionId && headerVersionId !== bodyVersionId) {
    throw new BadRequestException(
      errorBody('VALIDATION_ERROR', 'version preconditions disagree', {
        reason: 'PRECONDITIONS_DISAGREE',
        ifMatchVersionId: headerVersionId,
        baseVersionId: bodyVersionId,
      }),
    );
  }
  return headerVersionId
    ? { expectedVersionId: headerVersionId, source: 'if-match' }
    : { expectedVersionId: bodyVersionId!, source: 'baseVersionId' };
}

export class ProfileVersionConflictException extends HttpException {
  constructor(
    readonly currentVersionId: string,
    siteId: string,
    precondition: ProfilePrecondition,
  ) {
    super(
      errorBody('SPEC_VERSION_CONFLICT', 'site profile has changed', {
        resourceType: 'siteProfile',
        siteId,
        expectedVersionId: precondition.expectedVersionId,
        currentVersionId,
        precondition: precondition.source,
        retry: 'REGET_MERGE_RETRY',
      }),
      precondition.source === 'if-match'
        ? HttpStatus.PRECONDITION_FAILED
        : HttpStatus.CONFLICT,
    );
  }
}

export function nextProfileVersionId(): string {
  return randomUUID();
}
