import { clamp01 } from '../lead/scoring';
import { deriveFitReasonCodes } from '../lead/reason-codes';
import { leadSignals } from '../lead/lead-package';
import { SUGGESTED_CONTACT_LEGAL_NOTE, suggestedContactPath } from '../lead/suggested-contact-path';
import type { CsvValue } from './csv';

/**
 * Columns of the BI-22 weekly report (design `docs/superpowers/plans/2026-10-10-lead-delivery-loop-design.md`
 * §5), Chinese headers as in the PRD weekly report. 为什么现在 / 原因码 / 注册地址 are filled from the
 * company's green facts (signals, deterministic reason codes, Impressum address); 开发信草稿 stays empty
 * until the L5 draft task fills it. The five customer columns stay last so the filled file can come back
 * through the feedback upload (BI-23) keyed by 线索 ID.
 */
export const WEEKLY_REPORT_COLUMNS = Object.freeze([
  '公司名',
  '域名',
  '国家',
  '贸易角色',
  '贸易角色置信度',
  '自有制造',
  '在售品牌（中国）',
  '在售品牌（非中国，含产地）',
  '登记号',
  '税号',
  '为什么现在',
  'Fit 分',
  '角色分',
  '意图分',
  '数据质量分',
  '可达性分',
  '互动分',
  '总分',
  'Fit 结论',
  '原因码',
  '证据链接',
  '联系路径',
  '注册地址',
  '开发信草稿',
  '制裁状态',
  '有效期至',
  '本条成本 USD（所属发现 run 合计，后端账本口径，未按线索分摊）',
  '所属发现 run ID',
  '线索 ID',
  '客户填写：相关性（1-5）',
  '客户填写：愿意联系（是/否）',
  '客户填写：原因码',
  '客户填写：备注',
  '客户填写：是否已联系（是/否）',
] as const);

/** Sanctions outcome of an exported row; an unresolved hit is withheld before a row is built. */
export type WeeklyReportSanctionsStatus = 'clear' | 'cleared_false_positive' | 'not_screened';

export interface WeeklyReportRowInput {
  readonly leadId: string;
  readonly fitVerdict: string | null;
  /** lead.fitReasons / lead.scoreDetail / lead.queue feed the deterministic reason codes (BI-20). */
  readonly fitReasons?: unknown;
  readonly scoreDetail?: unknown;
  readonly queue?: string | null;
  readonly totalScore: number | null;
  /** lead.scores as scoring writes it: `{fit, role, intent, dataQuality, reachability, engagement}`. */
  readonly scores: unknown;
  readonly company: {
    readonly name: string;
    readonly domain: string | null;
    readonly country: string | null;
    readonly attributes: unknown;
  };
  /** company_contact_point rows of the company (green links only, by database CHECK). */
  readonly contactPoints: readonly { readonly kind: string; readonly value: string; readonly status: string }[];
  readonly sanctionsStatus: WeeklyReportSanctionsStatus;
  /** ISO timestamp from computeValidUntil, or null without freshness evidence. */
  readonly validUntil: string | null;
  /** The discovery run the lead came from and its ledger total; null charge when not exactly known. */
  readonly runCost: { readonly runId: string; readonly chargedMicrousd: bigint | null } | null;
}

const TRADE_ROLE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  distributor: '分销商',
  wholesaler: '批发商',
  manufacturer: '制造商',
  mixed: '制造兼分销',
  service: '服务商',
  other: '其他',
});

const FIT_VERDICT_LABELS: Readonly<Record<string, string>> = Object.freeze({
  match: '匹配',
  weak: '弱匹配',
  mismatch: '不匹配',
});

/** Design §7 preference order of contact paths, with their labels. */
const CONTACT_PATHS: readonly (readonly [kind: string, label: string])[] = Object.freeze([
  ['supplier_page', '供应商入驻页'],
  ['contact_form', '询盘表单'],
  ['contact_page', '联系页'],
  ['impressum_page', 'Impressum 页'],
  ['linkedin_company_page', 'LinkedIn 公司页'],
  ['x_company_account', 'X 账号'],
]);

const CONTACT_LABELS: ReadonlyMap<string, string> = new Map(CONTACT_PATHS);

const SANCTIONS_LABELS: Readonly<Record<WeeklyReportSanctionsStatus, string>> = Object.freeze({
  clear: '已筛查，无命中',
  cleared_false_positive: '已筛查，命中经人工复核为误报',
  not_screened: '未筛查（筛查未启用）',
});

