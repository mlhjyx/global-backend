-- 复审 M1：sanctions_screening_result 一公司一结果——并发多 ICP qualify 的 find-then-create 会产双行 +
-- 「最新」非确定（人工清白可能被 open 兄弟行遮蔽）。改唯一键 → qualify 用 upsert 原子收敛。
-- DropIndex
DROP INDEX "sanctions_screening_result_workspace_id_canonical_company_i_idx";

-- CreateIndex
CREATE UNIQUE INDEX "sanctions_screening_result_workspace_id_canonical_company_i_key" ON "sanctions_screening_result"("workspace_id", "canonical_company_id");
