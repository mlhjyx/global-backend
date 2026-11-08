import { Prisma } from '@prisma/client';

import type { ContactEmailType } from './contact-classifier';

/**
 * A4（2026-11-08）：公司级联系方式层写入器。
 *
 * Impressum 法定公开的 role 邮箱、总机电话与联系表单 URL 是**公司事实**：email=amber
 * （职能邮箱，email_type 不得 personal——具名人只进联系人层），phone/form_url=green。
 * 自动化来源只写 UNVERIFIED；VALID 只能由人确认（updated_by 必填，DB 约束兜底）。
 * 幂等：唯一键 (workspace, company, channel, value)；重复出现只推进 last_seen。
 * suppression 前置由调用方负责（本写入器不做外部判断）。
 */

export type CompanyChannelKind = 'email' | 'phone' | 'form_url';
export type CompanyChannelSourceType = 'impressum' | 'contact_page' | 'homepage' | 'operator';

export interface CompanyChannelInput {
  channel: CompanyChannelKind;
  value: string;
  /** email 必填（且不得 personal）；phone/form_url 必须缺省。 */
  emailType?: ContactEmailType;
  sourceType: CompanyChannelSourceType;
  sourceUrl?: string;
  robotsStatus?: 'allowed' | 'disallowed' | 'unknown';
  tosStatus?: 'allowed' | 'restricted' | 'unknown';
  legalBasis?: 'legitimate_interest' | 'consent' | 'contract' | 'legal_obligation';
  verificationMethod?: 'smtp_rcpt' | 'pattern_guess' | 'provider_reported' | 'operator' | 'import';
}

export interface UpsertCompanyChannelsArgs {
  workspaceId: string;
  companyId: string;
  channels: CompanyChannelInput[];
  /** 观测时刻（缺省 now；测试注入）。 */
  seenAt?: Date;
}

const EMAIL_SHAPE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/u;
const PHONE_SHAPE = /^\+?[0-9()/ -]{5,32}$/u;

function normalizeValue(input: CompanyChannelInput): string {
  const trimmed = input.value.trim();
  if (input.channel === 'email') return trimmed.toLowerCase();
  if (input.channel === 'phone') return trimmed.replace(/\s+/gu, ' ');
  return trimmed;
}

function validate(input: CompanyChannelInput): string {
  const value = normalizeValue(input);
  if (input.channel === 'email') {
    if (!EMAIL_SHAPE.test(value)) throw new Error('COMPANY_CHANNEL_EMAIL_INVALID');
    if (!input.emailType) throw new Error('COMPANY_CHANNEL_EMAIL_TYPE_REQUIRED');
    if (input.emailType === 'personal') throw new Error('COMPANY_CHANNEL_PERSONAL_EMAIL_REFUSED');
  } else {
    if (input.emailType !== undefined) throw new Error('COMPANY_CHANNEL_EMAIL_TYPE_UNEXPECTED');
    if (input.channel === 'phone' && !PHONE_SHAPE.test(value)) throw new Error('COMPANY_CHANNEL_PHONE_INVALID');
    // 与 DB CHECK 对齐：只收干净联系页地址（无查询串/锚点/空白）。
    if (input.channel === 'form_url' && (!value.startsWith('https://') || /[?#\s]/u.test(value))) {
      throw new Error('COMPANY_CHANNEL_FORM_URL_INVALID');
    }
  }
  return value;
}

interface CompanyChannelTx {
  companyContactChannel: {
    upsert: (args: {
      where: {
        workspaceId_companyId_channel_value: {
          workspaceId: string;
          companyId: string;
          channel: string;
          value: string;
        };
      };
      update: Record<string, unknown>;
      create: Record<string, unknown>;
    }) => Promise<unknown>;
  };
}

export async function upsertCompanyContactChannels(
  tx: Prisma.TransactionClient,
  args: UpsertCompanyChannelsArgs,
): Promise<{ written: number }> {
  const seenAt = args.seenAt ?? new Date();
  const store = tx as unknown as CompanyChannelTx;
  let written = 0;
  for (const input of args.channels) {
    const value = validate(input);
    const dataClass = input.channel === 'email' ? 'amber' : 'green';
    await store.companyContactChannel.upsert({
      where: {
        workspaceId_companyId_channel_value: {
          workspaceId: args.workspaceId,
          companyId: args.companyId,
          channel: input.channel,
          value,
        },
      },
      // 重复观测：只推进 last_seen 与来源留痕；状态不因自动化重见而改变。
      update: {
        lastSeenAt: seenAt,
        ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
        ...(input.robotsStatus ? { robotsStatus: input.robotsStatus } : {}),
        ...(input.tosStatus ? { tosStatus: input.tosStatus } : {}),
      },
      create: {
        workspaceId: args.workspaceId,
        companyId: args.companyId,
        channel: input.channel,
        value,
        dataClass,
        status: 'UNVERIFIED',
        sourceType: input.sourceType,
        ...(input.emailType ? { emailType: input.emailType } : {}),
        ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
        ...(input.robotsStatus ? { robotsStatus: input.robotsStatus } : {}),
        ...(input.tosStatus ? { tosStatus: input.tosStatus } : {}),
        ...(input.legalBasis ? { legalBasis: input.legalBasis } : {}),
        ...(input.verificationMethod ? { verificationMethod: input.verificationMethod } : {}),
        firstSeenAt: seenAt,
        lastSeenAt: seenAt,
      },
    });
    written += 1;
  }
  return { written };
}
