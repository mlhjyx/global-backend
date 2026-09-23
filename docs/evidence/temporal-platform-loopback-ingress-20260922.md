# 原生 Temporal loopback ingress：原生 dockerd 真实运行记录

本记录是 2026-09-22 在原生 Linux dockerd 上的源码与 disposable 运行证明，外加对
保留拓扑的只增不改检查。它**不是** RuntimeEvidence、保留环境部署、原生镜像发布、
Release Bundle 或 Pilot/GA 验收。没有调用模型，没有改动保留环境的数据、凭据或命名空间。

## 绑定身份

- 仓库：`mlhjyx/global-backend`；基线 `origin/main` `9eb5695c5c56386be5210de2e09c48d331e64b01`
- 分支：`codex/temporal-platform-host-port`；候选提交 `101c4260f1b99b9f496c25c9de2666b6b43c962a`
- 候选源码摘要（`temporal-native-publication.mjs source`）：
  `sha256:cb9701f2e9f869174f47f330be3e6084672a54e8787051f3053c716afbab8aec`，22 个文件，含 `infra/temporal-platform/ingress/haproxy.cfg`
- 宿主：xin，原生 dockerd `29.8.1`（linux/amd64），`DOCKER_CONTEXT=default`
- relay 镜像：`docker.io/library/haproxy@sha256:52c5921e1619f39cbd5b25e1b4b5847667917f39745056cf004d9c263fbf11b9`（`3.4.4-alpine`，HAProxy 3.4 LTS）
- disposable 使用的原生二进制：从已钉镜像 `ghcr.io/mlhjyx/global-temporal-platform@sha256:01f0003a3c297e1840792fc5f98686a961e1b343cda88651ca18b21913539584`（revision `9eb5695c`）以从未启动的容器复制，SHA256 `df58a20dbfb5e045cf5d7cc4662b704e947e332253ec6071c4c5766c13494429`。本分支未改 Go 源码。

## RED：只接 internal 网络的容器没有宿主端口

- 保留环境 `global-temporal-platform-1`（源提交 `9eb5695c` 的编排）：`HostConfig.PortBindings` 有 `127.0.0.1:17233`，`NetworkSettings.Ports` 为空，`docker ps` 只显示 `7233/tcp`。17233 当时只由本机覆盖里的 socat 转发器占用。
- 复现（compose 项目 `global`，`codex-hostport-red-*` 资源，用后按名删除）：只接 `internal: true` 网络的容器声明 `127.0.0.1::7233`，结果 `configured={"7233/tcp":[{"HostIp":"127.0.0.1","HostPort":""}]} actual={"7233/tcp":null}`，`docker port` 报 `no public port '7233/tcp' published`。

## GREEN：relay 路径

同一复现里，relay 用本分支的 `ingress/haproxy.cfg` 原样运行（上游别名 `temporal-platform`）：

- 发布 `127.0.0.1:32773`，监听套接字只在 `127.0.0.1`；宿主经 relay 拿到上游应答。
- 出网：relay 内 `nc -z -w 3 1.1.1.1 443` 被阻断，宿主自身可达（正向对照）。
- 上游重建后地址 `192.168.64.2 → 192.168.64.4`，relay 未重启（RestartCount 0），约 2 秒后经 relay 恢复连通。
- 停止语义（独立审查发现后追测）：haproxy 作 PID 1 时 `/proc/1/status` 的 `SigCgt` 为全零，SIGTERM 与 SIGUSR1 都无处理器，`docker stop` 两种信号都是 10.4–10.7 秒后 SIGKILL（exit 137），加 `-W` 也一样；只有 `init: true` 且 `stop_signal: SIGTERM` 两者同时具备才是 0.8 秒 exit 143。按产品 `compose.yml` 形状、握着一条空闲连接实测。

## disposable harness（候选提交、干净工作树）

