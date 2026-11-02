# 账户与工作空间 · 模块技术方案

> 文档 ID：`DOC-MODULE-ACCOUNT-WORKSPACE-TECH-001`
> 生命周期：`DRAFT`（依据 2026-11-02 已批准方案起草）
> 生命周期依据：承接已批准方案 D1/D2/D10/D12；实现事实以代码与 status 为准。
> 模块产品说明：[product.md](product.md)
> 当前状态：[../../status/current.md](../../status/current.md)

## 1. 变更历史

| 日期 | 变更 | 原因 | 来源 |
| --- | --- | --- | --- |
| 2026-11-02 | 初稿：gain-saas 身份/空间实现、合同缺口、引导与权限上下文设计 | 模块文档结构落地 | 已批准方案 |

## 2. 技术概览

- **归属**：账户与工作空间全部在 gain-saas（NestJS 11 + Prisma + PostgreSQL 16），引擎不存用户。
- **三域共存**：租户域（admin/member）、运营域（ops_user）、服务域（事件消费/JWKS/预算签发）同进程、不同 guard 与 cookie。
- **引擎信任**：gain-saas 按请求铸造 RS256 JWT（claims：`sub`/`workspace`/`roles`，TTL ≤60s），引擎 JWKS 验签；`workspace` 即引擎租户 id。

## 3. 数据模型（gain-saas Prisma）

| 表 | 要点 |
| --- | --- |
| `users` | id、email 唯一、password_hash（argon2id）、status |
| `workspace` | id UUID（= 引擎租户 id）、name、`onboarding_completed_at`、`primary_company_profile_id`、`onboarding_draft`、status |
| `membership` | (user_id, workspace_id) 多对多、role admin/member、status（active/left/removed） |
| `invitation` | workspace、email、role、token、过期、接受状态 |
| `session` | jti、user_id/ops_user_id、realm、过期、revokedAt |
| `workspace_registry` | 事件消费遍历的空间清单（含 cursor/enabled） |
| `workspace_entitlement` | (workspace_id, key)、status、limits、source |
| `audit_log` | actor、action、target、detail、at |

## 4. 认证与会话

- 密码 argon2id；会话 HS256 JWT + HttpOnly `SameSite=Lax` cookie；登录限流落库（Redis/DB，替代单进程 Map）。
- 引擎 token：RS256，`workspace` claim 必须为 UUID；JWKS 双钥轮换（SigningKey 模型启用，kid 重叠）。
- 权限：`TenantGuard`（membership 校验）→ `AdminGuard`（admin 端点）→ BFF `requiredEntitlement`；服务端始终强校验，前端 allowedActions 只是呈现。

## 5. API 设计

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/register` | 注册（邮箱/密码/公司名/邀请码） |
| POST | `/api/auth/login` / `logout` / `change-password` | 会话 |
| GET/POST | `/api/workspaces` | 列出/创建空间 |
| PATCH | `/api/workspaces/:id` | 改名 |
| POST | `/api/auth/switch-workspace` | 换发会话（新 workspace claim） |
| POST | `/api/workspaces/:id/leave` | 退出（最后成员保护） |
| GET/POST/DELETE | `/api/members`、`/api/invitations` | 成员与邀请 |
| GET | `/api/workspace/context` | entitlements + allowedActions |
| GET/PATCH/POST | `/api/onboarding/state`、`/draft`、`/company` | 引导与建档 |

## 6. 实现状态与缺口

**已实现（as-built）**：注册/登录/会话/工作空间/成员/邀请/切换/审计；引导所需的空间字段尚未落库（见缺口）。

**缺口（2026-11-02 核验）**：
1. Workspace/Membership/Role/Entitlement 正式合同不存在（BLK-FE-003）——本模块补齐 `workspace_entitlement` + `/workspace/context`。
2. 注册后无引导：`POST /api/companies` 只传 `{website,name}`，无产品/目标市场（模块 02 缺口）。
3. JWKS 单钥、无轮换；CSRF 声称有实现无；cookie 无 `Secure`。
4. 登录限流仅单进程内存；ops 登录零限流；注册/接受邀请无限流。
5. 成员邮箱对所有成员可见（前端未做 admin 门，后端需同步强校验）。
6. 工作空间无停用/归档生命周期，废弃空间永久轮询。

## 7. 测试

- 现有：auth 相关仅 `auth.helpers.test.ts`；tenant/ops 域大量无测试。
- 需补：注册→引导→邀请→切换 E2E；OnboardingGuard 负向；跨空间 404；member 越权 403；限流；workspace context 合同快照。

## 8. 迁移与回退

- 新表/字段均为 additive（`workspace_entitlement`、`onboarding_*`、`primary_company_profile_id`）；迁移前 `pg_dump`。
- 回退：代码回退 + 保留新表（不删列）；引导开关可配置关闭。
