-- P1（联系人工程）· contact_point 四态 + 验证事件账。
--
-- 设计依据：《GainOS 深化计划 v3.0》第 2 章 §2.3.2（判定矩阵 / 状态机 / 迁移）；
-- 仓内计划 docs/superpowers/plans/2026-11-09-contact-point-four-state.md。
-- 加法为主：不删除任何列/表、不改写既有列语义；`source_type` 在回填后收紧 NOT NULL
-- （这是本迁移唯一的“契约”动作——回退到本迁移之前的镜像需先 ALTER COLUMN ... DROP NOT NULL）。
-- `status` 保留为 legacy 投影（UNVERIFIED/VALID/RISKY/INVALID），由写入器
-- （contact-point-verification-state.ts）同步维护；BLOCKED 是「本次尝试的合规处置」，
-- 进事件账 verdict=blocked，不是四态之一（旧列仍写 BLOCKED 供既有读侧保守）。
--
-- 迁移纪律：
--  - 收紧 source_type 之前先回填历史 NULL（→ legacy_unclassified），回填不会因脏值中断；
--  - 四态回填与 valid_since 同一条 UPDATE（valid_since 的等价约束在列上已生效）；
--  - 非 UNKNOWN 态必须有 verification_method + verification_provider（state_evidence_check
--    在回填之后添加，历史行无法溯源的方式记为 import/legacy_unclassified 并进入重验队列）；
--  - 重验排期用 now()+3 days，避免部署瞬间把存量邮箱打成重验风暴。
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- ① contact_point 四态列与形状约束。
ALTER TABLE "contact_point"
  ADD COLUMN "verification_state" TEXT NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "catch_all_class" TEXT,
  ADD COLUMN "verification_provider" TEXT,
  ADD COLUMN "confidence" SMALLINT,
  ADD COLUMN "domain_blind_key" TEXT,
  ADD COLUMN "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "next_reverify_at" TIMESTAMP(3),
  ADD COLUMN "valid_since" TIMESTAMP(3),
  ADD COLUMN "phone_type" TEXT,
  ADD COLUMN "last_verification_event_id" UUID;

ALTER TABLE "contact_point"
  ADD CONSTRAINT "contact_point_verification_state_check"
    CHECK ("verification_state" IN ('VALID', 'INVALID', 'CATCH_ALL_RISKY', 'UNKNOWN')),
  ADD CONSTRAINT "contact_point_catch_all_class_check"
    CHECK ("catch_all_class" IS NULL OR "catch_all_class" IN
      ('true_catch_all', 'unprobeable_provider', 'inconclusive', 'not_catch_all', 'unknown')),
  ADD CONSTRAINT "contact_point_confidence_check"
    CHECK ("confidence" IS NULL OR ("confidence" BETWEEN 0 AND 100)),
  ADD CONSTRAINT "contact_point_phone_type_check"
    CHECK ("phone_type" IS NULL OR "phone_type" IN ('mobile', 'landline', 'voip', 'unknown')),
  -- VALID ⇔ valid_since 非空；非 VALID 禁止携带 valid_since（离开即清空）。
  ADD CONSTRAINT "contact_point_valid_since_check"
    CHECK (("verification_state" = 'VALID') = ("valid_since" IS NOT NULL)),
  -- 域盲索引与 bi:v1: 前缀的格式一致（回填脚本写、按域聚合读，不落明文域）。
  ADD CONSTRAINT "contact_point_domain_blind_key_check"
    CHECK ("domain_blind_key" IS NULL OR "domain_blind_key" ~ '^bi:v1:[0-9a-f]{64}$');

CREATE INDEX "contact_point_domain_blind_key_idx"
  ON "contact_point" ("workspace_id", "domain_blind_key");
CREATE INDEX "contact_point_state_idx"
  ON "contact_point" ("workspace_id", "type", "verification_state");
-- 普通索引（非 partial）：Prisma datamodel 无法表达 partial index，而 #903 的漂移门是
-- ratchet（新漂移即红）；重验队列查询带 next_reverify_at IS NOT NULL，普通索引同样可用。
CREATE INDEX "contact_point_reverify_idx"
  ON "contact_point" ("workspace_id", "next_reverify_at");

-- ② source_type 收紧：先补历史值，再 NOT NULL。
--    legacy_unclassified = 迁移前无法溯源的写入（2026-11-08 审计：250/274 条邮箱此列 NULL）。
ALTER TABLE "contact_point" DROP CONSTRAINT IF EXISTS "contact_point_source_type_check";
ALTER TABLE "contact_point"
  ADD CONSTRAINT "contact_point_source_type_check" CHECK (
    "source_type" IN ('impressum', 'contact_page', 'homepage', 'directory', 'social',
                      'pattern_guess', 'operator', 'provider', 'legacy_unclassified')
  );
UPDATE "contact_point" SET "source_type" = 'legacy_unclassified' WHERE "source_type" IS NULL;
ALTER TABLE "contact_point" ALTER COLUMN "source_type" SET NOT NULL;

-- ③ verification_method 扩展：第三方验证 API 与电话查询。
ALTER TABLE "contact_point" DROP CONSTRAINT IF EXISTS "contact_point_verification_method_check";
ALTER TABLE "contact_point"
  ADD CONSTRAINT "contact_point_verification_method_check" CHECK (
    "verification_method" IS NULL OR "verification_method" IN
      ('smtp_rcpt', 'pattern_guess', 'provider_reported', 'operator', 'import', 'third_party_api')
  );

