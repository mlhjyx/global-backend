# Production dependency High 漏洞处置 TDD 记录

> 基线：`origin/main@412716a2a78ed6adfd3e605053f3f310651f9777`
>
> 本地实现：`codex/deps-security-remediation`，实现 checkpoint `7bbc8d80`；尚未 push、建 PR、合并或部署。
>
> 边界：本文记录本地源码、官方 npm audit、确定性测试与 renderer 视觉回归。它不是 GitHub Security alert readback、hosted CI、RuntimeEvidence、Release Bundle 或真实试点证据。

## 起点与目标

基线 lock SHA-256 为 `d98a61553ffa6ea3bca177f47c7c2a82362f774697ffd4c89fa299465072e868`。2026-08-12 使用 npm 官方 registry 的 production-only audit 返回 36 项：18 high、14 moderate、4 low、0 critical。GitHub vulnerability alerts 当时处于 disabled，不能把网页上看不到告警解释为依赖安全。

本轮只处置可有界验证的 High：

1. S1：`brace-expansion`、`fast-uri`、`ip-address`、`js-yaml`、`nanoid`、`postcss` 的 registry-only 传递依赖安全线；
2. S2：Multer 与 `path-to-regexp`，删除未使用的 `@nestjs/serve-static` 与 preview static seam，并让历史预览 verifier 使用最小 loopback `node:http`；
3. S3：Astro 5 → 7.2.1 与 Sharp 0.34 → 0.35.3，执行 Node `>=22.12.0`、CLI、后台 dev server、真实生产 renderer 及跨文件系统构建迁移。

没有用 arbitrary URL/Git/tarball override，也没有把 moderate/low finding 静默加入豁免。version-qualified override selector 仍只允许受信 registry semver，子版本或外部 source 必须 fail-closed。

## RED → GREEN

| 阶段 | RED checkpoint                                                                         | GREEN checkpoint 与关闭内容                                                                           |
| ---- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| S1   | `664b9d5d`、`5a1b5001`：安全 floor 与受控 selector 合同先失败                          | `11ec5831`：八组 registry-only floor 与 source-policy 同时通过                                        |
| S2   | `c5c7e42b`：Multer、ServeStatic/path-to-regexp 和 verifier 合同先失败                  | `a13a7919`：Multer 2.2.0；移除未使用 ServeStatic；最小 loopback verifier 通过                         |
| S3-A | `64339e36`、`7bc24608`：Astro/Sharp/Node floor 与 Codex 环境后台 server 生命周期先失败 | `60eb75ed`：Astro 7.2.1、Sharp 0.35.3、Node >=22.12.0；视觉 server 固定 foreground                    |
| S3-B | `51b19cd6`：Astro 7 package bin 和 `/tmp` 跨文件系统真实生产构建先失败                 | `f4db016d`：从 package manifest 解析 CLI；同文件系统 staging 构建，校验、复制、复算 digest 后原子提升 |
| S3-C | 工作区复审发现 renderer promote 前缺少 `outDir` admission guard                        | `f30892b9`：拒绝 root、缺父目录、父目录 symlink、目标 symlink 或非目录目标后才允许 rm/rename promote  |
| S3-D | `cfc12974`：复审证明 generic guard 仍会接受 `/tmp`、仓库根与中间目录 symlink           | `7bbc8d80`：输出必须是显式受控根的后代，逐层拒绝 symlink，并在 rm/rename 前重新 admission             |

Astro 7 在外部 `OUT_DIR` 上会把 prerender 中间文件回退到 renderer cwd 的 `.astro`，随后以 `rename(2)` 搬运；仓库与 `/tmp` 分属不同文件系统时会 `EXDEV`。最终实现不把 workspace 依赖解析 cwd 移到 `/tmp`，而是在 renderer 根下创建每次构建独有 staging，执行现有 file-count/depth/regular-file/no-symlink/单文件与总字节上限及 outbound-domain gate，再复制到目标文件系统 sibling 临时目录、复算 tree digest，最后同文件系统 rename。失败路径不写 release manifest，并清除 build/cache/delivery staging。

