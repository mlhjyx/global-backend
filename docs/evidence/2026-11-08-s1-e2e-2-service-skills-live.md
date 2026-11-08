# S1 E2E-2：服务技能在发车镜像上的闭环验证（2026-11-08）

> 结论先行：S1 设计 §9 定义的 E2E-2（公司名 → 制裁筛查 → 显式汇率/成本行 → L1 报价建议）
> 已在**发车后的运行镜像**上通过，9/9 断言全绿。验证用的是镜像内同源编译产物
> （`dist/sanctions/sanctions-matcher.js`、`dist/skills/service-skill-runtime.js`）与
> **库内真实名单数据**（`sanctions_entity` 12,157 条在用实体，三个源 ENABLED），
> 不是测试替身：列名实体命中 `potential_match`、未列名公司 `clear`、无可比 token 的名字
> `not_screened`；CIF 报价精确等于手算值且不含任何单证字段；导入技能 `tenant-default: disabled`。
>
> 口径：镜像是 `ghcr.io/mlhjyx/global-backend@sha256:e7b24c36…`（源 main `123e8d67`，
> 发布 run 42449210522，attestation 已验证），2026-11-08 05:19 UTC 发车，
> 归档见 `_archive/backend-runtime-switch-123e8d67-xin-20261108/`。

## 1. 环境事实（发车镜像与数据源）

- `/health/build`：`build_sha=123e8d67…`、`image_digest=sha256:e7b24c36…`、`attested=true`。
- 制裁源（`sanctions_source`，均 ENABLED）：`ofac_sdn`（10,018 条，list 2026-10-09）、
  `ofac_consolidated`（363 条，2026-09-14）、`eu_fsf`（1,776 条，2026-09-22；当日刷新 FAILED，
  保留上次成功数据）。在用实体 12,157 条（`withdrawn_at IS NULL`）。任何名字在两次采集之间
  结果可能变化，本证据以当次导出的索引为准。

## 2. 方法

运行中的 `global-api` 容器根文件系统是只读的，因此不往容器写文件：把库内在用实体导出为 JSON，
经 **stdin** 喂给 `docker exec -i global-api node -e …`，脚本直接 require 镜像内的 dist 模块，
组装一个与 `SanctionsScreeningService.screen()` 同语义的筛查函数（`buildSanctionsIndex` +
`screenName`，空命中判 `clear`，`listVersions` 取自 `sanctions_source` 的发布版本），再经
`executeServiceSkill` 走与生产相同的闭集分派。

```bash
# 导出在用实体（列裁剪，aliases 原样）
docker exec global-postgres psql -U global -d global_dev -tAc "select coalesce(json_agg(...), '[]') from sanctions_entity e join sanctions_source s on s.id=e.source_id where e.withdrawn_at is null" > /tmp/sanctions_rows.json
SCRIPT=$(cat /tmp/e2e2.js)   # 断言脚本（见 §4 摘要）
docker exec -i global-api node -e "$SCRIPT" < /tmp/sanctions_rows.json
```

## 3. 结果（2026-11-08 05:38 UTC，逐字取自输出）

```json
{
  "builtFromRows": 12157,
  "sanctionsListed": {
    "status": "potential_match",
    "count": 1,
    "first": { "matchedName": "0DAY TECHNOLOGIES", "source": "ofac_sdn", "listVersion": "2026-10-09", "nameScore": 1 }
  },
  "sanctionsClear": { "status": "clear", "count": 0 },
  "sanctionsBad": { "status": "not_screened", "truncated": false },
  "quote": { "incoterm": "CIF", "totalUnitPrice": 172.7, "totalAmount": 1727, "currency": "USD", "formulaVersion": "incoterms-2020/v1" },
  "checks": {
    "listedIsPotentialMatch": true,
    "clearForUnlisted": true,
    "notScreenedForTokenless": true,
    "quoteMathExact": true,
    "quoteHasNoDocumentFields": true,
    "quotingHumanGate": true,
    "sanctionsNoGate": true,
    "importedDisabled": true,
    "serviceSkillsHaveNoTools": true
  }
}
```

报价输入：CIF、数量 10、报价币 USD、汇率 1.1（EUR→USD，输入值）、加价 10%、成本行
goods 1000 EUR / packaging 100 / inland 50 / ocean 300 / insurance 20（USD）。
手算：成本 1100+100+50+300+20 = 1570 USD → 单价 157 × 1.1 = 172.7 → 总额 1727（分整数域精确，
无浮点漂移）。

## 4. 断言口径（脚本摘要）

- `sanctions.screen.v1`：命中时 `status=potential_match` 且 `matches[0]` 带名单源与 listVersion；
  未命中 `clear`；`"!!!"` 归一化无 token → `not_screened`（不臆造 clear）；输出含 `truncated`。
- `quoting.incoterms.v1`：`totalUnitPrice/totalAmount` 与手算精确相等、`formulaVersion=incoterms-2020/v1`；
  输出键名无 `proforma|invoice|packing|document|pdf`（L1 红线：不产单证）。
- 编译进镜像的目录（`dist/skills/generated/builtin-skill-catalog.js`）：`quoting.incoterms_quote`
  `humanGate=true`、`compliance.sanctions_screen` `humanGate=false`；两个 service 技能
  `allowedTools=[]`；`research.account_research` 与 `triage.lead_triage` `tenantDefault=disabled`。

## 5. 边界（本证据不覆盖什么）

- 只验证了 **service 技能的 handler + 镜像内目录**与真实名单数据；模型技能（含两个导入技能）
  的调用路径没有消费方（M2.1 接入），本证据不含模型调用。
- ops 面的租户启用流（`PUT /skills/:key/workspaces/:id`）与 resolver 的 DB 路径由单测覆盖
  （`skill-resolver.spec.ts` 的导入技能用例），未在本证据中重复执行。
- `eu_fsf` 当日刷新 FAILED 属源侧问题（保留上次成功版本）；命中/清白的语义以当次索引为准，
  名单时效由既有刷新任务负责。
- 服务技能的发布层模型评测回执不在 S1 范围（S2）。
