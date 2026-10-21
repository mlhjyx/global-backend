---
date: 2026-10-21
title: Let an artifact bind shared object bytes under its own media type, so empty HEAD probe results settle
---

- 起因：RL1 验收 run `c6b09756`（xin，2026-10-20）在信号阶段失败。根因复核发现：产物对象按内容寻址（主键是 sha256 + 隐私类），同样的字节共用一行；但产物表引用对象行的外键包含 `media_type`，`append_generic_operation_artifact_internal_v1` 也逐项比较对象行的 media type。线上唯一的空对象 10-12 由一个 crawl4ai-fetch/v1 结果先写成 `text/markdown`，此后每一次 http-get/v1 的 HEAD 探测（空 body，`text/plain`）都被拒为 `GENERIC_OPERATION_ARTIFACT_INVALID`，变成无法重放的操作。库里 19 份 http-get/v1 产物没有一份是空的，也就是从来没有一次 HEAD 探测落库成功。信号富集因此连续丢公司，直到阶段失败。#644 只修了存储层与服务层的相等判定，数据库这一层没动。
- 改动：
  - 新迁移 `20261021032000_generic_operation_artifact_object_media_type_reuse`：
    - 对象表加唯一键 `generic_operation_artifact_object_content_key (sha256, object_key, size_bytes, privacy_class)`；
    - 产物表的外键改为 `generic_operation_artifact_object_content_fkey`，引用这四列；
    - 先加新约束再删旧的 `…_metadata_fkey`、`…_metadata_key`，中间每一步都有约束兜着；
    - 用「取函数定义、精确替换、校验恰好一处」的改写，只删掉追加函数里对象行 media type 的比较（带漂移校验）。
  - 不变的部分：sha256、对象键、大小、隐私类仍须一致；已存在的同一产物仍须 media type 完全相同；产物行保留自己的 media type。
  - `schema.prisma` 同步新的外键与唯一键，Copy 回执已重签。
- 测试：
  - `generic-operation-artifact-object-version.postgres.spec.ts` 新增 2 例：
    - 同一份空字节先以 `text/markdown`、再以 `text/plain` 结算，两份产物各带自己的 media type，对象行仍是 `text/markdown`（先 RED：`GENERIC_OPERATION_ARTIFACT_INVALID`，只改函数后又被外键拒，两处都改后 GREEN）；
    - 大小不同的同一对象仍被拒绝。
  - 新增静态迁移 spec `generic-operation-artifact-object-media-type-migration.spec.ts`，3 例：约束先加后删、函数改写只删 media type 那一条且带漂移校验、Prisma schema 与迁移一致。
  - 在本地一次性 pgvector（同 CI digest）上跑 CI「Raw SQL parameter types on PostgreSQL」一步的 7 个 PG spec，36 例全绿；`generic-operation-artifact-subject.rls.spec.mjs` 10 例全绿。
  - 把 `global_dev` 的副本恢复进同一实例、只应用这条迁移：284 份产物不变，新约束全部 validated，函数里不再有对象 media type 比较。
  - 迁移后的测试库与 `schema.prisma` 做 `prisma migrate diff`：没有任何关于产物表的差异。
- 部署：这班车带迁移，换镜像要用 `gctl switch-backend <digest> --with-migrations <镜像源提交的 checkout>`，先 dry-run。
- 未做：
  - 信号阶段另外两处缺陷（单站 TLS 重置被当控制错误让整个活动失败；重试时同一家公司的确认批次混入新旧回执，`DOMAIN_ACK_MIXED_REPLAY_STATE`）另开 PR。
  - 卖方入驻理解工作流 `persistOfferings` 的同类混合确认另开 PR。
  - 不清理已因此留下的 RESERVED 操作。
