import { types } from 'node:util';
import type { TypedProjectionSchema } from './durable-result-strategy';
import { TypedProjectionRegistry } from './typed-projection.registry';
import type { TypedProjectionDefinition } from './typed-projection.types';

type JsonSchema = Readonly<Record<string, unknown>>;
type UnknownRecord = Record<string, unknown>;

export const SOURCE_RESULT_TOOL_IDS = Object.freeze([
  'ted.search',
  'openfda.search',
  'samgov.search',
  'smtp.rcpt_probe',
] as const);

export type SourceResultToolId = (typeof SOURCE_RESULT_TOOL_IDS)[number];

export const SOURCE_RESULT_PROJECTION_SCHEMAS = Object.freeze({
  'ted.search': 'ted-search/v1',
  'openfda.search': 'openfda-search/v1',
  'samgov.search': 'samgov-search/v1',
  'smtp.rcpt_probe': 'smtp-probe-verdict/v1',
} satisfies Readonly<Record<SourceResultToolId, TypedProjectionSchema>>);

const TOOL_RESULT_KEYS = ['data', 'costCents', 'degraded'] as const;
const TED_AWARD_KEYS = [
  'publicationNumber', 'publicationDate', 'noticeType', 'formType', 'cpvCodes',
  'buyerNames', 'buyerCountries', 'winners',
] as const;
const TED_NOTICE_KEYS = [
  'publicationNumber', 'publicationDate', 'publicationDateIso', 'noticeType',
  'cpvCodes', 'buyerNames', 'buyerCountries', 'deadlines',
] as const;
const TED_WINNER_KEYS = [
  'name', 'country', 'identifier', 'internetAddress', 'city',
] as const;
const OPENFDA_ESTABLISHMENT_KEYS = [
  'registrationNumber', 'feiNumber', 'name', 'country', 'city', 'stateCode',
  'statusCode', 'establishmentTypes', 'initialImporter', 'productCodes',
  'deviceFacts', 'deviceNames', 'ownerOperatorNumbers', 'createdDate',
] as const;
const OPENFDA_CLEARANCE_KEYS = [
  'kNumber', 'applicant', 'country', 'productCode', 'decisionDateIso',
  'decisionCode', 'deviceName', 'deviceFacts',
] as const;
const SAM_NOTICE_KEYS = [
  'noticeId', 'title', 'department', 'subTier', 'office', 'postedDateIso',
  'naicsCode', 'responseDeadlineIso', 'popCountry', 'link',
] as const;
const SMTP_REASON_CODES = Object.freeze([
  'ip_literal_not_allowed',
  'blocked_hostname',
  'dns_lookup_failed',
  'no_address',
  'non_global_address',
  'unsafe',
] as const);
const RESERVED_DYNAMIC_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const PROHIBITED_DYNAMIC_KEYS = new Set([
  'prompt', 'systemprompt', 'apikey', 'credential', 'credentials',
  'credentialref', 'token', 'accesstoken', 'rawresponse', 'responsebody',
  'authorization', 'header', 'headers', 'password', 'secret', 'cookie',
  'attributes',
]);

function projectionInvalid(): never {
  throw new Error('SOURCE_RESULT_PROJECTION_INVALID');
}

function ownDataRecord(
  value: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
): UnknownRecord {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) {
      projectionInvalid();
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) projectionInvalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string' || !allowedKeys.includes(key))) {
      projectionInvalid();
    }
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !('value' in descriptor)) projectionInvalid();
    }
    if (requiredKeys.some((key) => !Object.hasOwn(descriptors, key))) projectionInvalid();
    return value as UnknownRecord;
  } catch (error) {
    if (error instanceof Error && error.message === 'SOURCE_RESULT_PROJECTION_INVALID') {
      throw error;
    }
    projectionInvalid();
  }
}

