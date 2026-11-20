CREATE OR REPLACE FUNCTION public.market_candidate_complete_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp
AS $$
DECLARE
  target_id uuid;
  head_revision integer;
  target_revision integer;
  from_candidates jsonb;
  to_candidates jsonb;
BEGIN
  IF TG_TABLE_NAME='market_candidate_set' THEN target_id:=NEW.id; ELSE target_id:=NEW.set_id; END IF;
  SELECT current_revision INTO head_revision
    FROM public.market_candidate_set
    WHERE id=target_id AND workspace_id=NEW.workspace_id;
  IF NOT FOUND THEN RETURN NEW; END IF;

  IF TG_TABLE_NAME='market_candidate_feedback' THEN
    IF NEW.from_revision<1 OR NEW.to_revision<>NEW.from_revision+1 OR NEW.to_revision>head_revision THEN
      RAISE EXCEPTION 'MARKET_CANDIDATE_INCOMPLETE_REVISION' USING ERRCODE='23514';
    END IF;
    SELECT p.document_json->'candidates',r.document_json->'candidates'
      INTO from_candidates,to_candidates
      FROM public.market_candidate_set_revision p
      JOIN public.market_candidate_set_revision r
        ON r.workspace_id=p.workspace_id AND r.set_id=p.set_id AND r.revision=NEW.to_revision
      WHERE p.workspace_id=NEW.workspace_id AND p.set_id=target_id AND p.revision=NEW.from_revision;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'MARKET_CANDIDATE_INCOMPLETE_REVISION' USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(from_candidates) c WHERE c->>'candidateId'=NEW.candidate_id::text)
      OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(to_candidates) c WHERE c->>'candidateId'=NEW.candidate_id::text) THEN
      RAISE EXCEPTION 'MARKET_CANDIDATE_FEEDBACK_TARGET_INVALID' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME='market_candidate_set' THEN target_revision:=NEW.current_revision;
  ELSE target_revision:=NEW.revision;
  END IF;
  IF target_revision<1 OR target_revision>head_revision THEN
    RAISE EXCEPTION 'MARKET_CANDIDATE_INCOMPLETE_REVISION' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.market_candidate_set_revision
    WHERE workspace_id=NEW.workspace_id AND set_id=target_id AND revision=target_revision
  ) THEN
    RAISE EXCEPTION 'MARKET_CANDIDATE_INCOMPLETE_REVISION' USING ERRCODE='23514';
  END IF;
  IF target_revision>1 AND NOT EXISTS (
    SELECT 1 FROM public.market_candidate_feedback
    WHERE workspace_id=NEW.workspace_id AND set_id=target_id
      AND to_revision=target_revision AND from_revision=target_revision-1
  ) THEN
    RAISE EXCEPTION 'MARKET_CANDIDATE_INCOMPLETE_REVISION' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$$;
