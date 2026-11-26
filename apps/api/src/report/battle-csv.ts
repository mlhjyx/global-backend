/**
 * Gate 1 受审计多通道作战 CSV 导出器（CWE-1236 公式注入防护 + 法域合规标签）：
 *
 * 复用 `report/csv.ts` 的 RFC 4180 + UTF-8 BOM + OWASP 公式中和编码器，
 * 面向外贸工厂/试点企业（如琏升科技）直接输出可导入 Excel / 飞书多维表格的作战清表。
 * 纯函数、零跨模块依赖（符合 G16）。
 */
import { encodeCsv, type CsvValue } from './csv';

export interface BattleCsvRow {
  readonly companyName: string;
  readonly country: string;
  readonly domain: string | null;
  readonly fitScore: number | null;
  readonly evidenceSummary: string;
  readonly channelTier: 'S' | 'A' | 'B' | 'C';
  readonly contactName: string | null;
  readonly contactTitle: string | null;
  readonly committeeTrack: string;
  readonly contactEmail: string | null;
  readonly emailVerificationState: string | null;
  readonly linkedinUrl: string | null;
  readonly triggerHook: string | null;
  readonly linkedinNote: string | null;
  readonly referralInfoDraft: string | null;
  readonly vendorPortalOrWhatsapp: string | null;
  readonly complianceTag: string;
  readonly legalNoticeStatus: string;
  readonly sellerInboundFooter: string | null;
  readonly forwardableBlurb?: string | null;
  readonly outreachWindow?: string | null;
}

export const BATTLE_CSV_HEADERS: readonly string[] = Object.freeze([
  '目标买家公司',
  '国家/地区',
  '官网域名',
  '匹配分(0-1)',
  '关键证据摘要(C1-C5)',
  '触达通道分级(S/A/B/C)',
  '决策人姓名',
  '职位',
  '决策委员会轨道',
  '触达邮箱',
  '邮箱验真状态',
  'LinkedIn主页',
  '近期破冰钩子(Trigger)',
  'LinkedIn 3句附言(≤280字)',
  'C级info@转交请求信',
  '供应商门户/公开商务WA',
  'D3法域合规标签',
  'Art.14/LIA合规状态',
  '卖方入站回复页脚',
  '同事内推转介包(<=60词)',
  '当地工作时区与拨号提示',
]);

/** 个人邮箱局部脱敏（用于对外审计/汇报；真实试点作战导出传 maskPersonalEmails: false）。 */
export function maskEmailLocalPart(email: string | null): string {
  if (!email) return '';
  const trimmed = email.trim();
  const at = trimmed.indexOf('@');
  if (at <= 0) return trimmed;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  const prefix = local.slice(0, Math.min(2, local.length));
  return `${prefix}***@${domain}`;
}

export function renderBattleCsv(
  rows: readonly BattleCsvRow[],
  opts?: { maskEmails?: boolean },
): string {
  const mask = opts?.maskEmails === true;
  const encodedRows: CsvValue[][] = rows.map((row) => [
    row.companyName,
    row.country,
    row.domain ?? '',
    typeof row.fitScore === 'number' && Number.isFinite(row.fitScore) ? row.fitScore.toFixed(2) : '',
    row.evidenceSummary,
    row.channelTier,
    row.contactName ?? '',
    row.contactTitle ?? '',
    row.committeeTrack,
    mask ? maskEmailLocalPart(row.contactEmail) : (row.contactEmail ?? ''),
    row.emailVerificationState ?? '',
    row.linkedinUrl ?? '',
    row.triggerHook ?? '',
    row.linkedinNote ?? '',
    row.referralInfoDraft ?? '',
    row.vendorPortalOrWhatsapp ?? '',
    row.complianceTag,
    row.legalNoticeStatus,
    row.sellerInboundFooter ?? '',
    row.forwardableBlurb ?? '',
    row.outreachWindow ?? '',
  ]);
  return encodeCsv(BATTLE_CSV_HEADERS, encodedRows);
}
