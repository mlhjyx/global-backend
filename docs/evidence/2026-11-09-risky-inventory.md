# RISKY 联系点盘点（2026-11-09 只读元数据快照）

> 文档 ID：`EVIDENCE-RISKY-INVENTORY-20261109`
> 类型：只读基线证据（时点快照，不可改写）
> 数据源：`docker exec global-postgres psql -U global -d global_dev`（只读会话）
> 采集时间：2026-11-09 01:21（Asia/Shanghai）= 2026-11-08T17:21Z（UTC）
> 复算：`node scripts/metrics/risky-inventory.mjs`（`--json` / `--show-sql` / `--top-domains N`）
> PII 纪律：`contact_point.value` 是加密 PII 列，本盘点不读取、不解密、不输出任何地址明文；只用元数据列（type/status/verification_method/catch_all/source_type/email_type/verified_at/source_url）与公司级 `domain`。
> 对应计划：ch01 §2.2「0 VALID 不是市场的否定判决，是管线缺了一段」的复核与量化；为 P1 联系人工程（四态重验）提供基线。

## 1. 结论（TLDR）

- 邮箱联系点 274 条：**VALID 0 / RISKY 270 / UNVERIFIED 3 / INVALID 1**。RISKY 占 98.5%（Wilson 95% CI [96.3%, 99.4%]）。
- **RISKY 270 = 246 条从未验证 + 24 条 pattern_guess**（246 条 `verification_method`、`catch_all`、`source_type`、`email_type` 全为 NULL；24 条 `verification_method=source_type=pattern_guess`、`catch_all=unknown`、`email_type=personal`）。
- 溯源几乎为空白：274 条邮箱中仅 24 条有 `source_type`（全是 pattern_guess），`source_url` 命中 **0**；有 `verified_at` 的只有 37 条（36 RISKY + 1 INVALID，全部 2026-11-03，且验证方法为空——不是可审计的验证）。
- 域名级：270 条 RISKY 邮箱分布在 86 家公司 / 73 个域名上，全部有公司域名；86 家中 73 家的 lead 已判 fit=match。单公司最多 13 条 RISKY。
- SMTP 探测（`tool_budget_operation.result_schema='smtp-probe-verdict/v1'`，135 次）**全部只测到域名连通/MX**：reachable=true 135/135、`codes` 空 131、`mailFromCode` null 131 / 250 4——**没有一次邮箱级 RCPT 裁决**。
- 首日（11-08）口径需要两处修正：①「270 RISKY = 250 从未验证 + 24 pattern guess」把 3 条 UNVERIFIED + 1 条 INVALID 误并入 RISKY 的「从未验证」；正确拆分是 **RISKY 270 = 246 从未验证 + 24 pattern guess**。②「213 条无 source_type」已漂移为 **250 条无 source_type**（邮箱语境）。
- 因此「0 VALID」必须读作「从未做邮箱级验证 + 写入缺溯源」，而不是「市场证明这些邮箱不可用」。P1 的第一步应是**四态重分类（VALID/INVALID/CATCH-ALL/UNKNOWN）**，而不是继续扩大猜测邮箱。

## 2. 方法与口径

- 联系点状态语义按字典 §1.2：`VALID` 仅指经邮箱级验证且非 catch-all；`RISKY` 含未验证猜测与 catch-all/不确定；`UNVERIFIED` 为从未尝试；`INVALID` 为硬退信或验证器判死。
- 交叉表按 `status × catch_all × verification_method × source_type × email_type` 全维度展开；不做任何值列读取。
- 域名级汇总用 `canonical_contact.company_id → canonical_company.domain`（公司域名是公开业务信息，不是个人数据）。
- SMTP 探测读取 `tool_budget_operation.result_json` 的嵌套路径 `data.data.data.{reachable,codes,mailFromCode}`（只读聚合，不输出单条明细）。
- 只读保护同漏斗基线：`default_transaction_read_only=on`。

## 3. 真实读数

### 3.1 联系点总览（type × status）

| type | status | 数量 |
| --- | --- | --- |
| email | RISKY | 270 |
| email | UNVERIFIED | 3 |
| email | INVALID | 1 |
| linkedin | UNVERIFIED | 78 |
| phone | UNVERIFIED | 30 |

合计 382 条；`company_contact_channel`（公司级 Impressum 通道）0 行——A1 #888 发车前公司通道层为空。

### 3.2 邮箱四态 × 溯源交叉表（全维度）

| status | catch_all | verification_method | source_type | email_type | 数量 |
| --- | --- | --- | --- | --- | --- |
| RISKY | (null) | (null) | (null) | (null) | 246 |
| RISKY | unknown | pattern_guess | pattern_guess | personal | 24 |
| UNVERIFIED | (null) | (null) | (null) | (null) | 3 |
| INVALID | (null) | (null) | (null) | (null) | 1 |

解读：除 24 条 pattern_guess 外，其余 250 条邮箱没有任何验证方法、catch-all 判定、来源类型或邮箱类型——写入路径从未记录这些元数据。

### 3.3 验证新鲜度与溯源完整性（仅邮箱，n=274）

| 指标 | 数量 |
| --- | --- |
| 邮箱联系点总数 | 274 |
| 从未有 verified_at | 237 |
| 有 verified_at（全部 2026-11-03，验证方法为空） | 37（36 RISKY + 1 INVALID） |
| 有 source_url | 0 |

### 3.4 公司与域名分布（RISKY 邮箱 270 条）

