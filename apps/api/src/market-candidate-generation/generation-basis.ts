import { types } from "node:util";
import { BadRequestException } from "@nestjs/common";
import { isUUID } from "class-validator";
import {
  boundedArray,
  boundedNumber,
  boundedString,
  closedObject,
} from "../ai-tasks/task-schema-bounds";
import {
  canonicalJson,
  documentHash,
} from "../market-candidates/market-candidate-set.document";
import {
  assertModelOutputSchemaCompiles,
  checkAgainstSchema,
} from "../model-gateway/schema-validate";
import type { MarketCandidateSourceReferenceDto } from "../market-candidates/dto/market-candidate-set.dto";

export const GENERATION_INPUT_BYTES = 262_144;
export interface GenerationCompanyRow {
  id: string;
  workspaceId: string;
  version: number;
  name: string;
  website: string | null;
  industry: string | null;
  industryCode: string | null;
  summary: string | null;
  targetMarkets: string[];
  deletedAt: Date | null;
}
export interface GenerationOfferingRow {
  id: string;
  workspaceId: string;
  companyId: string;
  name: string;
  description: string | null;
  attributes: unknown;
}
export interface GenerationClaimRow {
  id: string;
  workspaceId: string;
  companyId: string;
  version: number;
  status: string;
  type: string;
  statement: string;
  validUntil: Date | null;
  verifiedAt: Date | null;
  verificationMethod: string | null;
}
export interface GenerationBasisRows {
  company: GenerationCompanyRow;
  offerings: GenerationOfferingRow[];
  claims: GenerationClaimRow[];
}
export interface GenerationBasisSource {
  kind: "OFFERING" | "CLAIM";
  key: string;
  sourceId: string;
  usedFieldsDigest: string;
  version: number | null;
  status: string | null;
}
export interface GenerationBasisDescriptors {
  schemaVersion: "market-candidate-generation-basis/v1";
  company: { companyId: string; version: number };
  sources: GenerationBasisSource[];
}
export interface GenerationInputMaterial {
  schemaVersion: "market-candidate-generation-input/v1";
  company: {
    id: string;
    version: number;
    name: string;
    website: string | null;
    industry: string | null;
    industryCode: string | null;
    summary: string | null;
    declaredTargetMarkets: string[];
  };
  offerings: Array<{
    basisKey: string;
    sourceId: string;
    usedFieldsDigest: string;
    name: string;
    description: string | null;
    attributesCanonicalJson: string | null;
  }>;
  claims: Array<{
    basisKey: string;
    sourceId: string;
    usedFieldsDigest: string;
    version: number;
    status: "APPROVED";
    type: string;
    statement: string;
    validUntil: string | null;
    verifiedAt: string | null;
    verificationMethod: string | null;
  }>;
}
export interface PreparedGenerationBasis {
  inputMaterial: GenerationInputMaterial;
  inputMaterialDigest: string;
  descriptors: GenerationBasisDescriptors;
  sources: MarketCandidateSourceReferenceDto[];
}
export interface GenerationPrepareInput {
  intentId: string;
  offeringIds?: string[];
  claimIds?: string[];
}

export function invalidGenerationInput(
  code: "VALIDATION_ERROR" | "NO_APPROVED_CLAIMS" = "VALIDATION_ERROR",
): never {
  throw new BadRequestException({
    error: { code, message: "候选生成依据或结果不符合合同" },
    message: code,
  });
}
function assertDataJson(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0,
): void {
  if (depth > 40) invalidGenerationInput();
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalidGenerationInput();
    return;
  }
  if (
    !value ||
    typeof value !== "object" ||
    types.isProxy(value) ||
    seen.has(value)
  )
    invalidGenerationInput();
  const array = Array.isArray(value),
    prototype = Object.getPrototypeOf(value);
  if (
    array
      ? prototype !== Array.prototype
      : prototype !== Object.prototype && prototype !== null
  )
    invalidGenerationInput();
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value),
    keys = Reflect.ownKeys(value);
  if (keys.some((k) => typeof k !== "string")) invalidGenerationInput();
  if (array) {
    const length = (value as unknown[]).length;
    if (keys.length !== length + 1) invalidGenerationInput();
    for (let i = 0; i < length; i++) {
      const d = descriptors[String(i)];
      if (!d?.enumerable || !("value" in d)) invalidGenerationInput();
      assertDataJson(d.value, seen, depth + 1);
    }
  } else
    for (const key of keys as string[]) {
      const d = descriptors[key];
      if (
        !d?.enumerable ||
        !("value" in d) ||
        ["__proto__", "prototype", "constructor"].includes(key)
      )
        invalidGenerationInput();
      assertDataJson(d.value, seen, depth + 1);
    }
  seen.delete(value);
}
export function generationCanonicalJson(
  value: unknown,
  maxBytes = GENERATION_INPUT_BYTES,
): string {
  assertDataJson(value);
  const result = canonicalJson(value);
  if (Buffer.byteLength(result, "utf8") > maxBytes) invalidGenerationInput();
  return result;
}
function uuid(value: unknown): string {
  if (typeof value !== "string" || !isUUID(value)) invalidGenerationInput();
  return value.toLowerCase();
}
function iso(value: Date | null): string | null {
  if (value === null) return null;
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    invalidGenerationInput();
  return value.toISOString();
}
const text = boundedString(GENERATION_INPUT_BYTES),
  nullableText = { oneOf: [text, { type: "null" }] },
  idSchema = boundedString(36, { minLength: 36 }),
  hashSchema = boundedString(64, { minLength: 64 }),
  versionSchema = boundedNumber(1, 2_147_483_647, true),
  dateSchema = { oneOf: [boundedString(40), { type: "null" }] };