复审补充的 promote admission guard 在任何 Astro 子进程启动前执行：每个调用方必须显式提供受控 `outputRoot`，`outDir` 必须是它的严格后代；root 自身和路径中的每个中间组件都必须是现存普通目录且不能是 symlink，已有目标也只能是普通目录。真实 Temporal 活动固定到 `previewRoot()`，browser-quality / sandbox verifier 则各自创建一次性随机根。复制与 digest 复核结束后、递归删除与 rename 前会再次执行同一 admission，阻断明显的路径漂移。

这个 guard 仍不是对同 Unix UID 恶意并发替换的强不可变绑定：Node 当前 promotion 仍通过路径字符串执行最终 `rm/rename`，第二次 admission 与系统调用之间存在极短 TOCTOU 窗口。当前 renderer 只接收仓内构造的 preview/一次性根，未暴露为 tenant 路径输入；若未来把本地目录账本或 renderer promotion 提升为受控试点恢复边界，仍须使用 retained directory handle / no-follow child traversal 或等价的受信 helper 进一步硬化。本文不把二次复核冒充为同 UID 防篡改证明。

## 最终本地验证

| 验证                                                           | 结果                                                               | 证明边界                                            |
| -------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------- |
| `pnpm install --frozen-lockfile --offline`                     | PASS                                                               | lock 可离线重放；不证明 registry/CI 可用性          |
| Prisma validate/generate、Contracts build/lint、API build/lint | PASS；Spectral 0 error / 15 条既有 tag warning                     | schema、类型、构建和 OpenAPI lint 未回退            |
| API `vitest run --coverage`                                    | 311 files；4664 PASS / 2 skipped                                   | 功能全绿；全局覆盖率仍低于项目 80% 门               |
| API coverage                                                   | statements 70.75%、branches 64.65%、functions 74.22%、lines 72.49% | 必须保持 merge HOLD，不能用依赖修复掩盖覆盖率债务   |
| API renderer-build spec                                        | 12/12 PASS                                                         | Astro 7 子进程、跨文件系统构建与输出目标 admission  |
| site-renderer contracts                                        | 4 files / 26 PASS                                                  | renderer 组件合同未回退                             |
| renderer fixtures                                              | 86/86 PASS                                                         | 所有固定 renderer fixture 可构建                    |
| visual baseline                                                | 81 PASS / 6 conditional skips                                      | 三断点语义、布局、reduced-motion 未漂移             |
| component qualification                                        | 所有现役组件三断点 byte-pinned 对比 PASS                           | 没有更新 snapshot                                   |
| M1-e-B Golden                                                  | 12 specs / 36 screenshots PASS                                     | 视觉 Golden 未漂移                                  |
| `pnpm docs:verify`                                             | 0 errors / 1 条既有表格 warning                                    | governance/docs 总门通过                            |
| Copy fixed-source impact                                       | `COPY_FIXED_SOURCE_FINGERPRINT_MISMATCH`                           | 本候选必须 HOLD；不得编辑旧 receipt 或推导 dispatch |

最终 lock SHA-256 为 `6a434ccc41ad560798a589c571f989684e38dad70d7e96df48f1f6670d7c53c2`。同一 production-only 官方 audit 返回 7 项：0 critical、0 high、6 moderate、1 low；High 从 18 降为 0。

## 仍未完成

- Moderate：Nest Core、`file-type`、`fast-xml-parser`、`qs`、OpenTelemetry；Low：`body-parser`。Nest/file-type/OpenTelemetry 涉及 framework/生态或 major compatibility，必须拆成下一批 TDD，不能用无验证 override 强压。
- 全局 API coverage 未达到 80%，当前 candidate 不是可合并完成态。
- dependency audit/Dependency Review/CodeQL 尚未在本 candidate 的 hosted CI 上运行，GitHub vulnerability alerts 也没有被本轮修改或重新启用。
- Copy fixed-source fingerprint 不匹配，旧 receipt 不代表当前依赖图；需要单独 fixed-source rebase/review/授权。
- 没有部署、目标环境 readback、RuntimeEvidence、Release Bundle、真实外部源/模型调用或试点。
