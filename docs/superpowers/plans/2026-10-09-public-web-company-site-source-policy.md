# public_web 公司自有官网通用 source_policy 落地设计

> 生命周期：`APPROVED`
> 生命周期依据：产品负责人 2026-10-09 会话内确认按建议实施（保留期 365 天、personal_data=true、用途只在 Raw 入库强制）

事实基线：`origin/main@265be43a`（#615 已合）。xin `global_dev` 只做只读 SELECT（2026-10-09）。迁移里的位置写作「迁移名 L行号」。

## 0. 结论

- 发现结果进不了公司库，唯一卡点是 Raw 入库要按来源主机找 source_policy。public_web 记录的来源主机是公司自己的域名，没有逐域策略，于是全部隔离（`SOURCE_POLICY_MISSING`），隔离行永远不物化。下游按域名查策略的门只对登记过的域名起作用（拦 SUSPENDED 或用途不符），未登记即放行，不受这个缺口影响。
- 方案：在 `source_policy` 加一行保留键 `public_web:company_site`。它不是合法主机名，任何主机匹配都碰不到它。TS 入库和 DB 写入器用同一套优先规则：先找逐域策略（最长匹配，SUSPENDED 也算）；找不到，且 provider 是 public_web、来源主机等于记录域名，才用通用行。
- 改动：`raw-source-ingestion.ts` 的 `policyFor`；一个迁移（新增绑定函数，并重定义 `write_raw_source_record_v2_legacy`）；`provider.registry.ts` 多 seed 一行；provider registry 文案。不改表结构，不改 `schema.prisma`，不碰受保护的 Broker 文件。
- 同一函数块顺带修两处 TS/DB 不一致（§3.4）。不修的话，用 SUSPENDED 封单站可能让整条 query 失败。

## 1. 实测与承重假设