-- ④ 回填四态（口径与 contact-point-verification-state.ts 的 legacyStatusToState 逐分支一致）：
--    status=VALID → VALID；INVALID → INVALID；RISKY 只有 catch_all='catch_all' 才
--    CATCH_ALL_RISKY，其余 RISKY/UNVERIFIED/脏值一律 UNKNOWN（进重验队列）。
UPDATE "contact_point"
SET "verification_state" = CASE
      WHEN "status" = 'VALID' THEN 'VALID'
      WHEN "status" = 'INVALID' THEN 'INVALID'
      WHEN "status" = 'RISKY' AND "catch_all" = 'catch_all' THEN 'CATCH_ALL_RISKY'
      ELSE 'UNKNOWN'
    END,
    "valid_since" = CASE
      WHEN "status" = 'VALID' THEN COALESCE("verified_at", "created_at")
      ELSE NULL
    END;

-- 非 UNKNOWN 态补验证方式/供应商/置信分：INVALID 来自自建 SMTP 的 550（唯一确定的一类），
-- VALID/CATCH_ALL_RISKY 的历史证据无法逐点重建 → legacy_unclassified + import（重验队列会刷新）。
UPDATE "contact_point"
SET "verification_provider" = CASE
      WHEN "verification_state" = 'INVALID' THEN 'smtp_self'
      WHEN "verification_state" IN ('VALID', 'CATCH_ALL_RISKY') THEN 'legacy_unclassified'
      ELSE "verification_provider"
    END,
    "verification_method" = CASE
      WHEN "verification_state" = 'INVALID' THEN 'smtp_rcpt'
      WHEN "verification_state" IN ('VALID', 'CATCH_ALL_RISKY') THEN 'import'
      ELSE "verification_method"
    END,
    "catch_all_class" = CASE
      WHEN "verification_state" = 'CATCH_ALL_RISKY' AND "catch_all" = 'catch_all' THEN 'true_catch_all'
      ELSE "catch_all_class"
    END,
    "confidence" = CASE "verification_state"
      WHEN 'VALID' THEN 95
      WHEN 'INVALID' THEN 0
      WHEN 'CATCH_ALL_RISKY' THEN 55
      ELSE 20
    END,
    "last_seen_at" = "created_at";

-- 回填完成后才能加「非 UNKNOWN 必须有验证方式与供应商」的约束（否则回填过程本身会撞 CHECK）。
ALTER TABLE "contact_point"
  ADD CONSTRAINT "contact_point_state_evidence_check"
    CHECK ("verification_state" = 'UNKNOWN'
           OR ("verification_method" IS NOT NULL AND "verification_provider" IS NOT NULL));

-- 重验排期：UNKNOWN 3 天内、VALID/CATCH_ALL_RISKY 90 天 TTL、INVALID 终态不排期。
UPDATE "contact_point"
SET "next_reverify_at" = CASE "verification_state"
      WHEN 'UNKNOWN' THEN now() + interval '3 days'
      WHEN 'INVALID' THEN NULL
      ELSE now() + interval '90 days'
    END
WHERE "type" = 'email' AND "verification_state" <> 'INVALID' AND "next_reverify_at" IS NULL;

-- ⑤ 验证事件账（append-only）：每次验证尝试一行（成功/失败/被合规门拦截都记），
--    唯一键 (workspace, point, provider, request_hash) 保证供应商重试不重复记费。
CREATE TABLE "contact_point_verification_event" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "contact_point_id" UUID NOT NULL,
  "attempt_no" INTEGER NOT NULL,
  "provider_key" TEXT NOT NULL,
  "method" TEXT NOT NULL,
  "verdict" TEXT NOT NULL,
  "detail" TEXT,
  "catch_all" TEXT,
  "catch_all_class" TEXT,
  "score" SMALLINT,
  "cost_microusd" BIGINT NOT NULL DEFAULT 0,
  "lawful_basis" JSONB,
  "actor_id" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "latency_ms" INTEGER,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "contact_point_verification_event_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cpve_verdict_check" CHECK ("verdict" IN
    ('valid', 'invalid', 'catch_all', 'unknown', 'blocked', 'error')),
  CONSTRAINT "cpve_method_check" CHECK ("method" IN
    ('third_party_api', 'smtp_rcpt', 'operator', 'import', 'pattern_guess')),
  CONSTRAINT "cpve_catch_all_check" CHECK ("catch_all" IS NULL OR "catch_all" IN
    ('catch_all', 'not_catch_all', 'inconclusive', 'unknown')),
  CONSTRAINT "cpve_cost_check" CHECK ("cost_microusd" >= 0),
  CONSTRAINT "contact_point_verification_event_contact_point_id_fkey" FOREIGN KEY ("contact_point_id")
    REFERENCES "contact_point"("id") ON DELETE CASCADE,
  CONSTRAINT "cpve_unique_attempt" UNIQUE
    ("workspace_id", "contact_point_id", "provider_key", "request_hash")
);

CREATE INDEX "cpve_point_time_idx" ON "contact_point_verification_event"
  ("workspace_id", "contact_point_id", "created_at" DESC);
CREATE INDEX "cpve_verdict_time_idx" ON "contact_point_verification_event"
  ("workspace_id", "verdict", "created_at");
CREATE INDEX "cpve_provider_time_idx" ON "contact_point_verification_event"
  ("workspace_id", "provider_key", "created_at");

ALTER TABLE "contact_point_verification_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contact_point_verification_event" FORCE ROW LEVEL SECURITY;
CREATE POLICY "cpve_tenant_isolation" ON "contact_point_verification_event"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

-- append-only：app_user 只读与追加；更正只能走 DBA/DSR 流程。
REVOKE ALL ON TABLE "contact_point_verification_event" FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE "contact_point_verification_event" TO app_user;

COMMIT;
