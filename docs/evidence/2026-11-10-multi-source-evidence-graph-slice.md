# 多源证据图核心切片：数据归一 / 证据包 shadow / 佐证门 / 接触点补全 / golden 评测（2026-11-10）

> 生命周期：`APPROVED`（产品负责人 2026-11-10 批准「注册号锚定的多源证据图」核心切片，当晚交付）
> 结论：五项交付全部落地——dev 库归一回填与试点接触点补全真跑；证据包接进判定链现场装配，
> 跨源佐证门按 **enforce** 生效（FIT/NOT_FIT 不足 2 个独立分层即 fail-closed 降级 UNKNOWN，
> 开关 `JUDGE_CORROBORATION_MODE` 可回滚到 shadow/off）；golden ICP 评测集可运行。**不部署、
> 不发车**——代码改动在 PR 内待合；dev 库写入为幂等回填与 `attributes.evidence_bundle` /
> `industry_normalization`（审计面）。产品负责人当晚口径：取消影子期，直接 enforce。

## 1. 数据归一 backfill（真跑）

脚本：`apps/api/scripts/backfill-company-normalization.mts`（默认 dry-run；owner 连接跨租户，
按 id+原值条件更新）。归一函数：`apps/api/src/discovery/company-normalization.ts`。

**BEFORE（2026-11-10 dev 库实测，2423 行）**：

| country | 行数 |
| --- | --- |
| NULL | 1169 |
| DE | 846 |
| AT | 78 |
| CN | 76 |
| 德国 | 72 |
| CH | 68 |
| US | 61 |
| IT | 36 |
| FR | 9 |
| IN | 8 |

industry 空：**2303 / 2423** 行。

**dry-run 计划**：country 变更 121 行（变体归一 72：`德国`→DE；VAT 前缀补空 44；
GLEIF 注册国补空 5）；industry 回填候选 461 行（按 ISIC：28 机械设备 393、325 医疗器械 23、
24 基本金属 11、29 汽车 10、2599 钣金 9、26 电子 8、272 电池 4、303 航空航天 2、2610 电子元件 1）；
未识别 country 值：无。

**apply 结果**（`--apply`，已写 country 121 / industry 461）：

| country | 行数（after） |
| --- | --- |
| NULL | 1120 |
| DE | 963 |
| AT | 78 |
| CN | 76 |
| CH | 68 |
| US | 62 |
| IT | 37 |
| FR | 11 |
| IN | 8 |

industry 空：**1842 / 2423**（回填 461）。

**幂等验证**：apply 后重跑 dry-run → country 变更 0、industry 候选 0。

已知取舍：industry 推断是**粗粒度 ISIC 部门锚**（非最终 taxonomy）——证据来自
keywords/products（权重 2）、官网证据句（权重 1）、TED CPV / FDA product code 交叉表；
官网整句顺带提到的材质词可能带来噪声（如钢材提及 → 24），命中依据随
`attributes.industry_normalization.matched_terms` 落库供复核。非空 industry 永不覆盖。
不从域名 TLD 猜国家；未知 country 值只报告、不落库（本次没有未知值）。

## 2. 电话 / LinkedIn 补全（真跑 + 试点验证）

脚本：`apps/api/scripts/complete-contact-channels.mts`，试点名单 = `impressum-miner-2026-11-08`
的 20 家 DE 公司（`--domains=... --apply`，robots 先检、crawl4ai 双端点、每域去重、1s 间隔）。

**结果（2026-11-10，20/20 robots 允许、20/20 站点抓取成功、0 错误）**：

- **电话 12/20（60%）**：tsurumi.de 5、istpumpen.com 3、telekom.de 3、pumpentechnik-bass.de 2、
  sanotact-group.de 2、apollo-goessnitz.de 2、waldrichsiegen.de 2、de.milwaukeetool.eu 2、
  algamdach.de 2、aquaristik-bayern.de 1、wasserpumpe.de 1、eheim-service.de 1；
  抽查与 11-08 试点证据逐号一致（wasserpumpe.de `+4921618397808`、apollo `+4934493770`、istpumpen `+492261701430`）。
  与 11-08 一次性试点（14/20）的差异来自抓取波动（同域两次渲染不同，如 consent wall），
  管道幂等、重跑会收敛。
- **LinkedIn 0/20**：该批 SME 首页的渲染 markdown 里普遍没有 LinkedIn 链接（抽查 allweiler.de /
  ksb.com / mavex-pumpen.de 原始 markdown 零提及）——不是解析器问题（单测覆盖 /company/ 链接与
  自家页判定）；既有的 11 条 linkedin_company_page 是 website-profile 全量画像期留下的（~1000 家
  里 11 条，同样稀有）。本管线在站点真的链接公司页时会写入（单测 + provider 规则约束）。
- **写库**：company_contact_channel 42 次 upsert；库内 phone 27 条（impressum 17 + contact_page 10）、
  form_url 17 条（跑前分别为 1 条与 1 条）；company_contact_point 无新增（0 LinkedIn）。
  全部 UNVERIFIED、幂等（重复跑只推进 last_seen）。

## 3. 证据包 v1（enforce 接线，DE 少量样本，真跑）

