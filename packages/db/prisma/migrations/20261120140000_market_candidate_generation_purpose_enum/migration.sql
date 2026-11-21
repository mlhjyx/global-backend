-- PostgreSQL must commit this enum addition before the later USE migration.
ALTER TYPE "execution_budget_purpose" ADD VALUE 'market.candidates.generate';
