# Supply-chain canary 与 production audit ratchet TDD 记录

> 基线：`origin/main@362f88cac1656016bd5aba93032e0f1d90048cba`
>
> 范围：dependency review、production-only audit ratchet、机器可读遗留漏洞基线、Dependabot 分域、CodeQL canary。
>
> 边界：本文只记录本地源码与测试证据；没有 push、远端 PR、live ruleset/security setting、部署或真实试点证据。

## 用户旅程与失败面

1. 普通 PR 新增 moderate 及以上 production/runtime 漏洞时，Dependency Review canary 应失败。
2. 全量 production audit 允许既有漏洞消失，但新增、severity 升级、critical、已解决后回归、单项 remediation 到期、baseline 过期和畸形报告必须失败。
3. 首次 bootstrap 只能绑定 exact PR base、真实 base lock digest 和完全相等的 advisory 集，且不得在同一 PR 修改依赖图。
4. 后续 PR 必须使用 base commit 的 verifier/baseline，并比较受信 base 与 head 的实时 audit，candidate 不能修改 policy 后自证。
5. 仍有遗留漏洞时，机器回执必须显示 `RATCHET_PASS_WITH_LEGACY_RISK`；只有零漏洞才能显示 `PASS_CLEAR`。
6. Dependabot 将 patch/minor 维护按运行域拆分，协调式 major 继续单独迁移；CodeQL 与新供应链 job 先作为 non-required canary。

## RED → GREEN 证据

| 周期 | RED checkpoint 与预期失败                                                             | GREEN checkpoint 与结果                                                                         |
| ---- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 1    | `fe9bb3bdfb7bdbe7d45a2b66329cda6772edbf10`：39 tests 中 8 个新增合同失败              | `c3ba6b5f343b75d1b0aa8238be11cfbacc9c581a`：基础 canary、baseline、分域、治理入口通过           |
| 2    | `29176d51c9bf41dd361c9ad8a64efe88df01b800`：41 tests 中 4 个新增防绕过合同失败        | `9666fa09`：bootstrap 锁定 base lock/advisory 集，metadata 与 due date fail-closed，41/41 通过  |
| 3    | `01f1aa26`：回执语义、base/head regression、comparison input 和 pnpm 固定版本合同失败 | `b3c3f0e5`：43/43 governance tests 通过；官方 registry base/head 本地模拟返回 36 条遗留风险回执 |
| 4    | `9860d912`：finding exposure、advisory metadata 和实际 `.pnpmfile.cjs` 路径合同失败   | `0a283dab`：45/45 governance tests；183 条 canonical exposure；installed base/head 比较通过     |
| 5    | `480eff12`：候选 `.npmrc`、代理/TLS/CA/Node 环境注入和依赖配置 ownership 合同失败     | `652f3607`：46/46 governance tests；安装/audit 使用环境 allowlist，仓库 `.npmrc` 在联网前拒绝   |

实现过程中只修生产代码以满足既定 RED；测试修正仅有一处 YAML 标准缩进期望从 8 空格改为实际 `with.version` 的 10 空格，没有降低行为合同。

## 本地验证矩阵

| 验证                                              | 结果                                                          | 证明边界                                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `node --test scripts/supply-chain-gates.spec.mjs` | 15/15 PASS                                                    | ratchet、bootstrap、回归、网络信任边界、回执、workflow/Dependabot/CodeQL 静态合同          |
| `pnpm governance:verify`                          | 46/46 PASS；governance verifier PASS                          | 新 suite 已被 canonical root entry 独立锁定；现有 traceability/provider/release 合同未回退 |
| 官方 registry installed base/head 模拟            | `RATCHET_PASS_WITH_LEGACY_RISK`；36 advisories；183 exposures | base 与 head 都禁 scripts/pnpm hooks 后物化路径；不代表漏洞已解决                          |
| Prettier 与 `git diff --check`                    | PASS                                                          | 新增 YAML/JS/JSON/Markdown 格式与 whitespace 合同                                          |
| Copy v13 fixed-source rebuild                     | `0a283dab`：7/7 PASS；Prisma/contracts/API build PASS         | 根 `package.json` 与受绑定 source 未因本切片漂移                                           |
| `docs:verify`、memory、decision-card              | `0a283dab`：0 errors/1 既有 warning；15/15；13/13             | 文档与项目治理总门不回退                                                                   |

Node 内置 governance tests 没有单独的覆盖率采集器，因此本文不伪造百分比。测试直接覆盖所有新增判定分支，并用结构性 mutation 合同锁定 workflow 接线；GitHub-hosted Dependency Review、CodeQL 上传权限、Dependabot 实际分组以及 Actions 事件语义仍只能由未来 exact-head canary 证明。

## 已知风险与后续门

- 当前 36 条 production advisory 是限时债务，不是漏洞豁免；其中 high 18、moderate 14、low 4、critical 0。真实修复仍是独立阻塞治理。
- `OWN-SECURITY`、`OWN-PLATFORM` 等责任帽在权威治理表中仍存在 `UNASSIGNED` 或 `ROLE_EXISTS_ASSIGNEE_UNRECORDED`；本切片不伪造个人 assignee。周末处置前必须由用户/项目治理补齐实际责任人。
- 新 job 未加入 required contexts；live ruleset、GitHub Code Security 可用性和 action canary 均未改动、未验证。
- CodeQL 与 Dependency Review 成功也不能证明部署安全、运行安全或 AI 获客真实试点就绪。
- 真实试点继续 `NO-GO`；本切片不读取凭据、不调用付费模型、不触发外部业务副作用。