脚本：`apps/api/scripts/build-evidence-bundle.mts`；装配器 `apps/api/src/discovery/evidence-bundle.ts`
（T1 官方注册/招投标/专利、T2 Wikidata、T3 官网/技术足迹/结构化收割）。判定链在 FIT/NOT_FIT
落地前按当前属性**现场装配**（零出网，含本 run 刚写回的 website_profile/富集结果），并把包写回
`attributes.evidence_bundle`（判定记录同事务；写失败按 fail-closed 让判定失败可重试）。CLI 的
实时探测部分（富集 provider 经 ToolBroker；内存预算账本）用于回填/离线复核。

**随机 DE 样本（10 家，dry-run）**：withBundle 5/10，corroborated（≥2 层）2/10；
tier 分布：none 5、T3 3、T2+T3 2。GLEIF/Wikidata 实时探测对该批 SME 命中很低
（GLEIF 覆盖以金融实体为主；样本含 2 个 `.example` 合成域）。

**定向样本（7 家已有 T1/T2 证据的 DE 公司，`--apply`）**：

| 公司域 | tiers | 来源 |
| --- | --- | --- |
| festool.com | T1+T2+T3 | gleif + wikidata + website/digital_footprint |
| al-ko.com | T1+T2+T3 | 同上 |
| group.pfeiffer-vacuum.com | T1+T2+T3 | gleif + wikidata + structured_harvest |
| framo-morat.com | T1+T3 | gleif + website_profile（wikidata 实时探测 miss） |
| avag-pumpen.de | T1 | gleif |
| axflow.com | T3 | 实时探测 miss（wikidata/gleif） |
| kramp.com | 无 | 实时探测 miss |

写库：7/7 `attributes.evidence_bundle`（kramp.com 写入空包 = 「已查无证据」的影子记录）。
dev 库现有 bundle：12 行（含下一节 5 家 IT 公司）。

## 4. 跨源佐证门（enforce，fail-closed）

评估器：`apps/api/src/discovery/judgment/corroboration.ts`（FIT/NOT_FIT 需 ≥2 个独立分层）。
判定链接线：`fit-judge-v2.ts`（v2 判定链 + Lead 投影：跨源不足即把 match/mismatch 降级 weak、
主记录 verdict 记 UNKNOWN、`verdictProposed` 保留原判定）与 `fit-judge.ts` v1 路径同口径；
`judgment_record.sampling.corroboration` 记录评估与降级原因。`JUDGE_CORROBORATION_MODE` 默认
`enforce`（非法值 fail-closed 到 enforce）；`shadow`/`off` 为回滚开关。判定快照（judge prompt）
新增 `cross_source_evidence` 摘要——证据分层真实参与理解输入，而非只做事后门。

**离线样例（dev 库真实 NOT_FIT 判定 × 证据包，CLI 生成）**：

| 公司 | verdict | tiers | corroboration |
| --- | --- | --- | --- |
| breton.it | NOT_FIT | T2+T3 | CORROBORATED |
| netframe.it | NOT_FIT | T2+T3 | CORROBORATED |
| leos.it | NOT_FIT | T2+T3 | CORROBORATED |
| cloanto.com | NOT_FIT | T2+T3 | CORROBORATED |
| valbruna-stainless-steel.com | NOT_FIT | T2+T3 | CORROBORATED |

5/5 已判定公司在离线评估下 CORROBORATED（Wikidata QID + 官网画像）——enforce 下这 5 条维持原判，
不会降级。反例：单层/无包公司在单测与 v2 判定用例中按 fail-closed 降级 UNKNOWN（Lead=weak/
待复核，绝不自动推荐或自动拒绝），见 `fit-judge-v2.spec.ts` 的跨源佐证门 describe。
**注**：dev 运行时仍是旧镜像——接线由单测覆盖，随下一班镜像生效后新判定自动带降级与记录。

## 5. Golden ICP 评测集（骨架，可运行）

评测集：`docs/eval/golden-icp/queries.yaml`（26 条查询，3 条已标注：泵类分销/泵类制造/泵类维修服务，
label 取自 dev 库真实公司与试点名单）；口径/标注模板：同目录 README；解析与排序：
`apps/api/src/eval/golden-icp.ts`；脚本：`apps/api/scripts/evaluate-golden-icp.mts`。

**首跑（k=10，dev 库）**：已标注 3 条，mean P@10 = **0.0333**、mean recall = **0.0833**
（de-pump-manufacturer 命中 ksb.com）。其余 23 条未标注，仅出候选预览。
解读：候选池 631 家（去重后）中泵类公司饱和，「词面/ISIC 排序 v0」把大量同为泵类的未标注公司
排进 top-10——top-10 预览人工复核基本都确实是泵类公司，**precision@10 是稀疏标注下的下限**；
后续接入证据包分层加分并补标注后重测（口径变化须在 README 记录）。

## 6. 发布与残余

- 不部署、不发车：全部改动经 PR 合入 main；下一班镜像生效后 enforce 门与证据包写回才在 run 内生效。
- 残余：① 富集阶段的证据探测历史上按「已有命名空间跳过」，T1 命中率受 provider 覆盖限制；
② golden 集 23 条待标注；③ industry 推断粗粒度（ISIC 部门），需人工/规则复核噪声；
④ companies_house/inpi_rne/google_patents/samgov 暂无 canonical 属性命名空间，暂不计入 T1
（留了抽取位，provider 一旦落命名空间即生效）。
