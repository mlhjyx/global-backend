BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE "generic_operation_artifact"
  VALIDATE CONSTRAINT "generic_operation_artifact_expected_facts_check";
ALTER TABLE "tool_budget_operation"
  VALIDATE CONSTRAINT "tool_budget_operation_expected_facts_check";
COMMIT;
