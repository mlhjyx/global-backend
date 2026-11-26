-- Preserve review audit history while dropping stamps generated from ID-only reviews.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

LOCK TABLE public.source_channel_record IN SHARE ROW EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION public.bind_source_channel_record_review_version_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.reviewed_content_hash := NULL;
  ELSIF ROW(NEW.content_hash, NEW.name, NEW.website, NEW.country, NEW.industry,
            NEW.products, NEW.keywords, NEW.source_url)
      IS DISTINCT FROM
        ROW(OLD.content_hash, OLD.name, OLD.website, OLD.country, OLD.industry,
            OLD.products, OLD.keywords, OLD.source_url) THEN
    NEW.reviewed_content_hash := NULL;
    IF OLD.review_status = 'APPROVED' AND NEW.review_status = 'APPROVED' THEN
      NEW.review_status := 'PENDING';
      NEW.reviewed_at := NULL;
      NEW.reviewed_by := NULL;
    END IF;
  ELSIF NEW.reviewed_content_hash IS NOT NULL AND (
    NEW.review_status <> 'APPROVED' OR
    NEW.reviewed_content_hash IS DISTINCT FROM NEW.content_hash OR
    NEW.reviewed_content_hash !~ '^[0-9a-f]{64}$'
  ) THEN
    NEW.reviewed_content_hash := NULL;
  END IF;
  RETURN NEW;
END;
$$;

UPDATE public.source_channel_record
SET reviewed_content_hash = NULL
WHERE reviewed_content_hash IS NOT NULL;

COMMIT;
