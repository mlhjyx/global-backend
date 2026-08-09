# Supply-chain canary 与 production audit ratchet TDD 记录

> 基线：`origin/main@fcb61e3060dd3289fec93bca11d02584f8080791`
>
> 范围：dependency review、production-only audit ratchet、机器可读遗留漏洞基线、Dependabot 分域、CodeQL canary。
>
> 边界：本文只把源码与本地测试作为实现证据；GitHub-hosted canary、live ruleset/security setting、部署和真实试点必须由各自的 exact-head 运行证据证明，不能从本文推断。

## 用户旅程与失败面

1. 普通 PR 新增 moderate 及以上 production/runtime 漏洞时，Dependency Review canary 应失败。
2. 全量 production audit 允许既有漏洞消失，但新增、severity 升级、critical、已解决后回归、单项 remediation 到期、baseline 过期和畸形报告必须失败。
3. 首次 bootstrap 只能绑定 exact PR base、真实 base lock digest 和完全相等的 advisory 集，且不得在同一 PR 修改依赖图。
4. 后续 PR 必须使用 base commit 的 verifier/baseline，并比较受信 base 与 head 的实时 audit，candidate 不能修改 policy 后自证。
5. 仍有遗留漏洞时，机器回执必须显示 `RATCHET_PASS_WITH_LEGACY_RISK`；只有零漏洞才能显示 `PASS_CLEAR`。
6. Dependabot 将 patch/minor 维护按运行域拆分，协调式 major 继续单独迁移；CodeQL 与新供应链 job 先作为 non-required canary。
7. `pnpm-workspace.yaml` 只接受覆盖全部 tracked workspace manifest 的 block-style 仓库内 glob；`pnpm-lock.yaml` 只接受当前 pnpm 生成的无转义/anchor/alias/tag/merge/block-scalar 子集与 registry integrity resolution。任何更宽 YAML 语义、catalog/configDependency、外部路径或非 registry 源都必须先扩展受信策略与 mutation 合同。
8. 任一 tracked manifest 都不得用 `pnpm.auditConfig` 在 ratchet 前过滤 GHSA/CVE；候选配置不能把 advisory 消失冒充 remediation。
9. source-policy 在解析 workspace glob 前验证 Git index mode；tracked symlink/gitlink 不能把仓库内 pattern 间接解析到仓库外目录。
10. production audit CLI 即使脱离当前 workflow 单独执行，也必须在读取 audit 结果前自行执行仓库依赖源准入，不能依赖调用者维持安全顺序。
11. 首次 PR bootstrap 的 baseline 必须随最终 PR base 重绑定；主线合成后，旧开发基线不得继续冒充 GitHub canary 的 exact base。
12. 所有 baseline、audit、manifest、workspace 与 lock 输入必须通过同一个已打开且 `O_NOFOLLOW | O_NONBLOCK` 的文件句柄完成类型、大小、稳定性检查和有界读取；路径检查与重新打开之间不得存在 TOCTOU 窗口，最终组件 symlink 必须被真实行为测试拒绝。

## RED → GREEN 证据

