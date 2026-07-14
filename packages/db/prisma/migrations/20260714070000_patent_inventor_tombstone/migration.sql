-- 🔴 Art.17 擦除墓碑（scale-safe #89 fast-follow · Codex PR #93 P2-5）：按发明人**盲键**持久记录已擦除主体，
-- 令周更刷新 upsert 前跳过——防 DSR 完成后同一 assignee 从 BigQuery 再拉回被擦除人 PII 重物化。
-- 平台级共享表（无 RLS，镜像 patent_inventor_cache）。🔴 只存不可逆盲键 inventor_name_key，绝无明文名。

-- CreateTable
CREATE TABLE "patent_inventor_tombstone" (
    "id" UUID NOT NULL,
    "inventor_name_key" TEXT NOT NULL,
    "erased_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patent_inventor_tombstone_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "patent_inventor_tombstone_inventor_name_key_key" ON "patent_inventor_tombstone"("inventor_name_key");

-- 平台级共享表（无 RLS，镜像 patent_inventor_cache）：app_user 需 INSERT/SELECT（擦除侧走 app_user withWorkspace 事务写墓碑；
-- 刷新侧走 owner 读跳过）。DELETE/UPDATE 一并授（对齐 patent_inventor_cache grant，便于运维手工纠正）。
GRANT SELECT, INSERT, UPDATE, DELETE ON "patent_inventor_tombstone" TO app_user;