function denseArray(value: unknown): unknown[] {
  try {
    if (!Array.isArray(value) || types.isProxy(value) ||
      Object.getPrototypeOf(value) !== Array.prototype) projectionInvalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key === 'symbol')) projectionInvalid();
    for (const key of keys as string[]) {
      if (key === 'length') continue;
      const descriptor = descriptors[key];
      if (!/^(0|[1-9][0-9]*)$/.test(key) || !descriptor?.enumerable ||
        !('value' in descriptor)) projectionInvalid();
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(descriptors, String(index))) projectionInvalid();
    }
    if (keys.length !== value.length + 1) projectionInvalid();
    return value;
  } catch (error) {
    if (error instanceof Error && error.message === 'SOURCE_RESULT_PROJECTION_INVALID') {
      throw error;
    }
    projectionInvalid();
  }
}

function field(record: UnknownRecord, name: string): unknown {
  return Object.getOwnPropertyDescriptor(record, name)?.value;
}

function hasDefinedField(record: UnknownRecord, name: string): boolean {
  return Object.hasOwn(record, name) && field(record, name) !== undefined;
}

function optionalField(record: UnknownRecord, name: string): UnknownRecord {
  return hasDefinedField(record, name) ? { [name]: field(record, name) } : {};
}

function projectStringArray(value: unknown): unknown[] {
  return denseArray(value).map((entry) => entry);
}

function assertDynamicKey(key: string): void {
  const compact = key.normalize('NFKC').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  if (
    !key || key !== key.normalize('NFC') || RESERVED_DYNAMIC_KEYS.has(key) ||
    PROHIBITED_DYNAMIC_KEYS.has(compact)
  ) projectionInvalid();
}

function projectFactEntries(value: unknown): UnknownRecord[] {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) {
      projectionInvalid();
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) projectionInvalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string')) projectionInvalid();
    return (keys as string[]).sort().map((key) => {
      assertDynamicKey(key);
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !('value' in descriptor) ||
        typeof descriptor.value !== 'string') projectionInvalid();
      return { key, value: descriptor.value };
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'SOURCE_RESULT_PROJECTION_INVALID') {
      throw error;
    }
    projectionInvalid();
  }
}

function restoreFactEntries(value: unknown): UnknownRecord {
  const restored: UnknownRecord = {};
  let previousKey: string | undefined;
  for (const rawEntry of denseArray(value)) {
    const entry = ownDataRecord(rawEntry, ['key', 'value'], ['key', 'value']);
    const key = field(entry, 'key');
    const factValue = field(entry, 'value');
    if (typeof key !== 'string' || typeof factValue !== 'string') projectionInvalid();
    assertDynamicKey(key);
    if (previousKey !== undefined && key <= previousKey) projectionInvalid();
    previousKey = key;
    Object.defineProperty(restored, key, {
      configurable: true,
      enumerable: true,
      value: factValue,
      writable: true,
    });
  }
  return restored;
}

function projectToolResult(
  raw: unknown,
  dataAllowedKeys: readonly string[],
): { readonly result: UnknownRecord; readonly data: UnknownRecord } {
  const result = ownDataRecord(raw, TOOL_RESULT_KEYS, ['data', 'costCents']);
  return {
    result,
    data: ownDataRecord(field(result, 'data'), dataAllowedKeys, []),
  };
}

function projectResultMetadata(result: UnknownRecord): UnknownRecord {
  return {
    costCents: field(result, 'costCents'),
    ...(hasDefinedField(result, 'degraded')
      ? { degraded: field(result, 'degraded') }
      : {}),
  };
}

function restoreToolResult(projected: unknown, data: UnknownRecord): UnknownRecord {
  const result = ownDataRecord(projected, TOOL_RESULT_KEYS, ['data', 'costCents']);
  return {
    data,
    costCents: field(result, 'costCents'),
    ...(hasDefinedField(result, 'degraded')
      ? { degraded: field(result, 'degraded') }
      : {}),
  };
}

const stringSchema = (maxLength: number, extra?: JsonSchema): JsonSchema => ({
  type: 'string', maxLength, ...extra,
});

const nullableStringSchema = (maxLength: number): JsonSchema => ({
  type: ['string', 'null'], maxLength,
});

