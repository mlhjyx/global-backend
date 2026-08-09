# AI 获客阶段 0：API 运行身份与 layered health TDD 记录

> 基线：`origin/main@a3c5c323e93ca398c12c96f89cf2967218862070`
>
> 范围：API bind admission、build attestation、`live/build/ready`、Temporal control-plane probe 与 CI 构建回执。
>
> 边界：本文只记录 source/deterministic evidence；没有部署、服务重启、真实凭据、外部调用、RuntimeEvidence、Release Bundle 或 pilot 授权。真实试点继续 `NO-GO`。

## 用户旅程与失败面

1. development/test 未配置 host 时只监听 `127.0.0.1`；controlled pilot 必须显式绑定 `127.0.0.1`，production 必须显式提供非 wildcard IP；IPv6 expanded/mapped unspecified 也按解析后语义拒绝。
2. pilot/production 必须同时使用 `NODE_ENV=production`，缺 build receipt、JWKS URI/issuer/audience 或 gateway 配置时在启动阶段 fail-closed；model stub 永远禁用，CORS 未配置时默认拒绝，响应和日志不输出 credential。
3. build receipt 只接受 closed v1 shape，绑定 exact source SHA、构建时间、完整 emitted tree、schema digest 和 migration revision；运行时不调用 Git。
4. executable artifact root 由当前 compiled module 位置固定；receipt 不能指向另一个 release。root/每层目录/普通文件通过 Linux descriptor 与 `/proc/self/fd` 锚定遍历，全部 no-follow，并限制单文件、总字节、entry 数与目录深度；receipt、schema、migration inventory 的 symlink、特殊文件、读取中替换和 digest 漂移均拒绝。`migration_revision` 仍只是受控目录清单中的最新 revision 标签，不声称是 migration SQL 内容摘要。
5. `/health/live` 只证明进程可响应；`/health/build` 返回非敏感构建身份；`/health/ready` 探测 DB、Temporal control plane 与 runtime admission。DB probe 使用受限连接等待、transaction timeout 与 PostgreSQL statement timeout，不用无法取消底层查询的 `Promise.race` 冒充有界。
6. 当前没有 durable worker heartbeat 与 Outbox relay leader/backlog evidence；响应必须显示 `not_proven`，pilot/production 因此保持 `not_ready`，不得用 task-queue poller、timer 或启动日志冒充。
7. 旧 `/health` 和 `/health/db` 保持兼容；OpenAPI 对 build/readiness 使用 closed response schema。
8. Copy Sonnet recovery v14 固定源内的 root/API package、Prisma schema、contracts 与 model runtime 字节不变；构建器通过独立脚本和 CI step 接线。

## RED → GREEN 检查点

| 周期 | RED checkpoint 与预期失败                                                          | GREEN checkpoint 与结果                                                                                                  |
| ---- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 1    | `04f6e9b4`：4 个 suite 因 runtime/readiness 模块不存在而失败                       | `8ad3da81`：环境、回执、admission、readiness、Temporal probe 与 health controller 实现；24/24 聚焦测试、lint、build 通过 |
| 2    | `8a0e9e90`：把 worker/relay 成功断言纠正为 `not_proven`，保持同一 RED 根因         | `8ad3da81`：development API-local ready；pilot/production 在 durable evidence 前 `not_ready`                             |
| 3    | `270c7e6a`：listen wiring、generator、Temporal RPC 和三层 health 路由 8 项行为失败 | `8ad3da81`：真实 `app.listen(port, host)`、原子 generator、typed probe 与兼容端点通过                                    |
| 4    | `b2d930f3`：governance test 精确报告 CI 缺 build-attestation step                  | `2181fdb9`：required build 在 Copy final rebuild 后以 `${{ github.sha }}` 生成并自验回执                                 |
| 5    | `7ee28645`：生成 OpenAPI 的 build 为 open bag、ready 200/503 无 body schema        | `2181fdb9` + `1992f630`：build/readiness 使用 closed schema，机器生成格式重新导出且不经 Prettier 改写                    |
| 6    | `c145d00d`：独立 review 的 9 个负例暴露模式分裂、等价 wildcard、旁路 release、目录/schema no-follow 与 live open bag | `e9d25d0c`：受控模式/CORS/stub 单一边界、descriptor-anchored artifact、schema/migration guard、固定 executable root 与 closed live schema 全部转绿 |
| 7    | `94d04fa7`：readiness DB 连接和 statement 无 deadline，4 项中 2 项预期失败 | `fc2dc65b`：interactive transaction 以 `maxWait=1000ms`、`timeout=2500ms` 和 `statement_timeout=2000ms` 有界，4/4 转绿 |
| 8    | `44695e1e`：controlled CORS 接受 `*`、带 path origin 和不安全远端 HTTP | `f68c5157`：只接受 canonical HTTP(S) origin，controlled 远端必须 HTTPS，loopback HTTP 仍可显式配置 |
| 9    | `d069bad4`：JWKS/issuer URL 可携带 ambient credentials、query 或 fragment | `f68c5157`：认证 URL 对上述歧义输入 fail-closed；空白 audience/key 同样视为未配置 |

## 验证边界

- 聚焦 Vitest、API lint/build、OpenAPI drift、governance topology、Copy v14 fixed-source rebuild、`docs:verify` 与 `git diff --check` 必须在最终 exact head 重新运行。
- CI 生成的 receipt 绑定 GitHub checkout 的 `github.sha` 与最终 API dist；它仍不是部署回执。部署阶段必须从干净 release checkout 重新构建、生成 receipt，并由 live `/health/build` 与部署 SHA 逐字回读。
- descriptor-anchored artifact inventory 是 Ubuntu/Linux 部署合同，依赖 `/proc/self/fd`；非 Linux 环境不能据此宣称受控部署兼容。
- worker heartbeat、Outbox advisory lock/lease、Schedule receipts、备份恢复和 `/health/ops` 属于后续 durable-ops PR，不在本切片伪造。
