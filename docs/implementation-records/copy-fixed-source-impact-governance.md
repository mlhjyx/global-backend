# Copy fixed-source 影响治理

> 文档 ID：`DOC-IMPL-COPY-FIXED-SOURCE-IMPACT-001`
> 生命周期：`CURRENT`
> 适用范围：Site Builder Copy Sonnet recovery active v22 binding、reviewed exact path-set successor 与共享源码演进边界

## 1. 问题与当前信任根

Copy active v22 runtime binding 把 API、Model Runtime、Site Builder、Contracts、Prisma 与 package/lockfile 的 82 个精确路径作为 source bundle。该绑定是正确的：任一 bound byte 漂移后，都不能继续声称当前 source tree 与该 binding 相同。

当前信任根固定为：

| 字段 | 精确值 |
| --- | --- |
| Binding path | `docs/evidence/site-builder/m1-g-copy-sonnet-recovery-runtime-binding-v22.json` |
| Binding artifact | `site-builder-copy-sonnet-recovery-runtime-binding-prep/2026-08-15-v22-v1` |
| Fixed source commit | `71d6c1c42ff7adc76f3a045cb8348246565e2536` |
| Binding file SHA-256 | `135ff0a6166d30b2257de48048b5c6c093a277ace5ef376a6e3dac1582a58bcd` |
| Source bundle digest | `5f4c321e9d48f0208e5b293a4d40d8f648c0414b8a429a789bed63cf4f874ac0` |
| Bound file count | 82 |

Binding path、binding bytes、artifact ID、fixed source commit 与 source bundle digest 不能由 eligibility receipt 自行替换。更新 binding 必须另做 fixed-source rebase、独立复审和明确授权。

## 2. 机器合同

[eligibility receipt](../evidence/site-builder/copy-runtime-eligibility.json) 是当前 source tree 相对 active v22 binding 的机器状态。`scripts/copy-fixed-source-impact.mjs` 在 required build 中执行并验证：

1. 从 no-follow repository directory handle 出发逐层打开全部 bound paths，拒绝 symlink、特殊文件、目录替换与同句柄读取漂移。
2. 每个文件最多 16 MiB、全部文件最多 128 MiB、最多 512 个 paths；精确读取后重新计算逐文件 SHA-256 与 canonical source fingerprint。
3. 当前文件 inventory 必须和 binding 的 path 数量、顺序与名称逐字相同；不能加路径、少路径、重排或重复。
4. 零漂移只能生成 `CURRENT` / `stale_scope=NONE`。
5. 有漂移只能生成 `STALE_HOLD`，且 drifted paths 必须逐项等于一个 reviewed exact path-set successor；任何 partial、extra、混合或未知集合都以 `COPY_FIXED_SOURCE_STALE_SCOPE_INVALID` 停止。
6. Receipt 的 fingerprint、status、drift paths、scope 与 follow-up 必须由当前 bytes 重算并逐项相等；旧 receipt 不能描述新 tree。

当前 verifier 保留多个窄且互不通配的 reviewed exact scopes：

- `PRISMA_SCHEMA_EVOLUTION`：仅共享 Prisma schema 的已审查演进。
- `PRODUCTION_PARITY_SINGLE_RUNTIME_PATH`：Production Parity 单一运行路径的精确集合。
- `PRODUCTION_PARITY_SINGLE_RUNTIME_PATH_SECURITY_PATCH`：上一个精确集合加已审查的根 package security 变化。
- `PRODUCTION_PARITY_EXECUTION_BUDGET_AUTHORITY_FOUNDATION`：当前 11-path Authority foundation successor。

这些 scopes 是历史与当前分支所需的 exact sets，不是 allow-prefix、目录 wildcard、任意子集或“只要与 Copy 无关就放行”的语义例外。

## 3. 当前 11-path successor

机器生成并 readback 的当前状态：