| # | 假设 | 结论与证据 |
| --- | --- | --- |
| A1 | TS 入库怎样找策略 | `raw-source-ingestion.ts:310-361` 从 `provenance.sourceUrl` 取主机，小写并去掉开头的 `www.`。`policyFor`（`:363-420`）对每行 `domain` 做同样处理，按「相等或后缀」匹配，最长者胜；无匹配给 `kind:"missing"` 快照。判定顺序（`:548-572`）：无策略 → `SOURCE_POLICY_MISSING`；用途不含 `discovery` → `SOURCE_POLICY_PURPOSE_NOT_ALLOWED`；非 `APPROVED` → `SOURCE_POLICY_SUSPENDED`。三种都是 QUARANTINED。保留期取策略值，夹在 1–3650 之间；无策略时用 `RAW_SOURCE_DEFAULT_RETENTION_DAYS`，默认 365（`:70-74`）。 |
| A2 | 策略何时读 | `discovery.activities.ts:586-597` 在各源 fan-out 之前一次性读全表（表无 RLS，直接读）。同一份列表生成 SUSPENDED 黑名单（`:621-623`），public_web 在搜索阶段按**精确**域名跳过（`public-web.provider.ts:153,172`）。governed 路径（`discovery-query-governed-execution.ts:272-277`）和 legacy 路径（`discovery.activities.ts:727-732`）都用这份列表。 |
| A3 | DB 写入器的最终版本 | `write_raw_source_record_v2` 只是包装（`20260826150000` L512-587），真正写入的是 `write_raw_source_record_v2_legacy`，正文即 `20260826130000` L695-1011（`20260826150000` L509-510 改名，此后没有迁移再定义它）。xin 上两函数的 `md5(prosrc)` 分别是 `80b1a012…` 和 `8923e0e3…`，与两份迁移正文逐字一致。 |
| A4 | DB 是否按主机复核策略 | 会复核。应用只传 `sourcePolicyId`（`raw-source-writer.ts:21-25,61`）。写入器按 id 读策略（L920-923，`FOR KEY SHARE`），要求四件事，否则 RAISE `RAW_SOURCE_WRITER_POLICY_BINDING_INVALID`：(1) 来源主机等于策略域名或是其子域，**不去 `www.`**（L924-927）；(2) `retention_days` 相等（L928）；(3) `allowed_purpose` 是含 `discovery` 的字符串数组，**不分状态都查**（L929-933）；(4) ACCEPTED 时 `review_status='APPROVED'`（L934-935）。ACCEPTED 必须带策略 id（L911-914）。快照由 DB 自己派生（L938-946），重放时与已存行比对，不同即 `RAW_SOURCE_WRITER_DRIFT`（L1006）。 |
| A5 | public_web 的来源绑定 | ACCEPTED 时，DB 要求来源主机等于 `payload.domain`（L906-907），TS 要求 `host === domain === externalId`（`raw-source-provider-schema.ts:677-678`）。DB 只收小写 LDH 主机（`raw_source_safe_https_url_v2`，`20260826150000` L62-78）。provider 绑定只允许 `public_intelligence` 和 `industry_data`（`20260826130000` L840）。 |
| A6 | 写入器报错的后果 | 任何 `RAW_SOURCE_*` 异常都转成控制错误 `DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_RECEIPT_MISMATCH`（`discovery-query-governed-execution.ts:216-219`）。整条 query 回滚，workflow 照样上抛（`discovery.workflow.ts:242`），run 失败。**所以 TS 与 DB 的判定必须完全一致。** |
| A7 | 隔离行能否放行 | 不能。Raw 行除到期外不可改，快照列也一样（`20260826110000` L60-90）。物化时 QUARANTINED 只得 `RAW_QUARANTINED`（`discovery-company-materialization-ctx.ts:337-341`；`20260830130400` L915-918）。run `733fbf03` 的 21 行（xin：`REJECTED / PROVIDER_PAYLOAD_SCHEMA_INVALID`，快照 `kind=missing`）只能重跑。 |
| A8 | ACCEPTED 之后还要过什么 | 物化不读 source_policy（`20260830130100`、`130200`、`130400` 都不引用它）。ACCEPTED 行依次检查：RESTRICT_PROCESSING 处置、suppression（domain / company_name）、是否到期、名称与合成来源。都过，就是 `CANONICALIZED`（`discovery-company-materialization-ctx.ts:353-371`，`discovery-company-materialization-canonical.ts:111-140`；legacy 路径同口径，`discovery.activities.ts:895-952`）。 |
| A9 | xin 现状 | 15 行策略都是 API 源（`access_mode=api`，全部 APPROVED，没有 SUSPENDED）。`public_web`、`website_profile`、`digital_footprint`、`structured_harvest`、`web_watch`、`decision_maker` 都是 ENABLED。最新迁移是 `20260925090000_artifact_subject_execution_hold`。 |
| A10 | RLS 与授权 | source_policy 无 RLS。**与前提不符**：app_user 实有 SELECT/INSERT/UPDATE/DELETE。`20260706033625` L23-28 的默认权限覆盖了 `20260706164026` L35 只授 SELECT 的本意（xin `has_table_privilege` 实测）。运行时只通过 owner 连接的 seed 写这张表（`outbox-relay.service.ts:146-147,213-219`）。 |

## 2. 下游同类门

| 阶段 | 门与证据 | 遇到没有逐域策略的公司域名 | 结论 |
| --- | --- | --- | --- |
| Raw 入库 | A1、A4 | 隔离 | 唯一卡点，本设计覆盖 |
| 物化 / Domain ACK | 只看 `ingest_status`（A8）；`apps/api/src/durable-results/` 不引用 source_policy | 不涉及 | 不需要覆盖；但写入器一 RAISE，整条 query 失败（A6） |
| 官网画像 `profileWebsitesForRun` | 要求 `website_profile` 为 ENABLED（`discovery.activities.ts:1379-1383`）。`crawl4ai.fetch` 是 advisory（`builtin-tools.ts:225`），purpose 为 `enrichment`（`website-profile.provider.ts:171-173`）。Broker 对 advisory 工具：未登记放行，登记即强制 SUSPENDED 与用途（`tool-broker.ts:188-223`）；读取器按域名精确查（`tool-broker.factory.ts:60-71`） | 放行 | 不卡，不接通用行 |
| 信号富集 `enrichSignalsRun` | 先按精确域名跳过 SUSPENDED（`discovery.activities.ts:1543-1550,1614`）；`crawl4ai.render` 和 `http.get` 都是 advisory（`source-tools.ts:142,257`） | 放行 | 不卡 |
| 网站监控 `registerWatchesForRun` | 按精确域名跳过 SUSPENDED（`website-watch.service.ts:105-113`）；`http.get` 是 advisory（`intent-projection.service.ts:368`） | 放行 | 不卡 |
| 决策人 / 公开联系人（手动端点） | `crawl4ai.fetch` 是 advisory，purpose 为 `discovery,enrichment`，先查 robots（`decision-maker.provider.ts:125,144-150`；`public-web.provider.ts:321-330`）；存量 backlog 的联系人活动目前是 authority hold（`backlog.activities.ts:21-26,138-142`） | 放行 | 范围外，不卡 |
| 邮箱验证、GLEIF / Wikidata 富集 | `smtp.rcpt_probe` 是 advisory（`builtin-tools.ts:457`）；gleif / wikidata 是 required，治理域已登记 | 放行或不涉及 | 不卡 |

