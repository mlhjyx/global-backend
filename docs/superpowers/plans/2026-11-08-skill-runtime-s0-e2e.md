# S0 Skill Runtime v0 · 发车后端到端演示脚本（2026-11-08）

> 生命周期：`GUIDE`
> 生命周期依据：S0 设计 §6 的演示口径（`docs/superpowers/plans/2026-11-08-skill-runtime-s0.md`）；S0 已合入 main（PR #831/#833/#835/#838）并于 2026-11-07 发车，E2E 三部分已完成（Part 1 发车后执行；Part 2/3 随 2026-11-08 发车完成，记录见 `_archive/backend-runtime-switch-99845741-xin-20261107/` 与 `_archive/backend-runtime-switch-123e8d67-xin-20261108/`）；本脚本保留为后续复验口径。
> 用法：按 Part 1 → 2 → 3 顺序；Part 1/3 零成本，Part 2 需要两次真实理解 run（每 workspace 一次，成本约等于一次单公司理解）。

## 0. 前置

```bash
API=http://127.0.0.1:3000/api/v1          # 引擎；host 网络
OPS_TOKEN=<saas-ops 运营 token>             # 具备 ops:read + ops:write
WS_A=<工作空间 A 的 uuid>                    # 用于平台停用/恢复演示
WS_B=<工作空间 B 的 uuid>                    # 用于 workspace 覆盖演示（与 A 不同）
COMPANY_A=<A 空间内一个可理解的公司 uuid>     # 有官网或资料库文档
COMPANY_B=<B 空间内一个可理解的公司 uuid>
DATABASE_URL=<owner 连接串>                  # 只读取证用（psql）
```

- 全部先只读；任何 `PATCH/PUT/DELETE` 只改技能启停覆盖，**不动业务数据**。
- 文中 `jq` 断言可用 `jq -e`；失败即停。
- 执行人：运营/值班；证据（命令输出 + SQL 结果）贴到发车归档 README。

## Part 1 · 目录与启停面（零成本）

```bash
# 1.1 三个技能已在平台目录且 ACTIVE、版本 1.0.0
curl -s "$API/skills" -H "Authorization: Bearer $OPS_TOKEN" | jq -e '
  [.data[].skillKey] | sort ==
  ["company.understanding.extract","company.understanding.extract_offerings","discovery.qualify_fit"]'
curl -s "$API/skills" -H "Authorization: Bearer $OPS_TOKEN" | jq -e '
  [.data[] | {k:.skillKey, s:.status, v:.currentVersion}] | all(.s == "ACTIVE" and .v == "1.0.0")'

# 1.2 未登记技能：404（负向）
curl -s -o /dev/null -w '%{http_code}\n' \
  "$API/skills/no.such_skill" -H "Authorization: Bearer $OPS_TOKEN"   # 期望 404

# 1.3 租户 token 调 ops 端点：403（负向；用一个无 ops scope 的租户 token）
curl -s -o /dev/null -w '%{http_code}\n' \
  "$API/skills" -H "Authorization: Bearer $TENANT_TOKEN"              # 期望 403

# 1.4 快照现状（发车前应已有 S0 解析记录；无记录则跳过对比）
psql "$DATABASE_URL" -Atc '
  SELECT count(*) FROM skill_resolution_snapshot;
'
```

## Part 2 · 零行为变化 + 两级停用（需要两次真实理解 run）

> 触发方式沿用产品正常流程（gain-saas 报价 → 签发 Grant → `POST /companies/:id/understanding/retry` 或新建带官网公司）；本脚本只负责**观测与启停**，不代签 Grant。
> 每次 run 前记下 `ai_trace` 与快照基线，run 后对照。

### 2.1 基线 run（WS_A，COMPANY_A，全部技能 ACTIVE）

```bash
BEFORE_TRACE=$(psql "$DATABASE_URL" -Atc "SELECT count(*) FROM ai_trace WHERE workspace_id='$WS_A'")
BEFORE_SNAP=$(psql "$DATABASE_URL" -Atc "SELECT count(*) FROM skill_resolution_snapshot WHERE workspace_id='$WS_A'")
```

在产品侧触发 COMPANY_A 理解成功（`company_profile.status` 最终 REVIEW/ACTIVE）。然后：

```bash
# a) 新增的模型调用仍是原来的 task/model（零行为变化：task id 与模型名不变）
psql "$DATABASE_URL" -Atc "
  SELECT meta->>'task', meta->>'model', count(*) FROM ai_trace
  WHERE workspace_id='$WS_A' AND created_at > now() - interval '30 minutes'
  GROUP BY 1,2 ORDER BY 1;"
# 期望：company_understanding.extract_claims / extract_offerings / extract_profile
#       的 task 与模型名与发车前一致（对照历史 trace）

# b) 出现 skill 解析快照（技能级审计）
psql "$DATABASE_URL" -Atc "
  SELECT skill_key, descriptor->>'version', descriptor->>'taskContractId', created_at
  FROM skill_resolution_snapshot WHERE workspace_id='$WS_A' ORDER BY created_at DESC LIMIT 5;"
# 期望：company.understanding.extract / .extract_offerings（各 1 行；重复 run 不翻行）

# c) 快照不可变：条目数只增不重复（同 descriptor 摘要唯一）
psql "$DATABASE_URL" -Atc "
  SELECT skill_key, count(*) FROM skill_resolution_snapshot
  WHERE workspace_id='$WS_A' GROUP BY 1;"
```

