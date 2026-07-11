-- AlterTable
ALTER TABLE "field_evidence" ADD COLUMN     "data_class" TEXT NOT NULL DEFAULT 'green';

-- CreateTable
CREATE TABLE "jurisdiction_policy" (
    "id" UUID NOT NULL,
    "subject_jurisdiction" TEXT NOT NULL,
    "processor_jurisdiction" TEXT NOT NULL,
    "data_class" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "effect" TEXT NOT NULL,
    "requires_lawful_basis" BOOLEAN NOT NULL DEFAULT false,
    "article14_required" BOOLEAN NOT NULL DEFAULT false,
    "retention_days" INTEGER,
    "rule_version" TEXT NOT NULL DEFAULT 'v1',
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "jurisdiction_policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy_decision_log" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "data_class" TEXT NOT NULL,
    "subject_jurisdiction" TEXT NOT NULL,
    "processor_jurisdiction" TEXT NOT NULL,
    "effect" TEXT NOT NULL,
    "allowed" BOOLEAN NOT NULL,
    "reason" TEXT NOT NULL,
    "rule_id" TEXT,
    "rule_version" TEXT NOT NULL,
    "article14_required" BOOLEAN NOT NULL DEFAULT false,
    "subject_type" TEXT,
    "subject_id" UUID,
    "lawful_basis_ref" TEXT,
    "actor_id" TEXT,
    "correlation_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "policy_decision_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lia_record" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "scope_ref" UUID,
    "basis" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "necessity_note" TEXT,
    "balancing_note" TEXT,
    "ref" TEXT,
    "recorded_by" TEXT NOT NULL,
    "version" TEXT NOT NULL DEFAULT 'v1',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "effective_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "withdrawn_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lia_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "article14_notice" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "jurisdiction" TEXT NOT NULL,
    "obligation" TEXT NOT NULL DEFAULT 'REQUIRED',
    "due_at" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "fulfilled_at" TIMESTAMP(3),
    "channel" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "article14_notice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "jurisdiction_policy_subject_jurisdiction_processor_jurisdic_key" ON "jurisdiction_policy"("subject_jurisdiction", "processor_jurisdiction", "data_class", "action", "rule_version");

-- CreateIndex
CREATE INDEX "policy_decision_log_workspace_id_idx" ON "policy_decision_log"("workspace_id");

-- CreateIndex
CREATE INDEX "policy_decision_log_workspace_id_action_idx" ON "policy_decision_log"("workspace_id", "action");

-- CreateIndex
CREATE INDEX "lia_record_workspace_id_idx" ON "lia_record"("workspace_id");

-- CreateIndex
CREATE INDEX "lia_record_workspace_id_scope_idx" ON "lia_record"("workspace_id", "scope");

-- CreateIndex
CREATE INDEX "article14_notice_workspace_id_idx" ON "article14_notice"("workspace_id");

-- CreateIndex
CREATE INDEX "article14_notice_workspace_id_subject_id_idx" ON "article14_notice"("workspace_id", "subject_id");

-- ── 收口⑥ 存储合规：RLS + DB 层最小权限（角色拆分）+ dataClass 回填 ──────────────

-- jurisdiction_policy：平台级治理规则表（无 RLS，同 source_policy/data_provider）。app_user 只读，
-- owner（global）写 seed。REVOKE 写权限=最小权限（DEFAULT PRIVILEGES 已授全 CRUD，此处收回写）。
REVOKE INSERT, UPDATE, DELETE ON "jurisdiction_policy" FROM app_user;

-- policy_decision_log：租户 RLS 三件套 + **append-only**（审计不可篡改，连 app 角色也不能改/删——
-- DB 层保证，非代码纪律；收口⑥「DB 角色拆分」的具体交付）。
ALTER TABLE "policy_decision_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "policy_decision_log" FORCE ROW LEVEL SECURITY;
CREATE POLICY "policy_decision_log_tenant_isolation" ON "policy_decision_log"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());
REVOKE UPDATE, DELETE ON "policy_decision_log" FROM app_user;

-- lia_record：租户 RLS 三件套（生命周期记录，允许 UPDATE 撤回/版本化）。
ALTER TABLE "lia_record" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lia_record" FORCE ROW LEVEL SECURITY;
CREATE POLICY "lia_record_tenant_isolation" ON "lia_record"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

-- article14_notice：租户 RLS 三件套（履行状态生命周期）。
ALTER TABLE "article14_notice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "article14_notice" FORCE ROW LEVEL SECURITY;
CREATE POLICY "article14_notice_tenant_isolation" ON "article14_notice"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

-- lia_record / article14_notice：保留 UPDATE（生命周期=撤回/版本化/履行状态 PENDING→FULFILLED），但
-- REVOKE DELETE——GDPR Art.5(2) 问责证据（LIA 权衡、Art.14 告知履行）不可硬删，软删除走 status；
-- 与 policy_decision_log append-only 立场一致（DB 层保证，非代码纪律）。
REVOKE DELETE ON "lia_record" FROM app_user;
REVOKE DELETE ON "article14_notice" FROM app_user;

-- field_evidence.data_class 回填：存量具名个人数据一律标 red（合规保守=偏严）。含：person.profile、
-- value.personal_data:true、以及联系点第二副本证据（email/phone/linkedin/email.guess——这些行的 value
-- 即人名邮箱/电话/领英，皆个人数据 GDPR Art.4）。SQL 无法廉价区分职能/人名邮箱，故 email 一律 red；
-- 前向写路径按 cleanEmail 精分 amber/red。green 是最宽松档，legacy PII 留 green 会漏保护。
UPDATE "field_evidence"
SET "data_class" = 'red'
WHERE "field" IN ('person.profile', 'email', 'phone', 'linkedin', 'email.guess')
   OR ("value" ? 'personal_data' AND ("value" ->> 'personal_data') = 'true');