通用行**只给 Raw 入库用，不接进 Broker**，理由有三：
- advisory 本来就放行，没有缺口。
- 如果 Broker 能读到它，`crawl4ai.fetch` 的 `site_builder` 用途（`builtin-tools.ts:228`）会被通用行的用途集拒掉。
- `tool-broker.ts` 和 `tool-broker.factory.ts` 是钉了 sha256 的受保护文件（`durable-result-strategies.json` 的 `physicalExecutionWiring.protectedFiles`；`scripts/execution-authority-policy.mjs:56-61,504-528`）。

代价：通用行里的 `enrichment` 只是声明，没有任何代码门读它。下游抓取继续按 advisory 规则走，与其他来源发现的公司一样（见开放问题 1）。

## 3. 触点

### 3.1 表示方式

| 方案 | 做法 | 好处 | 代价 |
| --- | --- | --- | --- |
| A 保留键行（推荐） | `source_policy` 加一行，`domain='public_web:company_site'` | 不改表，也不改 `schema.prisma`（它是 Copy 绑定文件，一改就要重签，`scripts/copy-fixed-source-impact.mjs:37-49`）；不碰受保护文件；键里有 `:` 和 `_`，URL 解析出的主机和 DB 的 LDH 主机都不可能等于它或以它结尾，所以 Broker 的精确查找和各处 SUSPENDED 黑名单都永远命中不了它 | 借用了 `domain` 列（schema 注释写「'*' 不允许」，`schema.prisma:985`）；TS、DB 两处都要显式排除它 |
| B 加 `scope` / `provider_key` 列 | 通用行标为 `PROVIDER_DEFAULT` | 语义直白 | 改 `schema.prisma` 要 Copy 重签，与 admission-lease PR 的重签撞在同一行；`domain` 仍是 NOT NULL UNIQUE，还得放占位值；每个读全表的消费者都要加过滤 |
| C 独立表 | 按 provider 存默认策略 | 语义最干净 | 新 Prisma 模型（要重签）；写入命令 `raw-source-writer/v2` 的键集合是封闭的（`20260826130000` L751-754），得加键或升版本；要新的快照类型；默认权限会给 app_user 写权限，还得另外 REVOKE |

### 3.2 优先规则（TS 与 DB 逐条相同）

1. 主机和策略域名都先转小写，再去掉开头的 `www.`（即 TS 现有做法）。
2. 在保留键以外的逐域策略里，取「相等或后缀匹配」中最长的一条。只要匹配到就用它，不管它是 APPROVED、SUSPENDED 还是缺用途。
3. 逐域策略都不匹配时，只有同时满足 providerKey 是 `public_web`、来源主机等于记录的 `domain`，才用通用行。
4. 其余情况按缺策略处理，与现状相同。
5. 选定策略后：非 APPROVED → `SOURCE_POLICY_SUSPENDED`；用途不含 `discovery` → `SOURCE_POLICY_PURPOSE_NOT_ALLOWED`。建议把 SUSPENDED 判定挪到用途判定之前（对调 `:560-565` 两段），封禁行的处置码才会是 SUSPENDED。

实施时补充（2026-10-09，不改上面的规则，只把它说死）：

