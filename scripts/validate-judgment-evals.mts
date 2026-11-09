/**
 * judge 金标清单确定性校验（P3 J11；设计 §4.3.10.1 层 D）。
 *
 * 每 PR 在 CI 跑（挂在 docs:verify 里），零模型调用、零数据库：
 *  1. manifest 结构与身份：schemaVersion / rubricVersion / rubricSha256 / promptHash /
 *     judge-output 版本必须与代码常量一致（rubric 或 prompt 一变，金标必须显式重冻结）；
 *  2. 每个 case 文件 sha256 与 inputDigest 与 manifest 逐字一致；
 *  3. judge 输出通过 judge-output/v2 结构校验；
 *  4. 证据校验 + 确定性聚合后的 verdict 与 reason 码与期望完全一致；
 *  5. 锚点完整性（10/0/unclear + 中间档、闭集键）与 required ensure 场景覆盖；
 *  6. case 文件 PII 扫描（不得含邮箱/电话；金标只存公司级公开证据）。
 *
 * 用法：pnpm exec tsx scripts/validate-judgment-evals.mts
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  aggregateJudgment,
  type JudgmentReasonCode,
} from '../apps/api/src/discovery/judgment/aggregate-judgment';
import {
  validateEvidence,
  type EvidenceUrlPolicy,
} from '../apps/api/src/discovery/judgment/evidence-validate';
import {
  ANCHOR_KEY_SET,
  CRITERION_IDS,
  RUBRIC_CRITERIA,
  RUBRIC_SHA256,
  RUBRIC_VERSION,
} from '../apps/api/src/discovery/judgment/fit-rubric';
import {
  JUDGE_OUTPUT_SCHEMA_VERSION,
  validateJudgeOutputV2,
  type JudgeCriterionOutput,
} from '../apps/api/src/discovery/judgment/judge-output-v2';
import { PROMPT_HASH } from '../apps/api/src/discovery/judgment/judge-prompt';

const ROOT = resolve(import.meta.dirname, '..');
const GOLDEN_DIR = resolve(ROOT, 'evals/golden-judgments');
const MANIFEST_PATH = resolve(GOLDEN_DIR, 'manifest.json');
const MANIFEST_SCHEMA_VERSION = 'golden-judgments/v1';

const REQUIRED_ENSURE = [
  'injection',
  'refusal',
  'evidence-missing',
  'competitor',
  'size',
] as const;

const VALID_SPLITS = ['calib', 'test', 'candidate', 'retired'] as const;

/** 金标不得含邮箱/电话（公开公司级证据里的招聘联系方式也不行）。 */
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u;
const ISO_INSTANT = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/gu;
const PHONE_CANDIDATE = /\+?\(?\d[\d\s()/-]{5,}\d/gu;

/**
 * 电话启发式：先剥掉 ISO 时间戳（否则 2026-11-09 会被误报），
 * 再把「至少 9 位数字」的连续号码候选视为电话（德国号码如 030 12345678）。
 */
function looksLikePhone(text: string): boolean {
  const stripped = text.replace(ISO_INSTANT, ' ');
  for (const match of stripped.matchAll(PHONE_CANDIDATE)) {
    const digits = (match[0].match(/\d/gu) ?? []).length;
    if (digits >= 9) return true;
  }
  return false;
}

interface GoldenCaseFile {
  ensure: string;
  expected: { label: 'FIT' | 'NOT_FIT' | 'UNKNOWN'; note?: string; reasonCodes: string[] };
  id: string;
  input: { icpBrief: string; snapshot: { fetchedAt: string; text: string } };
  judge: {
    denyUrls?: string[];
    now: string;
    output: unknown;
  };
}

interface ManifestCase {
  ensure: string;
  expectedLabel: string;
  expectedReasonCodes: string[];
  file: string;
  fileSha256: string;
  id: string;
  inputDigest: string;
  split: string;
}

interface Manifest {
  cases: ManifestCase[];
  promptHash: string;
  rubricSha256: string;
  rubricVersion: string;
  schemaVersion: string;
  schemaVersionJudge: string;
}

const errors: string[] = [];
const fail = (message: string): void => {
  errors.push(message);
};

function sha256Bytes(bytes: Buffer | string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function canonicalInputDigest(input: GoldenCaseFile['input']): string {
  return sha256Bytes(JSON.stringify(input));
}

function verifyIdentity(manifest: Manifest): void {
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    fail(`manifest.schemaVersion: expected ${MANIFEST_SCHEMA_VERSION}`);
  }
  if (manifest.rubricVersion !== RUBRIC_VERSION) {
    fail(
      `manifest.rubricVersion ${manifest.rubricVersion} ≠ code ${RUBRIC_VERSION}: rubric 变更必须重冻结金标`,
    );
  }
  if (manifest.rubricSha256 !== RUBRIC_SHA256) {
    fail('manifest.rubricSha256 与代码不一致：先升 RUBRIC_VERSION 再更新金标');
  }
  if (manifest.promptHash !== PROMPT_HASH) {
    fail('manifest.promptHash 与代码不一致：prompt/rubric 变更必须显式重冻结金标');
  }
  if (manifest.schemaVersionJudge !== JUDGE_OUTPUT_SCHEMA_VERSION) {
    fail(
      `manifest.schemaVersionJudge ${manifest.schemaVersionJudge} ≠ ${JUDGE_OUTPUT_SCHEMA_VERSION}`,
    );
  }
}

function verifyAnchors(): void {
  for (const criterion of RUBRIC_CRITERIA) {
    const keys = Object.keys(criterion.anchors);
    for (const key of keys) {
      if (!(ANCHOR_KEY_SET as readonly string[]).includes(key)) {
        fail(`anchor ${criterion.id}.${key} 不在闭集内`);
      }
    }
    for (const required of ['10', '0', 'unclear']) {
      if (!keys.includes(required)) {
        fail(`anchor ${criterion.id} 缺档位 ${required}`);
      }
    }
    const middle = keys.filter(
      (key) => !['10', '9', '0', 'unclear'].includes(key),
    );
    if (middle.length === 0) fail(`anchor ${criterion.id} 缺中间档位`);
  }
  if (RUBRIC_CRITERIA.length !== CRITERION_IDS.length) {
    fail('rubric criterion 数量与 CRITERION_IDS 不一致');
  }
}

function verifyCase(
  manifestCase: ManifestCase,
): void {
  const casePath = resolve(GOLDEN_DIR, manifestCase.file);
  if (!existsSync(casePath)) {
    fail(`${manifestCase.id}: case 文件不存在（${manifestCase.file}）`);
    return;
  }
  const raw = readFileSync(casePath);
  if (sha256Bytes(raw) !== manifestCase.fileSha256) {
    fail(`${manifestCase.id}: fileSha256 与 manifest 不一致（fixture 改动必须重登记）`);
  }
  if (!(VALID_SPLITS as readonly string[]).includes(manifestCase.split)) {
    fail(`${manifestCase.id}: 非法 split ${manifestCase.split}`);
  }

  let parsed: GoldenCaseFile;
  try {
    parsed = JSON.parse(raw.toString('utf8')) as GoldenCaseFile;
  } catch (error) {
    fail(`${manifestCase.id}: 不是合法 JSON（${String(error)}）`);
    return;
  }
  if (parsed.id !== manifestCase.id) {
    fail(`${manifestCase.id}: 文件内 id ${parsed.id} 与 manifest 不一致`);
  }
  if (parsed.ensure !== manifestCase.ensure) {
    fail(`${manifestCase.id}: ensure 类别与 manifest 不一致`);
  }
  if (canonicalInputDigest(parsed.input) !== manifestCase.inputDigest) {
    fail(`${manifestCase.id}: inputDigest 与 manifest 不一致（输入改动必须重登记）`);
  }
  if (parsed.expected.label !== manifestCase.expectedLabel) {
    fail(`${manifestCase.id}: expectedLabel 与 manifest 不一致`);
  }
  if (
    JSON.stringify([...parsed.expected.reasonCodes].sort()) !==
    JSON.stringify([...manifestCase.expectedReasonCodes].sort())
  ) {
    fail(`${manifestCase.id}: expectedReasonCodes 与 manifest 不一致`);
  }

  const caseText = raw.toString('utf8');
  if (EMAIL_PATTERN.test(caseText)) {
    fail(`${manifestCase.id}: 命中 PII 扫描（email）——金标只允许公司级公开证据`);
  }
  if (looksLikePhone(caseText)) {
    fail(`${manifestCase.id}: 命中 PII 扫描（phone）——金标只允许公司级公开证据`);
  }

  const validation = validateJudgeOutputV2(parsed.judge.output);
  if (!validation.ok) {
    fail(
      `${manifestCase.id}: judge 输出未通过 judge-output/v2 校验：${validation.errors.join('; ')}`,
    );
    return;
  }

  const denied = new Set(parsed.judge.denyUrls ?? []);
  const urlPolicy: EvidenceUrlPolicy = (url) => ({ allowed: !denied.has(url) });
  const evidence = validateEvidence(
    validation.value.criteria as readonly JudgeCriterionOutput[],
    {
      now: parsed.judge.now,
      snapshotFetchedAt: parsed.input.snapshot.fetchedAt,
      snapshotText: parsed.input.snapshot.text,
      urlPolicy,
    },
  );
  const result = aggregateJudgment({ output: validation.value, evidence });

  if (result.verdict !== parsed.expected.label) {
    fail(
      `${manifestCase.id}: 聚合结果 ${result.verdict} ≠ 期望 ${parsed.expected.label}（原因 ${result.reasonCodes.join(',')}）`,
    );
  }
  const expected = [...parsed.expected.reasonCodes].sort();
  const actual = [...new Set(result.reasonCodes as JudgmentReasonCode[])].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(
      `${manifestCase.id}: reason 码 ${actual.join(',')} ≠ 期望 ${expected.join(',')}`,
    );
  }
}

