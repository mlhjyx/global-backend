---
date: 2026-11-03
title: Relay seller document uploads through the engine so browsers can upload without reaching object storage
---

- 起因：Phase 2c 前端上传时发现 presign 返回的上传地址是引擎侧 `127.0.0.1:9000`（对象存储只监听宿主回环），用户在浏览器里根本连不上；直传方案对远程用户不成立。
- 改动：新增 `PUT /companies/:companyId/seller-documents/:documentId/content`：请求体按原始字节读取（独立的 51MB 上限，413 早退），校验 `pending_upload` 状态、Content-Type 与 presign 申报一致、字节数等于申报大小，再由引擎按同一 staging key 写入对象存储（`SellerDocumentsStorage.putObject`，签名与生命周期标签同 presign）。写入后照常 `commit` 校验并入队。接口说明已登记并重导出 openapi。
- 测试：服务级 6 例（成功/非 pending/类型不符/大小不符/404/存储失败）；全量 API 单测通过；`operation-descriptions` 与 seller-documents 相关规格通过。
- 未做：保留原 presign 直传路径给能访问对象存储的调用方；未加断点续传；大文件分片不在本期。