- 第 1 条的「转小写」只折叠 ASCII 字母，TS 与 DB（`translate`）一样；DB 的 `lower()` 随库的排序规则变，会让两边对个别非 ASCII 域名的判定不同。来源主机本来就是小写 ASCII。
- 第 2 条的「最长」按去掉 `www.` 之后的长度算。原来 TS 按原始拼写长度排序，`www.foo.com` 会压过更具体的 `eu.foo.com`。
- 第 2 条并列（多行规范化后是同一个域名，如 `foo.com` 与 `www.foo.com`、`FOO.com`）时，非 APPROVED 的行优先，再按原始拼写长、再按 id。这样只要有一种拼写封了该站，封禁就生效，结果也不随读出顺序变。
- 第 3 条的「来源主机」指 URL 里的主机原样（小写，不去 `www.`），与写入器 L906-907、TS provider 校验比较的是同一个值。

### 3.3 TS 改动

- 新常量 `PUBLIC_WEB_COMPANY_SITE_POLICY_DOMAIN = "public_web:company_site"`，放在新的小模块里（如 `apps/api/src/discovery/source-policy-scope.ts`），入库、seed 和测试共用这一个。
- `policyFor` 加两个参数：providerKey 和记录域名。候选里排除保留键，按 §3.2 第 3 条兜底。`prepareRawSourceBatch` 传入 `args.providerKey` 和归一后 payload 的 `domain`（`:536-543`）。
- 快照形状不变：`kind:"source_policy"`，`domain` 就是保留键。所以 `raw-source-writer.ts` 不用改。`discovery.activities.ts` 也不用改，保留键进了黑名单也无害。

### 3.4 DB 迁移（一个）

`packages/db/prisma/migrations/<时间戳>_public_web_company_site_source_policy/migration.sql`，单事务，开头 `SET LOCAL lock_timeout='5s'`、`statement_timeout='30s'`。

- **新函数** `public.raw_source_policy_binding_v3(provider_key, ingest_status, source_host, payload, policy_id, retention_days) RETURNS JSONB`：按 §3.2 复核，返回快照。`SET search_path = pg_catalog, public, pg_temp`（#616 起所有 SECURITY DEFINER 函数一律把 pg_temp 放最后，静态与真库护栏都会检查），表名全部写全限定名。它含 `FOR KEY SHARE`，不能标 STABLE。`REVOKE ALL … FROM PUBLIC, app_user`，做法同 `20260826130000` L1013-1023。
  - 通用行：provider 必须是 `public_web`；主机非空；不存在任何匹配该主机的逐域策略；ACCEPTED 时主机必须等于 `payload.domain`（与 L906-907 重复，多一道防线）。QUARANTINED 行的 payload 只是回执，域名一致由 TS 保证：只有通过 provider 校验的记录才带得出主机（`raw-source-ingestion.ts:510-537`）。
  - 逐域策略：主机匹配改成与 TS 一样去掉 `www.`。现在的问题：封禁行若写成 `www.foo.com`，TS 会命中 `foo.com`，DB 却不认，整条 query 失败。
  - 两类共同：`retention_days` 必须相等；含 `discovery` 用途和 APPROVED 这两条**只对 ACCEPTED 要求**。现在的问题：TS 会把缺用途策略下的行隔离（`raw-source-ingestion.spec.ts:1048-1074`），DB 却对同一行 RAISE（L929-933）。不修的话，只设了 `review_status='SUSPENDED'`、`allowed_purpose` 留 NULL 的封禁行，会让每个碰到该站的 run 失败。快照里的 `allowedPurpose` 按策略实际值写 `["discovery"]` 或 `[]`，与 TS `:415` 一致。
  - 逐域策略还要是最具体的（实施时补充，对应 §3.2 第 2 条）：覆盖该主机的逐域策略里，不能有规范化后更长的；ACCEPTED 还要求同样长的几行全是 APPROVED。原写入器只查「覆盖」，不查「最具体」，app_user 可以拿父域的 APPROVED 行绕过子域的 SUSPENDED 行；通用行的「无逐域策略覆盖」与它是同一道检查。TS 按 §3.2 选出的行总能通过；只有运行中有人新加了更具体的行或把并列行改成 SUSPENDED，写入才会被拒（fail-closed，与 §6 通用行的情形相同）。
