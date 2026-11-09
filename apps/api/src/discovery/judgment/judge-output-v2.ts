/**
 * judge-output/v2 严格 schema 与结构校验（P3 J09；设计 §4.3.3.5）。
 *
 * 约束：`additionalProperties:false`、字段全 required、嵌套 ≤5、枚举闭集、
 * **证据先于结论**（属性顺序 = 输出顺序）。网关若不支持约束解码，由调用方用
 * `validateJudgeOutputV2` 做「schema 校验 + 一次修复重试」兜底，失败记
 * `OUTPUT_SCHEMA_INVALID`（见 failure-codes.ts）。
 */

import { CRITERION_IDS, CRITERION_LABELS } from './fit-rubric';

export const JUDGE_OUTPUT_SCHEMA_VERSION = 'judge-output/v2' as const;

const EVIDENCE_KINDS = [
  'website',
  'impressum',
  'register',
  'directory',
  'wikidata',
  'other',
] as const;

export const JUDGE_OUTPUT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'criteria',
    'evidence_completeness',
    'verdict_proposed',
    'refusal',
  ],
  properties: {
    criteria: {
      type: 'array',
      minItems: 5,
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id',
          'applicable',
          'score',
          'label',
          'evidence',
          'rationale',
        ],
        properties: {
          id: { type: 'string', enum: [...CRITERION_IDS] },
          applicable: { type: 'boolean' },
          score: { type: ['integer', 'null'], minimum: 0, maximum: 10 },
          label: { type: 'string', enum: [...CRITERION_LABELS] },
          evidence: {
            type: 'array',
            maxItems: 6,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['kind', 'url', 'span'],
              properties: {
                kind: { type: 'string', enum: [...EVIDENCE_KINDS] },
                url: { type: 'string', maxLength: 2048 },
                span: { type: 'string', maxLength: 500 },
                fetched_at: { type: 'string', maxLength: 40 },
              },
            },
          },
          rationale: { type: 'string', maxLength: 600 },
        },
      },
    },
    evidence_completeness: { type: 'boolean' },
    verdict_proposed: { type: 'string', enum: ['FIT', 'NOT_FIT', 'UNKNOWN'] },
    refusal: {
      type: 'object',
      additionalProperties: false,
      required: ['is_refusal', 'reason'],
      properties: {
        is_refusal: { type: 'boolean' },
        reason: { type: ['string', 'null'], maxLength: 300 },
      },
    },
  },
} as const;

export interface JudgeEvidenceItem {
  fetched_at?: string;
  kind: (typeof EVIDENCE_KINDS)[number];
  span: string;
  url: string;
}

export interface JudgeCriterionOutput {
  applicable: boolean;
  evidence: JudgeEvidenceItem[];
  id: (typeof CRITERION_IDS)[number];
  label: (typeof CRITERION_LABELS)[number];
  rationale: string;
  score: null | number;
}

export interface JudgeOutputV2 {
  criteria: JudgeCriterionOutput[];
  evidence_completeness: boolean;
  refusal: { is_refusal: boolean; reason: null | string };
  verdict_proposed: 'FIT' | 'NOT_FIT' | 'UNKNOWN';
}

export type JudgeOutputValidation =
  | { errors: string[]; ok: false }
  | { ok: true; value: JudgeOutputV2 };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  at: string,
  errors: string[],
): void {
  for (const key of required) {
    if (!(key in record)) errors.push(`${at}.${key}: required`);
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) errors.push(`${at}.${key}: unexpected`);
  }
}

function checkString(
  value: unknown,
  at: string,
  maxLength: number,
  errors: string[],
): void {
  if (typeof value !== 'string') {
    errors.push(`${at}: string required`);
    return;
  }
  if (value.length > maxLength) errors.push(`${at}: maxLength ${maxLength}`);
}

/**
 * 结构校验（不判语义、不跑模型）：闭集枚举、required、additionalProperties、
 * 长度与分数范围。任何错误都应映射为失败码 OUTPUT_SCHEMA_INVALID。
 */
