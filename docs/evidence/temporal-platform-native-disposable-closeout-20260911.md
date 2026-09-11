# Platform Temporal native disposable closeout

本记录是 2026-09-11 对唯一后续候选的源码与 disposable 运行证明。它不生成
RuntimeEvidence，也不改变保留环境、生产部署、凭据、真实 provider/model 或
Pilot/GA 状态。

## 绑定身份

- 仓库：`mlhjyx/global-backend`
- 基线：`origin/main` `89f212b6d4666627d19032c7ef5c297d2f019533`
- 候选分支：`codex/temporal-native-disposable-closeout-20260911`
- 候选源码提交：`1996f40a2679bd65eb8116662a8696a0bf33cac3`
- worktree：`/global/backend/.codex/worktrees/temporal-native-disposable-closeout-20260911`
- native server binary：Go 1.26.4、CGO disabled、static、trimmed；SHA-256
  `7a87b647be61383d7163154da2f0665417d23242b6e93fc73437fdd364d1903b`
- Temporal config SHA-256：
  `b210f37bb95bbac9caf241420623be9fdfcbfaaa46b80f86b3407843b47bde1e`
- disposable compose SHA-256：
  `f0f15e1f334df13afff7b63bacca040261a4b57fc270c527b5e4be6907ba8f68`
- compose identity：`docker compose -p global -f infra/temporal-platform/test-support/compose.disposable.yml`

## 源码变更

候选把 #494/#495 已合入的 custom binary/config selector 与 JWT-only frontend
边界接到同一验证路径：

- public frontend 在显式 JWT-only 模式下仍要求 server cert/key identity；显式
  frontend mTLS 仍要求完整 client CA；internode 始终要求独立 CA、clientAuth 与
  hostname verification。
- `TEMPORAL_BROADCAST_ADDRESS=127.0.0.1` 使指定 custom binary 使用固定 disposable
  ringpop 地址；reader subject 继续由已合入配置固定为
  `task4c-growthos-reader`。
- reader JWT-only 请求必须通过 TLS handshake；若呈现客户端证书，证书身份仍须
  与 reader subject 精确绑定；reader RPC allowlist 未扩大。
- reader 成功路径使用 SDK `Connection.lazy` 直接调用
  `DescribeSchedule`、`DescribeWorkflowExecution` 和
  `GetWorkflowExecutionHistory`。CLI 仅保留写入和跨 namespace 的拒绝探针，避免
  `GetSystemInfo` 预检绕过三 RPC allowlist 的测试意图。

## 本地门禁

以下命令均在该候选 worktree 执行并通过：

```text
docker run ... golang:1.26.4 go mod verify
docker run ... golang:1.26.4 go test -mod=readonly -race ./...
docker run ... golang:1.26.4 go vet -mod=readonly ./...
CGO_ENABLED=0 go build -mod=readonly -trimpath -buildvcs=false ./cmd/server
node --test scripts/temporal-platform-infrastructure-contract.spec.mjs
pnpm --filter @global/db generate
pnpm --filter @global/contracts build
pnpm --filter @global/api build
pnpm governance:verify
pnpm docs:verify
pnpm --filter @global/code-intelligence test
pnpm code-intelligence:scan
```

Go 1.26.4 的完整 race/vet/build 结果为成功；Code Intelligence 生成了绑定该
worktree 的 29,666 条静态边、12,990 个节点、0 个扫描错误。它是静态辅助证据，
不是运行时证明；runtime snapshot 当前仍缺失。

## Disposable 运行矩阵

命令使用真实 custom native binary：

```text
TEMPORAL_PLATFORM_NATIVE_SERVER_BINARY=/tmp/temporal-reader-go-cache.cpQy07/temporal-server-closeout-main89f212b6 \
TEMPORAL_PLATFORM_TEST_RUN_ID=sep11native22 \
infra/temporal-platform/test-support/verify-disposable.sh
```

结果：

- native server 进入 Temporal server 容器并达到 healthy；未返回
  `TEMPORAL_PLATFORM_START_UNAVAILABLE`。
- `platform-automation` namespace provisioning 幂等通过；retention、ownership
  drift 均被拒绝后恢复。
- reader 的三个直接读 RPC 全部成功。
- no-token、reader write、reader cross-namespace、wrong audience、worker
  cross-namespace、worker admin、writer admin 全部返回 `PERMISSION_DENIED`。
- worker `PollWorkflowTaskQueue` 与 `RespondWorkflowTaskFailed` 通过其专用 JWT；
  internal frontend 无 client certificate 返回 `INTERNAL_MTLS_REJECTED`。
- disposable server、JWKS、PostgreSQL、schema、network、volume 和 worker probe
  均由同一 run 的有界 cleanup 处理；运行结束时匹配的 container、volume、network
  数量均为 `0`。

## 分层裁决

- 源码、Go/API/contracts/governance/docs/ContractGraph 与 disposable native
  运行门：`PASS`，均绑定上述候选内容。
- hosted CI/review/merge：#494 与 #495 已在本轮分别合入；本候选尚未取得新的
  hosted CI 或独立 reviewer readback，不能把本地结果当成该门的通过。
- GrowthOS producer、service JWT、capability JWKS、真实跨仓 readback：
  `EXTERNAL_OWNED / HOLD`，#479 保持 Draft/HOLD。
- #407 历史综合候选仍保留；Wikidata country binding 小候选尚未实施。
- root `main` sync is `APPLIED`: local and `origin/main` both resolve to
  `89f212b6d4666627d19032c7ef5c297d2f019533`; the sync receipt reported
  `statusPreserved=true` with an unchanged status digest. The previously cited
  addendum is now a tracked file on both sides. Untracked `.playwright-cli/`
  artifacts were retained.
- 当前 RuntimeEvidence：`0 current / 6 historical`；Release Bundle：
  `EXTERNAL_UNVERIFIED`；UAT 未运行；Pilot/GA 未授权。
