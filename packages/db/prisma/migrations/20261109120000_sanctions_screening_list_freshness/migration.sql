-- ch08 §3.1.12 制裁陈旧门：筛查结果记录名单新鲜度（运营台/审计可见；防「陈旧名单自动放行」无痕）。
ALTER TABLE "sanctions_screening_result"
  ADD COLUMN "list_stale" boolean NOT NULL DEFAULT false,
  ADD COLUMN "list_age_days" integer,
  ADD COLUMN "list_snapshot" jsonb;