export function validateJudgeOutputV2(value: unknown): JudgeOutputValidation {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ['$: object required'] };
  exactKeys(
    value,
    ['criteria', 'evidence_completeness', 'verdict_proposed', 'refusal'],
    [],
    '$',
    errors,
  );

  if (typeof value.evidence_completeness !== 'boolean') {
    errors.push('$.evidence_completeness: boolean required');
  }
  if (
    typeof value.verdict_proposed !== 'string' ||
    !['FIT', 'NOT_FIT', 'UNKNOWN'].includes(value.verdict_proposed)
  ) {
    errors.push('$.verdict_proposed: enum FIT|NOT_FIT|UNKNOWN');
  }

  if (isRecord(value.refusal)) {
    exactKeys(value.refusal, ['is_refusal', 'reason'], [], '$.refusal', errors);
    if (typeof value.refusal.is_refusal !== 'boolean') {
      errors.push('$.refusal.is_refusal: boolean required');
    }
    if (
      value.refusal.reason !== null &&
      typeof value.refusal.reason !== 'string'
    ) {
      errors.push('$.refusal.reason: string|null required');
    } else if (
      typeof value.refusal.reason === 'string' &&
      value.refusal.reason.length > 300
    ) {
      errors.push('$.refusal.reason: maxLength 300');
    }
  } else {
    errors.push('$.refusal: object required');
  }

  if (!Array.isArray(value.criteria)) {
    errors.push('$.criteria: array required');
    return { ok: false, errors };
  }
  if (value.criteria.length !== 5) {
    errors.push('$.criteria: exactly 5 items required');
  }
  const seen = new Set<string>();
  value.criteria.forEach((item, index) => {
    const at = `$.criteria[${index}]`;
    if (!isRecord(item)) {
      errors.push(`${at}: object required`);
      return;
    }
    exactKeys(
      item,
      ['id', 'applicable', 'score', 'label', 'evidence', 'rationale'],
      [],
      at,
      errors,
    );
    if (
      typeof item.id !== 'string' ||
      !(CRITERION_IDS as readonly string[]).includes(item.id)
    ) {
      errors.push(`${at}.id: enum C1..C5`);
    } else if (seen.has(item.id)) {
      errors.push(`${at}.id: duplicate ${item.id}`);
    } else {
      seen.add(item.id);
    }
    if (typeof item.applicable !== 'boolean') {
      errors.push(`${at}.applicable: boolean required`);
    }
    if (
      item.score !== null &&
      (typeof item.score !== 'number' ||
        !Number.isInteger(item.score) ||
        item.score < 0 ||
        item.score > 10)
    ) {
      errors.push(`${at}.score: integer 0..10 or null`);
    }
    if (
      typeof item.label !== 'string' ||
      !(CRITERION_LABELS as readonly string[]).includes(item.label)
    ) {
      errors.push(`${at}.label: enum pass|weak|fail|unclear|not_applicable`);
    }
    checkString(item.rationale, `${at}.rationale`, 600, errors);

    if (!Array.isArray(item.evidence)) {
      errors.push(`${at}.evidence: array required`);
    } else {
      if (item.evidence.length > 6) {
        errors.push(`${at}.evidence: maxItems 6`);
      }
      item.evidence.forEach((evidence, evidenceIndex) => {
        const evidenceAt = `${at}.evidence[${evidenceIndex}]`;
        if (!isRecord(evidence)) {
          errors.push(`${evidenceAt}: object required`);
          return;
        }
        exactKeys(
          evidence,
          ['kind', 'url', 'span'],
          ['fetched_at'],
          evidenceAt,
          errors,
        );
        if (
          typeof evidence.kind !== 'string' ||
          !(EVIDENCE_KINDS as readonly string[]).includes(evidence.kind)
        ) {
          errors.push(`${evidenceAt}.kind: enum ${EVIDENCE_KINDS.join('|')}`);
        }
        checkString(evidence.url, `${evidenceAt}.url`, 2048, errors);
        checkString(evidence.span, `${evidenceAt}.span`, 500, errors);
        if (evidence.fetched_at !== undefined) {
          checkString(
            evidence.fetched_at,
            `${evidenceAt}.fetched_at`,
            40,
            errors,
          );
        }
      });
    }
  });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: value as unknown as JudgeOutputV2 };
}
