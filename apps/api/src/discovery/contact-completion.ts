/**
 * 电话 / LinkedIn 补全管线（2026-11-10，多源证据图核心切片 ④）。
 *
 * 复用两条既有产品路径，不新增解析器：
 *  - `collectCompanyChannels`（A1/A4）：Impressum/联系页 → role 邮箱、总机电话、表单 URL；
 *  - `findContactPaths`（BI-14）：首页链接 → 自家 LinkedIn 公司页（/company/<slug>，slug 与域名锚定）。
 *
 * 本模块只做**装配**（纯函数）：给定首页 markdown 与已抓取的法定页，产出
 *  - 要写 company_contact_channel 的电话/表单渠道（**邮箱不进本管线**——邮箱走联系人/公司渠道
 *    既有链路，本管线只补电话与 LinkedIn，避免在回填里另起一套 amber 数据路径）；
 *  - 要写 company_contact_point 的 linkedin_company_page URL。
 * 抓取（robots 先检、crawl4ai render）与落库由 CLI 脚本完成：
 * `apps/api/scripts/complete-contact-channels.mts`。
 */
import type { CompanyChannelInput } from './company-contact-channel';
import { collectCompanyChannels, type ImpressumPage } from './impressum/collect-company-channels';
import { findContactPaths, type CompanyContactLinks } from './website-profile/contact-paths';

export interface ContactCompletionPlan {
  /** 电话与表单渠道（公司级 A4 层）；本管线不写邮箱。 */
  channels: CompanyChannelInput[];
  /** 首页链接到的自家 LinkedIn 公司页；无则 null。 */
  linkedinCompanyPage: string | null;
  /** 首页链接解析明细（诊断用）。 */
  links: CompanyContactLinks;
}

export function planContactCompletion(args: {
  /** 公司主域（小写、无 www）。 */
  domain: string;
  /** ISO 国家码（DE/AT/CH 启用无 + 的号码补全，见 collectCompanyChannels）。 */
  country?: string | null;
  /** 首页 markdown（crawl4ai.fetch）——findContactPaths 解析链接用。 */
  homeMarkdown: string;
  /** 已抓取的 Impressum/联系页（robots 已检）。 */
  pages: ImpressumPage[];
  /** 渠道上限（默认沿用 collectCompanyChannels 的 8）。 */
  cap?: number;
}): ContactCompletionPlan {
  const links = findContactPaths(args.homeMarkdown, args.domain);
  const channels = collectCompanyChannels({
    domain: args.domain,
    country: args.country ?? undefined,
    pages: args.pages,
    ...(args.cap !== undefined ? { cap: args.cap } : {}),
  }).filter((channel) => channel.channel !== 'email');
  return { channels, linkedinCompanyPage: links.linkedinCompanyPage, links };
}
