# D6：per-tenant LIA 采集（多租户前的合法依据声明）

> 生命周期：`CLOSED`（**2026-11-04 决策：租户声明模型取消**——以 `2026-11-04-acquisition-system-complete-design.md` §7.4 为准：声明入口下架、BFF 注入平台级 lawful-basis 引用、访问审计补偿；本文保留作历史记录）
> 依据：产品负责人 2026-11-03 拍板「现在做」，并确认 D6-1 最小版 / D6-2 403+引导 / D6-3 保留版本历史 / D6-4 立即生效。
> 落地：gain-saas PR #40 已合并（squash `c555122`，2026-11-03）并已部署上线（migrate + 重建 + systemd 重启，见 §七）。
> 依据：联系人发现设计稿 §5.3d / D6；产品负责人 2026-11-03 拍板「现在需要多租户，现在做」。

## 一、现状（实读代码）

- **引擎**：`POST /canonical-companies/:id/discover-contacts`（以及 guess-emails / verify）**每个请求**要求在 body 里带
  `lawfulBasis: { basis: 'legitimate_interest'|'consent'|'contract'|'legal_obligation', ref?, note? }`；
  缺了按合同返回 403 `CONTACT_DISCOVERY_LAWFUL_BASIS_REQUIRED`（#731）。引擎用 `stampLawfulBasis`
  记录 `recordedBy`（用户）+ `recordedAt`（时间）并随证据落库。
- **gain-saas（M4）**：DecisionMakerCard 在每次发现/猜测/验证前弹表单让用户手填 basis/ref/note。
- **run 路径**：`decision_maker` provider config 里的全局 interim LIA（`OWNER-DECISION-2026-10-11`）只服务
  run 内联系人阶段与 backlog；与 HTTP 路径互不影响。
- **没有**任何 per-workspace 的合法依据存储——这就是多租户缺口。

## 二、目标

租户（workspace）在 gain-saas 里**一次性声明**其合法依据（LIA），此后三个联系人操作自动携带；
未声明的租户仍被 403 挡住并引导到声明页。引擎语义不变（请求级校验与审计留痕不变）。

## 三、方案（草案）

1. **gain-saas 存储**：新表 `workspace_compliance_declaration`（workspace_id unique、basis、ref、note、
   declared_by、declared_at、version=n+1）。租户重新声明 → version 递增，历史保留。
2. **BFF**：`GET/PUT /api/settings/compliance`（member 读写、admin 或 owner 才能写——按租户角色定）；
   discover-contacts / guess-emails / contact-points verify 三路由：请求未带 lawfulBasis 时**自动注入**
   租户声明的当前版本；note 自动附加声明快照（`declared:vN@date`），保证每次调用的审计能追溯到哪一版声明。
   未声明 → 透传引擎 403，前端引导到设置页。
3. **前端**：新增「合规设置 / 数据处理声明」页（设置菜单下）：表单 = basis 下拉（含每项的解释文案）+
   ref（LIA/工单引用）+ note（利益均衡评估摘要，自由文本，建议带模板提示）；保存后显示「已声明 vN · 日期」。
   DecisionMakerCard：已声明 → 移除每次弹表单，直接操作并在操作旁显示「依据 vN」；未声明 → 按钮跳设置页。
4. **引擎**：不改代码。run 路径的全局 config 保留（平台自动化继续用；多租户下可按 workspace override，属后续）。
5. **审计与证据**：引擎已 stamping（用户+时间）；BFF 注入的 note 快照提供声明版本追溯；声明表历史不删。

## 四、需要产品负责人确认的要点

- **D6-1 表单最小版 vs 完整 LIA 模板**：最小版 = basis + ref + note（note 自由文本，前端给 LIA 要点提示：
  目的/利益权衡/保障措施）；完整版 = 三个必填文本块 + 签署人。建议**最小版**（不阻塞多租户、note 可承载正式 LIA 文本）。
- **D6-2 未声明的租户**：三个联系人操作保持 403 + 引导（本次不做「强制入驻流程」，声明入口在设置页）。
- **D6-3 历史声明**：重新声明只新增版本不删旧版（审计需要）。
- **D6-4 变更后生效**：立即生效（新版本注入），进行中的调用不受影响。

## 五、步骤（TDD）

1. gain-saas：迁移 + 仓储 + BFF 路由（GET/PUT）+ 三路由注入 + 测试。
2. gain-saas 前端：设置页 + DecisionMakerCard 改造 + 测试。
3. 引擎：无代码改动；回归 BFF 注入路径的 403/成功两分支。
4. 文档：设计稿回写、changelog 片段（gain-saas 仓）。

## 六、风险

- BFF 注入让「每次显式操作声明」变成「租户级一次性声明」——审计形态变化由 note 快照 + 声明表版本补偿。
- 多租户角色：谁能声明/修改（建议 admin/owner，member 只读）。

## 七、实施记录（2026-11-03）

**已合并**：gain-saas PR `mlhjyx/gain-saas#40`（squash `c555122`）。改动：声明表
`workspace_compliance_declaration`（手写迁移 `20261103120000`，`version` 自增、历史保留）+
`ComplianceDeclarationService`（枚举/长度校验、并发 P2002 重试、审计 `compliance.declare`）+
BFF `GET/PUT /api/settings/compliance`（写仅 admin）与三路由注入（quote 之前）+ 设置页与决策人卡片改造。
服务端 34 文件 / 181 测试全绿；web 构建绿（vue-tsc 仅余主干既有的 2 条 vxe-pc-ui 声明缺失）。

**实施中的两处设计修正**（独立审查后落地，与 §三 的初稿表述不同，以此处为准）：

1. **注入的 `lawfulBasisNote` 只放版本戳**（`declared vN YYYY-MM-DD`），不附 note 全文。引擎合同限
   note ≤1000 字符且禁控制字符（`NO_CONTROL_CHARS`，多行直接 400/502），而声明摘要允许 4000 字符多行。
   声明全文保存在 SaaS 声明表（版本 + `declared_by`/`declared_at` + 审计），引擎侧凭版本戳回溯。
2. **`lawfulBasisRef` 在注入时压成单行并截断 ≤480**，历史脏行也不会打挂联系人操作。

**部署（2026-11-03 21:08 CST，产品负责人「现在部署」授权）**：迁移前 dump 备份
`/root/DbBackup/gain-saas-pre-d6-20261103T130740Z`；`prisma migrate deploy` 应用
`20261103120000_workspace_compliance_declaration`；重建 shared/ops-pg/server + web 产物；`systemctl
restart gain-saas-web`（4020/18447/18448 正常）。线上验证：登录后 `GET /api/settings/compliance`
返回 200（部署前 404），声明表按 workspace 版本化生效。
