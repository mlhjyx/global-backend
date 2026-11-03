# 联系人 run 路径验收：第十四班镜像（2026-11-04）

> 结论：**run 内联系人阶段在 `8b142f53`（第十四班）上端到端通过**——15/15 家 fit=match 公司全部覆盖，
> 48 人 / 43 邮箱 / 11 电话，`email_guess` 15/15 补全（全部 RISKY），D7 联系人子预算 $1.65/$2.00，
> 零失败、零预算截断、零租约跳过，run 状态 `DONE`（71 分钟）。同名守卫与岗位词守卫的丢弃计数在线上可见；
> 本轮另发现一类残留：**公司名为泛词**（如 `technical.de`，公司名就叫「Technical」）时，headline 含
> 该词的其他公司员工仍会被社媒层收录（20 条新联系人中 2 条，10%）。

## 1. 背景与镜像

- 镜像 `ghcr.io/mlhjyx/global-backend@sha256:e2cfa8cc…`（源 `8b142f53`，第十四班，含
  #760 零产出三类根因修复、#761 称号去重 + 社媒岗位词守卫、#762 资料库浏览器上传中转）。
- 验收走 E2E 卖方场景（虚构泵业卖方 + 4 条 claims → ICP → 16 查询 → execute），经 gain-saas BFF
  发起（`POST /api/query-plans/:id/execute`），工作区 demo（`982c2a12…`）。

## 2. 结果（run `d6ea63da-2fbe-4888-9475-82028eeeca65`，状态 `DONE`）

| 指标 | 值 |
| --- | --- |
| 时长 | 约 71 分钟（18:33Z 起，19:44Z 终态） |
| 查询 | 16/16，接收 67 家、去重后入库 63 家 |
| fit | match 15 / weak 13 / mismatch 39；unjudged 0、预算跳过 0 |
| websiteProfile | 16 家画像，10 家匹配 |
| signals | 12 家参与、3 家获得信号（digital_footprint + structured_harvest） |
| **contacts** | **15 家（= 全部 fit=match）**、48 人、43 邮箱、11 电话、skipped=false |
| emailGuess | enabled；20 人无邮箱 → 尝试 15、持久化 15、risky 15、verified 0、blocked 0、failed 0 |
| D7 联系人子预算 | cap $2.00，spent $1.65（≈11¢/家，含联系人全部适配器与模型调用），未耗尽 |
| 预算截断 / 租约跳过 | 0 / 0 |
| 社媒守卫诊断 | `social_namesake_dropped`=21、`social_uninformative_dropped`=17、`social_blocked`=2、`social_fetches`=3 |
| 失败 | 0 |

- 本轮 20 条**新**联系人分布在 4 家公司（9/8/2/1）；其余联系人行是这些公司在历史 run 中已有的存量。
- 新行中无「公司当人」行（含 GmbH/Ltd/Consult 等字样的姓名为 0）；无外域（in/uk/zw）LinkedIn 档案。

## 3. 观察与残留

1. **守卫在线生效**：`social_namesake_dropped`（同名/缺公司佐证）与 `social_uninformative_dropped`
   （#761 新增的岗位词要求）在真实 run 里分别丢弃 21 / 17 条候选，与前几轮 Golden Set 的机制一致。
2. **泛词公司名是新的残留类**：`technical.de` 的公司名就是「Technical」这个常见词，社媒 L3 收录了
   2 条别家公司员工（headline 为「… at Redline Technical…」「… at Treefrog Cinegraphix…」）。
   守卫要求「标题里有公司佐证」，泛词天然满足——建议要求佐证 token 具备区分度（维护一个
   Technical/Industries/Systems/Solutions 之类的泛词表，或要求域名/雇主字段级证据），否则此类别会
   随公司名越泛越常见。
3. **email_guess 口径不变**：15 个候选全 RISKY、0 VALID（catch-all 诚实上限），与 M5 §7/§9 一致。
4. run 63（标签 63）因外部取消在 signals 阶段 fail-closed 记 `FAILED`（`CancelledFailure`；
   引擎自身从不取消 workflow，时序上也排除了随后的镜像切换——切换在 18:29:18 通过「无 RUNNING」
   检查时该 run 已终结）。当晚另有一个并行 workspace 的 run 用 429/504 打满模型上游，两者都被拖到
   2 小时量级；此运维注意已写入 `local-config/RUNBOOK.md` §10（同时只跑一个 discovery run）。

## 4. 结论与建议

- 第十四班镜像的 **run 路径联系人阶段验收通过**（首次在单次 run 内 `DONE` 且全量覆盖 fit=match）。
- 下一步：① 泛词公司名的守卫收紧（引擎侧小改动，与 Golden Set 第三轮 §9 的两类残留同属社媒层）；
  ② 用同一批 20 家 Golden Set 在第十四班镜像上跑第四轮复测（#760/#761 上线后的首个完整对比）。