| 周期 | RED checkpoint 与预期失败                                                                                        | GREEN checkpoint 与结果                                                                                            |
| ---- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1    | `fe9bb3bdfb7bdbe7d45a2b66329cda6772edbf10`：39 tests 中 8 个新增合同失败                                         | `c3ba6b5f343b75d1b0aa8238be11cfbacc9c581a`：基础 canary、baseline、分域、治理入口通过                              |
| 2    | `29176d51c9bf41dd361c9ad8a64efe88df01b800`：41 tests 中 4 个新增防绕过合同失败                                   | `9666fa09`：bootstrap 锁定 base lock/advisory 集，metadata 与 due date fail-closed，41/41 通过                     |
| 3    | `01f1aa26`：回执语义、base/head regression、comparison input 和 pnpm 固定版本合同失败                            | `b3c3f0e5`：43/43 governance tests 通过；官方 registry base/head 本地模拟返回 36 条遗留风险回执                    |
| 4    | `9860d912`：finding exposure、advisory metadata 和实际 `.pnpmfile.cjs` 路径合同失败                              | `0a283dab`：45/45 governance tests；183 条 canonical exposure；installed base/head 比较通过                        |
| 5    | `480eff12`：候选 `.npmrc`、代理/TLS/CA/Node 环境注入和依赖配置 ownership 合同失败                                | `652f3607`：46/46 governance tests；安装/audit 使用环境 allowlist，仓库 `.npmrc` 在联网前拒绝                      |
| 6    | `67df655e`：新增 dependency ownership 未同步机器治理清单时总门失败                                               | `a39d4cbe`：CODEOWNERS 末尾承重块与 required-contexts 机器真值逐项一致，governance verifier 通过                   |
| 7    | `1ca67ba2` / `69f4efaa`：direct URL/Git/tarball 与不可枚举的 archive base checkout 合同失败                      | `8ba9c2b8`：受信 source-policy 在 base/head install 前运行；base 改用可审计 detached Git worktree                  |
| 8    | `ed34bd0b`：无显式协议、仅 `repo/commit/type: git` 的 lock resolution 仍能绕过                                   | `8ba9c2b8`：隐式 Git/directory resolution、越界 importer/link 也 fail-closed；官方 registry 图通过                 |
| 9    | `7ecda778`：workspace flow/越界 glob 与 YAML escape 合同失败；partial GREEN 的单引号保留键 mutation 再次变红     | `7e0230a1`：严格 workspace schema 与 lock YAML 子集 fail-closed；`\\x`/`\\u`/`\\U`、quoted key、flow path 均被阻断 |
| 10   | `b4ecce59`：`!!binary` 可把 base64 解码为 Git resolution 并绕过 raw-text source marker                           | `de54ddd8`：全面拒绝 tag/anchor/alias 指示符；`!!`、`!<...>` 与 `*.alias` mutation 均被阻断                        |
| 11   | `9d2214a8`：`pnpm.auditConfig.ignoreGhsas/ignoreCves` 可在 ratchet 前隐藏 advisory                               | `7102fe29`：所有 tracked manifest 的 `pnpm.auditConfig` 均 fail-closed，candidate 不能过滤 audit 事实              |
| 12   | `eee0026e`：flow singleton-sequence key 被 js-yaml 字符串化为 `resolution/repo/commit/type`                      | `3a80d502`：拒绝 complex-key `?` 与 collection mapping key，并补 scp-like Git source 防线                          |
| 13   | `febf8f21`：workspace glob 尚未把 tracked symlink/gitlink 纳入 trust boundary                                    | `d865d606`：联网安装前只接受 Git index 中的 100644/100755 regular files，其他 mode 全部 fail-closed                |
| 14   | `f09917cf`：审计 CLI 尚未独立调用 source-policy，脱离 workflow 时可遗漏依赖源准入                                | `aeed36b1`：CLI 在读取基线或运行 `pnpm audit` 前执行仓库依赖源准入，workflow 前置门继续作为第一层防护              |
| 15   | `81eb0140`：合成到当前 main 后，机器测试精确报 `BASELINE_BOOTSTRAP_BASE_MISMATCH`                                | `3691304d`：baseline 重绑定 `6b78901c…`；36 advisories/183 exposures 与 lock digest 不变，bootstrap exact 参数通过 |
| 16   | `7da72efa` / `0a41c1f4`：合入 #361 后，CLI 与 repository baseline test 精确报 `BASELINE_BOOTSTRAP_BASE_MISMATCH` | `01249ef4`：baseline 重绑定 `fcb61e30…`；36 advisories/183 exposures、remediation 时限和 lock digest 均保持不变    |
| 17   | `ee6a141c`：GitHub CodeQL 在 `lstat(path)` 后按路径重新 `readFile` 的两处输入读取上报告 HIGH TOCTOU              | `968c9a30`：audit/source-policy 复用同一 no-follow handle 完成 fstat、有界 read、前后 identity/stability 复核      |
| 18   | `8bc60e26`：独立安全复审要求 FIFO 不得在类型判断前阻塞，并新增最终组件 symlink 行为合同                          | `44ef4fcb`：secure open 增加 `O_NONBLOCK`；symlink 正例拒绝与全部 18 项供应链测试通过                              |