const integerSchema = (minimum: number, maximum: number): JsonSchema => ({
  type: 'integer', minimum, maximum,
});

const nullableIntegerSchema = (minimum: number, maximum: number): JsonSchema => ({
  type: ['integer', 'null'], minimum, maximum,
});

const arraySchema = (maxItems: number, items: JsonSchema): JsonSchema => ({
  type: 'array', maxItems, items,
});

function objectSchema(
  properties: Readonly<Record<string, JsonSchema>>,
  required: readonly string[],
): JsonSchema {
  return { type: 'object', additionalProperties: false, required, properties };
}

function toolResultSchema(data: JsonSchema): JsonSchema {
  return objectSchema({
    data,
    costCents: integerSchema(0, 1_000_000_000),
    degraded: { type: 'boolean' },
  }, ['data', 'costCents']);
}

const stringArraySchema = (maxItems: number, maxLength = 500): JsonSchema =>
  arraySchema(maxItems, stringSchema(maxLength));

const tedWinnerSchema = objectSchema({
  name: stringSchema(500),
  country: stringSchema(500),
  identifier: stringSchema(500),
  internetAddress: stringSchema(2048),
  city: stringSchema(500),
}, ['name']);

const tedAwardSchema = objectSchema({
  publicationNumber: stringSchema(500),
  publicationDate: stringSchema(500),
  noticeType: stringSchema(500),
  formType: stringSchema(500),
  cpvCodes: stringArraySchema(64),
  buyerNames: stringArraySchema(64),
  buyerCountries: stringArraySchema(64),
  winners: arraySchema(32, tedWinnerSchema),
}, ['cpvCodes', 'buyerNames', 'buyerCountries', 'winners']);

const tedNoticeSchema = objectSchema({
  publicationNumber: stringSchema(500),
  publicationDate: stringSchema(500),
  publicationDateIso: stringSchema(500),
  noticeType: stringSchema(500),
  cpvCodes: stringArraySchema(64),
  buyerNames: stringArraySchema(64),
  buyerCountries: stringArraySchema(64),
  deadlines: stringArraySchema(64),
}, ['cpvCodes', 'buyerNames', 'buyerCountries', 'deadlines']);

function projectTedWinner(raw: unknown): UnknownRecord {
  const winner = ownDataRecord(raw, TED_WINNER_KEYS, ['name']);
  return {
    name: field(winner, 'name'),
    ...optionalField(winner, 'country'),
    ...optionalField(winner, 'identifier'),
    ...optionalField(winner, 'internetAddress'),
    ...optionalField(winner, 'city'),
  };
}

function projectTedAward(raw: unknown): UnknownRecord {
  const award = ownDataRecord(raw, TED_AWARD_KEYS, [
    'cpvCodes', 'buyerNames', 'buyerCountries', 'winners',
  ]);
  return {
    ...optionalField(award, 'publicationNumber'),
    ...optionalField(award, 'publicationDate'),
    ...optionalField(award, 'noticeType'),
    ...optionalField(award, 'formType'),
    cpvCodes: projectStringArray(field(award, 'cpvCodes')),
    buyerNames: projectStringArray(field(award, 'buyerNames')),
    buyerCountries: projectStringArray(field(award, 'buyerCountries')),
    winners: denseArray(field(award, 'winners')).map(projectTedWinner),
  };
}

function projectTedNotice(raw: unknown): UnknownRecord {
  const notice = ownDataRecord(raw, TED_NOTICE_KEYS, [
    'cpvCodes', 'buyerNames', 'buyerCountries', 'deadlines',
  ]);
  return {
    ...optionalField(notice, 'publicationNumber'),
    ...optionalField(notice, 'publicationDate'),
    ...optionalField(notice, 'publicationDateIso'),
    ...optionalField(notice, 'noticeType'),
    cpvCodes: projectStringArray(field(notice, 'cpvCodes')),
    buyerNames: projectStringArray(field(notice, 'buyerNames')),
    buyerCountries: projectStringArray(field(notice, 'buyerCountries')),
    deadlines: projectStringArray(field(notice, 'deadlines')),
  };
}