const SCORE_KEYS = ['fit', 'role', 'intent', 'dataQuality', 'reachability', 'engagement'] as const;

/** Own-property lookup, so a stored value such as `constructor` never reads the prototype. */
function labelOf(labels: Readonly<Record<string, string>>, key: string): string {
  return Object.hasOwn(labels, key) ? labels[key]! : key;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function decimal(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? clamp01(value).toFixed(2) : '';
}

function yesNo(value: unknown): string {
  return value === true ? '是' : value === false ? '否' : '';
}

function isHttps(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('https://');
}

function brands(profile: Record<string, unknown>): { chinese: string; other: string } {
  const list = Array.isArray(profile.carried_brands) ? profile.carried_brands : [];
  const chinese: string[] = [];
  const other: string[] = [];
  for (const entry of list) {
    const brand = record(entry);
    const name = text(brand.name);
    if (!name) continue;
    const country = text(brand.country).toUpperCase();
    if (country === 'CN') chinese.push(name);
    else other.push(country ? `${name} (${country})` : name);
  }
  return { chinese: chinese.join('; '), other: other.join('; ') };
}

function usableContactPoints(points: WeeklyReportRowInput['contactPoints']) {
  return CONTACT_PATHS.flatMap(([kind, label]) =>
    points
      .filter((point) => point.kind === kind && point.status !== 'INVALID' && isHttps(point.value))
      .map((point) => ({ ...point, label })),
  );
}

/** Ledger micro-dollars as an exact USD decimal string. */
export function formatMicrousd(microusd: bigint): string {
  const whole = microusd / 1_000_000n;
  const fraction = (microusd % 1_000_000n).toString().padStart(6, '0');
  return `${whole}.${fraction}`;
}

/** One report row, in {@link WEEKLY_REPORT_COLUMNS} order. Missing facts stay empty, never guessed. */
export function weeklyReportRow(input: WeeklyReportRowInput): readonly CsvValue[] {
  const attributes = record(input.company.attributes);
  const profile = record(attributes.website_profile);
  const scores = record(input.scores);
  const carried = brands(profile);
  const points = usableContactPoints(input.contactPoints);
  const evidenceLinks = [
    ...new Set([...(isHttps(profile.source_url) ? [profile.source_url] : []), ...points.map((point) => point.value)]),
  ];
  const tradeRole = text(profile.trade_role);
  const verdict = input.fitVerdict ?? '';
  const whyNow = leadSignals(attributes)
    .map((signal) => `${signal.at.slice(0, 10)} ${signal.type}${signal.url ? ` ${signal.url}` : ''}`)
    .join('\n');
  const reasonCodes = deriveFitReasonCodes({
    fitVerdict: input.fitVerdict,
    queue: input.queue,
    scores: input.scores,
    scoreDetail: input.scoreDetail,
  }).join('; ');
  const suggested = suggestedContactPath(input.contactPoints);
  const suggestedLine = suggested
    ? `建议联系路径（${CONTACT_LABELS.get(suggested.kind) ?? suggested.kind}）：${suggested.url}（${SUGGESTED_CONTACT_LEGAL_NOTE}）`
    : '';
  const pathLines = points.map(
    (point) => `${point.label}：${point.value}${point.status === 'VALID' ? '（已人工确认）' : ''}`,
  );
  const row: CsvValue[] = [
    input.company.name,
    input.company.domain ?? '',
    input.company.country ?? '',
    labelOf(TRADE_ROLE_LABELS, tradeRole),
    decimal(profile.trade_role_confidence),
    yesNo(profile.own_manufacturing),
    carried.chinese,
    carried.other,
    text(profile.register_key),
    text(profile.vat_id),
    whyNow,
    ...SCORE_KEYS.map((key) => decimal(scores[key])),
    decimal(input.totalScore),
    labelOf(FIT_VERDICT_LABELS, verdict),
    reasonCodes,
    evidenceLinks.join('\n'),
    [...pathLines, ...(suggestedLine ? [suggestedLine] : [])].join('\n'),
    text(profile.registered_address),
    '', // 开发信草稿: first-contact draft (L5 task, not generated in this PR)
    SANCTIONS_LABELS[input.sanctionsStatus],
    input.validUntil ? input.validUntil.slice(0, 10) : '',
    input.runCost?.chargedMicrousd == null ? '' : formatMicrousd(input.runCost.chargedMicrousd),
    input.runCost?.runId ?? '',
    input.leadId,
    '',
    '',
    '',
    '',
    '',
  ];
  return Object.freeze(row);
}
