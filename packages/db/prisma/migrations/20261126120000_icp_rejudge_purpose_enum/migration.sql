-- PostgreSQL must commit this enum addition before the later USE migration.
ALTER TYPE "execution_budget_purpose"
  ADD VALUE IF NOT EXISTS 'icp.rejudge' AFTER 'icp.query_plan';