function restoreTedWinner(raw: unknown): UnknownRecord {
  const winner = ownDataRecord(raw, TED_WINNER_KEYS, ['name']);
  return {
    name: field(winner, 'name'),
    ...optionalField(winner, 'country'),
    ...optionalField(winner, 'identifier'),
    ...optionalField(winner, 'internetAddress'),
    ...optionalField(winner, 'city'),
  };
}

function restoreTedAward(raw: unknown): UnknownRecord {
  const award = ownDataRecord(raw, TED_AWARD_KEYS, [
    'cpvCodes', 'buyerNames', 'buyerCountries', 'winners',
  ]);
  return {
    ...optionalField(award, 'publicationNumber'),
    ...optionalField(award, 'publicationDate'),
    ...optionalField(award, 'noticeType'),
    ...optionalField(award, 'formType'),
    cpvCodes: [...denseArray(field(award, 'cpvCodes'))],
    buyerNames: [...denseArray(field(award, 'buyerNames'))],
    buyerCountries: [...denseArray(field(award, 'buyerCountries'))],
    winners: denseArray(field(award, 'winners')).map(restoreTedWinner),
  };
}

function restoreTedNotice(raw: unknown): UnknownRecord {
  const notice = ownDataRecord(raw, TED_NOTICE_KEYS, [
    'cpvCodes', 'buyerNames', 'buyerCountries', 'deadlines',
  ]);
  return {
    ...optionalField(notice, 'publicationNumber'),
    ...optionalField(notice, 'publicationDate'),
    ...optionalField(notice, 'publicationDateIso'),
    ...optionalField(notice, 'noticeType'),
    cpvCodes: [...denseArray(field(notice, 'cpvCodes'))],
    buyerNames: [...denseArray(field(notice, 'buyerNames'))],
    buyerCountries: [...denseArray(field(notice, 'buyerCountries'))],
    deadlines: [...denseArray(field(notice, 'deadlines'))],
  };
}

const tedDefinition: TypedProjectionDefinition<unknown, unknown> = {
  schema: 'ted-search/v1',
  jsonSchema: toolResultSchema(objectSchema({
    awards: arraySchema(32, tedAwardSchema),
    notices: arraySchema(32, tedNoticeSchema),
  }, [])),
  project(raw) {
    const { result, data } = projectToolResult(raw, ['awards', 'notices']);
    return {
      data: {
        ...(hasDefinedField(data, 'awards')
          ? { awards: denseArray(field(data, 'awards')).map(projectTedAward) }
          : {}),
        ...(hasDefinedField(data, 'notices')
          ? { notices: denseArray(field(data, 'notices')).map(projectTedNotice) }
          : {}),
      },
      ...projectResultMetadata(result),
    };
  },
  restore(projected) {
    const result = ownDataRecord(projected, TOOL_RESULT_KEYS, ['data', 'costCents']);
    const data = ownDataRecord(field(result, 'data'), ['awards', 'notices'], []);
    return restoreToolResult(result, {
      ...(hasDefinedField(data, 'awards')
        ? { awards: denseArray(field(data, 'awards')).map(restoreTedAward) }
        : {}),
      ...(hasDefinedField(data, 'notices')
        ? { notices: denseArray(field(data, 'notices')).map(restoreTedNotice) }
        : {}),
    });
  },
};

const factEntrySchema = objectSchema({
  key: stringSchema(120),
  value: stringSchema(1000),
}, ['key', 'value']);

const openFdaEstablishmentSchema = objectSchema({
  registrationNumber: stringSchema(500),
  feiNumber: stringSchema(500),
  name: stringSchema(500),
  country: stringSchema(500),
  city: stringSchema(500),
  stateCode: stringSchema(500),
  statusCode: stringSchema(500),
  establishmentTypes: stringArraySchema(64),
  initialImporter: { type: 'boolean' },
  productCodes: stringArraySchema(64),
  factEntries: arraySchema(64, factEntrySchema),
  deviceNames: stringArraySchema(64),
  ownerOperatorNumbers: stringArraySchema(64),
  createdDate: stringSchema(500),
}, [
  'name', 'establishmentTypes', 'initialImporter', 'productCodes',
  'deviceNames', 'ownerOperatorNumbers',
]);

