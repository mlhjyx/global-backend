-- PostgreSQL requires a newly added enum value to commit before later schema
-- objects may reference it. Keep this forward-only phase separate.
ALTER TYPE "tool_budget_operation_status"
  ADD VALUE IF NOT EXISTS 'RESULT_UNKNOWN' AFTER 'RESERVED';