### 2.2 平台停用 → fail-closed（负向，WS_A）

```bash
# 停用理解主技能（平台级）
curl -s -X PATCH "$API/skills/company.understanding.extract/status" \
  -H "Authorization: Bearer $OPS_TOKEN" -H 'content-type: application/json' \
  -d '{"status":"DISABLED","reason":"S0 E2E kill-switch demo"}' | jq -e '.data.status == "DISABLED"'

# 再触发一次理解（新产品公司或 retry）。期望：run 明确失败，不静默成功。
psql "$DATABASE_URL" -Atc "
  SELECT id, status, understanding_last_error FROM company_profile
  WHERE workspace_id='$WS_A' ORDER BY updated_at DESC LIMIT 3;"
# 期望：understanding_last_error 形如 `extract:SKILL_PLATFORM_DISABLED`（或 crawl 阶段之前的
#       SKILL_PLATFORM_DISABLED；关键是出现 SKILL_ 前缀的闭集 token，而非空或普通 upstream 错误）

# 且停用期间没有新的模型调用（kill switch 在 wire 之前生效）
psql "$DATABASE_URL" -Atc "SELECT count(*) FROM ai_trace
  WHERE workspace_id='$WS_A' AND created_at > now() - interval '5 minutes';"
# 期望：0（本次失败 run 未产生模型调用）

# 恢复
curl -s -X PATCH "$API/skills/company.understanding.extract/status" \
  -H "Authorization: Bearer $OPS_TOKEN" -H 'content-type: application/json' \
  -d '{"status":"ACTIVE","reason":"E2E restore"}' | jq -e '.data.status == "ACTIVE"'
```

> 生效时延：worker 解析缓存 TTL ≤30s；停用后请等 30s 再触发负向 run。

### 2.3 workspace 覆盖 → 只影响目标空间（WS_B）

```bash
# 对 WS_B 停用 offerings 抽取（只影响 B）
curl -s -X PUT "$API/skills/company.understanding.extract_offerings/workspaces/$WS_B" \
  -H "Authorization: Bearer $OPS_TOKEN" -H 'content-type: application/json' \
  -d '{"enabled":false,"reason":"S0 E2E workspace override"}' | jq -e '.data.enabled == false'

curl -s "$API/skills/company.understanding.extract_offerings/workspaces/$WS_B" \
  -H "Authorization: Bearer $OPS_TOKEN" | jq -e '.data.enabled == false'
curl -s "$API/skills/company.understanding.extract_offerings/workspaces/$WS_A" \
  -H "Authorization: Bearer $OPS_TOKEN" | jq -e '.data.enabled == true'

# 触发 WS_B 的 COMPANY_B 理解：期望 extract 阶段失败并记 `extract:SKILL_WORKSPACE_DISABLED`
psql "$DATABASE_URL" -Atc "
  SELECT status, understanding_last_error FROM company_profile
  WHERE id='$COMPANY_B';"

# 撤销覆盖 → 跟随平台默认
curl -s -X DELETE "$API/skills/company.understanding.extract_offerings/workspaces/$WS_B" \
  -H "Authorization: Bearer $OPS_TOKEN" | jq -e '.data.removed == true'
```

### 2.4 快照不可变复核

```bash
# 停用/恢复不修改既有快照行：条目数与 digest 集合保持（只可能新增，不会改写）
psql "$DATABASE_URL" -Atc "
  SELECT skill_key, descriptor_digest, created_at FROM skill_resolution_snapshot
  WHERE workspace_id='$WS_A' ORDER BY created_at;"
# 与 2.1 的输出逐行比对；任何旧行 digest/created_at 变化都算失败。
```

## Part 3 · 收尾与回滚

```bash
# 3.1 所有技能恢复 ACTIVE；两个空间无覆盖残留
curl -s "$API/skills" -H "Authorization: Bearer $OPS_TOKEN" | jq -e '[.data[].status] | all(. == "ACTIVE")'
curl -s "$API/skills/company.understanding.extract_offerings/workspaces/$WS_B" \
  -H "Authorization: Bearer $OPS_TOKEN" | jq -e '.data.override == null'
```

- 任一步失败：按 S0 设计 §10 回退（镜像回滚；表残留无害）；启停问题用 ops API 恢复 ACTIVE，或 SQL 由 owner 复核。
- 把以下证据贴入发车归档 `_archive/backend-runtime-switch-<sha>-xin-<date>/README.md`：Part 1 输出、2.1 的 ai_trace 对照与快照查询、2.2/2.3 的 `understanding_last_error`、2.4 的前后对比、Part 3 恢复确认。

## 备注（测试级负向，不在本脚本重复）

未登记技能对执行侧不可用、契约漂移 fail-closed、跨租户 enablement 不可见、快照 UPDATE/DELETE 被拒等，已由 `apps/api/src/skills/*.spec.ts` 与 `packages/db/test/skill-runtime.rls.spec.mjs` 覆盖（含真库 RLS 用例）；本脚本只演示运营可见面。