- 覆盖 86 家公司 / 73 个域名；无域名公司的行 0（域名全部可归因）。
- 每公司 RISKY 条数分布：1 条 ×26 家、2 条 ×18、3 条 ×15、4 条 ×6、5 条 ×2、6 条 ×15、8 条 ×1、9 条 ×2、13 条 ×1。
- 86 家中 73 家的 lead 已判 fit=match（其余 13 家未判 match）。
- 按 workspace：`982c2a12` 117 条 / 35 家（E2E 租户）；`0ec8b535` 38 / 10；`8e85e943` 33 / 13；**主租户 `c3584cf9` 28 条 / 10 家**；`6d716048` 22 / 8；`a7a3e69f` 18 / 7；`d46d2170` 12 / 2；`dfe64718` 2 / 1。
- 域名级 Top（按 RISKY 条数）：bridge-industry-consulting.de 15、himmelinfo.de 14、pumpen-dunkel.de 13、biergans.com 9、kriwan.com 9、steffens-pumpen.de 7、abwshop.de 6、elmar.gmbh 6、hypneu.de 6、inzelmann.com 6。

### 3.5 SMTP 探测实际测到了什么

`tool_budget_operation.result_schema = 'smtp-probe-verdict/v1'` 共 135 条：

| 字段 | 分布 |
| --- | --- |
| `reachable` | true 135 / false 0 |
| `codes` | 空数组 131 / 有值 4 |
| `mailFromCode` | null 131 / `250` 4 |

解读：探测只到「域名可达/有 MX」层；唯一出现过的 250 是 SMTP 握手问候（mailFromCode），不是逐地址 RCPT 结果。**这 135 次探测不能作为任何地址的有效性证据**，也不能把 `reachable=true` 当成 VALID。

### 3.6 电话与 LinkedIn

| type | status | 数量 | 有 source_type |
| --- | --- | --- | --- |
| linkedin | UNVERIFIED | 78 | 0 |
| phone | UNVERIFIED | 30 | 0 |

电话 30 条全部未验证（其中主租户 0 条；match 公司有电话 4 家，全部在 `982c2a12` E2E 租户）。LinkedIn 只是 URL 联系点，按字典不进入任何可触达分子。

## 4. SQL（关键片段）

邮箱四态 × 溯源交叉表：

```sql
select status,
       coalesce(catch_all, '(null)') catch_all,
       coalesce(verification_method, '(null)') verification_method,
       coalesce(source_type, '(null)') source_type,
       coalesce(email_type, '(null)') email_type,
       count(*) n
from contact_point
where type = 'email'
group by 1, 2, 3, 4, 5
order by n desc;
```

域名级汇总（不解密 value）：

```sql
select
  count(*) risky_rows,
  count(distinct ct.company_id) companies,
  count(distinct c.domain) filter (where c.domain is not null) domains
from contact_point cp
join canonical_contact ct on ct.id = cp.contact_id
join canonical_company c on c.id = ct.company_id
where cp.type = 'email' and cp.status = 'RISKY';
```

SMTP 探测聚合（只取嵌套判定字段）：

```sql
select
  count(*) total,
  count(*) filter (where result_json -> 'data' -> 'data' -> 'data' ->> 'reachable' = 'true') reachable_true,
  count(*) filter (where jsonb_array_length(coalesce(result_json -> 'data' -> 'data' -> 'data' -> 'codes', '[]'::jsonb)) = 0) empty_codes,
  count(*) filter (where result_json -> 'data' -> 'data' -> 'data' ->> 'mailFromCode' is null) mailfrom_null,
  count(*) filter (where result_json -> 'data' -> 'data' -> 'data' ->> 'mailFromCode' = '250') mailfrom_250
from tool_budget_operation
where result_schema = 'smtp-probe-verdict/v1';
```

完整 SQL 由 `node scripts/metrics/risky-inventory.mjs --show-sql` 输出。

## 5. 与 2026-11-08 首日盘点的差异

| 项 | 11-08 口径 | 11-09 复核 | 处置 |
| --- | --- | --- | --- |
| RISKY 270 的构成 | 「250 从未验证 + 24 pattern guess」 | **246 从未验证 + 24 pattern guess**（「250」含 3 条 UNVERIFIED + 1 条 INVALID） | 以本证据为准 |
| 无 source_type 的邮箱 | 213 | **250**（274 − 24 pattern_guess） | 以本证据为准 |
| 有 verified_at | 37 | 37（全部 2026-11-03，方法为空） | 一致；但「有 verified_at」≠「可审计验证」 |
| SMTP 探测 | 135 条 reachable=true、codes=[] 131、mailFromCode null 131/250 4 | 完全一致 | 精确复现 |
| 邮箱总数 | 274（当时 contact_point 274 = 全部是邮箱） | 274 邮箱 + 30 电话 + 78 LinkedIn = 382 | 总数口径扩展 |

## 6. 结论与下一步

1. **0 VALID 是管线缺口**：270 条 RISKY 中 246 条从未尝试验证、24 条只是模式猜测；没有任何一条经过邮箱级验证。P1 的第一优先级是把这 274 条按四态（VALID/INVALID/CATCH-ALL/UNKNOWN）重分类，并把 `verification_method/source_type/verified_at` 变成写入必填。
2. **写入缺溯源**：250/274 无 `source_type`、274/274 无 `source_url`，无法回答「这个地址从哪来、是否允许使用」。这直接影响 VRIC 的合法依据条件（字典 §1.3-5）。
3. **域名不是瓶颈**：RISKY 邮箱全部能落到公司域名（86/86 家）；瓶颈在「人级邮箱验证」而不是「找域名」。
4. **不可用作触达**：当前任何「有 270 个邮箱」的说法都必须写成「270 条 RISKY（其中 246 条从未验证、24 条模式猜测）」，不得计入 T2-002 分子或 VRIC。