| 字段 | 精确值 |
| --- | --- |
| Status | `STALE_HOLD` |
| Current source fingerprint | `0e791c86b1cc20042898ce049968c121b196da05f7d8c9cc1bcff1e999c5868e` |
| Stale scope | `PRODUCTION_PARITY_EXECUTION_BUDGET_AUTHORITY_FOUNDATION` |
| Dispatch authorization | `NOT_AUTHORIZED` |
| Pilot eligibility | `BLOCKED` |
| Required follow-up | `REBASE_FIXED_SOURCE_BEFORE_DISPATCH` |
| Eligibility receipt SHA-256 | `a4e54aa5b2f65d60f931dd0cfbaf35e61618cc2e5911f53108f42146e5e4f1c9` |

精确 drifted paths：

1. `apps/api/package.json`
2. `apps/api/src/model-gateway/new-api-request-bound-settlement.ts`
3. `apps/api/src/model-runtime/structured-task-runtime-bridge.ts`
4. `apps/api/src/site-builder/agents/ai-task.ts`
5. `apps/api/tsconfig.build.json`
6. `package.json`
7. `packages/contracts/package.json`
8. `packages/contracts/src/index.ts`
9. `packages/contracts/src/site-builder/component-qualification.ts`
10. `packages/db/prisma/schema.prisma`
11. `pnpm-lock.yaml`

`packages/contracts/src/index.ts` 是相对 predecessor exact set 新增的 Authority contract export 漂移；其余十项来自已审查的 Production Parity/security successor。当前 receipt 没有改 active binding，也没有生成新的 Copy artifact。

## 4. 安全边界

- `successor` 不是 `CURRENT`；`CURRENT` 仍只允许全部 82 个 bound file bytes 与 active binding 完全相同。
- `successor` 不代表 rebaseline；active v22 binding 与其 SHA-256 继续作为不可替换信任根。
- `successor` 不授权 dispatch；`dispatch_authorization=NOT_AUTHORIZED` 与 `pilot_eligibility=BLOCKED` 是 closed-shape receipt 的固定字段。
- `STALE_HOLD` 必须保持 `REBASE_FIXED_SOURCE_BEFORE_DISPATCH`；它不能用于 Release Bundle、真实 pilot、capability、quality、promotion、route 或 deployed/current 声明。
- 只有 `CURRENT` 才能进入 manifest/runtime binding 双 fixed-source rebuild。`STALE_HOLD` 只允许已审查的非 Copy 施工继续普通 build/test，不运行 rebuild。
- 未来任何 scope、active binding 或 Copy 承重源码变化都必须新增 TDD、exact machine receipt、correctness/security review、Hosted CI 与独立合并/dispatch 决策；不能只编辑本页或 receipt。

## 5. 验证

```bash
node --test scripts/copy-fixed-source-impact.spec.mjs
node scripts/copy-fixed-source-impact.mjs
node --test scripts/governance-document-drift.spec.mjs
pnpm governance:verify
pnpm docs:verify
```

Mutation coverage 包括 exact current、missing receipt、partial path set、extra path set、predecessor stale set、fingerprint mismatch、binding substitution、unsafe path、symlink、文件增长/替换和累计字节上限。

仅当机器结果为 `CURRENT` 时，required build 才可运行：

```bash
COPY_SONNET_RECOVERY_MANIFEST_REBUILD_TEST=1 \
COPY_SONNET_RECOVERY_REBUILD_TEST=1 \
pnpm --filter @global/api exec vitest run \
  src/site-builder/eval/copy-sonnet-recovery-manifest-prep.spec.ts \
  src/site-builder/eval/copy-sonnet-recovery-runtime-binding-prep.spec.ts
```

这些命令只提供源码与确定性合同证据。Hosted GitHub Actions、live ruleset、部署构建身份、RuntimeEvidence、真实 provider 与 pilot 仍是独立门。

## 6. TDD provenance

- `2449b038` RED / `ccf400ff` GREEN：描述符锚定、同句柄稳定读取、目录身份复核、累计资源上限、closed-shape receipt 与 CODEOWNERS policy。
- `f5c0fc9c`：引入 reviewed exact path-set successor 机制，替代单一非承重 schema 例外。
- `1d5aeb69`：增加精确 Production Parity security-patch successor。
- `907936bc` RED / `7b34625c` GREEN：锁定当前 Authority foundation exact 11-path successor，并拒绝 partial、extra 与 predecessor stale sets。
- `573d2ad4` RED：CURRENT 文档必须逐项反映 active receipt，且旧 active-version/单 schema 叙述必须失败。