实现过程中只修生产代码以满足既定 RED；测试修正仅有一处 YAML 标准缩进期望从 8 空格改为实际 `with.version` 的 10 空格，没有降低行为合同。

Cycle 15 与 16 的 exact-main 重采样都只更新 source/base commit 与 `captured_at`；原有 remediation due date、baseline `valid_until`、36 条 advisory、183 条 exposure 和 lock digest 全部保持不变，不能借主线同步延长漏洞债务。

## 本地验证矩阵

| 验证                                              | 结果                                                          | 证明边界                                                                                     |
| ------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `node --test scripts/supply-chain-gates.spec.mjs` | 18/18 PASS                                                    | ratchet、bootstrap、回归、source/网络信任边界、原子输入读取、workflow/Dependabot/CodeQL 合同 |
| `pnpm governance:verify`                          | 49/49 PASS；governance verifier PASS                          | 新 suite 已被 canonical root entry 独立锁定；现有 traceability/provider/release 合同未回退   |
| 官方 registry installed base/head 模拟            | `RATCHET_PASS_WITH_LEGACY_RISK`；36 advisories；183 exposures | base 与 head 都禁 scripts/pnpm hooks 后物化路径；不代表漏洞已解决                            |
| Prettier 与 `git diff --check`                    | PASS                                                          | 新增 YAML/JS/JSON/Markdown 格式与 whitespace 合同                                            |
| Copy v14 fixed-source rebuild                     | 本轮最终复验：8/8 PASS；Prisma/contracts/API build PASS       | 当前 main 的 Copy v14 source/binding 与供应链合成树兼容                                      |
| `docs:verify`、memory、decision-card              | 本轮最终复验：0 errors/1 既有 warning；15/15；13/13           | 文档与项目治理总门不回退                                                                     |

Node 内置 governance tests 没有单独的覆盖率采集器，因此本文不伪造百分比。测试直接覆盖所有新增判定分支，并用结构性 mutation 合同锁定 workflow 接线；GitHub-hosted Dependency Review、CodeQL 上传权限、Dependabot 实际分组以及 Actions 事件语义仍只能由未来 exact-head canary 证明。

## 已知风险与后续门

- 当前 36 条 production advisory 是限时债务，不是漏洞豁免；其中 high 18、moderate 14、low 4、critical 0。真实修复仍是独立阻塞治理。
- `OWN-SECURITY`、`OWN-PLATFORM` 等责任帽在权威治理表中仍存在 `UNASSIGNED` 或 `ROLE_EXISTS_ASSIGNEE_UNRECORDED`；本切片不伪造个人 assignee。周末处置前必须由用户/项目治理补齐实际责任人。
- 新 job 未加入 required contexts；live ruleset、GitHub Code Security 可用性和 action canary 均未改动、未验证。
- 首次 Draft canary 的普通 CodeQL workflow job成功，但独立 CodeQL analysis check 在 `d7f7d3d9…` 精确 head 上发现两处 HIGH TOCTOU；该 head 已被拒绝。Cycle 17/18 只代表本地修复，必须由新的 exact-head GitHub CodeQL analysis 清零后才能关闭远端门。
- 既有 required `ci.yml` 仍执行普通 `pnpm install --frozen-lockfile`，尚未统一采用本切片的 source-policy、环境 allowlist 和 lifecycle-script 禁用；这是后续“全 CI 安装面硬化”阻塞治理，不因新 canary 变安全而被视为关闭。
- CodeQL 与 Dependency Review 成功也不能证明部署安全、运行安全或 AI 获客真实试点就绪。
- 真实试点继续 `NO-GO`；本切片不读取凭据、不调用付费模型、不触发外部业务副作用。
