import type { PrismaClient } from '@prisma/client';

/**
 * 制裁名单源 + source_policy 种子（平台级，owner 连接写；启动期幂等，与 DiscoveryProviderRegistry.seed 同点调用）。
 * 🔴 全部 **status=DISABLED**（真测绿后 ops 手动翻 ENABLED；`update:{}` 不覆盖 ops 手改）。
 * 端点据 2026-07-14 一手真探（OFAC 跟 302 + 必带 UA；EU 固定公开 token）。
 */

interface SanctionsSourceSeed {
  key: string;
  label: string;
  url: string;
  format: string;
  license: string;
}

const SOURCES: SanctionsSourceSeed[] = [
  {
    key: 'ofac_sdn',
    label: 'OFAC SDN (US Treasury)',
    url: 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML',
    format: 'ofac_sdn_xml',
    license: 'Public Domain (U.S. Government Work)',
  },
  {
    key: 'ofac_consolidated',
    label: 'OFAC Consolidated (Non-SDN, US Treasury)',
    url: 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/CONSOLIDATED.XML',
    format: 'ofac_sdn_xml', // 与 SDN 同 schema，共用解析器
    license: 'Public Domain (U.S. Government Work)',
  },
  {
    key: 'eu_fsf',
    label: 'EU Consolidated Financial Sanctions (FSF, DG FISMA)',
    url: 'https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw',
    format: 'eu_fsf_xml',
    license: 'CC-BY-4.0', // EU 再用（Decision 2011/833/EU）——实现期核实
  },
];

interface SanctionsPolicySeed {
  domain: string;
  notes: string;
}

const POLICIES: SanctionsPolicySeed[] = [
  {
    domain: 'sanctionslistservice.ofac.treas.gov',
    notes:
      'OFAC SDN/Consolidated 官方下载（零鉴权，必带 User-Agent + 跟 302）。美国政府作品公共领域（署名非义务）。'
      + '🔴 原始含个人条目（Individual）→ 摄取层 parseOfacXml 结构性剔除，绝不入绿库。只公开端点、不爬 UI。',
  },
  {
    domain: 'webgate.ec.europa.eu',
    notes:
      'EU FSF 制裁名单（固定公开 token，非人肉密钥）。EU 再用许可（CC-BY 式，实现期核实）。'
      + '🔴 原始含个人条目（person）→ 摄取层 parseEuFsf 结构性剔除。只公开 token 文件端点、不爬 portal UI。',
  },
];

/** 幂等 seed（owner 连接）：sanctions_source（DISABLED）+ source_policy（sanctions_screening 用途门）。 */
export async function seedSanctions(db: PrismaClient): Promise<void> {
  for (const s of SOURCES) {
    await db.sanctionsSource.upsert({
      where: { key: s.key },
      update: {}, // 不覆盖 ops 手改的 status/config
      create: { key: s.key, label: s.label, url: s.url, format: s.format, license: s.license, status: 'DISABLED' },
    });
  }
  for (const p of POLICIES) {
    await db.sourcePolicy.upsert({
      where: { domain: p.domain },
      update: {},
      create: {
        domain: p.domain,
        sourceType: 'sanctions_list',
        accessMode: 'api',
        reviewStatus: 'APPROVED',
        robotsStatus: 'ALLOWS',
        termsStatus: 'REVIEWED_OK',
        personalData: true, // 原始名单含个人（摄取层剔除）；用途门仅放行 sanctions_screening
        allowedPurpose: ['sanctions_screening'],
        retentionDays: 365,
        notes: p.notes,
      },
    });
  }
}
