import { describe, expect, it } from 'vitest';

import {
  ANCHOR_KEY_SET,
  CRITERION_IDS,
  RUBRIC_CRITERIA,
  RUBRIC_SHA256,
  RUBRIC_VERSION,
} from './fit-rubric';
import { buildJudgePrompt, JUDGE_SYSTEM_PROMPT, PROMPT_HASH } from './judge-prompt';
import {
  JUDGE_OUTPUT_JSON_SCHEMA,
  validateJudgeOutputV2,
  type JudgeOutputV2,
} from './judge-output-v2';

function golden(): JudgeOutputV2 {
  return {
    criteria: [
      {
        id: 'C1_MATERIAL',
        applicable: true,
        score: 8,
        label: 'pass',
        evidence: [
          {
            kind: 'website',
            url: 'https://example.com/products',
            span: 'Edelstahlbleche und Laserzuschnitte',
          },
        ],
        rationale: '官网产品页与 ICP 材质一致。',
      },
      {
        id: 'C2_ROLE',
        applicable: true,
        score: 9,
        label: 'pass',
        evidence: [
          {
            kind: 'impressum',
            url: 'https://example.com/impressum',
            span: 'Großhandel mit Markenwerkzeugen',
          },
        ],
        rationale: '明确批发转售第三方品牌。',
      },
      {
        id: 'C3_PROCESS',
        applicable: true,
        score: 7,
        label: 'pass',
        evidence: [
          {
            kind: 'website',
            url: 'https://example.com/fertigung',
            span: 'Laserschneiden und Kanten',
          },
        ],
        rationale: '覆盖核心工艺，缺焊接。',
      },
      {
        id: 'C4_BUSINESS_MODEL',
        applicable: true,
        score: 8,
        label: 'pass',
        evidence: [
          {
            kind: 'website',
            url: 'https://example.com/ueber-uns',
            span: 'Handelsunternehmen mit eigenem Lager',
          },
        ],
        rationale: '采购转售模式明确。',
      },
      {
        id: 'C5_SIZE',
        applicable: false,
        score: null,
        label: 'not_applicable',
        evidence: [],
        rationale: 'ICP 未声明规模要求。',
      },
    ],
    evidence_completeness: true,
    verdict_proposed: 'FIT',
    refusal: { is_refusal: false, reason: null },
  };
}

describe('fit-v2 rubric（P3 J09）', () => {
  it('版本与权重：fit-v2，五 criterion 权重和为 1', () => {
    expect(RUBRIC_VERSION).toBe('fit-v2');
    expect(RUBRIC_CRITERIA.map((c) => c.id)).toEqual([...CRITERION_IDS]);
    const total = RUBRIC_CRITERIA.reduce((sum, c) => sum + c.weight, 0);
    expect(Math.round(total * 1000) / 1000).toBe(1);
  });

  it('锚点完整性：每个 criterion 都有 10/0/unclear 与至少一档中间分，键在闭集内', () => {
    for (const criterion of RUBRIC_CRITERIA) {
      const keys = Object.keys(criterion.anchors);
      for (const key of keys) {
        expect(ANCHOR_KEY_SET as readonly string[], `${criterion.id}.${key}`).toContain(key);
        expect(criterion.anchors[key]!.trim().length, `${criterion.id}.${key}`).toBeGreaterThan(0);
      }
      expect(keys, criterion.id).toContain('10');
      expect(keys, criterion.id).toContain('0');
      expect(keys, criterion.id).toContain('unclear');
      const middle = keys.filter(
        (key) => !['10', '0', 'unclear', '9'].includes(key),
      );
      expect(middle.length, criterion.id).toBeGreaterThan(0);
      expect(criterion.evidenceRequired.length, criterion.id).toBeGreaterThan(0);
    }
  });

  it('rubric hash 冻结：锚点/权重/枚举改动必须显式升版本', () => {
    expect(RUBRIC_SHA256).toBe(
      '4abc5652e8eead2641ff5a2d73fde06e9d2faf8ac4514dd6c0e82c50745f0f53',
    );
  });

  it('prompt hash 冻结：任何措辞/格式/锚点改动都会变红', () => {
    expect(PROMPT_HASH).toBe(
      'a3b4a557717e947b838fe7e0d62e3140712a47db24b9285e77c6d4a5345ccf96',
    );
  });

  it('prompt 与 rubric 同源：每条锚点文本逐字出现在 system prompt 里', () => {
    for (const criterion of RUBRIC_CRITERIA) {
      expect(JUDGE_SYSTEM_PROMPT).toContain(criterion.id);
      for (const text of Object.values(criterion.anchors)) {
        expect(JUDGE_SYSTEM_PROMPT, criterion.id).toContain(text);
      }
    }
  });

  it('prompt 构造器只替换占位符、hash 稳定', () => {
    const prompt = buildJudgePrompt({
      icpBrief: '德国金属加工进口商，50-200 人',
      companySnapshot: 'Muster Metallbau GmbH; Edelstahl; Großhandel',
    });
    expect(prompt.user).toContain('德国金属加工进口商');
    expect(prompt.user).toContain('Muster Metallbau GmbH');
    expect(prompt.user).not.toContain('{{icpBrief}}');
    expect(prompt.promptHash).toBe(PROMPT_HASH);
    expect(prompt.schemaVersion).toBe('judge-output/v2');
  });
});

describe('judge-output/v2 结构校验', () => {
  it('金样例通过', () => {
    const result = validateJudgeOutputV2(golden());
    expect(result.ok).toBe(true);
  });

  it('schema 是严格闭集：additionalProperties=false 且 required 齐全', () => {
    const schema = JUDGE_OUTPUT_JSON_SCHEMA;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual([
      'criteria',
      'evidence_completeness',
      'verdict_proposed',
      'refusal',
    ]);
    const item = schema.properties.criteria.items;
    expect(item.additionalProperties).toBe(false);
    expect(item.properties.label.enum).toEqual([
      'pass',
      'weak',
      'fail',
      'unclear',
      'not_applicable',
    ]);
  });

  it('多余字段、缺字段、枚举漂移、重复 criterion、证据超限都拒绝', () => {
    const extra = { ...golden(), extra: true } as unknown;
    expect(validateJudgeOutputV2(extra).ok).toBe(false);

    const missing = { ...golden() } as Record<string, unknown>;
    delete missing['refusal'];
    expect(validateJudgeOutputV2(missing).ok).toBe(false);

    const drift = golden();
    drift.criteria[0]!.label = 'maybe' as never;
    expect(validateJudgeOutputV2(drift).ok).toBe(false);

    const duplicate = golden();
    duplicate.criteria[1]!.id = 'C1_MATERIAL';
    expect(validateJudgeOutputV2(duplicate).ok).toBe(false);

    const tooManyEvidence = golden();
    tooManyEvidence.criteria[0]!.evidence = Array.from({ length: 7 }, () => ({
      kind: 'website' as const,
      url: 'https://example.com',
      span: 'x',
    }));
    expect(validateJudgeOutputV2(tooManyEvidence).ok).toBe(false);

    const badScore = golden();
    badScore.criteria[0]!.score = 11;
    expect(validateJudgeOutputV2(badScore).ok).toBe(false);
  });
});
