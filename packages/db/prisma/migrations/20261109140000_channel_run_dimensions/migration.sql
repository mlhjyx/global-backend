-- CH-6（GainOS v3.0 第 6 章 §6.3.2 migration 4）：source_channel_run 运行维度扩展。
--   * 两段式落账需要的计数列（requests/bytes_fetched/http_*）与运行画像（duration/circuit/mode）；
--   * status 增加 PARTIAL：截断但有产出 / 部分页失败但已落记录，不参与失败率坏轮判定。
-- Additive；历史 10 行 run 全部为 1 页试跑，回填 mode='preview' 之后按需修正（默认 'run' 已是安全缺省）。
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "source_channel_run"
  ADD COLUMN "mode" VARCHAR(8) NOT NULL DEFAULT 'run',
  ADD COLUMN "manifest_sha256" CHAR(64),
  ADD COLUMN "plan_digest" CHAR(64),
  ADD COLUMN "requests" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "bytes_fetched" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "http_4xx" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "http_5xx" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "http_429" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "duration_ms" INTEGER,
  ADD COLUMN "circuit_state" VARCHAR(16),
  ADD COLUMN "operator_note" VARCHAR(500);

ALTER TABLE "source_channel_run"
  ADD CONSTRAINT "source_channel_run_mode_check" CHECK ("mode" IN ('preview', 'run')),
  ADD CONSTRAINT "source_channel_run_dimension_counts_check" CHECK (
    "requests" BETWEEN 0 AND 1000000
    AND "bytes_fetched" BETWEEN 0 AND 1000000000000
    AND "http_4xx" BETWEEN 0 AND 1000000
    AND "http_5xx" BETWEEN 0 AND 1000000
    AND "http_429" BETWEEN 0 AND 1000000
    AND ("duration_ms" IS NULL OR "duration_ms" BETWEEN 0 AND 86400000)
  ),
  ADD CONSTRAINT "source_channel_run_circuit_check" CHECK (
    "circuit_state" IS NULL OR "circuit_state" IN ('closed', 'open', 'half_open')
  );

-- status 词表增加 PARTIAL（两段式落账后「截断但有产出」不再冒充 SUCCEEDED）。
ALTER TABLE "source_channel_run" DROP CONSTRAINT "source_channel_run_status_check";
ALTER TABLE "source_channel_run"
  ADD CONSTRAINT "source_channel_run_status_check"
    CHECK ("status" IN ('RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED'));

-- 已完成的 10 行历史 run 都是 preview 试跑（计划 §6.2.3）。
UPDATE "source_channel_run" SET "mode" = 'preview' WHERE "finished_at" IS NOT NULL;

COMMIT;
