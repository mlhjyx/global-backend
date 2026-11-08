---
date: 2026-11-08
title: Mine Impressum and legal pages for classified company-level contacts
---

- 起因：A1（Phase 2 第二项，产品负责人最关心的「德国邮箱覆盖率 70–90%」核心）——现有 public_web 只按首页链接正则抓 contact/impressum 页、从 markdown 抽邮箱电话，JSON-LD/cfemail 等 HTML 面形态与固定路径探测都拿不到；抽出的联系方式只进联系人层，没有公司级 role 邮箱/总机落点。
- 改动：
  - 新模块 `discovery/impressum/`：cfemail XOR 解码、schema.org JSON-LD contactPoint 抽取（Person 子树整体跳过）、文本混淆解码（[at]/[dot] 等）、HTML 实体解码（`info&#64;…` 防爬形态）、电话归一（`+49 (0)89` → `+4989`；非 DE/AT/CH 不猜国别）、法律页发现（链接评分 + DE/AT/CH 固定路径探测）、公司级渠道装配器（本站域/同组织域邮箱；personal 不进公司层；每条带来源页/来源类型/robots 留痕）。
  - `public_web` provider：Impressum/联系页改用 `crawl4ai.render` 取渲染后 HTML（JSON-LD/cfemail 取数面；内置 robots 强制），失败回退 markdown；产出 `companyChannels`。
  - `contact-discovery-core`：adapter 契约扩展可选 `companyChannels`，在**同一事务**内经 suppression 复读过滤（email/domain 规范化比对）后调 A4 写入器落 `company_contact_channel`；`crawl4ai.render` 加入联系人发现的持久回执生产者名单。
- 测试：抽取原语 25 例（cfemail/JSON-LD/混淆/ät/实体/电话矩阵/回溯与越界鲁棒性）、法律页发现 7 例、装配器 11 例（同组织域/冒充域/实体/缩写/失败安全）、provider 接线 1 例（渲染页 → mailto/tel → 公司级渠道、personal 剔除）、core 落库 3 例（suppression 过滤、公司被抑制不写、无渠道不写表）；既有 public-web/contacts-stage 全绿。
- 未做：A6 发送合规门；SMTP 验证（A2 范围）；JSON-LD 的 Person 型条目（个人数据只走联系人层）；展会/协会源（A10）。
- 审查修订（独立审查，2026-11-08）：`crawl4ai.render` 加入 contact.find_decision_makers 白名单（缺它时 ToolPolicyDenied 会把整次联系人发现打成失败）；渠道值 fail-safe 清洗（网页可控值不 throw）；公司被抑制时不写渠道；混淆正则改有界量词（40k 串 38s→毫秒）；同组织域改词根完全相等并拒冒充域；单段缩写（ds@/mm@）不冒认公司渠道；技术预算信封补 render 计数（fetch 14/render 8）；页数预算 2→4 且固定路径给全变体。

- 证据：`docs/evidence/acquisition/impressum-miner-2026-11-08.{json,md}`（dev 库 20 家 DE 真实样本：可达 Impressum 19 家，邮箱+电话双命中 11/19 = 57.9%——**DoD ≥80% 未达**；差距归因、脚本参数与产品默认的差异、后续项见 md）。
