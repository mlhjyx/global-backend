-- Art.17 擦除审计链补齐（scale-safe #89）：回执记平台专利发明人缓存按盲键命中删的行数。
-- 追加列，默认 0（既有回执行不受影响；DeletionReceipt 无 RLS，随 deletion_receipt 表既有 GRANT）。
ALTER TABLE "deletion_receipt" ADD COLUMN "patent_cache_erased" INTEGER NOT NULL DEFAULT 0;
