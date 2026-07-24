# DQ-1 · SiteSpec 共享契约（落地设计 + 实施记录）

> ⚠️ **历史 1.0 实施记录**：PR #117（commit `af87fd1`，2026-07-15）把 SiteSpec 1.0.0 type-only 共享契约合入 main；本页以下保留当时的实施记录与本地验证证据，不改写历史正文。
> 当前兼容合同为 `SiteSpec 1.0.0 | 1.1.0`：Demo v0 固定 1.0，M1-e-B 的受控链使用 1.1；DesignBrief 已由 producer/assembly/ReleaseManifest v2 消费，DesignEvaluation 仍属 M1-f。协同背景见 [00-decisions-and-coordination.md](00-decisions-and-coordination.md) §3。

## 1. 问题：契约有文档、无代码执行 → 双真值静默漂移

[04-sitespec-contract.md](04-sitespec-contract.md) 是 SiteSpec 的**设计权威**，但代码里没有一处"执行"它。实际有两份**手写 TS 接口**建模同一信封、互不引用：

- 生产端：`apps/api/src/site-builder/demo-spec.ts` 的 `MaterializedDemoDoc`
- 消费端：`apps/site-renderer/src/lib/spec.ts` 的 `MaterializedSpec`

已在漂移（本次落地前实测差异）：

| 字段 | 生产端 `MaterializedDemoDoc` | 消费端 `MaterializedSpec` | 后果 |
|---|---|---|---|
| `site.theme.tokenOverrides` | 无 | `?: Record<string,string>` | 消费端读的字段生产端从不发 |
| `pages[].puck.root.props` | 必填 | 可选 | 契约松紧不一致 |
| `assets` 值形状 | `Record<string, never>`（永远空） | `Record<string, { kind, hash }>` | 同名字段两种形状 |

任一端改动无编译期护栏 → 漂移只在运行时暴露。这是跨应用共享契约的头号地基风险。

## 2. 决策

1. **单一真值 = `@global/contracts` 的共享 TS 类型**（`src/site-builder/site-spec.ts`）。两端 `import type { SiteSpec }`，漂移在**编译期**即报错。
2. **第一刀 type-only、零运行时**（不引 Zod）：精确达成"消灭类型漂移"，血量最小。04 §7 的运行时校验器作为紧接 follow-up 叠加（见 §6）。
3. **打包 = 契约包 dist 化**（`tsc` emit `dist/*.d.ts`），两端消费**声明文件**。
   - **为何不用 raw-TS 源**：实测 API 的 `nest build`（tsc，`rootDir: ./src`）**拒绝** import 包外 raw `.ts`——`TS6059: File is not under 'rootDir'`，**即便 `import type`**。声明文件（`.d.ts`）不受 rootDir 约束，故 dist 化是唯一干净解。
   - `tsconfig.base.json` 的 `paths["@global/contracts"]` 由 `src/index.ts` 重指向 `dist/index.d.ts`。
4. **CI**：`build-test` 与 `contracts` 两个 job，在 `@global/api build` 前各加一步 `pnpm --filter @global/contracts build`（api 依赖其 dist d.ts；无 turbo，显式排序）。
5. **向后兼容**：保留 `MaterializedDemoDoc` / `MaterializedSpec` 作为 `= SiteSpec` 别名，既有 import 一律不惊动（零改 .astro / 零改 activities）。

## 3. 漂移调和（取兼容超集）

`SiteSpec` 按 04 定为两端都能满足的超集：`theme.tokenOverrides` 可选、`puck.root.props` 可选、`assets: Record<string, AssetRef>`（空对象合法 → 生产端 `{}` 通过）。故两端既有产出/读取均无需改逻辑。

## 4. 文件

| 文件 | 改动 |
|---|---|
| `packages/contracts/src/site-builder/site-spec.ts` | **新增**：`SiteSpec`/`SitePage`/`PuckData`/`PuckBlock`/`AssetRef`/`SITE_SPEC_VERSION` |
| `packages/contracts/src/index.ts` | 新增 `export * from './site-builder/site-spec'` |
| `packages/contracts/tsconfig.json` | **新增**：emit `dist` + 声明 |
| `packages/contracts/package.json` | `main/types` → `dist`；加 `build: tsc` |
| `tsconfig.base.json` | `paths["@global/contracts"]` → `dist/index.d.ts` |
| `apps/api/src/site-builder/demo-spec.ts` | `MaterializedDemoDoc` → `= SiteSpec` 别名 + import |
| `apps/api/src/site-builder/demo-spec.spec.ts` | 加契约守卫测试（版本一致 + 信封双守） |
| `apps/api/package.json` | 加 `@global/contracts: workspace:*` |
| `apps/site-renderer/src/lib/spec.ts` | `MaterializedSpec` → `= SiteSpec` 别名 + import |
| `apps/site-renderer/package.json` | 加 `@global/contracts: workspace:*` |
| `.github/workflows/ci.yml` | 两 job 在 api build 前加契约 build 步 |

## 5. 验证（本地，无 sandbox）

- `pnpm --filter @global/contracts build` → emit `dist/index.d.ts` + `site-builder/site-spec.d.ts`。
- `pnpm --filter @global/api build`（nest build = tsc 全量）→ **干净通过**（先前 raw-TS 方案在此复现 TS6059，dist 方案解除）。
- `pnpm --filter @global/api test` → **1239 测试全绿**；新增契约守卫 2 测通过。
- Node 解析探针：渲染器侧 `@global/contracts` → `dist/index.js`（types `dist/index.d.ts`），`SiteSpec`/`SITE_SPEC_VERSION` 已导出（type-only import 由 astro build 擦除，解析无虞）。

## 6. Follow-ups（不在本 PR）

1. **Zod 运行时校验器**（04 §7 三重门）：在 `@global/contracts` 叠加 `siteSpecSchema`，渲染器 `loadSpec` 处 `parse`——把生产端违约变成响亮构建错误。届时契约包引 `zod` 运行时依赖。
2. **DesignBrief**（设计智能层）：代码尚无消费者，随该层落地时补，现不预造（YAGNI）。
3. **两开发者 rebase**：本 PR 合并后，双方分支 rebase 到共享契约再动热点文件（`demo-spec.ts` / `spec.ts`），见 00-decisions §2/§3。

## 7. 风险分级

`packages/contracts/**` + CI + 跨两 app → **实质级**（[CONTRIBUTING.md](../../CONTRIBUTING.md)「PR 粒度与风险分级」/ [ci-merge-automation.md](../backend/ci-merge-automation.md) 风险规则）→ **专项复核，用户明确确认后才合并**。