function main(): void {
  if (!existsSync(MANIFEST_PATH)) {
    console.error('[judgment-evals] manifest.json 不存在');
    process.exit(1);
  }
  const manifest = JSON.parse(
    readFileSync(MANIFEST_PATH, 'utf8'),
  ) as Manifest;

  verifyIdentity(manifest);
  verifyAnchors();

  if (!Array.isArray(manifest.cases) || manifest.cases.length === 0) {
    fail('manifest.cases 必须是非空数组');
  }
  const ids = new Set<string>();
  for (const manifestCase of manifest.cases ?? []) {
    if (ids.has(manifestCase.id)) fail(`重复 case id：${manifestCase.id}`);
    ids.add(manifestCase.id);
    verifyCase(manifestCase);
  }

  for (const required of REQUIRED_ENSURE) {
    if (!(manifest.cases ?? []).some((c) => c.ensure === required)) {
      fail(`缺少 required ensure 场景：${required}`);
    }
  }
  if ((manifest.cases ?? []).length < 15) {
    fail(`金标用例少于 15 个（当前 ${(manifest.cases ?? []).length}）`);
  }

  if (errors.length > 0) {
    console.error(`[judgment-evals] FAILED — ${errors.length} 个问题：`);
    for (const message of errors) console.error(`  - ${message}`);
    process.exit(1);
  }
  console.log(
    `[judgment-evals] OK — ${manifest.cases.length} 个金标用例通过（rubric ${RUBRIC_VERSION}，schema ${JUDGE_OUTPUT_SCHEMA_VERSION}，prompt ${PROMPT_HASH.slice(0, 12)}…）`,
  );
}

main();