const openFdaClearanceSchema = objectSchema({
  kNumber: stringSchema(500),
  applicant: stringSchema(500),
  country: stringSchema(500),
  productCode: stringSchema(500),
  decisionDateIso: stringSchema(500),
  decisionCode: stringSchema(500),
  deviceName: stringSchema(500),
  factEntries: arraySchema(64, factEntrySchema),
}, ['applicant']);

function projectOpenFdaEstablishment(raw: unknown): UnknownRecord {
  const record = ownDataRecord(raw, OPENFDA_ESTABLISHMENT_KEYS, [
    'name', 'establishmentTypes', 'initialImporter', 'productCodes',
    'deviceNames', 'ownerOperatorNumbers',
  ]);
  return {
    ...optionalField(record, 'registrationNumber'),
    ...optionalField(record, 'feiNumber'),
    name: field(record, 'name'),
    ...optionalField(record, 'country'),
    ...optionalField(record, 'city'),
    ...optionalField(record, 'stateCode'),
    ...optionalField(record, 'statusCode'),
    establishmentTypes: projectStringArray(field(record, 'establishmentTypes')),
    initialImporter: field(record, 'initialImporter'),
    productCodes: projectStringArray(field(record, 'productCodes')),
    ...(hasDefinedField(record, 'deviceFacts')
      ? { factEntries: projectFactEntries(field(record, 'deviceFacts')) }
      : {}),
    deviceNames: projectStringArray(field(record, 'deviceNames')),
    ownerOperatorNumbers: projectStringArray(field(record, 'ownerOperatorNumbers')),
    ...optionalField(record, 'createdDate'),
  };
}

function projectOpenFdaClearance(raw: unknown): UnknownRecord {
  const record = ownDataRecord(raw, OPENFDA_CLEARANCE_KEYS, ['applicant']);
  return {
    ...optionalField(record, 'kNumber'),
    applicant: field(record, 'applicant'),
    ...optionalField(record, 'country'),
    ...optionalField(record, 'productCode'),
    ...optionalField(record, 'decisionDateIso'),
    ...optionalField(record, 'decisionCode'),
    ...optionalField(record, 'deviceName'),
    ...(hasDefinedField(record, 'deviceFacts')
      ? { factEntries: projectFactEntries(field(record, 'deviceFacts')) }
      : {}),
  };
}

function restoreOpenFdaEstablishment(raw: unknown): UnknownRecord {
  const record = ownDataRecord(raw, [
    'registrationNumber', 'feiNumber', 'name', 'country', 'city', 'stateCode',
    'statusCode', 'establishmentTypes', 'initialImporter', 'productCodes',
    'factEntries', 'deviceNames', 'ownerOperatorNumbers', 'createdDate',
  ], [
    'name', 'establishmentTypes', 'initialImporter', 'productCodes',
    'deviceNames', 'ownerOperatorNumbers',
  ]);
  return {
    ...optionalField(record, 'registrationNumber'),
    ...optionalField(record, 'feiNumber'),
    name: field(record, 'name'),
    ...optionalField(record, 'country'),
    ...optionalField(record, 'city'),
    ...optionalField(record, 'stateCode'),
    ...optionalField(record, 'statusCode'),
    establishmentTypes: [...denseArray(field(record, 'establishmentTypes'))],
    initialImporter: field(record, 'initialImporter'),
    productCodes: [...denseArray(field(record, 'productCodes'))],
    ...(hasDefinedField(record, 'factEntries')
      ? { deviceFacts: restoreFactEntries(field(record, 'factEntries')) }
      : {}),
    deviceNames: [...denseArray(field(record, 'deviceNames'))],
    ownerOperatorNumbers: [...denseArray(field(record, 'ownerOperatorNumbers'))],
    ...optionalField(record, 'createdDate'),
  };
}

