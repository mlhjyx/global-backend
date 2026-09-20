-- DropForeignKey
ALTER TABLE "execution_domain_ack" DROP CONSTRAINT "execution_domain_ack_account_fkey";

-- DropForeignKey
ALTER TABLE "execution_domain_ack" DROP CONSTRAINT "execution_domain_ack_authority_fkey";

-- DropForeignKey
ALTER TABLE "execution_domain_ack" DROP CONSTRAINT "execution_domain_ack_operation_fkey";

-- DropForeignKey
ALTER TABLE "field_evidence" DROP CONSTRAINT "field_evidence_workspace_raw_fkey";

-- DropForeignKey
ALTER TABLE "identity_link" DROP CONSTRAINT "identity_link_workspace_raw_fkey";

-- DropForeignKey
ALTER TABLE "personal_artifact_cleanup_command" DROP CONSTRAINT "personal_artifact_cleanup_command_artifact_fkey";

-- DropForeignKey
ALTER TABLE "personal_artifact_cleanup_command" DROP CONSTRAINT "personal_artifact_cleanup_command_request_fkey";

-- DropForeignKey
ALTER TABLE "personal_artifact_cleanup_command" DROP CONSTRAINT "personal_artifact_cleanup_command_workspace_fkey";

-- DropForeignKey
ALTER TABLE "raw_source_governance_disposition" DROP CONSTRAINT "raw_source_governance_disposition_raw_scope_fkey";

-- DropForeignKey
ALTER TABLE "raw_source_record" DROP CONSTRAINT "raw_source_record_workspace_run_fkey";

-- DropForeignKey
ALTER TABLE "source_entity" DROP CONSTRAINT "source_entity_last_seen_fetch_fkey";

-- AlterTable
ALTER TABLE "personal_artifact_cleanup_command" ALTER COLUMN "command_id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "raw_source_field_evidence_cleanup_audit" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "raw_source_governance_disposition" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "runtime_process_lease" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "site_build_budget_grant" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "site_build_spend_reconciliation" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "suppression_decision" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "tool_budget_account" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "tool_budget_operation" DROP COLUMN "receipt_cost_basis",
DROP COLUMN "receipt_usage",
ALTER COLUMN "id" DROP DEFAULT;

-- DropTable
DROP TABLE "execution_domain_ack";

-- RenameIndex
ALTER INDEX "source_entity_last_seen_fetch_idx" RENAME TO "source_entity_last_seen_fetch_id_idx";

