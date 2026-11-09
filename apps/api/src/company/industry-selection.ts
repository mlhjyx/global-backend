import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

/**
 * 行业选择落库（注册即建档第 1 步，2026-11-10）。
 *
 * - 给出 industryCode：必须是 canonical_taxonomy(kind='industry') 的现存节点；industry
 *   存展示标签（客户端随语言传入的标签优先，缺省用词表中文/德文/英文标签）。
 * - 只给 industry 自由文本：保持旧行为，industryCode 不写。
 * - 两者都不给：都不写。
 *
 * 读取 canonical_taxonomy 是平台表（app_user 只读），在调用方事务内读即可。
 */
export interface IndustrySelection {
  readonly industry?: string;
  readonly industryCode?: string;
}

export async function resolveIndustrySelection(
  tx: Prisma.TransactionClient,
  input: { readonly industry?: string; readonly industryCode?: string },
): Promise<IndustrySelection> {
  if (input.industryCode === undefined) {
    if (input.industry === undefined) return {};
    const industry = input.industry.trim();
    if (!industry) {
      throw new BadRequestException({
        error: { code: 'VALIDATION_ERROR', message: 'industry 不能为空' },
      });
    }
    return { industry };
  }
  const node = await tx.canonicalTaxonomy.findUnique({
    where: { kind_code: { kind: 'industry', code: input.industryCode } },
    select: { code: true, labelEn: true, labels: true },
  });
  if (!node) {
    throw new BadRequestException({
      error: {
        code: 'UNKNOWN_INDUSTRY_CODE',
        message: `industryCode「${input.industryCode}」不在受控行业词表中`,
      },
    });
  }
  const labels = (node.labels as Record<string, string> | null) ?? {};
  const label =
    input.industry?.trim() || labels.zh || labels.de || node.labelEn;
  return { industry: label, industryCode: node.code };
}
