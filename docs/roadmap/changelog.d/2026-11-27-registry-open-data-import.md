---
date: 2026-11-27
pr:
title: Add open-data registry cleaners, industry crosswalks, and AU/BR solar company imports
---

- 起因：本地平台注册库 `registry_frame` / `registry_snapshot` / `registry_entity` 为空（0 条），无法支撑 `registry_frame` 按国家与行业代码直接枚举在营光伏及电气相关法人企业；同时原有 `industry-map.ts` 缺少英国 UK SIC 2007、巴西 CNAE 2.0、澳洲 ANZSIC 2006 与 NACE Rev.2 的交叉映射，且 `PrismaRegistryFrameStore.applyPlan` 逐行 upsert 难以承受万级快照装载。
- 改动：
  - 补齐 `apps/api/src/registry/industry-map.ts` 的 UK SIC 2007 / BR CNAE 2.0 / AU ANZSIC 2006 → NACE Rev.2 交叉映射、4 位 ISIC Rev.4 补充映射及多语种光伏/电气安装与批发查询别名，并在 `frame-normalize.ts` 接入各国行业码自动归一。
  - 新增 `apps/api/src/registry/open-data-cleaners.ts` 与流式预处理脚本 `scripts/frames/prepare-open-data.mts`（经 `unzip -p` 零解压读取官方 ZIP，严格校验 CRN / AU ABN mod-89 / BR CNPJ 双 mod-11，跳过自然人、个体户、家庭信托、巴西 MEI 与 `Socios*.zip`，不落街道门牌/个人邮箱/电话）。
  - 升级 `apps/api/src/registry/frame-store.prisma.ts` 的 `applyPlan` 为分批 `createMany` 快路径（冲突时自动回退逐行 upsert）与分批 `touches` / `changes`，适配万级开放数据快照事务装载。
  - 新增 `au-abr-abn.json`、`br-rfb-cnpj.json` 帧配置与合成样例并登记至 `scripts/frames/frames/catalog.json`；更新 `gb-companies-house.json` 为 `OGL-UK-3.0` 许可并接线 `UK-SIC-2007` 行业码映射，移除 `addressLines` 字段以收紧隐私底线。
  - 实测导入澳洲 ABR ABN 全量清洗集（19,562 条在营法人）与巴西 RFB CNPJ 已校验分片清洗集（12,253 条在营非 MEI 法人总部）入本地 `global_dev`。
- 测试：
  - 单测：`pnpm --filter @global/api exec vitest run src/registry/industry-map.spec.ts src/registry/open-data-cleaners.spec.ts src/registry/frame-normalize.spec.ts src/registry/frame-catalog.spec.ts src/registry/frame-importer.spec.ts src/registry/frame-store.prisma.spec.ts src/registry/query.spec.ts src/discovery/providers/registry-frame.provider.spec.ts` 8 文件 93 用例全绿。
  - 构建与治理：`pnpm --filter @global/api build`、`node scripts/check-file-budgets.mjs`、`node scripts/governance-module-boundaries.mjs verify`、`node --test scripts/governance-document-drift.spec.mjs`、`node scripts/governance-changelog-fragments.mjs require --base origin/main --head HEAD`、`pnpm docs:verify` 与 `gitleaks` 均通过。
  - 真实数据实测：澳洲全量 20,698,677 行流式清洗入库 19,562 条（幂等重跑验证通过）；巴西 14,260,305 条经营场所（Estabelecimentos 1/2/4）与 71,068,586 条全量企业表关联清洗入库 12,253 条（幂等重跑验证通过）；`RegistryFrameDiscoveryProvider` 实测按 AU/BR + 光伏安装/电气批发/光伏发电查询返回真实法人与 0 成本确定性血缘回执。
- 未做：
  - 英国 Companies House 官方 `en_output.html` 自 2026-11-26 13:01 GMT 起返回 `Service Unavailable`（所有探测的 `BasicCompanyData*.zip` 返回 404），本次已完成清洗器/映射/帧配置与单测，待官方源恢复后即可单命令导入。
  - 巴西其余 7 个 `Estabelecimentos` 分片（含 2.32 GB `Estabelecimentos0.zip`）因 SERPRO 源站限速与多连接重置暂缓下载，后续补齐分片后可幂等重跑全量刷新。
  - 本 PR 未合并、未开启 `data_provider` 生产开关、未触发镜像发布。