- **重定义** `CREATE OR REPLACE FUNCTION public.write_raw_source_record_v2_legacy(JSONB)`：正文逐字复制 `20260826130000` L707-1010，只把 L911-947 换成对新函数的调用。签名、属主、SECURITY DEFINER、ACL 都不变，包装函数不动。原文的 `SET search_path = pg_catalog, public` 改为 `pg_catalog, public, pg_temp`：#616 的迁移已把它改成这样，这里再用旧写法 `CREATE OR REPLACE` 会把加固撤回，护栏会拦下。
- 不建表、不改列、不回填、不插入策略行。

### 3.5 Seed

在 `provider.registry.ts` 的 `seed()` 里加一条 `sourcePolicy.upsert`，写法与 `:208-283` 相同，用 `update: {}`：运维把它改成 SUSPENDED 后，启动 seed 不会改回来。seed 由 outbox relay 通过 owner 连接执行（A10）。

| 字段 | 值 | 依据 |
| --- | --- | --- |
| `domain` | `public_web:company_site` | §3.1 |
| `source_type`、`access_mode` | `official_website`、`crawl` | `schema.prisma:986-987` 的词表 |
| `allowed_purpose` | `["discovery","enrichment"]` | owner 定的用途 |
| `retention_days` | 365 | 与列默认值（`schema.prisma:995`）、TS 默认值（`raw-source-ingestion.ts:73`）一致，xin 15 行中有 14 行也是 365 |
| `review_status` | `APPROVED` | — |
| `robots_status`、`terms_status` | `UNREVIEWED`、`UNREVIEWED` | 无法逐站审，如实写；先例是 `mapyourshow.com` |
| `personal_data` | `true` | 公司官网常有 Impressum 人名；registry 记的是 `RESTRICTED_POSSIBLE`；入库记录本身不含个人数据 |
| `notes` | 适用范围、优先规则、决定日期 | 不写花括号：`governance-evidence-provider-contracts.mjs:131-145` 用正则扫 `create: {…}` |

代码只读 `domain`、`review_status`、`allowed_purpose`、`retention_days`、`id`、`updated_at` 这几列；`robots_status`、`terms_status`、`personal_data` 等只是声明。

### 3.6 快照与文档

- 每条 public_web Raw 行的 `source_policy_snapshot` 由 DB 派生：`{kind, id, domain:"public_web:company_site", retentionDays, reviewStatus, allowedPurpose, updatedAt, minimizedFields}`。快照不可改，随行到期。按 `source_policy_snapshot->>'domain' = 'public_web:company_site'` 可查出所有走通用行的记录。
- `docs/governance/provider-registry.json` 的 public_web 条目：
  - 改写 `license.note`：逐域策略优先，没有才用通用行；前提是来源主机就是记录自己的域名；不存页面正文。
  - `test_paths` 和 `evidence_refs` 加上新 spec。
  - 改完运行 `pnpm governance:providers`，重新生成 `docs/backend/provider-registry.md`。
- changelog 加一条。
- 不必改的文件：
  - `storage-compliance-spec.md`：它是 `CLOSED` 的实施记录，「source_policy fail-closed」原则仍然成立。
  - `execution-authority-callsites.json`：没有新调用点。
- `provider.registry.ts` 受 CODEOWNERS 管控（`scripts/environment-parity-policy.spec.mjs:373`）。

## 4. 合规与安全

