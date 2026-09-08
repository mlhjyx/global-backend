# 平台proof实施计划

依据：[用户已确认规格](2026-09-08-platform-proof-approved-spec.md)，原字节SHA256为907707d7ed0696df9d8bfc017115a530ac811cd0045202390d714510ab5e4dad。其PROPOSED标题保留作为冻结审查输入；本任务中用户已明确回复“好的，继续”，确认该精确规格。

施工：Backend专用worktree codex/platform-proof-capability-20260908；不覆盖GrowthOS权威目录的现有writer。跨仓修改使用另行核对后的archive+patch入口。

1. Backend signed capability验证与缓存。文件apps/api/src/platform-authority/platform-capability-snapshot.ts及spec：闭合payload、issuer/audience/nonce/source/policy/schedule绑定、RS256专用kid、公钥用途、底层最早截止、空队列规则。先RED，后GREEN；不接production registry直到端到端readback完成。
2. GrowthOS Temporal生产只读adapter：先核对SDK/build工具链，再精确方法/namespace约束、history与schedule证据提取、前后快照一致性；服务端Authorizer必须独立实现和验证。新依赖固定版本与供应链证据。
3. GrowthOS capability响应接口与Backend有界HTTP刷新：service JWT认证，签名快照，10秒single-flight刷新，3秒deadline，失败清缓存；禁止健康检查创造业务状态。
4. issuer/revocation事实及独立控制面consumer接线：从持久真实状态读事实；控制面先于平台Worker启动；缺能力仍not_ready。
5. Backend三类contributor接入现有readiness，覆盖disabled schedule、restart cold cache与expiry；跨仓契约负例、相关覆盖>=80%、docs/governance/ContractGraph、独立review。
6. 精确部署清单与运行核验：依用户具体运行授权执行，固定image/server/权限/CA/migration身份。无授权不变更服务端身份、发布镜像或启动真实平台任务。UAT/Release/Pilot继续各自验收。

本地验证完成不代表后续任务完成。每个切片保留fixture在测试入口，不把stub注入产品root。例行修复/检查不重复审批，正式规格变更才回到相应门。

## 实施进展与跨任务所有权

- 本任务已实现Backend签名信封、schedule行绑定、底层deadline和single-flight缓存四模块；75项回归通过。两次独立review发现的BOM解码与JWT秒精度问题均按RED/GREEN修复后复审关闭。API build、lint、docs/governance通过；真实HTTP transport及registry root未接入，不能据此宣称runtime ready。
- Task 2及Task 4的GrowthOS源码当前由既有“修复独立站前端构建失败”任务（01a00ab2-0341-7443-adf1-04d9dfd6b0ff）推进，施工路径/root/.codex/worktrees/growthos-platform-authority-20260908。只读接管核对发现原生Temporal reader候选和持久签发补丁已存在；该任务仍在执行HMAC入口、撤销Outbox/fence ACK和能力检查。它的测试/提交声明必须在集成时按exact-source核验；本任务不覆盖其writer或重复新增迁移。
- Task 3、5等待双方明确的capability wire/schema和producer事实交付。已批准的本任务签名capability readback与其它任务HMAC签发入口用途不同，不能自动互代；接线时同时核对issuer/audience/nonce/schema/密钥用途及底层fact截止。
- 冻结规格内源码事实是审批时快照，不覆盖后续并行任务进展。当前源码实现和运行事实按各自exact commit/readback核验。

## Backend HTTP transport交付

- 新增platform-capability-transport.ts及测试：固定配置endpoint（HTTPS或literal loopback HTTP），专用service token provider，3秒覆盖取token/fetch/stream的总deadline，禁止重定向/cookie，application/jose与16KiB响应限制，UTF8/BOM/framing严格检查。
- POST请求compact JSON字段固定为operationId=platformAutomationCapabilities_v1、nonce、backendSha、growthosSha、policyDigest、namespace=platform-automation、schedules。每个schedule固定scheduleId/workflowType/taskQueue/mode；nonce由cache生成。真实HTTP path仍必须与GrowthOS code-first接口确认，不由外部请求决定。
- 返回raw compact JWS交给cache的签名/行/有效期验证；transport本身不授予ready。service token须由SaaS既有受控身份供应，接收方仍需核验服务主体/audience/scope。HMAC签发入口不能替代此capability read操作。
- 新增transport focused23项，五模块合计98项通过；transport覆盖率statements98.48/branches98.36/functions81.81/lines98.33。独立review通过实现，额外验证父signal取消时body读取被取消。所有测试离线，不触发真实服务或凭据。
- 尚未完成：实际token provider、producer endpoint/schema冻结、capability JWKS轮换接线、三类production contributor注册、服务端真实事实与跨仓运行验收。现有代码不自动改变当前not_ready状态。
