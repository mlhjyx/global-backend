-- Persist the exact Site Builder policy/model snapshot selected for every
-- gateway call. Nullable preserves historical and non-Site-Builder traces.
ALTER TABLE "ai_trace" ADD COLUMN "meta" JSONB;
