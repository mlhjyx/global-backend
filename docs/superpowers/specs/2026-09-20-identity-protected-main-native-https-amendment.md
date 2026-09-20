# Protected-main 只读观察的有界 HTTPS 修订

状态：INDEPENDENT_DESIGN_REVIEW_COMPLETE_AWAITING_OWNER_DECISION。仅授权后的本地实现候选；本文不授权凭据、controller 物化、真实认证请求、push、merge 或 root main 同步。

独立只读设计审查 `native_https_amendment_review` 未发现阻塞提交 owner 决策的 Critical/Important 问题；它没有执行探测或实现，不构成实施批准或 admission。

## 已证实的问题

2026-09-20 对本机 `/usr/bin/gh` 的合成 loopback 探测，文件 SHA-256 为 `2a50166c5728e8fdbe5ea924c008c7ba09b476dfe448f6af17c1b3ecb471a791`，版本输出为 2.46.0。服务只监听 127.0.0.1；只使用合成值，未访问 GitHub、provider 或真实凭据。

- 302 响应后 GH 实际请求了本地 `/final`，输出合法的 main/SHA/protected TSV。
- 原始 JSON 为 2,097,257 bytes，经过 `--jq` 投影只输出 51 bytes，外层 4096-byte stdout 限制仍返回 PASS。
- 这些 PASS 只是本地进程完成；它们恰好证明 stdout 上限不是原始 HTTP body 上限。现有描述符不能用于声称传输字节已受限或重定向已拒绝。

