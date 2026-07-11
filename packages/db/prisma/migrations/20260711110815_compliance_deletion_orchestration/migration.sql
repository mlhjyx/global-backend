-- CreateTable
CREATE TABLE "deletion_request" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "requested_by" TEXT NOT NULL,
    "request_ref" TEXT,
    "reason" TEXT,
    "stats" JSONB,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "deletion_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deletion_receipt" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "deletion_request_id" UUID NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "contacts_erased" INTEGER NOT NULL DEFAULT 0,
    "contact_points_erased" INTEGER NOT NULL DEFAULT 0,
    "field_evidence_erased" INTEGER NOT NULL DEFAULT 0,
    "signals_revoked" INTEGER NOT NULL DEFAULT 0,
    "companies_suppressed" INTEGER NOT NULL DEFAULT 0,
    "leads_rescore_requested" INTEGER NOT NULL DEFAULT 0,
    "rule_version" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deletion_receipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "deletion_request_workspace_id_idx" ON "deletion_request"("workspace_id");

-- CreateIndex
CREATE INDEX "deletion_request_workspace_id_status_idx" ON "deletion_request"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "deletion_request_workspace_id_subject_type_subject_id_idx" ON "deletion_request"("workspace_id", "subject_type", "subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "deletion_receipt_deletion_request_id_key" ON "deletion_receipt"("deletion_request_id");

-- CreateIndex
CREATE INDEX "deletion_receipt_workspace_id_idx" ON "deletion_receipt"("workspace_id");

-- AddForeignKey（onDelete: Restrict——回执在则父不可删，防级联删绕过 receipt append-only）
ALTER TABLE "deletion_receipt" ADD CONSTRAINT "deletion_receipt_deletion_request_id_fkey" FOREIGN KEY ("deletion_request_id") REFERENCES "deletion_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── 收口⑥ PR-B 删除编排：RLS 租户隔离 + append-only 回执（DB 层最小权限）──────────────

-- deletion_request：租户 RLS 三件套。状态机 RECEIVED→FROZEN→ERASING→COMPLETED|FAILED 只需 UPDATE，
-- 从不需要 DELETE → **REVOKE DELETE**（防 app_user 删父级联抹掉 receipt 的 append-only；且回执 FK=RESTRICT
-- 双保险：即便有 DELETE 权，只要回执在也删不动父）。
ALTER TABLE "deletion_request" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "deletion_request" FORCE ROW LEVEL SECURITY;
CREATE POLICY "deletion_request_tenant_isolation" ON "deletion_request"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());
REVOKE DELETE ON "deletion_request" FROM app_user;

-- 「同主体至多一条在途请求」部分唯一索引：DB 层防 createRequest find-then-create 并发竞态（两个并发
-- POST 各建一条 → 两条 append-only 回执 + 两条 DeletionCompleted）。终态 COMPLETED/FAILED 不占唯一位，
-- 允许完成后对同主体再次发起。第二个并发插入在此索引冲突 → P2002 → createRequest 回退复用在途请求。
CREATE UNIQUE INDEX "deletion_request_active_subject_uniq"
  ON "deletion_request" ("workspace_id", "subject_type", "subject_id")
  WHERE "status" IN ('RECEIVED', 'FROZEN', 'ERASING');

-- deletion_receipt：租户 RLS 三件套 + **append-only**（REVOKE UPDATE,DELETE FROM app_user——
-- 擦除问责证明不可篡改/不可删，GDPR Art.5(2)；与 policy_decision_log 立场一致，DB 层保证非代码纪律）。
ALTER TABLE "deletion_receipt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "deletion_receipt" FORCE ROW LEVEL SECURITY;
CREATE POLICY "deletion_receipt_tenant_isolation" ON "deletion_receipt"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());
REVOKE UPDATE, DELETE ON "deletion_receipt" FROM app_user;