- **放行了什么**：每条记录只有公司名、域名、ISO 国家代码、可选的员工数、最多 20 个受控词、证据摘要、置信度、来源类，以及 provenance 四项（`public-web.provider.ts:396-433`；顶层键见 `raw-source-provider-normalizer.ts:77-87`）。不存页面正文，不存个人数据。DB 另外检查名称和 URL 里不得夹带邮箱、电话、凭据等（名称规则见 `raw_source_provider_company_name_valid_v2`，最终版在 `20260826170000` L9-30；URL 规则见 `20260826150000` L62-78）。独资商户的公司名可能指向自然人，这一点与其他公司来源同口径。
- **来源其实是搜索引擎**：发现阶段不抓页面，只把同一域名下的 SearXNG 搜索标题和 URL 交给模型（`public-web.provider.ts:157,185`）。`searxng.search` 的 source_policy 模式是 `none`（`builtin-tools.ts:89`）。`contentHash` 是这段搜索证据的指纹，不是页面内容的指纹（`:429,610-615`）。`sourceUrl` 是该域名上的某个页面或首页（`:516-522`）。上游搜索引擎条款沿用现状，不在本设计内。
- **robots 与条款**：发现阶段不抓页面，不涉及 robots。下游抓取由工具按 URL 查 robots：`crawl4ai.*` 是 `respectsRobots:true`；`http.get` 是 false（`source-tools.ts:258`），只用来取 robots.txt、sitemap 和监控页。站点条款无法逐站审，通用行如实写 `UNREVIEWED`；站方有异议就封那一站。
- **封单站**（用 owner 连接执行）：
  ```sql
  INSERT INTO source_policy(id,domain,source_type,access_mode,allowed_purpose,retention_days,review_status,notes,updated_at)
  VALUES (gen_random_uuid(),'<规范域名>','official_website','crawl','["discovery","enrichment"]',365,'SUSPENDED','<原因/日期>',now());
  ```
  - 规范域名：小写，用 punycode，不带 `www.`、协议和尾点，与 public_web 记录的 `domain` 写法相同。
  - `allowed_purpose` 要带 `discovery`，这样新旧写入器都不会失败。
  - 封禁后：public_web 搜索阶段跳过该精确域名；Raw 把该域名及其子域的记录隔离为 `SOURCE_POLICY_SUSPENDED`；Broker、信号富集、网站监控不再抓该精确主机。
  - 只对之后的 run 生效。已建档的公司要另用 suppression 处理（「停采不停用」，`docs/architecture/current.md:152`）。
- **全部关停**：把通用行改成 SUSPENDED，seed 不会改回。若要连搜索和模型调用一起停，把 `data_provider.public_web` 设为 DISABLED。删除通用行无效，下次启动时 seed 会重建。
- **审计**：每条 Raw 行的快照（策略 id、`updatedAt`、状态、保留期）、provenance 四列和处置码都不可改。通用行本身没有历史表，修改它时要同时在 `_archive/` 留一份记录。

## 5. 决策与权衡（请 owner 确认）

1. 表示方式选 A（§3.1）。
2. seed 写在代码里（`provider.registry.ts`），不在迁移里 INSERT，与本仓惯例一致：参考数据由代码幂等 seed。代价：新镜像启动后、relay 完成 seed 之前，public_web 记录仍按缺策略隔离（fail-closed），没有害处。
3. 保留期 365 天。
4. 通用行不接入 Broker（§2）。
5. 在同一函数块里修两处 TS/DB 不一致：`www.` 匹配；用途和 APPROVED 只对 ACCEPTED 要求。不修，封单站可能让整条 query 失败。
6. SUSPENDED 判定放在用途判定之前。只影响处置码。
7. 通用行 `personal_data` 设为 `true`。

## 6. 风险与回退

- **TS/DB 判定不一致**：会让整条 query 失败（A6）。§7 第 4 步用同一组用例在真库上对照，兜住这个风险。
- **运行中改策略**：TS 在 fan-out 前读策略（A2），DB 在写入时复核。如果中间有人新加了逐域行，DB 会拒收通用行的 id，这条 query 失败（fail-closed）。现在把 APPROVED 改成 SUSPENDED 也会这样；改动通用行还会改变它的 `updated_at`，同一 run 重放写入时快照对不上，报 `RAW_SOURCE_WRITER_DRIFT`（A4）。规则：改 source_policy 前，先确认没有在跑的 run。
- **放行后的出网**：放行后，同一个 run 会继续抓这些公司官网。画像最多 50 家（`execution-envelope.ts:35`）；信号富集和网站监控只针对 fit=match 的公司；抓取都查 robots。
- **迁移安全**：只新增一个函数、替换一个函数，不动表。拿不到锁就快速失败。`CREATE OR REPLACE` 保留属主和 ACL。
- **部署**：运行时要求库里最新的迁移等于镜像证明的 `migration_revision`。
  - 镜像取迁移目录名最大的一个（`build-attestation.ts:385-412`），库取 `finished_at` 最新的一个（`runtime-process-lease.ts:562-578`；worker 在 `worker.ts:165-178` 检查）。
  - 所以 `migrate deploy` 和换镜像要在同一窗口完成，并按 RUNBOOK §2 走全流程（含 R4 续期和 GrowthOS 钉值）。换的时候不能有 run 在跑。
  - 先例：2026-09-25 有个迁移先上了库，API 一直报 `MIGRATION_REVISION_MISMATCH`，到 09-30 换了镜像才恢复（xin `_archive/backend-runtime-switch-xin-20260930/README.md:6`）。