上游 [go-gh v2.6.0 的 jq 实现](https://github.com/cli/go-gh/blob/v2.6.0/pkg/jq/jq.go) 在 JSON 投影前执行 `io.ReadAll`；[HTTP client](https://github.com/cli/go-gh/blob/v2.6.0/pkg/api/http_client.go) 此处没有配置 CheckRedirect。发行版是否还含其他 patch 不由上游源码推断；上述行为由当前二进制的本地探测直接支持。

## 推荐修订与边界

只把 PROTECTED_MAIN_READBACK 的第二条观察从 GH `api --jq` 改为一个仓库内、经审查并钉住源码的 Node HTTPS 读取器。第一条 Git ls-remote 观察、两条 SHA 必须相等、protected=true、不可变 request/provenance 与原关闭/合并权限门保持不变。其他 GitHub 操作继续各自原合同，不能经新只读入口调用。

这是对原设计指定 GH 物理操作的显式修订，不能静默解释旧 v2 controller 合同。采用版本化的 protected-main transport profile `identity-protected-main-native-https/v1`；后续新的 controller request/receipt 合同必须同时绑定该 profile 的规范摘要、adapter source closure、工具/信任根闭包和独立 review。旧 v2 receipt、旧 controller materialization、unadmitted refresh 与本地 helper PASS 不自动升级或互认。完整 schema 变更及原 Task0B bootstrap/readback 消费者必须在实施计划中逐项列出并统一验证，禁止单改 producer 绕过 admission。

备选方案是维护经审查的 GH 补丁发行版，加入原始响应上限与拒绝重定向，并冻结 Go/module/ELF 闭包。此方案保留 GH 命令形态，但增加第三方工具的构建和长期维护，因此不推荐作为本任务的最小修复。单纯提高 stdout 限制、依赖 `--jq`、增加机器内存或只加超时不能修复这个缺口。

## 新读取器的封闭合同

1. 唯一 URL 为 `https://api.github.com/repos/mlhjyx/global-backend/branches/main`，唯一方法 GET，端口 443；不得由 request、环境变量或返回数据提供 host/path/port/query。无 request body、pagination、cache、逻辑重试或客户端重定向。所有 3xx 均 HOLD，且不发起 Location 请求。
2. 使用固定 Node HTTPS 实现、独立 agent、TLS 主机名校验与受控 CA 信任根；禁止关闭证书校验、继承代理/loader/debug 环境或 fallback 到 GH。API 网络操作最多一次 HTTP exchange。Git 协议的交换次数及 helper 闭包仍单独待审，不由这一次 exchange 的上限代替。
3. DNS 只解析固定主机，最多 5 秒；答复数量上限 16。全部地址必须符合本仓普通 global-unicast 分类语义，空、超量、保留/私网或混合不安全答复均 HOLD。使用现有已锁定 ipaddr.js 分类能力并绑定其实际源文件摘要，不另写不完整私网正则。只选一个已验证地址连接并固定 TLS servername/Host；不进行第二次 DNS、地址 fallback 或自动 family racing。连接的 remoteAddress 必须回读匹配选定地址。
4. 不引入已有业务 net-guard 中的 Cloudflare DoH fallback，也不改变该产品模块。当前机器 DNS 若只返回 fake-IP，本控制器保持 HOLD，不能擅自扩大到额外 resolver/域名；resolver 信任根属于独立精确环境授权。复用的是 IP 分类合同，不是复制或改变产品执行路径。
5. 响应 headers 上限 8 KiB；raw body 上限 64 KiB，在每个 chunk 到来时累计，超过即 destroy 请求/响应，不先 readAll 再检查。Content-Length 非法、重复或已声明超限时提前 HOLD。发送 Accept-Encoding: identity；压缩编码及非 UTF-8 JSON 拒绝，避免解压后绕过字节上限。还须检查实际结束字节数与声明长度一致。
6. DNS、连接、TLS、headers、body 共用最多 15 秒的单调期限；整体控制器的 30 秒期限包含 FD 读取和两次观察，不是给每个阶段重新开始 30 秒。每次同步身份检查完成后重验剩余期限；超时不再 dispatch。同步文件系统内核阻塞仍属于受信主机的可用性假设，不能声称 JavaScript timer 可中断内核。
7. 仅 HTTP 200 进入解析；401/403/404/429/5xx、无 EOF、aborted/stream error、重复关键 JSON 字段、非法 UTF-8、过深结构或非法字段类型均 HOLD，不透传 body、headers、stderr 或 exception cause。解析深度上限 128。投影 name=main、40 位小写 commit.sha、protected=true；Git 与 API 的 SHA 不同亦 HOLD。
8. FD 中的值由私有 adapter 在内存里绑定 Authorization；本轮修订不扩大 controller 父进程入站环境，也不读普通 gh 登录配置。新 HTTPS 分支不使用 GH_TOKEN 子进程环境。Git 分支仍保留原先单独审查的私有 header 环境绑定。自有 Buffer 用后清零；不能承诺擦除 V8 字符串或内核 buffer。报告和 receipt 仅含 opaque handle/scope 摘要，不含凭据值或其原始响应。

## 依赖、回执与防重放

新 adapter 不消除原有 NODE/GIT/native loader/libraries/CA/DNS 等闭包缺口。只读 0555/0444 文件包的加载路径必须确实使用被钉住的依赖，不能只复制一份未被 loader 使用的库来宣称冻结。现有 file-set verifier 继续只证明提交的文件集合；完整闭包在独立审查和实际回读前保持 UNPROVEN。

controller 必须在消费 FD 和发起请求前验证受信安装根、源/工具/profile/request/授权/handle/scope 的精确绑定，再排他领取 request。读取失败或部分执行不覆盖 journal、不自动重放。只有两条真实观察成功且所有执行后身份检查成功，才能排他写入操作结果和 receipt，再由独立 readback 验证。结果记录、受信 receipt producer 和 Task0A ADMITTED 分层；新的网络 adapter 不允许自行声称后两者成立。

## 实现前决策与验收

需要 owner 决定是否批准以上限定的本地传输修订。确认后编写具体实现计划并按 RED→GREEN 连续实施，无需再次询问普通技术选择。确认仅覆盖本地源码、审查和合成 loopback 测试，不覆盖凭据创建、安装、真实 GitHub 请求或任何远端写动作。

验收必须包含真实本地 TLS 服务及合成响应：3xx 不跟随、64 KiB 边界和 chunked 超限、错误/重复 Content-Length、压缩体、慢 headers/body、DNS 晚到、私网/混合答复、连接 IP 漂移、TLS 主机名失败、错误状态、duplicate JSON keys、无 EOF、错误脱敏、SHA 不一致，以及崩溃/重放。替代 endpoint/CA/resolver 只能来自独立测试入口，不能成为产品或安装控制器的可配置 bypass。有效结果仍只作为 OPERATION_RESULT_ONLY，真实 receipt/admission 另行回读。