`TEMPORAL_PLATFORM_NATIVE_SERVER_BINARY=<上述二进制> infra/temporal-platform/test-support/verify-disposable.sh`，退出 0，耗时约 1 分 47 秒，结束后无 `codex-task4c-*` 容器、网络或卷残留。关键输出：

- 五轮 provision 都通过 `platform-automation` 与 `default` 两份合同；`namespace retention and ownership drift rejected`（含 `default` 保留期漂移 → `TEMPORAL_CUSTOMER_NAMESPACE_DRIFT`）
- `HOST_INGRESS_PASS loopback TLS passthrough, authorized DescribeSchedule, unauthenticated denied`：`network_mode: host` 探针经 relay 的临时 `127.0.0.1` 端口，TLS 对端是 Temporal 前端证书（正确名称通过，错误名称 `ERR_TLS_CERT_ALTNAME_INVALID`），Schedule writer 的 `DescribeSchedule` 成功，无 token 被拒；server 容器无任何宿主端口绑定，ingress 网桥 `Internal/masquerade/ICC/IPv6` 均为 `false`
- 原有矩阵不变：reader 允许与拒绝、reader mTLS 边界、internode mTLS 拒绝、worker poll/respond、`MACHINE_WORKER_PASS platform-automation` 与 `MACHINE_WORKER_PASS default`（`default` 只来自共享 provision，探针不再自建）、跨命名空间/admin/错误受众拒绝，末行 `disposable platform Temporal TLS/JWT/native-authorizer proof passed`

## 保留拓扑的只增不改检查（xin）

- 用 xin 真实的 `temporal-platform.env` 渲染本分支 `compose.yml + compose.native.yml`（渲染 JSON 只写 0600 临时文件、未打印，用后删除），新准入 `compose` 结果 `PASS`；server `ports=null`，relay `127.0.0.1:17233->7233`。源提交 `9eb5695c` 的旧编排在新准入下被拒（`TEMPORAL_NATIVE_PUBLICATION_INVALID`）。
- 仅启动本分支的 `temporal-platform-ingress`（`--no-deps`，`TEMPORAL_PLATFORM_HOST_PORT=17234`），接到在运行的原生 Temporal：发布 `127.0.0.1:17234`；网桥 `internal=false masquerade=false icc=false`；`openssl s_client` 以 xin 客户端 CA 和主机名校验得到 `Verify return code: 0 (ok)`、`ALPN protocol: h2`；宿主网络里无 token 的 `operator namespace describe --namespace default` 得到 `Request unauthorized.`；relay 出网被阻断。前后比对，`global-temporal-platform-1` 与 socat 转发器的容器 ID 与启动时间不变；relay 容器与 `global-temporal-platform-ingress` 网络用后按名删除。

## 本地检查

- `node --test scripts/temporal-native-publication.spec.mjs scripts/temporal-platform-infrastructure-contract.spec.mjs`：43 项全过（RED 阶段 8 项失败，均为缺失的导出、合同、relay 配置、探针与编排形状）。
- `gctl check`：docs/governance、prisma generate、contracts、lint、build/typecheck 通过；零容器单测 8651 过、1 失败：`browser-readiness-probe.spec.ts` 的 1000 子进程 soak 在 120 秒超时，当时负载约 15（4 核）。本分支未改 `apps/api`，该文件单独重跑 24/24 通过。

## 不能证明

- 不是保留部署：xin 仍运行镜像 `…@sha256:01f0003a…`（源 `9eb5695c`）加本机 socat 覆盖。启用 relay 需要先从包含本改动的 main 提交发布原生镜像（源码摘要绑定两份 Compose 与 relay 配置；手动发布工作流另需授权），再切换 env、删除本机转发器覆盖、让 `gctl` 启动 `temporal-platform-ingress`。
- Docker Desktop（WSL）未在本次重新验证。
- 不代表平台 schedule 注册、`verify.sh` 保留读回、RuntimeEvidence 或 R4 其余步骤完成。