function restoreOpenFdaClearance(raw: unknown): UnknownRecord {
  const record = ownDataRecord(raw, [
    'kNumber', 'applicant', 'country', 'productCode', 'decisionDateIso',
    'decisionCode', 'deviceName', 'factEntries',
  ], ['applicant']);
  return {
    ...optionalField(record, 'kNumber'),
    applicant: field(record, 'applicant'),
    ...optionalField(record, 'country'),
    ...optionalField(record, 'productCode'),
    ...optionalField(record, 'decisionDateIso'),
    ...optionalField(record, 'decisionCode'),
    ...optionalField(record, 'deviceName'),
    ...(hasDefinedField(record, 'factEntries')
      ? { deviceFacts: restoreFactEntries(field(record, 'factEntries')) }
      : {}),
  };
}

const openFdaDefinition: TypedProjectionDefinition<unknown, unknown> = {
  schema: 'openfda-search/v1',
  jsonSchema: toolResultSchema(objectSchema({
    establishments: arraySchema(12, openFdaEstablishmentSchema),
    clearances: arraySchema(12, openFdaClearanceSchema),
  }, [])),
  project(raw) {
    const { result, data } = projectToolResult(raw, ['establishments', 'clearances']);
    return {
      data: {
        ...(hasDefinedField(data, 'establishments')
          ? {
              establishments: denseArray(field(data, 'establishments'))
                .map(projectOpenFdaEstablishment),
            }
          : {}),
        ...(hasDefinedField(data, 'clearances')
          ? {
              clearances: denseArray(field(data, 'clearances'))
                .map(projectOpenFdaClearance),
            }
          : {}),
      },
      ...projectResultMetadata(result),
    };
  },
  restore(projected) {
    const result = ownDataRecord(projected, TOOL_RESULT_KEYS, ['data', 'costCents']);
    const data = ownDataRecord(field(result, 'data'), ['establishments', 'clearances'], []);
    return restoreToolResult(result, {
      ...(hasDefinedField(data, 'establishments')
        ? {
            establishments: denseArray(field(data, 'establishments'))
              .map(restoreOpenFdaEstablishment),
          }
        : {}),
      ...(hasDefinedField(data, 'clearances')
        ? {
            clearances: denseArray(field(data, 'clearances'))
              .map(restoreOpenFdaClearance),
          }
        : {}),
    });
  },
};

const samNoticeSchema = objectSchema({
  noticeId: stringSchema(500),
  title: stringSchema(2000),
  department: stringSchema(500),
  subTier: stringSchema(500),
  office: stringSchema(500),
  postedDateIso: nullableStringSchema(500),
  naicsCode: stringSchema(500),
  responseDeadlineIso: nullableStringSchema(500),
  popCountry: stringSchema(500),
  link: stringSchema(2048),
}, [
  'noticeId', 'title', 'department', 'subTier', 'office', 'postedDateIso',
  'naicsCode', 'responseDeadlineIso',
]);

function projectSamNotice(raw: unknown): UnknownRecord {
  const notice = ownDataRecord(raw, SAM_NOTICE_KEYS, [
    'noticeId', 'title', 'department', 'subTier', 'office', 'postedDateIso',
    'naicsCode', 'responseDeadlineIso',
  ]);
  return {
    noticeId: field(notice, 'noticeId'),
    title: field(notice, 'title'),
    department: field(notice, 'department'),
    subTier: field(notice, 'subTier'),
    office: field(notice, 'office'),
    postedDateIso: field(notice, 'postedDateIso'),
    naicsCode: field(notice, 'naicsCode'),
    responseDeadlineIso: field(notice, 'responseDeadlineIso'),
    ...optionalField(notice, 'popCountry'),
    ...optionalField(notice, 'link'),
  };
}