const companyProperties = {
  id: idSchema,
  version: versionSchema,
  name: text,
  website: nullableText,
  industry: nullableText,
  industryCode: nullableText,
  summary: nullableText,
  declaredTargetMarkets: boundedArray(256, text),
};
const offeringProperties = {
  basisKey: boundedString(80),
  sourceId: idSchema,
  usedFieldsDigest: hashSchema,
  name: text,
  description: nullableText,
  attributesCanonicalJson: nullableText,
};
const claimProperties = {
  basisKey: boundedString(80),
  sourceId: idSchema,
  usedFieldsDigest: hashSchema,
  version: versionSchema,
  status: boundedString(8, { const: "APPROVED" }),
  type: text,
  statement: text,
  validUntil: dateSchema,
  verifiedAt: dateSchema,
  verificationMethod: nullableText,
};
export const GENERATION_INPUT_SCHEMA = closedObject(
  {
    schemaVersion: boundedString(80, {
      const: "market-candidate-generation-input/v1",
    }),
    company: closedObject(companyProperties, Object.keys(companyProperties)),
    offerings: {
      ...boundedArray(
        200,
        closedObject(offeringProperties, Object.keys(offeringProperties)),
      ),
      minItems: 1,
    },
    claims: {
      ...boundedArray(
        200,
        closedObject(claimProperties, Object.keys(claimProperties)),
      ),
      minItems: 1,
    },
  },
  ["schemaVersion", "company", "offerings", "claims"],
);
function offeringFields(row: GenerationInputMaterial["offerings"][number]) {
  return {
    name: row.name,
    description: row.description,
    attributesCanonicalJson: row.attributesCanonicalJson,
  };
}
function claimFields(row: GenerationInputMaterial["claims"][number]) {
  return {
    version: row.version,
    status: row.status,
    type: row.type,
    statement: row.statement,
    validUntil: row.validUntil,
    verifiedAt: row.verifiedAt,
    verificationMethod: row.verificationMethod,
  };
}
export function assertGenerationInput(
  value: unknown,
  schema: Record<string, unknown> = GENERATION_INPUT_SCHEMA,
): GenerationInputMaterial {
  assertModelOutputSchemaCompiles(schema);
  const encoded = generationCanonicalJson(value),
    material = JSON.parse(encoded) as GenerationInputMaterial;
  if (!checkAgainstSchema(schema, material).valid) invalidGenerationInput();
  if (
    !Array.isArray(material.offerings) ||
    !Array.isArray(material.claims) ||
    material.offerings.length + material.claims.length > 200
  )
    invalidGenerationInput();
  uuid(material.company.id);
  const keys = new Set<string>();
  for (const row of material.offerings) {
    const key = "OFFERING:" + uuid(row.sourceId);
    if (
      row.basisKey !== key ||
      keys.has(key) ||
      row.usedFieldsDigest !== documentHash(offeringFields(row))
    )
      invalidGenerationInput();
    keys.add(key);
    if (row.attributesCanonicalJson !== null) {
      let attrs: unknown;
      try {
        attrs = JSON.parse(row.attributesCanonicalJson);
      } catch {
        invalidGenerationInput();
      }
      if (generationCanonicalJson(attrs) !== row.attributesCanonicalJson)
        invalidGenerationInput();
    }
  }
  for (const row of material.claims) {
    const key = "CLAIM:" + uuid(row.sourceId);
    if (
      row.basisKey !== key ||
      keys.has(key) ||
      row.usedFieldsDigest !== documentHash(claimFields(row))
    )
      invalidGenerationInput();
    keys.add(key);
    for (const date of [row.validUntil, row.verifiedAt])
      if (
        date !== null &&
        (!Number.isFinite(Date.parse(date)) ||
          new Date(date).toISOString() !== date)
      )
        invalidGenerationInput();
  }
  return material;
}
export function normalizeGenerationPrepare(
  input: unknown,
): GenerationPrepareInput {
  assertDataJson(input);
  if (!input || typeof input !== "object" || Array.isArray(input))
    invalidGenerationInput();
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some(
      (k) => !["intentId", "offeringIds", "claimIds"].includes(k),
    )
  )
    invalidGenerationInput();
  const result: GenerationPrepareInput = { intentId: uuid(value.intentId) };
  for (const name of ["offeringIds", "claimIds"] as const)
    if (Object.hasOwn(value, name)) {
      const ids = value[name];
      if (!Array.isArray(ids)) invalidGenerationInput();
      result[name] = [...new Set(ids.map(uuid))].sort();
    }
  if ((result.offeringIds?.length ?? 0) + (result.claimIds?.length ?? 0) > 200)
    invalidGenerationInput();
  return result;
}
export function buildGenerationBasis(
  context: { workspaceId: string; companyId: string },
  rows: GenerationBasisRows,
  now = new Date(),
): PreparedGenerationBasis {
  const workspaceId = uuid(context.workspaceId),
    companyId = uuid(context.companyId),
    company = rows.company;
  if (
    !company ||
    uuid(company.id) !== companyId ||
    uuid(company.workspaceId) !== workspaceId ||
    company.deletedAt !== null ||
    !Number.isFinite(now.getTime())
  )
    invalidGenerationInput();
  if (
    rows.offerings.length < 1 ||
    rows.offerings.length + rows.claims.length > 200
  )
    invalidGenerationInput();
  if (rows.claims.length < 1) invalidGenerationInput("NO_APPROVED_CLAIMS");
  const offerings = rows.offerings
    .map((row) => {
      if (
        uuid(row.workspaceId) !== workspaceId ||
        uuid(row.companyId) !== companyId
      )
        invalidGenerationInput();
      const sourceId = uuid(row.id);
      const fields = {
        name: row.name,
        description: row.description,
        attributesCanonicalJson:
          row.attributes === null
            ? null
            : generationCanonicalJson(row.attributes),
      };
      return {
        basisKey: "OFFERING:" + sourceId,
        sourceId,
        usedFieldsDigest: documentHash(fields),
        ...fields,
      };
    })
    .sort((a, b) => a.sourceId.localeCompare(b.sourceId, "en"));
  const claims = rows.claims
    .map((row) => {
      if (
        uuid(row.workspaceId) !== workspaceId ||
        uuid(row.companyId) !== companyId ||
        row.status !== "APPROVED" ||
        (row.validUntil !== null && row.validUntil.getTime() <= now.getTime())
      )
        invalidGenerationInput();
      const sourceId = uuid(row.id),
        fields = {
          version: row.version,
          status: "APPROVED" as const,
          type: row.type,
          statement: row.statement,
          validUntil: iso(row.validUntil),
          verifiedAt: iso(row.verifiedAt),
          verificationMethod: row.verificationMethod,
        };
      return {
        basisKey: "CLAIM:" + sourceId,
        sourceId,
        usedFieldsDigest: documentHash(fields),
        ...fields,
      };
    })
    .sort((a, b) => a.sourceId.localeCompare(b.sourceId, "en"));
  const inputMaterial = assertGenerationInput({
    schemaVersion: "market-candidate-generation-input/v1",
    company: {
      id: companyId,
      version: company.version,
      name: company.name,
      website: company.website,
      industry: company.industry,
      industryCode: company.industryCode,
      summary: company.summary,
      declaredTargetMarkets: company.targetMarkets,
    },
    offerings,
    claims,
  });
  const sources: GenerationBasisSource[] = [
    ...offerings.map((row) => ({
      kind: "OFFERING" as const,
      key: row.basisKey,
      sourceId: row.sourceId,
      usedFieldsDigest: row.usedFieldsDigest,
      version: null,
      status: null,
    })),
    ...claims.map((row) => ({
      kind: "CLAIM" as const,
      key: row.basisKey,
      sourceId: row.sourceId,
      usedFieldsDigest: row.usedFieldsDigest,
      version: row.version,
      status: row.status,
    })),
  ].sort((a, b) => a.key.localeCompare(b.key, "en"));
  return {
    inputMaterial,
    inputMaterialDigest: documentHash(inputMaterial),
    descriptors: {
      schemaVersion: "market-candidate-generation-basis/v1",
      company: { companyId, version: company.version },
      sources,
    },
    sources: sources.map((row) => ({ kind: row.kind, sourceId: row.sourceId })),
  };
}