- **与 #616（SECURITY DEFINER 加固，迁移 `20261009160000_security_definer_search_path_pg_temp`）的关系**：本迁移的时间戳要晚于它；本迁移新建或重定义的 SECURITY DEFINER 函数都用 `pg_catalog, public, pg_temp`。
- **与 admission-lease PR 的迁移顺序**：
  - 现状：该 PR 的草案（§2.1，未入库）计划加迁移 `20261009xxxxxx_discovery_run_admission_lease`。`claude/discovery-run-admission-lease` 和 `-impl` 两条分支目前都没有提交。
  - 规则：
    - 后合并的 PR，合并前把自己的迁移目录改名，时间戳要晚于先合并的那个，然后重跑静态 spec。
    - 两个迁移同批部署时，一次 `migrate deploy` 会按名称顺序执行。
    - 不允许名称较早的迁移晚上库，否则库里最新的迁移与镜像不一致。
  - 冲突面：两者不改同一个函数或表（admission 改的是 `execution_budget_authority` 和 attest 函数）。本设计不改 `schema.prisma`，没有 Copy 重签冲突。同一天的 changelog 条目若有文本冲突，变基解决。
- **回退**：
  - 即时回退：把通用行改成 SUSPENDED，之后新 run 的记录即被隔离。
  - 正式回退：迁移只能向前，所以要写一个新迁移恢复旧函数体，再换镜像。旧镜像无法在新迁移上运行。
  - 已 ACCEPTED 的 Raw 行和已建档的公司都会保留（Raw 不可改），需要时用 suppression 或删除链处理。

## 7. TDD 步骤

1. **RED，静态合同**（不起容器）：新建 `apps/api/src/discovery/raw-source-company-site-policy.migration.spec.ts`，断言：
   - 新迁移是单个 BEGIN/COMMIT，含 `lock_timeout`；只定义新函数、替换 legacy；没有 `CREATE TABLE`、`ALTER TABLE`、`INSERT`、`UPDATE`。
   - legacy 的新正文去掉策略块后，与 `20260826130000` L707-1010 去掉 L911-947 后逐字相同。
   - SQL 里的保留键字面量等于 TS 常量；新函数固定了 `search_path`、表名用了全限定名，并对 PUBLIC 和 app_user 做了 REVOKE。
2. **RED，单测**（`APP_DATABASE_URL= pnpm --filter @global/api test`）：
   - `raw-source-ingestion.spec.ts` 加一组矩阵：
     - 只有通用行 → ACCEPTED，快照为保留键。
     - 以下三种都是 `SOURCE_POLICY_SUSPENDED`：精确域名被 SUSPENDED；父域被 SUSPENDED、记录在子域；SUSPENDED 行带 `www.` 前缀。
     - 逐域 APPROVED 优先于通用行。
     - 通用行 SUSPENDED、通用行缺用途、通用行不存在，三种分别验证。
     - 非 public_web 的 provider（registry、trade_fair），即使有通用行也是 MISSING。
     - SUSPENDED 判定先于用途判定。
   - provider.registry 的 seed spec：校验字段和 `update: {}`。
   - `public-web-raw-governance.spec.ts` 加一例：只有通用行时，映射出的记录为 ACCEPTED。