const samDefinition: TypedProjectionDefinition<unknown, unknown> = {
  schema: 'samgov-search/v1',
  jsonSchema: toolResultSchema(objectSchema({
    notices: arraySchema(32, samNoticeSchema),
  }, [])),
  project(raw) {
    const { result, data } = projectToolResult(raw, ['notices']);
    return {
      data: {
        ...(hasDefinedField(data, 'notices')
          ? { notices: denseArray(field(data, 'notices')).map(projectSamNotice) }
          : {}),
      },
      ...projectResultMetadata(result),
    };
  },
  restore(projected) {
    const result = ownDataRecord(projected, TOOL_RESULT_KEYS, ['data', 'costCents']);
    const data = ownDataRecord(field(result, 'data'), ['notices'], []);
    return restoreToolResult(result, {
      ...(hasDefinedField(data, 'notices')
        ? { notices: denseArray(field(data, 'notices')).map(projectSamNotice) }
        : {}),
    });
  },
};

function assertSmtpReason(value: unknown): void {
  if (typeof value !== 'string' || !SMTP_REASON_CODES.includes(
    value as (typeof SMTP_REASON_CODES)[number],
  )) projectionInvalid();
}

const smtpDefinition: TypedProjectionDefinition<unknown, unknown> = {
  schema: 'smtp-probe-verdict/v1',
  jsonSchema: toolResultSchema(objectSchema({
    reachable: { type: 'boolean' },
    mailFromCode: nullableIntegerSchema(200, 599),
    codes: arraySchema(8, nullableIntegerSchema(200, 599)),
    egressBlocked: stringSchema(120, { enum: [...SMTP_REASON_CODES] }),
  }, ['reachable', 'mailFromCode', 'codes'])),
  project(raw) {
    const { result, data } = projectToolResult(raw, [
      'reachable', 'mailFromCode', 'codes', 'egressBlocked',
    ]);
    ownDataRecord(data, ['reachable', 'mailFromCode', 'codes', 'egressBlocked'], [
      'reachable', 'mailFromCode', 'codes',
    ]);
    if (hasDefinedField(data, 'egressBlocked')) {
      assertSmtpReason(field(data, 'egressBlocked'));
    }
    return {
      data: {
        reachable: field(data, 'reachable'),
        mailFromCode: field(data, 'mailFromCode'),
        codes: denseArray(field(data, 'codes')).map((entry) => entry),
        ...optionalField(data, 'egressBlocked'),
      },
      ...projectResultMetadata(result),
    };
  },
  restore(projected) {
    const result = ownDataRecord(projected, TOOL_RESULT_KEYS, ['data', 'costCents']);
    const data = ownDataRecord(field(result, 'data'), [
      'reachable', 'mailFromCode', 'codes', 'egressBlocked',
    ], ['reachable', 'mailFromCode', 'codes']);
    if (hasDefinedField(data, 'egressBlocked')) {
      assertSmtpReason(field(data, 'egressBlocked'));
    }
    return restoreToolResult(result, {
      reachable: field(data, 'reachable'),
      mailFromCode: field(data, 'mailFromCode'),
      codes: [...denseArray(field(data, 'codes'))],
      ...optionalField(data, 'egressBlocked'),
    });
  },
};

export const SOURCE_RESULT_PROJECTION_DEFINITIONS = Object.freeze([
  tedDefinition,
  openFdaDefinition,
  samDefinition,
  smtpDefinition,
] as const);

export function getSourceResultProjectionSchema(toolId: string): TypedProjectionSchema {
  if (!Object.hasOwn(SOURCE_RESULT_PROJECTION_SCHEMAS, toolId)) {
    throw new Error('SOURCE_RESULT_PROJECTION_TOOL_UNKNOWN');
  }
  return SOURCE_RESULT_PROJECTION_SCHEMAS[toolId as SourceResultToolId];
}

export function registerSourceResultProjections(
  registry: TypedProjectionRegistry,
): TypedProjectionRegistry {
  for (const definition of SOURCE_RESULT_PROJECTION_DEFINITIONS) {
    registry.register(definition);
  }
  return registry;
}
