---
date: 2026-11-03
title: Fix three contact-discovery blind spots behind the zero-yield companies
---

- 起因：M5 第三轮复测后仍有 4 家零产出公司。逐家重放引擎取页路径（镜像 `fe0c7d71`，含 #748）后定位到三类引擎盲区与一类输入数据问题：
  - `avag-pumpen.de`：裸域的 `robots.txt` 被 Apache 301 到不存在的伪主机（`https://www.avag-pumpen.derobots.txt`——主机与文件名直接拼接、缺 `/`），SSRF 护栏拒绝解析后被 fail-closed 成「全站禁抓」；但首页本身 301 到 www origin，其 robots 明确放行。
  - `ava-berlin.de`：crawl4ai 的 markdown 恰好带 3 条人物页链接（不含 Impressum），#748 的「不足 3 条才补原始 HTML」门槛没有触发；真实 Impressum（`common/info/impressum.html`）只在原始 HTML 锚点里，固定路径 `/impressum` 落在站点 404 上。
  - `michalowski-gmbh.de`：选页本身正确（Impressum + 三个团队页），但链接规范化剥掉了尾斜杠；该站对无斜杠形态返回 39 字节反爬空壳，crawl4ai 对四个页面全部 500，带斜杠形态才是含具名 Geschäftsführer 的真页面。
  - `jaeckel-ohg.de`：Impressum 确无具名人，但首页团队区块列了两位 geschäftsführender Gesellschafter 与销售/商务人员并附邮箱——引擎只用首页做链接发现、从不抽取首页自身；社媒层 6 条候选确为无关同名者，守卫丢弃正确。
- 改动：
  - `decision-maker` 选页：存储域名 robots 被拒时改判同注册域的**另一主机形态**（裸域 ⇄ www，站点常只在其一上配好 robots），以其自身 robots 为准，两个形态都拒绝才放弃，抓取起点同步改用放行的那一个；原始 HTML 锚点补抽不再以「markdown 不足 3 条」为前提（每个公司多一次轻量 `http.get`，仍受同一契约与主体绑定）；锚点与 markdown 链接保留站点给出的原始形态（尾斜杠），两种写法都出现时优先带斜杠形态，只用归一化键去重。
  - 抽取兜底：选定的人物页一个人都没抽到时，抽取已抓到的首页文本（小站把团队/决策人直接铺在首页）。
- 测试：锚点/链接抽取保留尾斜杠并按归一化键去重的单测（含站点两种形态内容不同的回归）；「markdown 已有 3 条人物页链接仍补抽原始 HTML」的 provider 用例；裸域 robots 被坏跳转误伤时改从 www 抓取、两个 origin 都拒才放弃的用例；首页兜底抽取（含机构名过滤）与「选定页已有人则不抽取首页」的成本闸门用例。
- 部署：无迁移；随下一班车上线。已入库的旧结果不回溯重算。
- 未做：不修 `jaeckel-ohg` 的公司名数据质量（DB 里是域名 slug，社媒 dork 引号搜 slug 只得到无关同名者）——属公司补全/命名归一的输入问题，另行排期。
