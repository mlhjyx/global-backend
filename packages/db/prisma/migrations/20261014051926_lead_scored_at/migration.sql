-- lead.scored_at: when the scoring stage (qualify scoreCandidates) last wrote the
-- six-dimension scores for this lead. NULL means the row was created by the fit
-- gate and never scored (its queue is still the fit gate's preset), or that it
-- was scored before this column existed. Nullable, no default, no backfill: the
-- next scoring pass stamps it. The API's scored/queueBasis fields and the
-- LeadQualified snapshot's scored_at read it. Table privileges are unchanged.
ALTER TABLE "lead" ADD COLUMN "scored_at" TIMESTAMP(3);