3. **GREEN**：实现 TS、seed 和迁移。新 worktree 先跑 `pnpm --filter @global/api build`，否则会有 7 个假失败。
4. **真库合同**：新建 `apps/api/src/discovery/raw-source-company-site-policy.postgres.spec.ts`。
   - 门控：`RAW_SOURCE_POLICY_DATABASE_TEST=1`，并设置 `RAW_SOURCE_POLICY_TEST_DATABASE_URL`（owner）和 `RAW_SOURCE_POLICY_TEST_APP_DATABASE_URL`（app_user），才跑；只许回环主机；库名只许 `/global_test` 或 `/raw_source_policy_test`。仓内现有写法（`suppression-policy-lock.postgres.spec.ts:10-22`）是「URL 存在即跑 + 回环 + 库名白名单」，这里多加一个显式开关。
   - 第 2 步的矩阵经 `prepareRawSourceBatch` → `persistPreparedRawSourceRecord` 真写一遍（写入器要求 session_user 是 app_user，L740-743）。断言不 RAISE，状态和快照与 TS 一致。
   - 再加只有 DB 才会拒的负例：通用行 id 配非 public_web；存在匹配的逐域行时仍传通用行 id；ACCEPTED 配 SUSPENDED；保留期不等。实施时另加：存在更具体的逐域行时传父域行；ACCEPTED 时并列行里有 SUSPENDED。
   - CI：在 `ci.yml` 已跑过 `migrate deploy` 的 Raw SQL 步骤（L322-329）之后加一步。改 `ci.yml` 会让全部重门都跑（约 40 分钟）；不进 CI，这个 spec 就只能手跑，会无声过期。
5. **本机一次性库**（绝不连 `global_dev`）：
   - 起库：`docker --context default run -d --rm --pull never -p 127.0.0.1:<空闲端口>:5432 --tmpfs /var/lib/postgresql/data -e POSTGRES_USER=global -e POSTGRES_PASSWORD=<一次性> -e POSTGRES_DB=global_test pgvector/pgvector@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b`（与 `ci.yml:133` 钉的摘要相同，本机已有）。
   - 先只部署 main 的迁移，跑第 4 步，应为 RED；加上新迁移再跑，应为 GREEN。
   - 用完 `docker --context default stop`，容器随 `--rm` 删除。
6. **门禁**：`pnpm governance:providers`；`pnpm docs:verify`（已含 `pnpm governance:verify`）；`gctl check`。
7. **部署后真跑**（需单独授权）：
   - 用同一个 ICP 跑一次有界样本，期望 public_web 记录为 ACCEPTED、快照为保留键，并物化出公司。
   - 再插一条测试用的 SUSPENDED 行，确认对应记录被隔离、query 不失败；验完删除。

## 8. 开放问题（产品负责人 2026-10-09 已答复）

1. 「只限发现与富集」这个用途限制，要不要也约束下游抓取（画像、信号、网站监控）？目前它们走 Broker 的 advisory 规则，不读通用行；要约束就得改受保护的 Broker 文件。
   - **答复**：不约束下游，保持 advisory。用途只在 Raw 入库强制。
2. 保留期用 365 天，还是更短？
   - **答复**：365 天。
3. 通用行的 `personal_data` 设为 `true`，是否同意？
   - **答复**：同意，`true`。
4. public_web 写入 field_evidence 的许可是 `licensed`（`evidence-license.ts:11-13`），与 registry 里的 `SOURCE_SPECIFIC` 不一致。要不要另开一个小改，让 mapper 写 `license:'public'`？
   - **答复**：另开后续小改，不在本 PR。
5. 以后要不要给 `source_policy.domain` 加格式 CHECK？带 `https://`、尾点或大写的域名会让封禁静默失效。这不在本次范围内。
   - **答复**：以后再做。（本次 TS 与 DB 都按 ASCII 折叠大小写，大写拼写的封禁已能生效；`https://` 与尾点仍会静默失效。）
6. app_user 对 `source_policy` 实有写权限（A10），与「app_user 只读、owner 写」的本意不符。运行时没有用 app_user 写这张表（唯一的 eval seed 也明确拒绝 app_user，`copy-sonnet-recovery-source-policy-seed.ts:60-70`）。要不要另开 PR 收回写权限？`data_provider` 也是同样情况。
   - **答复**：另有一个 PR 收回 app_user 对 `source_policy` 与 `data_provider` 的写权限。本 PR 不动任何授权。
